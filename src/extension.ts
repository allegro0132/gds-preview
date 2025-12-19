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
        const maxWorkers = config.get<number>('maxWorkers', -1);
        const chunkSize = config.get<number>('chunkSize', 2000);
        const pythonPath = config.get<string>('pythonPath', 'python');
        const enableProfiling = config.get<boolean>('enableProfiling', false);

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
                            data: chunkInfo.data
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

        webviewPanel.webview.html = getWebviewContent(initialRenderingEngine, fastModeThreshold, labelFontSize, maxWorkers, chunkSize, pythonPath, enableProfiling);
        console.log("Webview HTML set");

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gdsPreview.fastModeThreshold') ||
                e.affectsConfiguration('gdsPreview.labelFontSize')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const newThreshold = config.get<number>('fastModeThreshold', 10);
                const newFontSize = config.get<number>('labelFontSize', 12);
                webviewPanel.webview.postMessage({
                    command: 'updateSettings',
                    fastModeThreshold: newThreshold,
                    labelFontSize: newFontSize,
                });
            }
            if (e.affectsConfiguration('gdsPreview.renderingEngine')) {
                updateWebview(currentCell, isNegative);
            }
            if (e.affectsConfiguration('gdsPreview.maxWorkers') || e.affectsConfiguration('gdsPreview.chunkSize')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const initialRenderingEngine = config.get<string>('renderingEngine', 'canvas');
                const fastModeThreshold = config.get<number>('fastModeThreshold', 10);
                const labelFontSize = config.get<number>('labelFontSize', 12);
                const maxWorkers = config.get<number>('maxWorkers', -1);
                const chunkSize = config.get<number>('chunkSize', 2000);
                const pythonPath = config.get<string>('pythonPath', 'python');
                const enableProfiling = config.get<boolean>('enableProfiling', false);

                webviewPanel.webview.html = getWebviewContent(initialRenderingEngine, fastModeThreshold, labelFontSize, maxWorkers, chunkSize, pythonPath, enableProfiling);
            }
        }, null, this.context.subscriptions);
    }
}

function getWebviewContent(engine: string, fastModeThreshold: number, labelFontSize: number, maxWorkersConfig: number, chunkSize: number, pythonPath: string, enableProfiling: boolean): string {
    const nonce = getNonce();
    const svgPanZoomCdn = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
    const earcutCdn = "https://unpkg.com/earcut@2.2.4/dist/earcut.min.js";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://unpkg.com; img-src data:; worker-src blob:; connect-src https://cdn.jsdelivr.net https://unpkg.com;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GDS Preview</title>
    <script nonce="${nonce}">
        try {
            const vscode = acquireVsCodeApi();
            window.vscode = vscode;
            window.onerror = function(message, source, lineno, colno, error) {
                vscode.postMessage({ command: 'error', message: "Global Error: " + message + " at " + source + ":" + lineno });
            };
            // Override console.log and console.error to forward to extension
            const originalLog = console.log;
            console.log = (...args) => {
                // originalLog(...args); // Can't see this anyway
                vscode.postMessage({ command: 'log', message: args.map(a => String(a)).join(' ') });
            };
            const originalError = console.error;
            console.error = (...args) => {
                // originalError(...args);
                vscode.postMessage({ command: 'error', message: args.map(a => String(a)).join(' ') });
            };
            console.log("Webview Head Script Running");
        } catch (e) {
            // If acquireVsCodeApi fails, we can't post message, but we can try to alert or something?
            // Actually, if it fails, we are in trouble.
            console.error("Failed to acquire vscode api: " + e);
        }
    </script>
    <style>
        body, html {
            margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        #view-container { flex-grow: 1; position: relative; height: 100%; overflow: hidden; }
        #gds-canvas, #gds-webgl-canvas { display: block; width: 100%; height: 100%; }
        #root-svg-for-panzoom { width: 100%; height: 100%; display: block; }
        .gds-layer path, .gds-layer polygon, .gds-layer text {
            fill: currentColor;
            stroke: currentColor;
        }
        #controls {
            width: 250px; height: 100%; overflow-y: auto;
            background-color: var(--vscode-sideBar-background);
            padding: 10px; box-sizing: border-box; display: flex; flex-direction: column;
            border-right: 1px solid var(--vscode-sideBar-border);
        }
        .layer-toggle { display: flex; align-items: center; margin-bottom: 5px; white-space: nowrap; }
        .layer-toggle input[type="checkbox"] { margin-right: 5px; }
        .layer-toggle input[type="color"] { margin-left: auto; width: 30px; height: 20px; padding: 0; border: none; background: none;}
        .action-btn {
            padding: 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; cursor: pointer;
        }
        .action-btn:hover { background-color: var(--vscode-button-hoverBackground); }
        #layers-list { margin-top: 10px; flex-grow: 1; overflow-y: auto; }
        .control-group { margin-bottom: 15px; }
        .control-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        .tree-view {
            border: 1px solid var(--vscode-dropdown-border);
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            height: 300px;
            overflow-y: auto;
            padding: 5px;
            font-size: 12px;
        }
        .tree-item {
            margin-left: 12px;
        }
        .tree-content {
            display: flex;
            align-items: center;
            cursor: pointer;
            padding: 2px 0;
        }
        .tree-content:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .tree-content.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .tree-toggle {
            width: 16px;
            height: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 2px;
            user-select: none;
            cursor: pointer;
        }
        .tree-toggle.empty {
            visibility: hidden;
        }
        .tree-toggle::after {
            content: '▶';
            font-size: 8px;
            transition: transform 0.1s;
        }
        .tree-item.expanded > .tree-content > .tree-toggle::after {
            transform: rotate(90deg);
        }
        .tree-children {
            display: none;
        }
        .tree-item.expanded > .tree-children {
            display: block;
        }
        select, input[type="number"], input[type="text"] {
            width: 100%; padding: 5px;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            box-sizing: border-box;
        }
        #status-msg { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 5px; }
        #toggle-controls-btn {
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            z-index: 1000;
            width: 20px;
            height: 40px;
            background-color: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-sideBar-border);
            border-left: none;
            border-radius: 0 4px 4px 0;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            padding: 0;
        }
        #toggle-controls-btn:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        #config-panel {
            position: absolute;
            right: 0;
            top: 0;
            height: 100%;
            width: 250px;
            background-color: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-sideBar-border);
            padding: 10px;
            box-sizing: border-box;
            overflow-y: auto;
            z-index: 900;
            display: none;
        }
        #toggle-config-btn {
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            z-index: 1000;
            width: 20px;
            height: 40px;
            background-color: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-sideBar-border);
            border-right: none;
            border-radius: 4px 0 0 4px;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            padding: 0;
        }
        #toggle-config-btn:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        #toolbar {
            position: absolute;
            top: 20px;
            left: 20px; /* Initial position relative to view-container */
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            border-radius: 4px;
            padding: 4px;
            display: flex;
            flex-direction: row;
            gap: 4px;
            z-index: 1000;
            height: 40px;
            align-items: center;
            cursor: move;
        }
        .toolbar-btn {
            width: 32px;
            height: 32px;
            background-color: transparent;
            border: 1px solid transparent;
            border-radius: 4px;
            color: var(--vscode-icon-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }
        .toolbar-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar-btn:active {
            background-color: var(--vscode-toolbar-activeBackground);
        }
        .toolbar-btn svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
        }
        .toolbar-separator {
            width: 1px;
            height: 80%;
            background-color: var(--vscode-widget-border);
            margin: 0 2px;
        }
        #rot-angle-input-toolbar {
            width: 32px;
            padding: 2px;
            text-align: center;
            font-size: 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            margin-right: 2px;
        }
        .layer-toggle.dragging {
            opacity: 0.5;
            background-color: var(--vscode-list-dropBackground);
        }
        .layer-toggle.drag-over {
            border-top: 2px solid var(--vscode-focusBorder);
        }
        .layer-drop-dummy {
            height: 10px;
            margin-top: 5px;
            border-top: 2px solid transparent;
        }
        .layer-drop-dummy.drag-over {
            border-top: 2px solid var(--vscode-focusBorder);
        }
    </style>
