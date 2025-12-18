import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "gds-preview" is now active!');

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
}

class GdsPreviewProvider implements vscode.CustomReadonlyEditorProvider {

    public static readonly viewType = 'gds-preview.gdsPreview';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

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
        const filePath = document.uri.fsPath;

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(os.tmpdir())]
        };

        let currentCell: string | undefined;
        let currentProcess: cp.ChildProcess | undefined;

        // Set initial HTML content
        const config = vscode.workspace.getConfiguration('gdsPreview');
        const initialRenderingEngine = config.get<string>('renderingEngine', 'canvas');
        const fastModeThreshold = config.get<number>('fastModeThreshold', 10);
        const labelFontSize = config.get<number>('labelFontSize', 12);
        const minLabelZoom = config.get<number>('minLabelZoom', 0.1);
        const pythonPath = config.get<string>('pythonPath', 'python');

        webviewPanel.webview.html = getWebviewContent(initialRenderingEngine, fastModeThreshold, labelFontSize, minLabelZoom, pythonPath);

        const updateWebview = (cellName?: string) => {
            // Kill existing process if any
            if (currentProcess) {
                console.log("Killing previous Python process...");
                currentProcess.kill();
                currentProcess = undefined;
            }

            const currentConfig = vscode.workspace.getConfiguration('gdsPreview');
            const currentRenderingEngine = currentConfig.get<string>('renderingEngine', 'canvas');

            const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);

            let scriptName = 'gds_to_canvas.py';
            if (currentRenderingEngine === 'svg') {
                scriptName = 'gds_to_svg.py';
            }

            const pythonScriptPath = this.context.asAbsolutePath(path.join('scripts', scriptName));
            const pythonPath = currentConfig.get<string>('pythonPath', 'python');

            const args = [pythonScriptPath, filePath, tempDir];
            if (cellName) {
                args.push(cellName);
            }

            console.log(`Running python script: ${pythonPath} ${args.join(' ')}`);

            const process = cp.spawn(pythonPath, args);
            currentProcess = process;

            let stderr = '';
            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            // Use readline to stream stdout line by line
            const rl = readline.createInterface({
                input: process.stdout,
                crlfDelay: Infinity
            });

            let isFirstLine = true;

            rl.on('line', (line) => {
                try {
                    if (!line.trim()) return;
                    const data = JSON.parse(line);

                    if (isFirstLine) {
                        // Metadata
                        webviewPanel.webview.postMessage({
                            command: 'initialize',
                            data: data,
                            engine: currentRenderingEngine
                        });
                        isFirstLine = false;
                    } else {
                        // Layer data chunk
                        // Python sends { layerKey, polygons, labels, chunkIndex, totalChunks }
                        webviewPanel.webview.postMessage({
                            command: 'addLayerChunk',
                            layerKey: data.layerKey,
                            data: data
                        });
                    }
                } catch (e: any) {
                    console.error(`Failed to parse line: ${e.message}`);
                    // Don't show error message for every line, just log it
                }
            });

            process.on('error', (err) => {
                console.error(`Failed to start python process: ${err}`);
                vscode.window.showErrorMessage(`Failed to start Python process. Please check if Python is installed and configured in 'gdsPreview.pythonPath'. Error: ${err.message}`);
            });

            process.on('close', (code) => {
                if (currentProcess !== process) {
                    return;
                }
                currentProcess = undefined;

                console.log(`Python script exited with code ${code}`);
                if (code !== 0) {
                    console.error(`Stderr: ${stderr}`);
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
                        console.error(`Failed to delete temporary directory: ${tempDir}`, err);
                    }
                });
            });
        };

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            message => {
                console.log(`Received message: ${JSON.stringify(message)}`);
                switch (message.command) {
                    case 'changeCell':
                        currentCell = message.cellName;
                        updateWebview(message.cellName);
                        return;
                    case 'reset':
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

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gdsPreview.fastModeThreshold') ||
                e.affectsConfiguration('gdsPreview.labelFontSize') ||
                e.affectsConfiguration('gdsPreview.minLabelZoom')) {
                const config = vscode.workspace.getConfiguration('gdsPreview');
                const newThreshold = config.get<number>('fastModeThreshold', 10);
                const newFontSize = config.get<number>('labelFontSize', 12);
                const newMinZoom = config.get<number>('minLabelZoom', 0.1);
                webviewPanel.webview.postMessage({
                    command: 'updateSettings',
                    fastModeThreshold: newThreshold,
                    labelFontSize: newFontSize,
                    minLabelZoom: newMinZoom
                });
            }
            if (e.affectsConfiguration('gdsPreview.renderingEngine')) {
                updateWebview(currentCell);
            }
        }, null, this.context.subscriptions);
    }
}

