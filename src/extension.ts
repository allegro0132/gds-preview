import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "gds-preview" is now active!');
    console.log(`Extension path: ${context.extensionPath}`);

    const provider = new GdsPreviewProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            GdsPreviewProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    context.subscriptions.push(vscode.commands.registerCommand('gds-preview.reset', () => {
        provider.reset();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gds-preview.stop', () => {
        provider.stop();
    }));
}

class GdsPreviewProvider implements vscode.CustomReadonlyEditorProvider {

    public static readonly viewType = 'gds-preview.gdsPreview';
    private readonly webviews = new Set<vscode.WebviewPanel>();

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    public reset() {
        for (const panel of this.webviews) {
            if (panel.visible) {
                panel.webview.postMessage({ command: 'reset' });
            }
        }
    }

    public stop() {
        for (const panel of this.webviews) {
            if (panel.visible) {
                panel.webview.postMessage({ command: 'stop' });
            }
        }
    }

    openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): vscode.CustomDocument | Thenable<vscode.CustomDocument> {
        return { uri, dispose: () => { } };
    }

    resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): void | Thenable<void> {
        console.log(`resolveCustomEditor called for ${document.uri.fsPath}`);
        this.webviews.add(webviewPanel);
        webviewPanel.onDidDispose(() => {
            this.webviews.delete(webviewPanel);
        });

        const filePath = document.uri.fsPath;

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(os.tmpdir()), this.context.extensionUri]
        };

        // Log options
        console.log(`Webview options set. localResourceRoots: ${JSON.stringify(webviewPanel.webview.options.localResourceRoots)}`);

        let currentCell: string | undefined;
        let currentProcess: cp.ChildProcess | undefined;
        let isNegative = false;

        // Set initial HTML content
        const config = vscode.workspace.getConfiguration('gdsPreview');
        const initialRenderingEngine = config.get<string>('renderingEngine', 'canvas');
        const fastModeThreshold = config.get<number>('fastModeThreshold', 10);
        const labelFontSize = config.get<number>('labelFontSize', 12);
        const portFontSize = config.get<number>('portFontSize', 12);
        const portArrowScale = config.get<number>('portArrowScale', 1.0);
        const maxSteps = config.get<number>('maxSteps', 5000);
        const maxWorkers = config.get<number>('maxWorkers', -1);
        const chunkSize = config.get<number>('chunkSize', 2000);
        const pythonPath = config.get<string>('pythonPath', 'python');
        const enableProfiling = config.get<boolean>('enableProfiling', false);
        const flowControlStep = config.get<number>('flowControlStep', 5);
        const useInstancing = config.get<boolean>('useInstancing', true);

        const updateWebview = (cellName?: string, isNegativeMode?: boolean) => {
            // console.log(`updateWebview called with cellName: ${cellName}`);
            // Kill existing process if any
            if (currentProcess) {
                console.log("Killing previous Python process...");
                currentProcess.kill();
                currentProcess = undefined;
            }

            const currentConfig = vscode.workspace.getConfiguration('gdsPreview');
            const currentRenderingEngine = currentConfig.get<string>('renderingEngine', 'canvas');
            const chunkSize = currentConfig.get<number>('chunkSize', 2000);
            const flowControlStep = currentConfig.get<number>('flowControlStep', 5);
            const useInstancing = currentConfig.get<boolean>('useInstancing', true);
            const enableProfiling = currentConfig.get<boolean>('enableProfiling', false);

            const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);

            let scriptName = 'gds_to_canvas.py';
            if (currentRenderingEngine === 'svg') {
                scriptName = 'gds_to_svg.py';
            }

            const pythonScriptPath = this.context.asAbsolutePath(path.join('scripts', scriptName));
            const pythonPath = currentConfig.get<string>('pythonPath', 'python');

            const args = [pythonScriptPath, filePath, tempDir];
            args.push(cellName || "");

            if (currentRenderingEngine === 'svg' && isNegativeMode) {
                args.push("--negative");
            } else {
                // Only pass chunk size for canvas/webgl mode or if not negative?
                // Actually gds_to_canvas expects chunk size as 4th arg.
                // gds_to_svg expects cell name as 3rd (optional) and flags after.
                // We need to be careful about argument order.

                // gds_to_canvas: path, out_dir, cell_name, chunk_size
                // gds_to_svg: path, out_dir, cell_name, [--negative]

                if (currentRenderingEngine !== 'svg') {
                    args.push(chunkSize.toString());
                    args.push(flowControlStep.toString());
                    // Use instancing if WebGL and enabled
                    args.push((currentRenderingEngine === 'webgl' && useInstancing) ? "1" : "0");
                }
            }

            console.log(`Running python script: ${pythonPath} ${args.join(' ')}`);
            if (enableProfiling) {
                console.time("PythonProcess");
            }

            const process = cp.spawn(pythonPath, args);
            currentProcess = process;

            let stderr = '';
            process.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.startsWith("PROFILE:")) {
                    if (enableProfiling) {
                        console.log(msg.trim());
                    }
                } else {
                    stderr += msg;
                }
            });

            // Use readline to stream stdout line by line
            const rl = readline.createInterface({
                input: process.stdout,
                crlfDelay: Infinity
            });

            let isFirstLine = true;

            let currentChunkMeta: any = null;

            rl.on('line', (line) => {
                if (isFirstLine) {
                    console.log(`[PythonProcess] First byte received`);
                }
                // console.log(`Received line from Python: ${line.substring(0, 100)}...`);
                try {
                    if (!line.trim()) return;

                    if (line.startsWith("CHUNK_B64|")) {
                        const chunkInfo = JSON.parse(line.substring(10));
                        webviewPanel.webview.postMessage({
                            command: 'addLayerChunkB64',
                            layerKey: chunkInfo.layerKey,
                            chunkIndex: chunkInfo.chunkIndex,
                            totalChunks: chunkInfo.totalChunks,
                            data: chunkInfo.data,
                            type: chunkInfo.type,
                            cellName: chunkInfo.cellName
                        });
                    } else {
                        // Legacy/Metadata handling
                        const data = JSON.parse(line);

                        if (isFirstLine) {
                            console.log("[PythonProcess] Sending initialize command to webview");
                            // Metadata
                            webviewPanel.webview.postMessage({
                                command: 'initialize',
                                data: data,
                                engine: currentRenderingEngine
                            }).then(
                                (success) => console.log(`[Webview Log] Initialize message delivery status: ${success}`),
                                (err) => console.log(`[Webview Log] Initialize message delivery failed: ${err}`)
                            );
                            isFirstLine = false;
                        } else if (data.type === 'ports') {
                            webviewPanel.webview.postMessage({
                                command: 'addPorts',
                                ports: data.ports
                            });
                        } else if (data.layerKey && data.labels) {
                            // Label chunk (still JSON)
                            webviewPanel.webview.postMessage({
                                command: 'addLayerChunk',
                                layerKey: data.layerKey,
                                data: data
                            });
                        }
                    }
                } catch (e: any) {
                    console.log(`Failed to parse line: ${e.message}`);
                    // Don't show error message for every line, just log it
                }
            });

            process.on('error', (err) => {
                console.log(`Failed to start python process: ${err}`);
                vscode.window.showErrorMessage(`Failed to start Python process. Please check if Python is installed and configured in 'gdsPreview.pythonPath'. Error: ${err.message}`);
            });

            process.on('close', (code) => {
                console.log(`[PythonProcess] Finished`);
                if (currentProcess !== process) {
                    return;
                }
                currentProcess = undefined;

                console.log(`Python script exited with code ${code}`);
                if (code !== 0) {
                    console.log(`Stderr: ${stderr}`);
                    if (stderr.includes("ModuleNotFoundError") && stderr.includes("gdstk")) {
                        vscode.window.showErrorMessage("Python module 'gdstk' is missing.", "Install gdstk").then(selection => {
                            if (selection === "Install gdstk") {
                                installGdstk(pythonPath);
                            }
                        });
                    } else if (stderr.includes("ModuleNotFoundError") && stderr.includes("klayout")) {
                        vscode.window.showErrorMessage("Python module 'klayout' is missing. It is required for port extraction.", "Install klayout").then(selection => {
                            if (selection === "Install klayout") {
                                installKlayout(pythonPath);
                            }
                        });
                    } else {
                        try {
                            const errJson = JSON.parse(stderr);
                            vscode.window.showErrorMessage(`Failed to convert GDS: ${errJson.error}`);
                        } catch {
                            vscode.window.showErrorMessage(`Failed to convert GDS. Exit code: ${code}. Stderr: ${stderr}`);
                        }
                    }
                    return;
                }

                // Send success message to webview
                webviewPanel.webview.postMessage({ command: 'status', message: 'Loaded successfully' });

                // Clean up temp dir (even though we didn't use it for files, we created it)
                fs.rm(tempDir, { recursive: true, force: true }, (err) => {
                    if (err) {
                        console.log(`Failed to delete temporary directory: ${tempDir} ${err}`);
                    }
                });
            });
        };

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'log') {
                    console.log(`[Webview Log]: ${message.message}`);
                    return;
                }
                if (message.command === 'error') {
                    console.log(`[Webview Error]: ${message.message}`);
                    return;
                }
                if (message.command === 'ready_for_next') {
                    // unset flow control signal
                    currentProcess?.stdin?.write("\n");
                    return;
                }

                console.log(`Received message: ${JSON.stringify(message)}`);
                switch (message.command) {
                    case 'changeCell':
                        currentCell = message.cellName;
                        updateWebview(message.cellName);
                        return;
                    case 'reloadNegative':
                        isNegative = message.isNegative;
                        updateWebview(currentCell, message.isNegative);
                        return;
                    case 'syncNegativeState':
                        isNegative = message.isNegative;
                        return;
                    case 'reset':
                        isNegative = false;
                        updateWebview(currentCell);
                        return;
                    case 'stop':
                        if (currentProcess) {
                            currentProcess.kill();
                            currentProcess = undefined;
                            webviewPanel.webview.postMessage({ command: 'status', message: 'Stopped by user' });
                        }
                        return;
                    case 'ready':
                        console.log("Received ready message from webview");
                        updateWebview(currentCell);
                        return;
                    case 'updateConfig':
                        const config = vscode.workspace.getConfiguration('gdsPreview');
                        if (message.key && message.value !== undefined) {
                            config.update(message.key, message.value, vscode.ConfigurationTarget.Global);
                        }
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );

        webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri, initialRenderingEngine, fastModeThreshold, labelFontSize, portFontSize, portArrowScale, maxSteps, maxWorkers, chunkSize, pythonPath, enableProfiling, flowControlStep, useInstancing);
        console.log("Webview HTML set");

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gdsPreview.fastModeThreshold') ||
                e.affectsConfiguration('gdsPreview.labelFontSize') ||
                e.affectsConfiguration('gdsPreview.portFontSize') ||
                e.affectsConfiguration('gdsPreview.portArrowScale') ||
                e.affectsConfiguration('gdsPreview.maxSteps')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const newThreshold = config.get<number>('fastModeThreshold', 10);
                const newFontSize = config.get<number>('labelFontSize', 12);
                const newPortFontSize = config.get<number>('portFontSize', 12);
                const newPortArrowScale = config.get<number>('portArrowScale', 1.0);
                const newMaxSteps = config.get<number>('maxSteps', 5000);
                webviewPanel.webview.postMessage({
                    command: 'updateSettings',
                    fastModeThreshold: newThreshold,
                    labelFontSize: newFontSize,
                    portFontSize: newPortFontSize,
                    portArrowScale: newPortArrowScale,
                    maxSteps: newMaxSteps
                });
            }
            if (e.affectsConfiguration('gdsPreview.renderingEngine')) {
                updateWebview(currentCell, isNegative);
            }
            if (e.affectsConfiguration('gdsPreview.maxWorkers') || e.affectsConfiguration('gdsPreview.chunkSize') || e.affectsConfiguration('gdsPreview.flowControlStep') || e.affectsConfiguration('gdsPreview.useInstancing')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const initialRenderingEngine = config.get<string>('renderingEngine', 'canvas');
                const fastModeThreshold = config.get<number>('fastModeThreshold', 10);
                const labelFontSize = config.get<number>('labelFontSize', 12);
                const portFontSize = config.get<number>('portFontSize', 12);
                const portArrowScale = config.get<number>('portArrowScale', 1.0);
                const maxSteps = config.get<number>('maxSteps', 5000);
                const maxWorkers = config.get<number>('maxWorkers', -1);
                const chunkSize = config.get<number>('chunkSize', 2000);
                const pythonPath = config.get<string>('pythonPath', 'python');
                const enableProfiling = config.get<boolean>('enableProfiling', false);
                const flowControlStep = config.get<number>('flowControlStep', 5);
                const useInstancing = config.get<boolean>('useInstancing', true);

                webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri, initialRenderingEngine, fastModeThreshold, labelFontSize, portFontSize, portArrowScale, maxSteps, maxWorkers, chunkSize, pythonPath, enableProfiling, flowControlStep, useInstancing);
            }
        }, null, this.context.subscriptions);
    }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, engine: string, fastModeThreshold: number, labelFontSize: number, portFontSize: number, portArrowScale: number, maxSteps: number, maxWorkersConfig: number, chunkSize: number, pythonPath: string, enableProfiling: boolean, flowControlStep: number, useInstancing: boolean): string {
    const nonce = getNonce();

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'main.js'));

    const svgPanZoomUri = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
    const earcutUri = "https://unpkg.com/earcut@2.2.4/dist/earcut.min.js";

    const geometryWorkerPath = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'workers', 'geometry.js').fsPath;
    const searchWorkerPath = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'workers', 'search.js').fsPath;

    let geometryWorkerCode = fs.readFileSync(geometryWorkerPath, 'utf-8');
    // Prepend earcutCdn definition for the worker
    geometryWorkerCode = `const earcutCdn = "${earcutUri}";\n` + geometryWorkerCode;

    const searchWorkerCode = fs.readFileSync(searchWorkerPath, 'utf-8');

    const htmlPath = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'index.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const config = {
        engine,
        fastModeThreshold,
        labelFontSize,
        portFontSize,
        portArrowScale,
        maxSteps,
        maxWorkers: maxWorkersConfig,
        chunkSize,
        pythonPath,
        enableProfiling,
        flowControlStep,
        useInstancing,
        workerCode: geometryWorkerCode,
        searchWorkerCode: searchWorkerCode
    };

    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{cspSource}}/g, webview.cspSource);
    html = html.replace(/{{styleUri}}/g, styleUri.toString());
    html = html.replace(/{{scriptUri}}/g, scriptUri.toString());
    html = html.replace(/{{svgPanZoomUri}}/g, svgPanZoomUri);
    html = html.replace(/{{earcutUri}}/g, earcutUri);
    html = html.replace(/{{gdsConfig}}/g, JSON.stringify(config));

    return html;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// This method is called when your extension is deactivated
export function deactivate() { }

function installGdstk(pythonPath: string) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Installing gdstk...",
        cancellable: false
    }, (progress, token) => {
        return new Promise<void>((resolve, reject) => {
            const command = `"${pythonPath}" -m pip install gdstk`;
            cp.exec(command, (err, stdout, stderr) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to install gdstk: ${err.message}`);
                    console.error(stderr);
                    reject(err);
                } else {
                    vscode.window.showInformationMessage("Successfully installed gdstk. Please reopen the GDS file to view it.");
                    resolve();
                }
            });
        });
    });
}

function installKlayout(pythonPath: string) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Installing klayout...",
        cancellable: false
    }, (progress, token) => {
        return new Promise<void>((resolve, reject) => {
            const command = `"${pythonPath}" -m pip install klayout`;
            cp.exec(command, (err, stdout, stderr) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to install klayout: ${err.message}`);
                    console.error(stderr);
                    reject(err);
                } else {
                    vscode.window.showInformationMessage("Successfully installed klayout. Please reopen the GDS file to view it.");
                    resolve();
                }
            });
        });
    });
}