</head>
<body>
    <div id="controls">
        <h3>Cell Control</h3>
        <div class="control-group">
            <label>Select Cell:</label>
            <div id="cell-tree" class="tree-view">Loading...</div>
            <div id="status-msg" style="font-size: 12px; color: #888; margin-top: 5px;">Initializing...</div>
        </div>
        <hr style="width: 100%; border-color: #444; margin: 15px 0;">
        <h3>Layer Control</h3>
        <div style="margin-top: 10px; display: flex; align-items: center;;">
            <div style="display: flex; align-items: center;">
                <input type="checkbox" id="show-labels-checkbox" style="margin-right: 4px;">
                <label for="show-labels-checkbox">Labels</label>
            </div>

            <div style="margin-left: auto; display: flex; align-items: center; gap: 5px;">
                <div style="display: flex; align-items: center;" title="Label Color">
                    <!-- Hidden actual input -->
                    <input type="color" id="label-color-picker" value="#ffffff" style="visibility: hidden; position: absolute; width: 0; height: 0;">

                    <!-- Reset button (hidden by default) -->
                    <div id="label-color-reset" style="display: none; margin-right: 4px; cursor: pointer; font-size: 14px;" title="Reset to layer colors">↺</div>

                    <!-- Custom trigger -->
                    <div id="label-color-trigger" style="width: 25px; height: 10px; border: 1px solid var(--vscode-input-border); cursor: pointer; background: linear-gradient(135deg, red, orange, yellow, green, blue, indigo, violet);" title="Click to set global color"></div>
                </div>

                <div style="display: flex; align-items: center;" title="Text Brightness">
                    <input type="range" min="0" max="1" step="0.1" value="0.5" id="label-brightness-slider" style="width: 50px;">
                </div>
            </div>
        </div>
        <div id="layers-list"></div>
    </div>
    <div id="view-container">
        <div id="toolbar" title="Drag to move">
            <!-- Center View -->
            <button id="recenter-btn" class="toolbar-btn" title="Center View">
                <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/><path d="M0 0h24v24H0z" fill="none"/><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
            </button>

            <div class="toolbar-separator"></div>

            <!-- Flip H -->
            <button id="flip-h-btn" class="toolbar-btn" title="Flip Horizontal">
                <svg viewBox="0 0 24 24"><path d="M15 21h2v-2h-2v2zm4-12h2V7h-2v2zM3 5v14c0 1.1.9 2 2 2h4v-2H5V5h4V3H5c-1.1 0-2 .9-2 2zm16-2v2h2c0-1.1-.9-2-2-2zm-8 20h2V1h-2v22zm8-6h2v-2h-2v2zM15 5h2V3h-2v2zm4 8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2z"/></svg>
            </button>
            <!-- Flip V -->
            <button id="flip-v-btn" class="toolbar-btn" title="Flip Vertical">
                <svg viewBox="0 0 24 24"><path d="M3 15v2h2v-2H3zm10 4h2v-2h-2v2zm2-16H5c-1.1 0-2 .9-2 2v4h2V5h14v4h2V5c0-1.1-.9-2-2-2zm2 16h2v-2h-2v2zM1 11v2h22v-2H1zm4 8h2v-2H5v2zm4 0h2v-2H9v2zm8 0h2v-2h-2v2z"/></svg>
            </button>

            <div class="toolbar-separator"></div>

            <!-- Rotation Input -->
            <input type="number" id="rot-angle-input" value="90" id="rot-angle-input-toolbar" style="width: 32px; padding: 2px; text-align: center; font-size: 10px; margin-right: 2px;" title="Rotation Angle">

            <!-- Rotate CW -->
            <button id="rot-cw-btn" class="toolbar-btn" title="Rotate CW">
                <svg viewBox="0 0 24 24"><path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z"/></svg>
            </button>
            <!-- Rotate CCW -->
            <button id="rot-ccw-btn" class="toolbar-btn" title="Rotate CCW">
                <svg viewBox="0 0 24 24"><path d="M8.45 5.55L13 1v3.07c3.94.49 7 3.85 7 7.93s-3.05 7.44-7 7.93v-2.02c2.84-.48 5-2.94 5-5.91s-2.16-5.43-5-5.91V10l-4.55-4.45zM4.07 11c.17-1.39.72-2.73 1.62-3.89l1.42 1.42c-.54.75-.88 1.6-1.02 2.47H4.07zm6.93 6.9v2.02c-1.39-.17-2.74-.71-3.9-1.61l1.44-1.44c.75.54 1.59.89 2.46 1.03zm-3.89-2.42l-1.42 1.41c-.9-1.16-1.45-2.5-1.62-3.89h2.02c.14.87.48 1.72 1.02 2.48z"/></svg>
            </button>

            <div class="toolbar-separator"></div>

            <!-- Negative View -->
            <button id="negative-view-btn" class="toolbar-btn" title="Toggle Negative View">
                <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z M8 8h8v8H8z" fill="currentColor" fill-rule="evenodd"/></svg>
            </button>
        </div>

        <button id="toggle-controls-btn" title="Toggle Sidebar">❮</button>
        <button id="toggle-config-btn" title="Toggle Configuration">⚙</button>

        <div id="config-panel">
            <h3>Configuration</h3>
            <div class="control-group">
                <label for="engine-select">Rendering Engine:</label>
                <select id="engine-select">
                    <option value="webgl">WebGL (GPU)</option>
                    <option value="canvas">Canvas (CPU)</option>
                    <option value="svg">SVG (Vector)</option>
                </select>
            </div>
            <div class="control-group">
                <label for="fast-mode-input">Fast Mode Threshold:</label>
                <input type="number" id="fast-mode-input" value="${fastModeThreshold}" min="1" step="1">
            </div>
            <div class="control-group">
                <label for="max-workers-input">Max Workers:</label>
                <input type="number" id="max-workers-input" value="${maxWorkersConfig}" min="-1" step="1" title="-1 for auto">
            </div>
            <div class="control-group">
                <label for="chunk-size-input">Chunk Size:</label>
                <input type="number" id="chunk-size-input" value="${chunkSize}" min="100" step="100">
            </div>
            <div class="control-group">
                <label for="font-size-input">Label Font Size:</label>
                <input type="number" id="font-size-input" value="${labelFontSize}" min="1" step="1">
            </div>
            <div class="control-group">
                <label for="python-path-input">Python Path:</label>
                <input type="text" id="python-path-input" value="${pythonPath}">
            </div>
        </div>

        <!-- Canvas for 'canvas' mode -->
        <canvas id="gds-canvas" style="display: none;"></canvas>
        <!-- WebGL Canvas -->
        <canvas id="gds-webgl-canvas" style="display: none;"></canvas>
        <!-- Text Overlay Canvas -->
        <canvas id="text-canvas" style="position: absolute; top: 0; left: 0; pointer-events: none;"></canvas>
        <!-- SVG container for 'svg' mode -->
        <div id="svg-container" style="display: none; width: 100%; height: 100%;"></div>
    </div>

    <script src="${svgPanZoomCdn}" onerror="console.error('Failed to load svg-pan-zoom')"></script>
    <script src="${earcutCdn}" onerror="console.error('Failed to load earcut')"></script>
    <script nonce="${nonce}">
        // vscode is already acquired in head script
        const vscode = window.vscode;

        console.log("GDS Preview: Main Script initialized");

        // Profiling
        const perfMetrics = {
            workerTime: 0,
            renderTime: 0,
            mainThreadParseTime: 0
        };

        // State
        let startTime = 0;
        let pendingTasks = 0;
        let pythonFinished = false;
        let geometry = {};
        let labels = {};
        let bbox = { x_min: 0, x_max: 0, y_min: 0, y_max: 0 };
        let activeLayers = new Set();
        let allLayers = [];
        let layerColors = {};
        let layerOpacities = {};
        let showLabels = false;
        let labelBrightness = 0.5;
        let globalLabelColor = null;
        let currentEngine = '${engine}';
        let fastModeThreshold = ${fastModeThreshold};
        let labelFontSize = ${labelFontSize};
        let enableProfiling = ${enableProfiling};
        let flipState = { x: 1, y: 1 };
        let rotationState = 0; // Degrees
        let expandedNodes = new Set(); // Persist tree expansion state
        let isViewFitted = false;
        let isNegative = false;
        let svgFragments = {};

        // WebGL State
        let gl = null;
        let glProgram = null;
        let layerBuffers = {}; // { layerKey: { vertexBuffer, vertexCount, colorLocation, matrixLocation } }
        let bboxBuffer = null;

        // Worker Pool for Triangulation
        const workerCode = \`
            try {
                importScripts('${earcutCdn}');
                // console.log("Worker: Earcut loaded successfully");
            } catch (e) {
                console.error("Worker: Failed to load earcut", e);
                self.postMessage({ type: 'log', message: "Worker failed to load earcut: " + e });
            }

            self.onmessage = function(e) {
                const t0 = performance.now();
                try {
                    let polygons;
                    if (e.data.isBinary) {
                        // Parse binary buffer
                        const buffer = e.data.buffer;
                        const dataView = new DataView(buffer);
                        let offset = 0;

                        // First 4 bytes is total polygons count
                        const totalPolys = dataView.getUint32(offset, true); // Little endian
                        offset += 4;

                        polygons = [];
                        for(let i=0; i<totalPolys; i++) {
                            const nPoints = dataView.getUint32(offset, true);
                            offset += 4;

                            // Create Float32Array view for points
                            // nPoints * 2 floats * 4 bytes
                            const byteLen = nPoints * 2 * 4;
                            const points = new Float32Array(buffer, offset, nPoints * 2);
                            polygons.push(points);
                            offset += byteLen;
                        }
                    } else if (e.data.isRaw) {
                        polygons = JSON.parse(e.data.polygonsString);
                    } else {
                        polygons = e.data.polygons;
                    }

                    const { id } = e.data;

                    if (e.data.returnPolygons) {
                        const t1 = performance.now();
                        // Return raw polygons (Float32Arrays)
                        // If binary, we can transfer the buffer back to save memory
                        const transfer = e.data.isBinary ? [e.data.buffer] : [];
                        self.postMessage({ id, polygons, duration: t1 - t0 }, transfer);
                        return;
                    }

                    if (!self.earcut) {
                        throw new Error("Earcut library not loaded");
                    }

                    const vertices = [];
                    let triCount = 0;
                    for (const flat of polygons) {
                        // Polygons are already flat [x,y,x,y...] from Python
                        const triangles = earcut(flat);
                        triCount += triangles.length / 3;
                        for (let i = 0; i < triangles.length; i++) {
                            const index = triangles[i];
                            vertices.push(flat[index * 2], flat[index * 2 + 1]);
                        }
                    }

                    const floatArray = new Float32Array(vertices);
                    const t1 = performance.now();
                    self.postMessage({ id, vertices: floatArray, duration: t1 - t0, triCount }, [floatArray.buffer]);
                } catch (err) {
                    console.error("Worker processing error:", err);
                    self.postMessage({ type: 'error', id: e.data.id, error: err.toString() });
                }
            };
        \`;

        const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);
        const workerPool = [];

        let maxWorkers = ${maxWorkersConfig};
        if (maxWorkers === -1) {
            maxWorkers = navigator.hardwareConcurrency || 4;
        }

        let workerRoundRobin = 0;

        console.log(\`Initializing worker pool with \${maxWorkers} workers\`);

        for (let i = 0; i < maxWorkers; i++) {
            const worker = new Worker(workerUrl);
            worker.onmessage = (e) => handleWorkerMessage(e, i);
            worker.onerror = (e) => {
                console.error(\`Worker \${i} error:\`, e);
                updateStatus(\`Worker error: \${e.message}\`);
            };
            workerPool.push(worker);
        }

        function handleWorkerMessage(e, workerIndex) {
            if (e.data.type === 'log') {
                // console.log(\`Worker \${workerIndex} Log:\`, e.data.message);
                return;
            }
            if (e.data.type === 'error') {
                console.error(\`Worker \${workerIndex} Error:\`, e.data.error);
                updateStatus(\`Worker \${workerIndex} error: \${e.data.error}\`);
                return;
            }

            const { id, vertices, polygons, duration } = e.data;
            if (duration) perfMetrics.workerTime += duration;

            // id is { layerKey, chunkIndex }
            const layerKey = id.layerKey;

            if (polygons && currentEngine === 'canvas') {
                if (!geometry[layerKey]) geometry[layerKey] = [];

                // Pre-calculate bbox for flat polygons
                for (const poly of polygons) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    // poly is Float32Array [x, y, x, y...]
                    for (let i = 0; i < poly.length; i += 2) {
                        const x = poly[i];
                        const y = poly[i+1];
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                    poly.bbox = { minX, minY, maxX, maxY };
                }
                geometry[layerKey].push(...polygons);
                requestAnimationFrame(draw);
            } else if (vertices && vertices.length > 0 && gl) {
                const buffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

                if (!layerBuffers[layerKey]) layerBuffers[layerKey] = [];

                layerBuffers[layerKey].push({
                    buffer: buffer,
                    count: vertices.length / 2
                });

                requestAnimationFrame(drawWebGL);
            }

            // updateStatus(\`Processed chunk for \${layerKey}\`);
            pendingTasks--;
            checkCompletion();
        }

        // Palette
        const palette = [
            "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
            "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
            "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000",
            "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080"
        ];

        // View state (Canvas)
        let scale = 1;
        let offsetX = 0;
        let offsetY = 0;
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;
        let panZoomInstance = null;

        // Interaction state for dynamic LOD
        let isInteracting = false;
        let interactionTimeout = null;

        // Elements
        const canvas = document.getElementById('gds-canvas');
        const scratchCanvas = document.createElement('canvas');
        const scratchCtx = scratchCanvas.getContext('2d');
        const svgContainer = document.getElementById('svg-container');
        const ctx = canvas.getContext('2d');
        const controls = document.getElementById('controls');
        const recenterBtn = document.getElementById('recenter-btn');
        const flipHBtn = document.getElementById('flip-h-btn');
        const flipVBtn = document.getElementById('flip-v-btn');
        const rotCWBtn = document.getElementById('rot-cw-btn');
        const rotCCWBtn = document.getElementById('rot-ccw-btn');
        const rotAngleInput = document.getElementById('rot-angle-input');
        const cellTree = document.getElementById('cell-tree');
        const statusMsg = document.getElementById('status-msg');
        const layersList = document.getElementById('layers-list');
        const toggleControlsBtn = document.getElementById('toggle-controls-btn');
        const toggleConfigBtn = document.getElementById('toggle-config-btn');
        const configPanel = document.getElementById('config-panel');

        // Config Elements
        const engineSelect = document.getElementById('engine-select');
        const fastModeInput = document.getElementById('fast-mode-input');
        const maxWorkersInput = document.getElementById('max-workers-input');
        const chunkSizeInput = document.getElementById('chunk-size-input');
        const fontSizeInput = document.getElementById('font-size-input');
        const minZoomInput = document.getElementById('min-zoom-input');
        const pythonPathInput = document.getElementById('python-path-input');

        // Initialize Engine Select
        if (engineSelect) {
            engineSelect.value = currentEngine;
            engineSelect.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'renderingEngine',
                    value: e.target.value
                });
            });
        }

        if (fastModeInput) {
            fastModeInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'fastModeThreshold',
                    value: parseFloat(e.target.value)
                });
            });
        }

        if (maxWorkersInput) {
            maxWorkersInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'maxWorkers',
                    value: parseInt(e.target.value)
                });
            });
        }

        if (chunkSizeInput) {
            chunkSizeInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'chunkSize',
                    value: parseInt(e.target.value)
                });
            });
        }

        if (fontSizeInput) {
            fontSizeInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'labelFontSize',
                    value: parseFloat(e.target.value)
                });
            });
        }

        if (pythonPathInput) {
            pythonPathInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'pythonPath',
                    value: e.target.value
                });
            });
        }

        function updateStatus(msg) {
            if (statusMsg) statusMsg.textContent = msg;
            console.log("Status:", msg);
        }

        function checkCompletion() {
            if (pythonFinished && pendingTasks === 0) {
                const elapsed = (performance.now() - startTime).toFixed(0);
                updateStatus(\`Loaded successfully in \${elapsed}ms\`);
                if (enableProfiling) {
                    console.log("PROFILE: Total Load Time:", elapsed, "ms");
                    console.log("PROFILE: Total Worker Time (Cumulative):", perfMetrics.workerTime.toFixed(0), "ms");
                    console.log("PROFILE: Main Thread Parse Time:", perfMetrics.mainThreadParseTime.toFixed(0), "ms");
                }
            }
        }

        function onInteraction() {
            if (!isInteracting) {
                isInteracting = true;
                // Redraw immediately to switch to low-quality mode
                // requestAnimationFrame(draw);
            }

            if (interactionTimeout) {
                clearTimeout(interactionTimeout);
            }

            interactionTimeout = setTimeout(() => {
                isInteracting = false;
                requestAnimationFrame(draw); // Redraw in high quality
            }, 300);
        }

        window.addEventListener('message', event => {
            const message = event.data;

            const handleEngineChange = (newEngine) => {
                if (currentEngine === 'svg' && newEngine !== 'svg') {
                    flipState.y *= -1;
                }
                currentEngine = newEngine;
            };

            if (message.command === 'updateData') {
                handleEngineChange(message.engine);
                handleDataUpdate(message.data);
            } else if (message.command === 'initialize') {
                handleEngineChange(message.engine);
                handleInitialize(message.data);
            } else if (message.command === 'addLayerChunk') {
                // console.log("Received layer chunk", message.layerKey);
                handleAddLayerChunk(message.layerKey, message.data);
            } else if (message.command === 'addLayerChunkB64') {
                handleAddLayerChunkB64(message.layerKey, message.chunkIndex, message.totalChunks, message.data);
            } else if (message.command === 'updateSettings') {
                if (message.fastModeThreshold !== undefined) {
                    fastModeThreshold = message.fastModeThreshold;
                    if (fastModeInput) fastModeInput.value = fastModeThreshold;
                    console.log("Updated fastModeThreshold to:", fastModeThreshold);
                }
                if (message.labelFontSize !== undefined) {
                    labelFontSize = message.labelFontSize;
                    if (fontSizeInput) fontSizeInput.value = labelFontSize;
                    console.log("Updated labelFontSize to:", labelFontSize);
                    requestAnimationFrame(drawLabels);
                }
            } else if (message.command === 'status') {
                updateStatus(message.message);
                if (message.message === 'Loaded successfully') {
                    pythonFinished = true;
                    checkCompletion();
                }
                    if (message.message === 'Loaded successfully' && currentEngine === 'svg') {
                    // Apply initial transform for SVG mode to fix orientation
                    flipState.y *= -1;
                    updateTransform();
                }
            } else if (message.command === 'reset') {
                flipState = { x: 1, y: 1 };
                rotationState = 0;
                updateTransform();
                // Reset toolbar position
                const toolbar = document.getElementById('toolbar');
                if (toolbar) {
                    toolbar.style.top = '20px';
                    toolbar.style.left = '20px';
                }

                // Reset Negative View
                isNegative = false;
                const negBtn = document.getElementById('negative-view-btn');
                if (negBtn) {
                    negBtn.style.backgroundColor = '';
                }

                requestAnimationFrame(drawLabels);
                if (currentEngine === 'canvas') requestAnimationFrame(draw);

                vscode.postMessage({ command: 'reset' });
            } else if (message.command === 'stop') {
                vscode.postMessage({ command: 'stop' });
            }
        });

        function selectCell(cellName) {
            vscode.postMessage({
                command: 'changeCell',
                cellName: cellName
            });
        }

        function buildTree(hierarchy, topLevelCells, allCells, currentCellName) {
            cellTree.innerHTML = '';

            // Fallback to flat list if no hierarchy
            if (!hierarchy || !topLevelCells || topLevelCells.length === 0) {
                allCells.forEach(cell => {
                    const item = document.createElement('div');
                    item.className = 'tree-content';
                    item.style.paddingLeft = '5px';
                    if (cell === currentCellName) item.classList.add('selected');
                    item.textContent = cell;
                    item.onclick = () => selectCell(cell);
                    cellTree.appendChild(item);
                });
                return;
            }

            // Pre-process roots to hide $$$ nodes and TEXT* nodes
            const validCellSet = new Set(allCells);
            let effectiveRoots = [];
            const processRoots = (roots) => {
                roots.forEach(root => {
                    if (root.startsWith('$$$') || root.startsWith('TEXT')) {
                        const children = hierarchy[root] || [];
                        processRoots(children);
                    } else {
                        if (validCellSet.has(root)) {
                            effectiveRoots.push(root);
                        }
                    }
                });
            };
            processRoots(topLevelCells);
            // Deduplicate and sort
            effectiveRoots = [...new Set(effectiveRoots)].sort();

            function createNode(cellName, visited) {
                const item = document.createElement('div');
                item.className = 'tree-item';

                // Restore expansion state
                if (expandedNodes.has(cellName)) {
                    item.classList.add('expanded');
                }

                const content = document.createElement('div');
                content.className = 'tree-content';
                if (cellName === currentCellName) content.classList.add('selected');

                const children = hierarchy[cellName] || [];
                const validChildren = children.filter(c => validCellSet.has(c));
                const hasChildren = validChildren.length > 0;

                const toggle = document.createElement('span');
                toggle.className = 'tree-toggle' + (hasChildren ? '' : ' empty');
                content.appendChild(toggle);

                const label = document.createElement('span');
                label.className = 'tree-label';
                label.textContent = cellName;
                content.appendChild(label);

                label.onclick = (e) => {
                    e.stopPropagation();
                    selectCell(cellName);
                };

                if (hasChildren) {
                    toggle.onclick = (e) => {
                        e.stopPropagation();
                        item.classList.toggle('expanded');
                        if (item.classList.contains('expanded')) {
                            expandedNodes.add(cellName);
                        } else {
                            expandedNodes.delete(cellName);
                        }
                    };
                }

                item.appendChild(content);

                if (hasChildren) {
                    const childrenContainer = document.createElement('div');
                    childrenContainer.className = 'tree-children';

                    if (!visited.has(cellName)) {
                        const newVisited = new Set(visited);
                        newVisited.add(cellName);
                        validChildren.forEach(childName => {
                            childrenContainer.appendChild(createNode(childName, newVisited));
                        });
                    } else {
                        const recursiveMsg = document.createElement('div');
                        recursiveMsg.textContent = '<recursive>';
                        recursiveMsg.style.paddingLeft = '20px';
                        recursiveMsg.style.color = '#888';
                        childrenContainer.appendChild(recursiveMsg);
                    }
                    item.appendChild(childrenContainer);
                }

                return item;
            }

            effectiveRoots.forEach(cellName => {
                cellTree.appendChild(createNode(cellName, new Set()));
            });
        }

        let dragSrcEl = null;

        function handleDragStart(e) {
            // Prevent dragging if interacting with inputs (checkbox, color, slider)
            if (e.target.tagName === 'INPUT') {
                e.preventDefault();
                return;
            }

            dragSrcEl = this;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this.getAttribute('data-layer-id'));
            this.classList.add('dragging');
        }

        function handleDragEnd(e) {
            this.classList.remove('dragging');
            const list = document.getElementById('layers-list');
            if (list) {
                list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            }
        }

        function handleDragOver(e) {
            if (e.preventDefault) {
                e.preventDefault();
            }
            e.dataTransfer.dropEffect = 'move';
            this.classList.add('drag-over');
            return false;
        }

        function handleDragEnter(e) {
            this.classList.add('drag-over');
        }

        function handleDragLeave(e) {
            this.classList.remove('drag-over');
        }

        function handleDrop(e) {
            if (e.stopPropagation) {
                e.stopPropagation();
            }
            // Cleanup is handled in dragend, but we can remove drag-over from target immediately
            this.classList.remove('drag-over');

            if (dragSrcEl !== this) {
                const list = document.getElementById('layers-list');
                // Insert before the drop target
                list.insertBefore(dragSrcEl, this);

                // Update allLayers order based on DOM
                const newOrder = [];
                list.querySelectorAll('.layer-toggle').forEach(el => {
                    const input = el.querySelector('input[type="checkbox"]');
                    if (input) {
                        newOrder.push(input.getAttribute('data-layer-id'));
                    }
                });
                allLayers = newOrder;

                // Trigger redraw
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') drawWebGL();
                else if (currentEngine === 'svg') {
                     const group = document.getElementById('gds-user-transform-group');
                     if (group) {
                         // We want renderOrder = [...allLayers].reverse()
                         // So the last element in allLayers should be the last element in DOM (topmost)
                         const renderOrder = [...allLayers].reverse();
                         renderOrder.forEach(layerKey => {
                             const layerGroup = document.getElementById('layer-group-' + layerKey);
                             if (layerGroup) {
                                 group.appendChild(layerGroup); // Moves it to the end
                             }
                         });
                     }
                }
                requestAnimationFrame(drawLabels);
            }
            return false;
        }

        function handleInitialize(data) {
            startTime = performance.now();
            pendingTasks = 0;
            pythonFinished = false;
            isViewFitted = false;
            updateStatus("Initializing...");

            // Reset state
            geometry = {};
            labels = {};
            bbox = data.bbox;
            activeLayers.clear();
            layerColors = {};
            layerOpacities = {};
            layerBuffers = {}; // Clear WebGL buffers

            // Clear worker queue/state if needed?
            // Workers are stateless in our design, they just process what they get.

            // Update Cell Tree
            buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

            // Sort layers for consistent display and rendering
            allLayers = data.layers;

            // Update Layers UI
            layersList.innerHTML = '';
            allLayers.forEach(layerKey => {
                activeLayers.add(layerKey);

                // Determine color
                let color = "#888888";
                const parts = layerKey.split('_');
                if (parts.length >= 1) {
                    const layerNum = parseInt(parts[0]);
                    if (!isNaN(layerNum)) {
                        color = palette[layerNum % palette.length];
                    } else {
                        let hash = 0;
                        for (let i = 0; i < layerKey.length; i++) {
                            hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                        }
                        color = palette[Math.abs(hash) % palette.length];
                    }
                }
                layerColors[layerKey] = color;
                layerOpacities[layerKey] = 0.8;

                // Create UI
                const div = document.createElement('div');
                div.className = 'layer-toggle';
                div.setAttribute('draggable', 'true');
                div.addEventListener('dragstart', handleDragStart, false);
                div.addEventListener('dragend', handleDragEnd, false);
                div.addEventListener('dragenter', handleDragEnter, false);
                div.addEventListener('dragover', handleDragOver, false);
                div.addEventListener('dragleave', handleDragLeave, false);
                div.addEventListener('drop', handleDrop, false);

                div.innerHTML = \`
                    <input type="checkbox" id="toggle-\${layerKey}" data-layer-id="\${layerKey}" checked>
                    <label for="toggle-\${layerKey}">Layer \${layerKey.replace('_', ' / ')}</label>
                    <input type="color" id="color-\${layerKey}" data-layer-id="\${layerKey}" value="\${color}">
                    <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="\${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
                \`;

                // Prevent drag when interacting with inputs
                div.querySelectorAll('input').forEach(input => {
                    input.addEventListener('mousedown', (e) => {
                        e.stopPropagation(); // Stop drag start
                        div.setAttribute('draggable', 'false');
                    });
                    input.addEventListener('mouseup', () => {
                        div.setAttribute('draggable', 'true');
                    });
                    input.addEventListener('mouseleave', () => {
                        div.setAttribute('draggable', 'true');
                    });
                    input.addEventListener('click', (e) => {
                        e.stopPropagation();
                    });
                });

                layersList.appendChild(div);
            });

            // Add dummy drop target at the end
            const dummy = document.createElement('div');
            dummy.className = 'layer-drop-dummy';
            dummy.addEventListener('dragenter', handleDragEnter, false);
            dummy.addEventListener('dragover', handleDragOver, false);
            dummy.addEventListener('dragleave', handleDragLeave, false);
            dummy.addEventListener('drop', handleDrop, false);
            layersList.appendChild(dummy);

            // Reset View
            if (currentEngine === 'canvas') {
                canvas.style.display = 'block';
                document.getElementById('gds-webgl-canvas').style.display = 'none';
                svgContainer.style.display = 'none';
                svgContainer.innerHTML = '';
                resizeCanvas();
                fitView();
            } else if (currentEngine === 'webgl') {
                setupWebGLMode({ geometry: {}, bbox: data.bbox, layers: [] });
            } else if (currentEngine === 'svg') {
                // Ensure svgFragments is populated from data if available
                if (data.svg_fragments) {
                    svgFragments = data.svg_fragments;
                }
                setupSvgMode(data);
                updateTransform();

                // Handle Labels for SVG mode (from separate JSON list)
                if (data.labels && data.labels.length > 0) {
                    data.labels.forEach(l => {
                        if (!labels[l.layerKey]) labels[l.layerKey] = [];
                        labels[l.layerKey].push(l);
                    });
                    requestAnimationFrame(drawLabels);
                }
            }

            updateStatus("Loading layers...");
        }

        function handleAddLayerChunkB64(layerKey, chunkIndex, totalChunks, b64Data) {
            // console.log("Received B64 chunk for", layerKey, "size:", b64Data.length);
            pendingTasks++;

            // Decode Base64 to ArrayBuffer
            const binaryString = window.atob(b64Data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const buffer = bytes.buffer;

            // Dispatch to worker
            const worker = workerPool[workerRoundRobin];
            workerRoundRobin = (workerRoundRobin + 1) % workerPool.length;

            worker.postMessage({
                id: { layerKey, chunkIndex },
                buffer: buffer,
                isBinary: true,
                returnPolygons: currentEngine === 'canvas'
            }, [buffer]); // Transfer buffer ownership

            updateStatus(\`Loading \${layerKey} (\${chunkIndex + 1}/\${totalChunks || '?'})\`);
        }

        function handleAddLayerChunk(layerKey, data) {
            const polys = data.polygons;

            // 1. Handle Geometry Storage (Canvas Mode Only)
            if (currentEngine === 'canvas') {
                if (polys && polys.length > 0) {
                    if (!geometry[layerKey]) geometry[layerKey] = [];

                    // Pre-calculate bbox
                    for (const poly of polys) {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        for (const p of poly) {
                            if (p[0] < minX) minX = p[0];
                            if (p[0] > maxX) maxX = p[0];
                            if (p[1] < minY) minY = p[1];
                            if (p[1] > maxY) maxY = p[1];
                        }
                        poly.bbox = { minX, minY, maxX, maxY };
                    }
                    geometry[layerKey].push(...polys);
                }
            }

            // 2. Handle Labels (Both Modes)
            if (data.labels && data.labels.length > 0) {
                if (!labels[layerKey]) labels[layerKey] = [];
                labels[layerKey].push(...data.labels);
            }

            // 3. Handle WebGL Buffers (WebGL Mode Only)
            // CRITICAL: We process and DISCARD the polygons immediately to save memory
            if (currentEngine === 'webgl' && polys && polys.length > 0) {
                // Dispatch to worker
                const worker = workerPool[workerRoundRobin];
                workerRoundRobin = (workerRoundRobin + 1) % workerPool.length;

                worker.postMessage({
                    id: { layerKey, chunkIndex: data.chunkIndex },
                    polygons: polys
                });
            }

            if (data.chunkIndex !== undefined) {
                updateStatus(\`Loading \${layerKey} (\${data.chunkIndex + 1}/\${data.totalChunks || '?'})\`);
            } else {
                updateStatus(\`Loading \${layerKey} (Labels)\`);
            }

            // Redraw
            if (currentEngine === 'canvas') requestAnimationFrame(draw);
            // WebGL redraw is triggered by worker callback
            requestAnimationFrame(drawLabels);
        }

        function handleDataUpdate(data) {
            updateStatus("Rendering...");

            // Update Cell Tree
            buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

            // Update Layers UI
            layersList.innerHTML = '';
            activeLayers.clear();
            layerColors = {};
            layerOpacities = {};

            allLayers = data.layers;
            if (data.svg_fragments) {
                svgFragments = data.svg_fragments;
            } else {
                svgFragments = {};
            }

            allLayers.forEach(layerKey => {
                activeLayers.add(layerKey);

                // Determine color
                let color = "#888888";
                const parts = layerKey.split('_');
                if (parts.length >= 1) {
                    const layerNum = parseInt(parts[0]);
                    if (!isNaN(layerNum)) {
                        color = palette[layerNum % palette.length];
                    } else {
                        let hash = 0;
                        for (let i = 0; i < layerKey.length; i++) {
                            hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                        }
                        color = palette[Math.abs(hash) % palette.length];
                    }
                }
                layerColors[layerKey] = color;
                layerOpacities[layerKey] = 0.8;

                // Create UI
                const div = document.createElement('div');
                div.className = 'layer-toggle';
                div.setAttribute('draggable', 'true');
                div.addEventListener('dragstart', handleDragStart, false);
                div.addEventListener('dragend', handleDragEnd, false);
                div.addEventListener('dragenter', handleDragEnter, false);
                div.addEventListener('dragover', handleDragOver, false);
                div.addEventListener('dragleave', handleDragLeave, false);
                div.addEventListener('drop', handleDrop, false);

                div.innerHTML = \`
                    <input type="checkbox" id="toggle-\${layerKey}" data-layer-id="\${layerKey}" checked>
                    <label for="toggle-\${layerKey}">Layer \${layerKey.replace('_', ' / ')}</label>
                    <input type="color" id="color-\${layerKey}" data-layer-id="\${layerKey}" value="\${color}">
                    <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="\${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
                \`;

                // Prevent drag when interacting with inputs
                div.querySelectorAll('input').forEach(input => {
                    input.addEventListener('mousedown', (e) => {
                        e.stopPropagation(); // Stop drag start
                        div.setAttribute('draggable', 'false');
                    });
                    input.addEventListener('mouseup', () => {
                        div.setAttribute('draggable', 'true');
                    });
                    input.addEventListener('mouseleave', () => {
                        div.setAttribute('draggable', 'true');
                    });
                    input.addEventListener('click', (e) => {
                        e.stopPropagation();
                    });
                });

                layersList.appendChild(div);
            });

            // Add dummy drop target at the end
            const dummy = document.createElement('div');
            dummy.className = 'layer-drop-dummy';
            dummy.addEventListener('dragenter', handleDragEnter, false);
            dummy.addEventListener('dragover', handleDragOver, false);
            dummy.addEventListener('dragleave', handleDragLeave, false);
            dummy.addEventListener('drop', handleDrop, false);
            layersList.appendChild(dummy);

            if (currentEngine === 'canvas') {
                setupCanvasMode(data);
            } else if (currentEngine === 'webgl') {
                setupWebGLMode(data);
            } else {
                setupSvgMode(data);
                updateTransform();
            }

            updateStatus("Ready");
        }

        function setupCanvasMode(data) {
            canvas.style.display = 'block';
            document.getElementById('gds-webgl-canvas').style.display = 'none';
            svgContainer.style.display = 'none';
            svgContainer.innerHTML = ''; // Clear SVG memory

            geometry = data.geometry;
            bbox = data.bbox;

            // Pre-calculate bounding boxes for culling
            for (const layerKey in geometry) {
                const polys = geometry[layerKey];
                for (const poly of polys) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    for (const p of poly) {
                        if (p[0] < minX) minX = p[0];
                        if (p[0] > maxX) maxX = p[0];
                        if (p[1] < minY) minY = p[1];
                        if (p[1] > maxY) maxY = p[1];
                    }
                    poly.bbox = { minX, minY, maxX, maxY };
                }
            }

            resizeCanvas();
            fitView();
        }

        function setupSvgMode(data) {
            canvas.style.display = 'none';
            const glCanvas = document.getElementById('gds-webgl-canvas');
            if (glCanvas) {
                glCanvas.style.display = 'none';
            }
            // Clear text canvas when switching to SVG
            const textCanvas = document.getElementById('text-canvas');
            if (textCanvas) {
                const ctx = textCanvas.getContext('2d');
                ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
            }
            // Ensure text canvas is sized correctly
            resizeCanvas();
            svgContainer.style.display = 'block';

            bbox = data.bbox; // Update global bbox for transform calculations

            const bboxWidth = data.bbox.x_max - data.bbox.x_min;
            const bboxHeight = data.bbox.y_max - data.bbox.y_min;
            // GDS is Y-up, SVG is Y-down.
            // We use a nested group structure:
            // SVG -> Viewport (controlled by pan-zoom) -> FlipGroup (controlled by us) -> Layers
            const viewBoxString = \`\${data.bbox.x_min} \${-data.bbox.y_max} \${bboxWidth} \${bboxHeight}\`;

            let svgContent = \`<svg id="root-svg-for-panzoom" viewBox="\${viewBoxString}" width="100%" height="100%">\`;

            // 1. Viewport Group (for svg-pan-zoom)
            svgContent += \`<g id="svg-pan-zoom-viewport">\`;

            // 2. Base Flip Group (scale 1, -1) to match GDS Y-up to SVG Y-down
            svgContent += \`<g id="gds-base-flip-group" transform="scale(1, -1)">\`;

            // 3. User Transform Group (Rotation, User Flip)
            // Initial transform will be set by updateTransform, but we default to identity here
            svgContent += \`<g id="gds-user-transform-group">\`;

            // Render in reverse dictionary order (Z -> A) so A is last in DOM (on top)
            const renderOrder = [...allLayers].reverse();

            for (const layerKey of renderOrder) {
                const fragment = svgFragments[layerKey] || "";
                const opacity = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;
                const color = layerColors[layerKey] || '#888888';

                // In Negative Mode (backend generated), the fragment IS the negative geometry (holes punched).
                // So we just render it normally.
                svgContent += \`<g id="layer-group-\${layerKey}" class="gds-layer" style="color: \${color}; opacity: \${opacity}; display: inline;">
                    \${fragment}
                </g>\`;
            }
            svgContent += \`</g>\`; // Close user transform group
            svgContent += \`</g>\`; // Close base flip group
            svgContent += \`</g>\`; // Close viewport group
            svgContent += '</svg>';

            svgContainer.innerHTML = svgContent;

            // Initialize pan-zoom
            if (panZoomInstance) {
                panZoomInstance.destroy();
            }
            panZoomInstance = svgPanZoom('#root-svg-for-panzoom', {
                viewportSelector: '#svg-pan-zoom-viewport',
                panEnabled: true,
                zoomEnabled: true,
                controlIconsEnabled: false,
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 100,
                onZoom: function(newZoom) {
                    const pan = this.getPan();
                    offsetX = pan.x;
                    offsetY = pan.y;
                    scale = newZoom;
                    requestAnimationFrame(drawLabels);
                },
                onPan: function(newPan) {
                    const pan = this.getPan();
                    offsetX = pan.x;
                    offsetY = pan.y;
                    scale = this.getSizes().realZoom;
                    requestAnimationFrame(drawLabels);
                }
            });
        }

        function setupWebGLMode(data) {
            canvas.style.display = 'none';
            svgContainer.style.display = 'none';
            const glCanvas = document.getElementById('gds-webgl-canvas');
            glCanvas.style.display = 'block';

            geometry = data.geometry;
            bbox = data.bbox;

            gl = glCanvas.getContext('webgl', { stencil: true });
            if (!gl) {
                updateStatus("WebGL not supported");
                return;
            }

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            // Shaders
            const vsSource = \`
                attribute vec2 a_position;
                uniform vec2 u_resolution;
                uniform vec2 u_offset;
                uniform float u_scale;
                uniform vec2 u_flip;
                uniform float u_rotation;

                void main() {
                    // Apply User Rotation (First)
                    float c = cos(u_rotation);
                    float s = sin(u_rotation);
                    vec2 rotated = vec2(a_position.x * c - a_position.y * s, a_position.x * s + a_position.y * c);

                    // Apply User Flip (Second)
                    vec2 flipped = rotated * u_flip;

                    // Apply Base Transform (Scale + Y-Flip + Offset)
                    // Note: u_scale is uniform scale. Base Y-flip is vec2(1, -1).
                    vec2 position = (flipped * vec2(1, -1) * u_scale) + u_offset;

                    // Convert from pixels to 0.0->1.0
                    vec2 zeroToOne = position / u_resolution;

                    // Convert from 0->1 to 0->2
                    vec2 zeroToTwo = zeroToOne * 2.0;

                    // Convert from 0->2 to -1->+1 (clipspace)
                    vec2 clipSpace = zeroToTwo - 1.0;

                    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
                }
            \`;

            const fsSource = \`
                precision mediump float;
                uniform vec4 u_color;
                void main() {
                    gl_FragColor = u_color;
                }
            \`;

            const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
            const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
            glProgram = createProgram(gl, vertexShader, fragmentShader);

            // Process Geometry
            // Note: In streaming mode, geometry might be empty if we are in WebGL mode
            // because we discard it to save memory.
            // But if we switch FROM Canvas TO WebGL, we need to process existing geometry.
            layerBuffers = {};

            // Create BBox Buffer for Negative View
            if (bbox) {
                const bboxVertices = [
                    bbox.x_min, bbox.y_min,
                    bbox.x_max, bbox.y_min,
                    bbox.x_min, bbox.y_max,
                    bbox.x_min, bbox.y_max,
                    bbox.x_max, bbox.y_min,
                    bbox.x_max, bbox.y_max
                ];
                bboxBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bboxVertices), gl.STATIC_DRAW);
            }

            for (const layerKey in geometry) {
                const polys = geometry[layerKey];
                if (!polys) continue;

                const vertices = [];

                for (const poly of polys) {
                    // Flatten polygon for earcut
                    const flat = [];
                    for (const p of poly) {
                        flat.push(p[0], p[1]);
                    }

                    // Triangulate
                    const triangles = earcut(flat);

                    // Add vertices
                    for (let i = 0; i < triangles.length; i++) {
                        const index = triangles[i];
                        vertices.push(flat[index * 2], flat[index * 2 + 1]);
                    }
                }

                if (vertices.length > 0) {
                    const buffer = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

                    if (!layerBuffers[layerKey]) layerBuffers[layerKey] = [];
                    layerBuffers[layerKey].push({
                        buffer: buffer,
                        count: vertices.length / 2
                    });
                }
            }

            resizeCanvas();
            fitView();
        }

        function createShader(gl, type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        function createProgram(gl, vertexShader, fragmentShader) {
            const program = gl.createProgram();
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.error(gl.getProgramInfoLog(program));
                gl.deleteProgram(program);
                return null;
            }
            return program;
        }

        function drawWebGL() {
            if (!gl || !glProgram) return;

            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
            gl.clearColor(0, 0, 0, 0); // Transparent background

            if (isNegative) {
                gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
                gl.enable(gl.STENCIL_TEST);
            } else {
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.disable(gl.STENCIL_TEST);
            }

            gl.useProgram(glProgram);

            const resolutionLocation = gl.getUniformLocation(glProgram, "u_resolution");
            const offsetLocation = gl.getUniformLocation(glProgram, "u_offset");
            const scaleLocation = gl.getUniformLocation(glProgram, "u_scale");
            const flipLocation = gl.getUniformLocation(glProgram, "u_flip");
            const rotationLocation = gl.getUniformLocation(glProgram, "u_rotation");
            const colorLocation = gl.getUniformLocation(glProgram, "u_color");
            const positionLocation = gl.getAttribLocation(glProgram, "a_position");

            gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
            gl.uniform2f(offsetLocation, offsetX, offsetY);
            gl.uniform1f(scaleLocation, scale);
            gl.uniform2f(flipLocation, flipState.x, flipState.y);
            gl.uniform1f(rotationLocation, rotationState * Math.PI / 180);

            gl.enableVertexAttribArray(positionLocation);

            // Render in reverse dictionary order (Z -> A) so A is drawn last (on top)
            const renderOrder = [...allLayers].reverse();

            for (const layerKey of renderOrder) {
                if (!activeLayers.has(layerKey)) continue;

                const buffers = layerBuffers[layerKey];
                // Support both single buffer (legacy/small files) and array of buffers (chunked)
                if (!buffers) continue;
                const bufferList = Array.isArray(buffers) ? buffers : [buffers];

                // Convert hex color to rgba
                const hex = layerColors[layerKey] || '#888888';
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                const a = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;

                if (isNegative) {
                    // Pass 1: Draw polygons to stencil buffer
                    gl.clear(gl.STENCIL_BUFFER_BIT);
                    gl.colorMask(false, false, false, false);
                    gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

                    for (const layerData of bufferList) {
                        gl.bindBuffer(gl.ARRAY_BUFFER, layerData.buffer);
                        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
                        gl.drawArrays(gl.TRIANGLES, 0, layerData.count);
                    }

                    // Pass 2: Draw BBox where stencil != 1
                    gl.colorMask(true, true, true, true);
                    gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF);
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

                    gl.uniform4f(colorLocation, r, g, b, a);

                    if (bboxBuffer) {
                        gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
                        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
                        gl.drawArrays(gl.TRIANGLES, 0, 6);
                    }

                } else {
                    gl.uniform4f(colorLocation, r, g, b, a);

                    for (const layerData of bufferList) {
                        gl.bindBuffer(gl.ARRAY_BUFFER, layerData.buffer);
                        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
                        gl.drawArrays(gl.TRIANGLES, 0, layerData.count);
                    }
                }
            }

            // Restore state
            if (isNegative) {
                gl.disable(gl.STENCIL_TEST);
            }
        }

        function resizeCanvas() {
            const container = document.getElementById('view-container');
            if (!container) return;
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;

            const glCanvas = document.getElementById('gds-webgl-canvas');
            if (glCanvas) {
                glCanvas.width = container.clientWidth;
                glCanvas.height = container.clientHeight;
                if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
            }

            const textCanvas = document.getElementById('text-canvas');
            if (textCanvas) {
                textCanvas.width = container.clientWidth;
                textCanvas.height = container.clientHeight;
            }

            if (!isViewFitted && (currentEngine === 'canvas' || currentEngine === 'webgl')) {
                fitView();
            } else {
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') {
                    const t0 = performance.now();
                    drawWebGL();
                    perfMetrics.renderTime += (performance.now() - t0);
                }
                drawLabels();
            }
        }

        function fitView() {
            if (currentEngine === 'svg') {
                if (panZoomInstance) {
                    panZoomInstance.fit();
                    panZoomInstance.center();
                    // Sync state for labels
                    const pan = panZoomInstance.getPan();
                    offsetX = pan.x;
                    offsetY = pan.y;
                    scale = panZoomInstance.getSizes().realZoom;
                    requestAnimationFrame(drawLabels);
                }
                return;
            }

            const width = bbox.x_max - bbox.x_min;
            const height = bbox.y_max - bbox.y_min;

            if (width === 0 || height === 0) {
                updateStatus("Empty bounding box");
                return;
            }

            const container = document.getElementById('view-container');
            if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
                return;
            }
            const canvasWidth = container.clientWidth;
            const canvasHeight = container.clientHeight;
            const padding = 20;

            const scaleX = (canvasWidth - 2 * padding) / width;
            const scaleY = (canvasHeight - 2 * padding) / height;
            scale = Math.min(scaleX, scaleY);

            const gcx = (bbox.x_min + bbox.x_max) / 2;
            const gcy = (bbox.y_min + bbox.y_max) / 2;

            offsetX = canvasWidth / 2 - gcx * scale;
            offsetY = canvasHeight / 2 + gcy * scale;

            isViewFitted = true;

            if (currentEngine === 'canvas') draw();
            else if (currentEngine === 'webgl') drawWebGL();

            drawLabels();
        }

        function drawLabels() {
            const textCanvas = document.getElementById('text-canvas');
            if (!textCanvas) return;
            const ctx = textCanvas.getContext('2d');
            ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);

            if (!showLabels) return;

            // Viewport culling for labels (in world coordinates)
            // Screen: 0,0 -> W,H
            // WorldX = (ScreenX - offsetX) / scale
            // WorldY = (ScreenY - offsetY) / -scale
            const viewMinX = (0 - offsetX) / scale;
            const viewMaxX = (textCanvas.width - offsetX) / scale;
            const viewMaxY = (0 - offsetY) / -scale;
            const viewMinY = (textCanvas.height - offsetY) / -scale;

            const vMinX = Math.min(viewMinX, viewMaxX);
            const vMaxX = Math.max(viewMinX, viewMaxX);
            const vMinY = Math.min(viewMinY, viewMaxY);
            const vMaxY = Math.max(viewMinY, viewMaxY);

            ctx.font = \`\${labelFontSize}px sans-serif\`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            // Helper to darken color
            const darken = (hex, factor) => {
                let r = parseInt(hex.slice(1, 3), 16);
                let g = parseInt(hex.slice(3, 5), 16);
                let b = parseInt(hex.slice(5, 7), 16);
                r = Math.floor(r * factor);
                g = Math.floor(g * factor);
                b = Math.floor(b * factor);
                return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
            };

            for (const layerKey in labels) {
                if (!activeLayers.has(layerKey)) continue;

                const layerLabels = labels[layerKey];

                if (globalLabelColor) {
                    ctx.fillStyle = darken(globalLabelColor, labelBrightness);
                } else {
                    const baseColor = layerColors[layerKey] || '#ffffff';
                    ctx.fillStyle = darken(baseColor, labelBrightness);
                }

                for (const label of layerLabels) {
                    // label: { text, x, y, ... }
                    const x = label.x;
                    const y = label.y;
                    const text = label.text;

                    // Project to screen coordinates manually
                    // World -> Rotation -> UserFlip -> BaseFlip -> Scale -> Offset

                    // 1. User Rotation
                    const rad = rotationState * Math.PI / 180;
                    const c = Math.cos(rad);
                    const s = Math.sin(rad);
                    const rx = x * c - y * s;
                    const ry = x * s + y * c;

                    // 2. User Flip
                    let wx = rx * flipState.x;
                    let wy = ry * flipState.y;

                    // 3. Base Flip (Y-up to Y-down) + Scale + Offset
                    // ScreenX = wx * scale + offsetX
                    // ScreenY = wy * -scale + offsetY
                    const screenX = wx * scale + offsetX;
                    const screenY = wy * -scale + offsetY;

                    ctx.fillText(text, screenX, screenY);
                }
            }
        }

        function draw() {
            if (currentEngine !== 'canvas') return;

            try {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.save();
                ctx.translate(offsetX, offsetY);
                ctx.scale(scale, -scale); // Base view transform

                // Apply user rotation and flip
                // Canvas transforms are applied in reverse order of code execution for the coordinate system
                // We want: Screen <- Pan <- Zoom <- BaseFlip <- Flip <- Rotation <- World
                // So code order: Pan, Zoom, BaseFlip, Flip, Rotation

                ctx.scale(flipState.x, flipState.y);
                ctx.rotate(rotationState * Math.PI / 180);

                // Viewport culling
                // Visible world bounds
                // Screen: 0,0 -> W,H
                // WorldX = (ScreenX - offsetX) / scale
                // WorldY = (ScreenY - offsetY) / -scale

                const viewMinX = (0 - offsetX) / scale;
                const viewMaxX = (canvas.width - offsetX) / scale;
                // Y is flipped. 0 is top (max world Y), H is bottom (min world Y)
                const viewMaxY = (0 - offsetY) / -scale;
                const viewMinY = (canvas.height - offsetY) / -scale;

                // Normalize min/max
                const vMinX = Math.min(viewMinX, viewMaxX);
                const vMaxX = Math.max(viewMinX, viewMaxX);
                const vMinY = Math.min(viewMinY, viewMaxY);
                const vMaxY = Math.max(viewMinY, viewMaxY);

                let polyCount = 0;
                let culledCount = 0;

                // Dynamic LOD threshold
                // If interacting, skip smaller items (e.g. < 10px)
                // If static, skip very small items (e.g. < 0.5px)
                const lodThreshold = isInteracting ? fastModeThreshold : 0.5;

                // Render in reverse dictionary order (Z -> A) so A is drawn last (on top)
                const renderOrder = [...allLayers].reverse();

                // Ensure scratch canvas size matches
                if (isNegative) {
                    if (scratchCanvas.width !== canvas.width || scratchCanvas.height !== canvas.height) {
                        scratchCanvas.width = canvas.width;
                        scratchCanvas.height = canvas.height;
                    }
                }

                for (const layerKey of renderOrder) {
                    if (!activeLayers.has(layerKey)) continue;

                    const polys = geometry[layerKey];
                    if (!polys) continue;

                    const layerColor = layerColors[layerKey] || '#888';
                    const layerOpacity = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;

                    let targetCtx = ctx;

                    if (isNegative) {
                        // Use scratch canvas for negative composition
                        targetCtx = scratchCtx;
                        targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
                        targetCtx.save();

                        // Apply same transform to scratch canvas
                        targetCtx.translate(offsetX, offsetY);
                        targetCtx.scale(scale, -scale);
                        targetCtx.scale(flipState.x, flipState.y);
                        targetCtx.rotate(rotationState * Math.PI / 180);

                        // Draw BBox (The "Sheet")
                        targetCtx.fillStyle = layerColor;
                        targetCtx.globalAlpha = layerOpacity;
                        targetCtx.beginPath();
                        targetCtx.rect(bbox.x_min, bbox.y_min, bbox.x_max - bbox.x_min, bbox.y_max - bbox.y_min);
                        targetCtx.fill();

                        // Prepare to punch holes
                        targetCtx.globalCompositeOperation = 'destination-out';
                        targetCtx.globalAlpha = 1.0; // Fully opaque eraser
                        targetCtx.fillStyle = '#000000'; // Color doesn't matter
                    } else {
                        ctx.fillStyle = layerColor;
                        ctx.strokeStyle = layerColor;
                    }

                    targetCtx.beginPath();
                    for (const poly of polys) {
                        // Culling check
                        if (poly.bbox) {
                            if (poly.bbox.maxX < vMinX || poly.bbox.minX > vMaxX ||
                                poly.bbox.maxY < vMinY || poly.bbox.minY > vMaxY) {
                                culledCount++;
                                continue;
                            }

                            // LOD check
                            const screenW = (poly.bbox.maxX - poly.bbox.minX) * scale;
                            const screenH = (poly.bbox.maxY - poly.bbox.minY) * scale;
                            if (screenW < lodThreshold && screenH < lodThreshold) {
                                culledCount++;
                                continue;
                            }
                        }

                        // Check if poly is Float32Array (flat) or Array of Arrays (legacy)
                        const isFlat = poly instanceof Float32Array;
                        const len = isFlat ? poly.length / 2 : poly.length;

                        if (len < 2) continue;

                        if (isFlat) {
                            targetCtx.moveTo(poly[0], poly[1]);
                            for (let i = 1; i < len; i++) {
                                targetCtx.lineTo(poly[i * 2], poly[i * 2 + 1]);
                            }
                        } else {
                            targetCtx.moveTo(poly[0][0], poly[0][1]);
                            for (let i = 1; i < poly.length; i++) {
                                targetCtx.lineTo(poly[i][0], poly[i][1]);
                            }
                        }
                        targetCtx.closePath();
                        polyCount++;
                    }

                    if (isNegative) {
                        targetCtx.fill(); // Punch holes
                        targetCtx.restore(); // Restore transform and composite op

                        // Draw result to main canvas
                        ctx.save();
                        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform to draw full screen image
                        ctx.drawImage(scratchCanvas, 0, 0);
                        ctx.restore();
                    } else {
                        ctx.globalAlpha = layerOpacity;
                        ctx.fill();
                    }
                }

                ctx.restore();

                // Debug overlay
                ctx.save();
                ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground');
                ctx.font = "12px sans-serif";
                ctx.fillText(\`Scale: \${scale.toExponential(2)} | Offset: \${offsetX.toFixed(0)}, \${offsetY.toFixed(0)}\`, 10, 20);
                ctx.fillText(\`Polygons: \${polyCount} (Culled: \${culledCount}) | Layers: \${activeLayers.size} | Mode: \${isInteracting ? 'Fast' : 'Quality'}\`, 10, 35);
            } catch (e) {
                console.error("Draw error:", e);
                updateStatus("Draw error: " + e.message);
            }
        }

        // Event Listeners
        window.addEventListener('resize', () => {
            if (currentEngine === 'canvas' || currentEngine === 'webgl') resizeCanvas();
            else if (panZoomInstance) {
                panZoomInstance.resize();
                panZoomInstance.fit();
                panZoomInstance.center();
            }
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'F2') {
                fitView();
            }
        });

        const viewContainer = document.getElementById('view-container');

        // Mouse interaction
        viewContainer.addEventListener('mousedown', e => {
            if (currentEngine !== 'canvas' && currentEngine !== 'webgl') return;
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            onInteraction();
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            onInteraction(); // Trigger one last update to potentially switch back to high quality
        });

        window.addEventListener('mousemove', e => {
            if (currentEngine !== 'canvas' && currentEngine !== 'webgl') return;
            if (isDragging) {
                onInteraction();
                const dx = e.clientX - lastX;
                const dy = e.clientY - lastY;
                lastX = e.clientX;
                lastY = e.clientY;
                offsetX += dx;
                offsetY += dy;
                if (currentEngine === 'canvas') requestAnimationFrame(draw);
                else requestAnimationFrame(drawWebGL);
                requestAnimationFrame(drawLabels);
            }
        });

        viewContainer.addEventListener('wheel', e => {
            if (currentEngine !== 'canvas' && currentEngine !== 'webgl') return;
            e.preventDefault();
            onInteraction();
            const zoomIntensity = 0.1;
            const delta = e.deltaY < 0 ? 1 : -1;
            const zoomFactor = Math.exp(delta * zoomIntensity);

            const rect = viewContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const worldX = (mouseX - offsetX) / scale;
            const worldY = (mouseY - offsetY) / -scale;

            scale *= zoomFactor;
            scale = Math.max(scale, 1e-5);

            offsetX = mouseX - worldX * scale;
            offsetY = mouseY - worldY * -scale;

            if (currentEngine === 'canvas') requestAnimationFrame(draw);
            else requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
        });

        controls.addEventListener('click', function(event) {
            const target = event.target;
            if (target.id === 'label-color-trigger') {
                document.getElementById('label-color-picker').click();
            }
            if (target.id === 'label-color-reset') {
                globalLabelColor = null;
                document.getElementById('label-color-trigger').style.background = 'linear-gradient(135deg, red, orange, yellow, green, blue, indigo, violet)';
                target.style.display = 'none';
                requestAnimationFrame(drawLabels);
            }
        });

        controls.addEventListener('change', function(event) {
            const target = event.target;
            if (target.id === 'cell-select') return;

            if (target.id === 'show-labels-checkbox') {
                showLabels = target.checked;
                requestAnimationFrame(drawLabels);
                return;
            }

            if (target.id === 'label-brightness-slider') {
                labelBrightness = parseFloat(target.value);
                requestAnimationFrame(drawLabels);
                return;
            }

            if (target.id === 'label-color-picker') {
                globalLabelColor = target.value;
                document.getElementById('label-color-trigger').style.background = globalLabelColor;
                document.getElementById('label-color-reset').style.display = 'inline-block';
                requestAnimationFrame(drawLabels);
                return;
            }

            if (target.id === 'label-color-picker') {
                globalLabelColor = target.value;
                requestAnimationFrame(drawLabels);
                return;
            }

            const layerId = target.getAttribute('data-layer-id');

            if (target.type === 'checkbox') {
                if (target.checked) {
                    activeLayers.add(layerId);
                } else {
                    activeLayers.delete(layerId);
                }
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                requestAnimationFrame(drawLabels);
                if (currentEngine === 'svg') {
                    const el = document.getElementById('layer-group-' + layerId);
                    if (el) el.style.display = target.checked ? 'block' : 'none';
                }
            } else if (target.type === 'color') {
                layerColors[layerId] = target.value;
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                requestAnimationFrame(drawLabels);
                if (currentEngine === 'svg') {
                    const el = document.getElementById('layer-group-' + layerId);
                    if (el) {
                        // Update color style for currentColor inheritance
                        el.style.color = target.value;
                        // Also update attributes for compatibility
                        el.setAttribute('fill', target.value);
                        el.setAttribute('stroke', target.value);
                    }
                }
            } else if (target.classList.contains('opacity-slider')) {
                layerOpacities[layerId] = parseFloat(target.value);
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                requestAnimationFrame(drawLabels);
                if (currentEngine === 'svg') {
                    const el = document.getElementById('layer-group-' + layerId);
                    if (el) el.style.opacity = target.value;
                }
            }
        });

        recenterBtn.addEventListener('click', fitView);

        const negativeViewBtn = document.getElementById('negative-view-btn');
        if (negativeViewBtn) {
            negativeViewBtn.addEventListener('click', () => {
                isNegative = !isNegative;
                if (isNegative) {
                    negativeViewBtn.style.backgroundColor = 'var(--vscode-toolbar-activeBackground)';
                } else {
                    negativeViewBtn.style.backgroundColor = '';
                }

                // Always sync state with extension host
                vscode.postMessage({
                    command: 'syncNegativeState',
                    isNegative: isNegative
                });

                if (currentEngine === 'canvas') requestAnimationFrame(draw);
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                else if (currentEngine === 'svg') {
                    // Trigger reload with negative flag
                    vscode.postMessage({
                        command: 'reloadNegative',
                        isNegative: isNegative
                    });
                }
            });
        }


        if (flipHBtn) {
            flipHBtn.addEventListener('click', () => {
                flipState.x *= -1;
                updateTransform();
            });
        }

        if (flipVBtn) {
            flipVBtn.addEventListener('click', () => {
                flipState.y *= -1;
                updateTransform();
            });
        }

        if (rotCWBtn && rotAngleInput) {
            rotCWBtn.addEventListener('click', () => {
                const angle = parseFloat(rotAngleInput.value) || 0;
                // If coordinate system is flipped (handedness changed), reverse rotation direction
                const dir = flipState.x * flipState.y;
                rotationState = (rotationState - (angle * dir)) % 360;
                updateTransform();
            });
        }

        if (rotCCWBtn && rotAngleInput) {
            rotCCWBtn.addEventListener('click', () => {
                const angle = parseFloat(rotAngleInput.value) || 0;
                // If coordinate system is flipped (handedness changed), reverse rotation direction
                const dir = flipState.x * flipState.y;
                rotationState = (rotationState + (angle * dir)) % 360;
                updateTransform();
            });
        }

        function updateTransform() {
            if (currentEngine === 'canvas') {
                draw();
            } else if (currentEngine === 'webgl') {
                drawWebGL();
            } else if (currentEngine === 'svg') {
                // Apply transform to the inner group
                const group = document.getElementById('gds-user-transform-group');
                if (group) {
                    group.setAttribute('transform', \`scale(\${flipState.x}, \${flipState.y}) rotate(\${rotationState})\`);
                }

                // Remove CSS transform from container if present (cleanup from previous logic)
                if (svgContainer) {
                    svgContainer.style.transform = '';
                }
            }
            requestAnimationFrame(drawLabels);
        }

        if (toggleControlsBtn) {
            toggleControlsBtn.addEventListener('click', () => {
                const isCollapsed = controls.style.display === 'none';
                if (isCollapsed) {
                    controls.style.display = 'flex';
                    toggleControlsBtn.textContent = '❮';
                    toggleControlsBtn.style.left = '0';
                } else {
                    controls.style.display = 'none';
                    toggleControlsBtn.textContent = '❯';
                    toggleControlsBtn.style.left = '0'; // It's relative to view-container, which now starts at 0
                }
                // Trigger resize
                if (currentEngine === 'canvas' || currentEngine === 'webgl') {
                    requestAnimationFrame(resizeCanvas);
                } else if (panZoomInstance) {
                    panZoomInstance.resize();
                    panZoomInstance.fit();
                    panZoomInstance.center();
                }
            });
        }

        if (toggleConfigBtn && configPanel) {
            toggleConfigBtn.addEventListener('click', () => {
                const isHidden = configPanel.style.display === 'none' || configPanel.style.display === '';
                if (isHidden) {
                    configPanel.style.display = 'block';
                    toggleConfigBtn.style.right = '250px';
                    toggleConfigBtn.style.color = '#fff'; // Active state
                } else {
                    configPanel.style.display = 'none';
                    toggleConfigBtn.style.right = '0';
                    toggleConfigBtn.style.color = '#ccc'; // Inactive state
                }
            });
        }

        // Toolbar Dragging Logic
        const toolbar = document.getElementById('toolbar');
        let isDraggingToolbar = false;
        let toolbarOffsetX = 0;
        let toolbarOffsetY = 0;

        if (toolbar) {
            toolbar.addEventListener('mousedown', (e) => {
                // Only drag if clicking on the toolbar background, not buttons/inputs
                if (e.target === toolbar || e.target.classList.contains('toolbar-separator')) {
                    isDraggingToolbar = true;
                    toolbarOffsetX = e.clientX - toolbar.offsetLeft;
                    toolbarOffsetY = e.clientY - toolbar.offsetTop;
                    e.preventDefault(); // Prevent text selection
                    e.stopPropagation(); // Prevent underlying elements from receiving the event
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isDraggingToolbar) {
                    let newLeft = e.clientX - toolbarOffsetX;
                    let newTop = e.clientY - toolbarOffsetY;

                    // Boundary checks
                    const maxX = window.innerWidth - toolbar.offsetWidth;
                    const maxY = window.innerHeight - toolbar.offsetHeight;

                    newLeft = Math.max(0, Math.min(newLeft, maxX));
                    newTop = Math.max(0, Math.min(newTop, maxY));

                    toolbar.style.left = newLeft + 'px';
                    toolbar.style.top = newTop + 'px';
                }
            });

            window.addEventListener('mouseup', () => {
                isDraggingToolbar = false;
            });
        }

        // Signal ready
        console.log("Sending ready message from webview script (end of script)");
        if (vscode) {
            vscode.postMessage({ command: 'ready' });
        } else {
            console.error("vscode API not found!");
        }
    </script>
</body>
</html>`;
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