function getWebviewContent(engine: string, fastModeThreshold: number, labelFontSize: number, minLabelZoom: number, pythonPath: string): string {
    const nonce = getNonce();
    const svgPanZoomCdn = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
    const earcutCdn = "https://unpkg.com/earcut@2.2.4/dist/earcut.min.js";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://unpkg.com; img-src data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GDS Preview</title>
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
        #recenter-btn, .action-btn {
            padding: 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; cursor: pointer;
        }
        #recenter-btn { margin-top: 10px; }
        .action-btn:hover, #recenter-btn:hover { background-color: var(--vscode-button-hoverBackground); }
        #layers-list { margin-top: 10px; flex-grow: 1; overflow-y: auto; }
        .control-group { margin-bottom: 15px; }
        .control-group label { display: block; margin-bottom: 5px; font-weight: bold; }
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
    </style>
</head>
<body>
    <div id="controls">
        <h3>Cell Control</h3>
        <div class="control-group">
            <label for="cell-select">Select Cell:</label>
            <select id="cell-select" disabled>
                <option>Loading...</option>
            </select>
            <div id="status-msg" style="font-size: 12px; color: #888; margin-top: 5px;">Initializing...</div>
            <div style="display: flex; gap: 5px; margin-top: 10px;">
                <button id="reset-btn" class="action-btn" style="flex: 1;">Reset</button>
                <button id="stop-btn" class="action-btn" style="flex: 1;">Stop</button>
            </div>
        </div>
        <hr style="width: 100%; border-color: #444; margin: 15px 0;">
        <h3>View Control</h3>
        <button id="recenter-btn">Center View</button>
        <hr style="width: 100%; border-color: #444; margin: 15px 0;">
        <h3>Layer Control</h3>
        <div style="margin-top: 10px;">
            <input type="checkbox" id="show-labels-checkbox">
            <label for="show-labels-checkbox">Show Labels</label>
            <input type="range" min="0" max="1" step="0.1" value="0.5" id="label-brightness-slider" style="width: 80px; margin-left: 10px; vertical-align: middle;" title="Text Brightness">
        </div>
        <div id="layers-list"></div>
    </div>
    <div id="view-container">
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
                <label for="font-size-input">Label Font Size:</label>
                <input type="number" id="font-size-input" value="${labelFontSize}" min="1" step="1">
            </div>
            <div class="control-group">
                <label for="min-zoom-input">Min Label Zoom:</label>
                <input type="number" id="min-zoom-input" value="${minLabelZoom}" min="0.001" step="0.001">
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

    <script src="${svgPanZoomCdn}"></script>
    <script src="${earcutCdn}"></script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        console.log("GDS Preview: Script initialized");

        // State
        let geometry = {};
        let labels = {};
        let bbox = { x_min: 0, x_max: 0, y_min: 0, y_max: 0 };
        let activeLayers = new Set();
        let layerColors = {};
        let layerOpacities = {};
        let showLabels = false;
        let labelBrightness = 0.5;
        let currentEngine = '${engine}';
        let fastModeThreshold = ${fastModeThreshold};
        let labelFontSize = ${labelFontSize};
        let minLabelZoom = ${minLabelZoom};

        // WebGL State
        let gl = null;
        let glProgram = null;
        let layerBuffers = {}; // { layerKey: { vertexBuffer, vertexCount, colorLocation, matrixLocation } }

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
        const svgContainer = document.getElementById('svg-container');
        const ctx = canvas.getContext('2d');
        const controls = document.getElementById('controls');
        const recenterBtn = document.getElementById('recenter-btn');
        const resetBtn = document.getElementById('reset-btn');
        const stopBtn = document.getElementById('stop-btn');
        const cellSelect = document.getElementById('cell-select');
        const statusMsg = document.getElementById('status-msg');
        const layersList = document.getElementById('layers-list');
        const toggleControlsBtn = document.getElementById('toggle-controls-btn');
        const toggleConfigBtn = document.getElementById('toggle-config-btn');
        const configPanel = document.getElementById('config-panel');

        // Config Elements
        const engineSelect = document.getElementById('engine-select');
        const fastModeInput = document.getElementById('fast-mode-input');
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

        if (fontSizeInput) {
            fontSizeInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'labelFontSize',
                    value: parseFloat(e.target.value)
                });
            });
        }

        if (minZoomInput) {
            minZoomInput.addEventListener('change', (e) => {
                vscode.postMessage({
                    command: 'updateConfig',
                    key: 'minLabelZoom',
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
            if (message.command === 'updateData') {
                console.log("Received data update");
                currentEngine = message.engine;
                handleDataUpdate(message.data);
            } else if (message.command === 'initialize') {
                console.log("Received initialization");
                currentEngine = message.engine;
                handleInitialize(message.data);
            } else if (message.command === 'addLayerChunk') {
                // console.log("Received layer chunk", message.layerKey);
                handleAddLayerChunk(message.layerKey, message.data);
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
                if (message.minLabelZoom !== undefined) {
                    minLabelZoom = message.minLabelZoom;
                    if (minZoomInput) minZoomInput.value = minLabelZoom;
                    console.log("Updated minLabelZoom to:", minLabelZoom);
                    requestAnimationFrame(drawLabels);
                }
            } else if (message.command === 'status') {
                updateStatus(message.message);
            }
        });

        function handleInitialize(data) {
            updateStatus("Initializing...");

            // Reset state
            geometry = {};
            labels = {};
            bbox = data.bbox;
            activeLayers.clear();
            layerColors = {};
            layerOpacities = {};
            layerTextBrightness = {};
            layerBuffers = {}; // Clear WebGL buffers

            // Update Cell Select
            cellSelect.innerHTML = '';
            cellSelect.disabled = false;
            data.all_cells.forEach(cell => {
                const option = document.createElement('option');
                option.value = cell;
                option.textContent = cell;
                if (cell === data.cell_name) option.selected = true;
                cellSelect.appendChild(option);
            });

            // Update Layers UI
            layersList.innerHTML = '';
            data.layers.forEach(layerKey => {
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
                div.innerHTML = \`
                    <input type="checkbox" id="toggle-\${layerKey}" data-layer-id="\${layerKey}" checked>
                    <label for="toggle-\${layerKey}">Layer \${layerKey.replace('_', ' / ')}</label>
                    <input type="color" id="color-\${layerKey}" data-layer-id="\${layerKey}" value="\${color}">
                    <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="\${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
                \`;
                layersList.appendChild(div);
            });

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
                canvas.style.display = 'none';
                document.getElementById('gds-webgl-canvas').style.display = 'none';
                // Ensure text canvas is sized correctly
                resizeCanvas();
                // Clear text canvas when switching to SVG
                const textCanvas = document.getElementById('text-canvas');
                if (textCanvas) {
                    const ctx = textCanvas.getContext('2d');
                    ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
                }
                svgContainer.style.display = 'block';
                svgContainer.innerHTML = '';

                if (data.svg_fragments) {
                    const width = data.bbox.x_max - data.bbox.x_min;
                    const height = data.bbox.y_max - data.bbox.y_min;
                    // Note: GDS is Y-up, SVG is Y-down. We might need to flip, but let's stick to raw coordinates for now
                    // or rely on svg-pan-zoom to handle orientation if the user rotates.
                    // Actually, let's just render it. If it's flipped, we can fix it later.
                    const viewBox = \`\${data.bbox.x_min} \${data.bbox.y_min} \${width} \${height}\`;

                    let svgContent = '';
                    for (const layerKey in data.svg_fragments) {
                        const fragment = data.svg_fragments[layerKey];
                        const color = layerColors[layerKey];
                        // Wrap in group for color and opacity control
                        svgContent += \`<g id="layer-group-\${layerKey}" fill="\${color}" stroke="\${color}" style="opacity: 0.8">\${fragment}</g>\`;
                    }

                    // Wrap for flip and viewport
                    // Flip Y axis to match GDS (Y-up)
                    const flippedContent = \`<g transform="scale(1, -1)">\${svgContent}</g>\`;
                    const viewportContent = \`<g id="svg-viewport">\${flippedContent}</g>\`;

                    // Create main SVG (No viewBox, let svg-pan-zoom handle it)
                    svgContainer.innerHTML = \`<svg id="main-svg" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background-color: #000;">\${viewportContent}</svg>\`;

                    // Initialize PanZoom
                    try {
                        // @ts-ignore
                        panZoomInstance = svgPanZoom('#main-svg', {
                            zoomEnabled: true,
                            controlIconsEnabled: false,
                            fit: true,
                            center: true,
                            minZoom: 0.001,
                            maxZoom: 1000,
                            viewportSelector: '#svg-viewport',
                            onZoom: function(newZoom) {
                                const pan = this.getPan();
                                offsetX = pan.x;
                                offsetY = pan.y;
                                scale = newZoom;
                                requestAnimationFrame(drawLabels);
                            },
                            onPan: function(newPan) {
                                // svg-pan-zoom pan is in screen pixels
                                // We need to sync this with our offsetX/offsetY
                                // But wait, svg-pan-zoom applies transform to the viewport.
                                // Our drawLabels uses offsetX/offsetY/scale to project world to screen.
                                // If svg-pan-zoom handles the transform, we just need to know the current transform.
                                const pan = this.getPan();
                                offsetX = pan.x;
                                offsetY = pan.y;
                                scale = this.getSizes().realZoom;
                                requestAnimationFrame(drawLabels);
                            }
                        });

                        // Initial sync
                        const pan = panZoomInstance.getPan();
                        offsetX = pan.x;
                        offsetY = pan.y;
                        scale = panZoomInstance.getSizes().realZoom;
                        requestAnimationFrame(drawLabels);

                    } catch (e) {
                        console.error("PanZoom init error:", e);
                    }
                }

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
                const vertices = [];
                for (const poly of polys) {
                    const flat = [];
                    for (const p of poly) {
                        flat.push(p[0], p[1]);
                    }
                    const triangles = earcut(flat);
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

            updateStatus(\`Loading \${layerKey} (\${data.chunkIndex + 1}/\${data.totalChunks || '?'})\`);

            // Redraw
            if (currentEngine === 'canvas') requestAnimationFrame(draw);
            else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);
        }

        function handleDataUpdate(data) {
            updateStatus("Rendering...");

            // Update Cell Select
            cellSelect.innerHTML = '';
            cellSelect.disabled = false;
            data.all_cells.forEach(cell => {
                const option = document.createElement('option');
                option.value = cell;
                option.textContent = cell;
                if (cell === data.cell_name) option.selected = true;
                cellSelect.appendChild(option);
            });

            // Update Layers UI
            layersList.innerHTML = '';
            activeLayers.clear();
            layerColors = {};
            layerOpacities = {};

            data.layers.forEach(layerKey => {
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
                div.innerHTML = \`
                    <input type="checkbox" id="toggle-\${layerKey}" data-layer-id="\${layerKey}" checked>
                    <label for="toggle-\${layerKey}">Layer \${layerKey.replace('_', ' / ')}</label>
                    <input type="color" id="color-\${layerKey}" data-layer-id="\${layerKey}" value="\${color}">
                    <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="\${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
                \`;
                layersList.appendChild(div);
            });

            if (currentEngine === 'canvas') {
                setupCanvasMode(data);
            } else if (currentEngine === 'webgl') {
                setupWebGLMode(data);
            } else {
                setupSvgMode(data);
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

            const bboxWidth = data.bbox.x_max - data.bbox.x_min;
            const bboxHeight = data.bbox.y_max - data.bbox.y_min;
            const viewBoxString = \`\${data.bbox.x_min} \${-data.bbox.y_max} \${bboxWidth} \${bboxHeight}\`;

            let svgContent = \`<svg id="root-svg-for-panzoom" viewBox="\${viewBoxString}" width="100%" height="100%">\`;

            for (const layerKey of data.layers) {
                const fragment = data.svg_fragments[layerKey];
                const opacity = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;
                svgContent += \`<g id="layer-group-\${layerKey}" class="gds-layer" style="color: \${layerColors[layerKey]}; opacity: \${opacity}; display: block;">
                    \${fragment}
                </g>\`;
            }
            svgContent += '</svg>';

            svgContainer.innerHTML = svgContent;

            // Initialize pan-zoom
            if (panZoomInstance) {
                panZoomInstance.destroy();
            }
            panZoomInstance = svgPanZoom('#root-svg-for-panzoom', {
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

            gl = glCanvas.getContext('webgl');
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

                void main() {
                    // Apply scale and offset
                    vec2 position = (a_position * vec2(1, -1) * u_scale) + u_offset;

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
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.useProgram(glProgram);

            const resolutionLocation = gl.getUniformLocation(glProgram, "u_resolution");
            const offsetLocation = gl.getUniformLocation(glProgram, "u_offset");
            const scaleLocation = gl.getUniformLocation(glProgram, "u_scale");
            const colorLocation = gl.getUniformLocation(glProgram, "u_color");
            const positionLocation = gl.getAttribLocation(glProgram, "a_position");

            gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
            gl.uniform2f(offsetLocation, offsetX, offsetY);
            gl.uniform1f(scaleLocation, scale);

            gl.enableVertexAttribArray(positionLocation);

            for (const layerKey in layerBuffers) {
                if (!activeLayers.has(layerKey)) continue;

                const buffers = layerBuffers[layerKey];
                // Support both single buffer (legacy/small files) and array of buffers (chunked)
                const bufferList = Array.isArray(buffers) ? buffers : [buffers];

                // Convert hex color to rgba
                const hex = layerColors[layerKey] || '#888888';
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                const a = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;

                gl.uniform4f(colorLocation, r, g, b, a);

                for (const layerData of bufferList) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, layerData.buffer);
                    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
                    gl.drawArrays(gl.TRIANGLES, 0, layerData.count);
                }
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

            if (currentEngine === 'canvas') draw();
            else if (currentEngine === 'webgl') drawWebGL();

            drawLabels();
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

            // Don't draw labels if zoomed out too far
            if (scale < minLabelZoom) {
                return;
            }

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
                const baseColor = layerColors[layerKey] || '#ffffff';
                ctx.fillStyle = darken(baseColor, labelBrightness);

                for (const label of layerLabels) {
                    // label: { text, x, y, ... }
                    const x = label.x;
                    const y = label.y;
                    const text = label.text;

                    if (x < vMinX || x > vMaxX || y < vMinY || y > vMaxY) continue;

                    // Project to screen coordinates manually
                    const screenX = x * scale + offsetX;
                    const screenY = y * -scale + offsetY;

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
                ctx.scale(scale, -scale);

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

                for (const layerKey in geometry) {
                    if (!activeLayers.has(layerKey)) continue;

                    const polys = geometry[layerKey];
                    if (!polys) continue;

                    ctx.fillStyle = layerColors[layerKey] || '#888';
                    ctx.strokeStyle = layerColors[layerKey] || '#888';

                    ctx.beginPath();
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

                        if (poly.length < 2) continue;
                        ctx.moveTo(poly[0][0], poly[0][1]);
                        for (let i = 1; i < poly.length; i++) {
                            ctx.lineTo(poly[i][0], poly[i][1]);
                        }
                        ctx.closePath();
                        polyCount++;
                    }
                    ctx.globalAlpha = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : 0.8;
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                    ctx.lineWidth = 1 / scale;
                    ctx.stroke();
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

        if (cellSelect) {
            cellSelect.addEventListener('change', function(e) {
                const selectedCell = e.target.value;
                updateStatus("Loading cell: " + selectedCell + "...");
                vscode.postMessage({
                    command: 'changeCell',
                    cellName: selectedCell
                });
            });
        }

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

        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'reset' });
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'stop' });
            });
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

        // Signal ready
        vscode.postMessage({ command: 'ready' });
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
