import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import * as net from 'net';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';

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
            try { currentProcess?.kill(); } catch { /* noop */ }
            currentProcess = undefined;
            try { cleanupServers(); } catch { /* noop */ }
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
        let isEngineReady = false;

        // Rust geometry bridge: TCP from Rust -> WebSocket to webview
        let wsServer: WebSocketServer | undefined;
        let tcpServer: net.Server | undefined;
        let wsPort: number | undefined;
        let tcpPort: number | undefined;
        let wsToken: string | undefined;
        let wsUrl: string | undefined;
        let wsClients = new Set<WebSocket>();
        let tcpSockets = new Set<net.Socket>();
        let pendingWsFrames: Buffer[] = [];
        let pendingWsBytes = 0;
        const MAX_PENDING_WS_BYTES = 64 * 1024 * 1024;
        let cleanupTimer: NodeJS.Timeout | undefined;

        const cleanupServers = () => {
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                cleanupTimer = undefined;
            }
            for (const s of tcpSockets) {
                try { s.destroy(); } catch { /* noop */ }
            }
            tcpSockets.clear();
            pendingWsFrames = [];
            pendingWsBytes = 0;
            for (const c of wsClients) {
                try { c.terminate(); } catch { /* noop */ }
            }
            wsClients.clear();
            try { wsServer?.close(); } catch { /* noop */ }
            try { tcpServer?.close(); } catch { /* noop */ }
            wsServer = undefined;
            tcpServer = undefined;
            wsPort = undefined;
            tcpPort = undefined;
            wsToken = undefined;
            wsUrl = undefined;
        };

        const startGeometryBridgeServers = async () => {
            cleanupServers();
            wsToken = crypto.randomBytes(16).toString('hex');

            const flushPendingFrames = () => {
                if (pendingWsFrames.length === 0) return;
                const frames = pendingWsFrames;
                pendingWsFrames = [];
                pendingWsBytes = 0;
                for (const frame of frames) {
                    for (const c of wsClients) {
                        if (c.readyState === c.OPEN) {
                            c.send(frame, { binary: true });
                        }
                    }
                }
            };

            wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
            wsServer.on('connection', (socket: WebSocket) => {
                let authed = false;
                socket.once('message', (data: RawData) => {
                    const token = data.toString();
                    if (token !== wsToken) {
                        socket.close();
                        return;
                    }
                    authed = true;
                    wsClients.add(socket);
                    flushPendingFrames();
                });
                socket.on('close', () => {
                    if (authed) wsClients.delete(socket);
                });
            });

            tcpServer = net.createServer((sock) => {
                tcpSockets.add(sock);
                let pending = Buffer.alloc(0);
                sock.on('data', (chunk) => {
                    pending = Buffer.concat([pending, chunk]);
                    while (pending.length >= 4) {
                        const frameLen = pending.readUInt32LE(0);
                        if (pending.length < 4 + frameLen) break;
                        const frame = Buffer.from(pending.subarray(4, 4 + frameLen));
                        pending = pending.subarray(4 + frameLen);

                        let hasOpenClient = false;
                        for (const c of wsClients) {
                            if (c.readyState === c.OPEN) {
                                hasOpenClient = true;
                                break;
                            }
                        }

                        if (!hasOpenClient) {
                            if (pendingWsBytes + frame.length <= MAX_PENDING_WS_BYTES) {
                                pendingWsFrames.push(frame);
                                pendingWsBytes += frame.length;
                            } else {
                                // Best-effort: if the buffer is full, drop frames to avoid unbounded memory.
                                // This should be rare; the webview normally connects right after initialize.
                            }
                            continue;
                        }

                        for (const c of wsClients) {
                            if (c.readyState === c.OPEN) {
                                c.send(frame, { binary: true });
                            }
                        }
                    }
                });
                sock.on('close', () => tcpSockets.delete(sock));
            });

            await new Promise<void>((resolve) => wsServer!.once('listening', () => resolve()));
            await new Promise<void>((resolve) => {
                tcpServer!.listen(0, '127.0.0.1', () => resolve());
            });

            const wsAddr = wsServer.address();
            if (typeof wsAddr === 'object' && wsAddr) {
                wsPort = wsAddr.port;
            }
            const tcpAddr = tcpServer.address();
            if (typeof tcpAddr === 'object' && tcpAddr) {
                tcpPort = tcpAddr.port;
            }

            if (!wsPort || !tcpPort || !wsToken) {
                throw new Error('Failed to start geometry bridge servers');
            }

            // Expose a URL that the webview can reach even in Remote-* scenarios.
            // In local VS Code, this typically round-trips to http://127.0.0.1:<port>.
            // In Remote-SSH/WSL/Containers, this becomes a forwarded/proxied https URL.
            const externalHttp = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${wsPort}`));
            const externalStr = externalHttp.toString();
            wsUrl = externalStr.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

            return { wsPort, tcpPort, wsToken, wsUrl };
        };

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
        const viewportStreaming = config.get<boolean>('viewportStreaming', false);
        const viewportPaddingFactor = config.get<number>('viewportPaddingFactor', 0.25);
        const viewportDebounceMs = config.get<number>('viewportDebounceMs', 80);

        const updateWebview = async (cellName?: string, isNegativeMode?: boolean) => {
            // console.log(`updateWebview called with cellName: ${cellName}`);
            // Kill existing process if any
            if (currentProcess) {
                console.log("Killing previous process...");
                currentProcess.kill();
                currentProcess = undefined;
            }

            const currentConfig = vscode.workspace.getConfiguration('gdsPreview');
            const currentRenderingEngine = currentConfig.get<string>('renderingEngine', 'canvas');
            const engineType = currentConfig.get<string>('engineType', 'rust');
            const chunkSize = currentConfig.get<number>('chunkSize', 2000);
            const flowControlStep = currentConfig.get<number>('flowControlStep', 5);
            const useInstancing = currentConfig.get<boolean>('useInstancing', true);
            const enableProfiling = currentConfig.get<boolean>('enableProfiling', false);
            const maxWorkers = currentConfig.get<number>('maxWorkers', -1);
            const viewportStreaming = currentConfig.get<boolean>('viewportStreaming', false);

            const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);

            let processCmd: string;
            let args: string[] = [];

            if (engineType === 'rust') {
                await startGeometryBridgeServers();

                const isWindows = process.platform === 'win32';
                const platform = process.platform;
                const arch = process.arch;

                // Priority 1: Dev build (standard cargo output)
                const devBinName = isWindows ? 'gds-engine-rust.exe' : 'gds-engine-rust';
                let rustPath = this.context.asAbsolutePath(path.join('gds-engine-rust', 'target', 'release', devBinName));

                if (!fs.existsSync(rustPath)) {
                    // Priority 2: Platform specific bundled binary
                    const specificBinName = `gds-engine-rust-${platform}-${arch}${isWindows ? '.exe' : ''}`;
                    rustPath = this.context.asAbsolutePath(path.join('bin', specificBinName));

                    if (!fs.existsSync(rustPath)) {
                        // Priority 3: Generic bundled binary (fallback)
                        rustPath = this.context.asAbsolutePath(path.join('bin', devBinName));
                    }
                }
                processCmd = rustPath;

                // Ensure executable permissions on non-Windows platforms
                if (!isWindows && fs.existsSync(processCmd)) {
                    try {
                        fs.chmodSync(processCmd, '755');
                    } catch (err) {
                        console.warn(`Failed to set executable permissions for ${processCmd}:`, err);
                    }
                }

                args = [filePath, tempDir, cellName || "", chunkSize.toString(), flowControlStep.toString()];
                args.push((currentRenderingEngine === 'webgl' && useInstancing) ? "1" : "0");

                // Stream binary geometry over TCP to the extension, then forward over WebSocket to the webview
                args.push('--tcp-port');
                args.push(String(tcpPort ?? 0));

                // For WebGL, request pre-triangulated vertices from Rust (no earcut in webview)
                args.push('--geom-mode');
                args.push(currentRenderingEngine === 'webgl' ? 'triangles' : 'polygons');

                // Optional: viewport-driven streaming to reduce webview memory for huge layouts.
                // Only supported with WebGL+Rust and instancing enabled.
                if (currentRenderingEngine === 'webgl' && viewportStreaming && useInstancing) {
                    args.push('--viewport-streaming');
                }
                if (isNegativeMode) {
                    args.push("--negative");
                }
            } else {
                let scriptName = 'gds_to_canvas.py';
                if (currentRenderingEngine === 'svg') {
                    scriptName = 'gds_to_svg.py';
                }

                const pythonScriptPath = this.context.asAbsolutePath(path.join('scripts', scriptName));
                const pythonPath = currentConfig.get<string>('pythonPath', 'python');

                processCmd = pythonPath;
                args = [pythonScriptPath, filePath, tempDir];
                args.push(cellName || "");

                if (currentRenderingEngine === 'svg' && isNegativeMode) {
                    args.push("--negative");
                } else {
                    if (currentRenderingEngine !== 'svg') {
                        args.push(chunkSize.toString());
                        args.push(flowControlStep.toString());
                        // Use instancing if WebGL and enabled
                        args.push((currentRenderingEngine === 'webgl' && useInstancing) ? "1" : "0");
                    }
                }
            }

            console.log(`Running engine: ${processCmd} ${args.join(' ')}`);
            if (enableProfiling) {
                console.time("EngineProcess");
            }

            const env: NodeJS.ProcessEnv = { ...process.env };
            // Use the same setting as the front-end worker pool to control Rust/Rayon parallelism.
            // -1 (or <=0) means "use all available CPU threads" (Rayon default).
            if (engineType === 'rust' && typeof maxWorkers === 'number' && maxWorkers > 0) {
                env.RAYON_NUM_THREADS = String(maxWorkers);
            } else {
                delete env.RAYON_NUM_THREADS;
            }

            const childProcess = cp.spawn(processCmd, args, { env });
            currentProcess = childProcess;
            isEngineReady = false;

            let stderr = '';
            childProcess.stderr.on('data', (data) => {
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
                input: childProcess.stdout,
                crlfDelay: Infinity
            });

            let isFirstLine = true;

            let currentChunkMeta: any = null;

            rl.on('line', (line) => {
                if (isFirstLine) {
                    console.log(`[EngineProcess] First byte received`);
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
                    } else if (line.startsWith("Warning:") || line.startsWith("INFO:")) {
                        console.log(`[Python Log] ${line}`);
                    } else {
                        // Legacy/Metadata handling
                        const data = JSON.parse(line);

                        if (isFirstLine) {
                            console.log("[PythonProcess] Sending initialize command to webview");
                            // Inject WS endpoint for Rust geometry streaming
                            if (engineType === 'rust' && wsPort && wsToken) {
                                // Prefer url (remote-friendly), keep port for backward compatibility.
                                (data as any).ws = { url: wsUrl, port: wsPort, token: wsToken };
                            }
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
                        } else if (data.command === 'found' || data.command === 'status') {
                            webviewPanel.webview.postMessage(data);
                        } else if (data.command === 'done') {
                            isEngineReady = true;
                            webviewPanel.webview.postMessage({ command: 'status', message: 'Loaded successfully' });
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

            childProcess.on('error', (err) => {
                console.log(`Failed to start engine process: ${err}`);
                vscode.window.showErrorMessage(`Failed to start engine process. Error: ${err.message}`);
            });

            childProcess.on('close', (code) => {
                console.log(`[EngineProcess] Finished`);
                if (currentProcess !== childProcess) {
                    return;
                }
                currentProcess = undefined;

                console.log(`Engine process exited with code ${code}`);
                if (code !== 0) {
                    console.log(`Stderr: ${stderr}`);
                    if (engineType === 'python') {
                        if (stderr.includes("ModuleNotFoundError") && stderr.includes("gdstk")) {
                            vscode.window.showErrorMessage("Python module 'gdstk' is missing.", "Install gdstk").then(selection => {
                                if (selection === "Install gdstk") {
                                    const pythonPath = currentConfig.get<string>('pythonPath', 'python');
                                    installGdstk(pythonPath);
                                }
                            });
                        } else if (stderr.includes("ModuleNotFoundError") && stderr.includes("klayout")) {
                            vscode.window.showErrorMessage("Python module 'klayout' is missing. It is required for port extraction.", "Install klayout").then(selection => {
                                if (selection === "Install klayout") {
                                    const pythonPath = currentConfig.get<string>('pythonPath', 'python');
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
                    } else {
                        vscode.window.showErrorMessage(`Rust engine failed with code ${code}. Stderr: ${stderr}`);
                    }
                    return;
                }

                // Send success message to webview (only if engine didn't emit a done message)
                if (!isEngineReady) {
                    webviewPanel.webview.postMessage({ command: 'status', message: 'Loaded successfully' });
                }

                // Small files can finish before the webview connects/auths to WS; keep the bridge
                // alive briefly to allow buffered frames to flush and avoid losing the only chunk.
                if (engineType === 'rust') {
                    const delayMs = (pendingWsFrames.length > 0 && wsClients.size === 0) ? 3000 : 750;
                    cleanupTimer = setTimeout(() => cleanupServers(), delayMs);
                } else {
                    cleanupServers();
                }

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
                        void updateWebview(message.cellName);
                        return;
                    case 'reloadNegative':
                        isNegative = message.isNegative;
                        void updateWebview(currentCell, message.isNegative);
                        return;
                    case 'syncNegativeState':
                        isNegative = message.isNegative;
                        return;
                    case 'reset':
                        isNegative = false;
                        void updateWebview(currentCell);
                        return;
                    case 'stop':
                        if (currentProcess) {
                            if (isEngineReady) {
                                currentProcess.stdin?.write(JSON.stringify({ command: 'stop' }) + "\n");
                            } else {
                                currentProcess.kill();
                                currentProcess = undefined;
                                webviewPanel.webview.postMessage({ command: 'status', message: 'Stopped by user' });
                            }
                        }
                        return;
                    case 'ready':
                        console.log("Received ready message from webview");
                        void updateWebview(currentCell);
                        return;
                    case 'updateConfig':
                        const config = vscode.workspace.getConfiguration('gdsPreview');
                        if (message.key && message.value !== undefined) {
                            config.update(message.key, message.value, vscode.ConfigurationTarget.Global);
                        }
                        return;
                    case 'find':
                        if (currentProcess) {
                            currentProcess.stdin?.write(JSON.stringify(message) + "\n");
                        }
                        return;
                    case 'viewport':
                        if (currentProcess) {
                            currentProcess.stdin?.write(JSON.stringify(message) + "\n");
                        }
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );

        webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri, initialRenderingEngine, fastModeThreshold, labelFontSize, portFontSize, portArrowScale, maxSteps, maxWorkers, chunkSize, pythonPath, enableProfiling, flowControlStep, useInstancing, viewportStreaming, viewportPaddingFactor, viewportDebounceMs);
        console.log("Webview HTML set");

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gdsPreview.fastModeThreshold') ||
                e.affectsConfiguration('gdsPreview.labelFontSize') ||
                e.affectsConfiguration('gdsPreview.portFontSize') ||
                e.affectsConfiguration('gdsPreview.portArrowScale') ||
                e.affectsConfiguration('gdsPreview.maxSteps') ||
                e.affectsConfiguration('gdsPreview.viewportPaddingFactor') ||
                e.affectsConfiguration('gdsPreview.viewportDebounceMs') ||
                e.affectsConfiguration('gdsPreview.enableProfiling')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const newThreshold = config.get<number>('fastModeThreshold', 10);
                const newFontSize = config.get<number>('labelFontSize', 12);
                const newPortFontSize = config.get<number>('portFontSize', 12);
                const newPortArrowScale = config.get<number>('portArrowScale', 1.0);
                const newMaxSteps = config.get<number>('maxSteps', 5000);
                const viewportPaddingFactor = config.get<number>('viewportPaddingFactor', 0.25);
                const viewportDebounceMs = config.get<number>('viewportDebounceMs', 80);
                const enableProfiling = config.get<boolean>('enableProfiling', false);
                webviewPanel.webview.postMessage({
                    command: 'updateSettings',
                    fastModeThreshold: newThreshold,
                    labelFontSize: newFontSize,
                    portFontSize: newPortFontSize,
                    portArrowScale: newPortArrowScale,
                    maxSteps: newMaxSteps,
                    viewportPaddingFactor,
                    viewportDebounceMs,
                    enableProfiling
                });
            }
            if (e.affectsConfiguration('gdsPreview.renderingEngine')) {
                void updateWebview(currentCell, isNegative);
            }
            if (e.affectsConfiguration('gdsPreview.maxWorkers') || e.affectsConfiguration('gdsPreview.chunkSize') || e.affectsConfiguration('gdsPreview.flowControlStep') || e.affectsConfiguration('gdsPreview.useInstancing') || e.affectsConfiguration('gdsPreview.viewportStreaming')) {
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
                const viewportStreaming = config.get<boolean>('viewportStreaming', false);
                const viewportPaddingFactor = config.get<number>('viewportPaddingFactor', 0.25);
                const viewportDebounceMs = config.get<number>('viewportDebounceMs', 80);

                webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri, initialRenderingEngine, fastModeThreshold, labelFontSize, portFontSize, portArrowScale, maxSteps, maxWorkers, chunkSize, pythonPath, enableProfiling, flowControlStep, useInstancing, viewportStreaming, viewportPaddingFactor, viewportDebounceMs);
            }
        }, null, this.context.subscriptions);
    }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, engine: string, fastModeThreshold: number, labelFontSize: number, portFontSize: number, portArrowScale: number, maxSteps: number, maxWorkersConfig: number, chunkSize: number, pythonPath: string, enableProfiling: boolean, flowControlStep: number, useInstancing: boolean, viewportStreaming: boolean, viewportPaddingFactor: number, viewportDebounceMs: number): string {
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
        engineType: vscode.workspace.getConfiguration('gdsPreview').get<string>('engineType', 'rust'),
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
        viewportStreaming,
        viewportPaddingFactor,
        viewportDebounceMs,
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
