import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

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

        // Set initial HTML content
        const config = vscode.workspace.getConfiguration('gdsPreview');
        const initialRenderingEngine = config.get<string>('renderingEngine', 'canvas');
        const fastModeThreshold = config.get<number>('fastModeThreshold', 10);

        webviewPanel.webview.html = getWebviewContent(initialRenderingEngine, fastModeThreshold);

        const updateWebview = (cellName?: string) => {
            const currentConfig = vscode.workspace.getConfiguration('gdsPreview');
            const currentRenderingEngine = currentConfig.get<string>('renderingEngine', 'canvas');

            const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);

            let scriptName = 'gds_to_canvas.py';
            if (currentRenderingEngine === 'svg') {
                scriptName = 'gds_to_svg.py';
            }

            const pythonScriptPath = this.context.asAbsolutePath(path.join('scripts', scriptName));
            const pythonPath = 'python3';

            const args = [pythonScriptPath, filePath, tempDir];
            if (cellName) {
                args.push(cellName);
            }

            console.log(`Running python script: ${pythonPath} ${args.join(' ')}`);

            const process = cp.spawn(pythonPath, args);

            let stdout = '';
            let stderr = '';
            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                console.log(`Python script exited with code ${code}`);
                if (code !== 0) {
                    console.error(`Stderr: ${stderr}`);
                    try {
                        const errJson = JSON.parse(stderr);
                        vscode.window.showErrorMessage(`Failed to convert GDS: ${errJson.error}`);
                    } catch {
                        vscode.window.showErrorMessage(`Failed to convert GDS. Exit code: ${code}. Stderr: ${stderr}`);
                    }
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    console.log(`Parsed result for cell: ${result.cell_name}`);
                    // Send data to webview via message instead of re-setting HTML
                    webviewPanel.webview.postMessage({ command: 'updateData', data: result, engine: currentRenderingEngine });
                } catch (e: any) {
                    console.error(`Failed to parse stdout: ${e.message}`);
                    console.error(`Stdout: ${stdout}`);
                    vscode.window.showErrorMessage(`Failed to parse layer data: ${e.message}`);
                }

                // Clean up temp dir
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
                    case 'ready':
                        updateWebview();
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gdsPreview.fastModeThreshold')) {
                const newThreshold = vscode.workspace.getConfiguration('gdsPreview').get<number>('fastModeThreshold', 10);
                webviewPanel.webview.postMessage({ command: 'updateSettings', fastModeThreshold: newThreshold });
            }
            if (e.affectsConfiguration('gdsPreview.renderingEngine')) {
                updateWebview(currentCell);
            }
        }, null, this.context.subscriptions);
    }
}

function getWebviewContent(engine: string, fastModeThreshold: number): string {
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
        #recenter-btn {
            margin-top: 10px; padding: 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; cursor: pointer;
        }
        #recenter-btn:hover { background-color: var(--vscode-button-hoverBackground); }
        #layers-list { margin-top: 10px; flex-grow: 1; overflow-y: auto; }
        .control-group { margin-bottom: 15px; }
        .control-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        select {
            width: 100%; padding: 5px;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
        }
        #status-msg { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 5px; }
    </style>
</head>
<body>
    <div id="controls">
        <div class="control-group">
            <label for="cell-select">Select Cell:</label>
            <select id="cell-select" disabled>
                <option>Loading...</option>
            </select>
            <div id="status-msg" style="font-size: 12px; color: #888; margin-top: 5px;">Initializing...</div>
        </div>
        <h3>View Control</h3>
        <button id="recenter-btn">Center View</button>
        <hr style="width: 100%; border-color: #444; margin: 15px 0;">
        <h3>Layers</h3>
        <div id="layers-list"></div>
    </div>
    <div id="view-container">
        <!-- Canvas for 'canvas' mode -->
        <canvas id="gds-canvas" style="display: none;"></canvas>
        <!-- WebGL Canvas -->
        <canvas id="gds-webgl-canvas" style="display: none;"></canvas>
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
        let bbox = { x_min: 0, x_max: 0, y_min: 0, y_max: 0 };
        let activeLayers = new Set();
        let layerColors = {};
        let currentEngine = '${engine}';
        let fastModeThreshold = ${fastModeThreshold};

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
        const cellSelect = document.getElementById('cell-select');
        const statusMsg = document.getElementById('status-msg');
        const layersList = document.getElementById('layers-list');

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
            } else if (message.command === 'updateSettings') {
                if (message.fastModeThreshold !== undefined) {
                    fastModeThreshold = message.fastModeThreshold;
                    console.log("Updated fastModeThreshold to:", fastModeThreshold);
                }
            }
        });

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

                // Create UI
                const div = document.createElement('div');
                div.className = 'layer-toggle';
                div.innerHTML = \`
                    <input type="checkbox" id="toggle-\${layerKey}" data-layer-id="\${layerKey}" checked>
                    <label for="toggle-\${layerKey}">Layer \${layerKey.replace('_', ' / ')}</label>
                    <input type="color" id="color-\${layerKey}" data-layer-id="\${layerKey}" value="\${color}">
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
            if (glCanvas) glCanvas.style.display = 'none';
            svgContainer.style.display = 'block';

            const bboxWidth = data.bbox.x_max - data.bbox.x_min;
            const bboxHeight = data.bbox.y_max - data.bbox.y_min;
            const viewBoxString = \`\${data.bbox.x_min} \${-data.bbox.y_max} \${bboxWidth} \${bboxHeight}\`;

            let svgContent = \`<svg id="root-svg-for-panzoom" viewBox="\${viewBoxString}" width="100%" height="100%">\`;

            for (const layerKey of data.layers) {
                const fragment = data.svg_fragments[layerKey];
                svgContent += \`<g id="layer-group-\${layerKey}" class="gds-layer" style="color: \${layerColors[layerKey]}; display: block;">
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
                maxZoom: 100
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
            layerBuffers = {};

            for (const layerKey in geometry) {
                const polys = geometry[layerKey];
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

                    layerBuffers[layerKey] = {
                        buffer: buffer,
                        count: vertices.length / 2
                    };
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

                const layerData = layerBuffers[layerKey];
                gl.bindBuffer(gl.ARRAY_BUFFER, layerData.buffer);
                gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

                // Convert hex color to rgba
                const hex = layerColors[layerKey] || '#888888';
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;

                gl.uniform4f(colorLocation, r, g, b, 1.0); // Alpha 1.0 for now

                gl.drawArrays(gl.TRIANGLES, 0, layerData.count);
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

            if (currentEngine === 'canvas') draw();
            else if (currentEngine === 'webgl') drawWebGL();
        }

        function fitView() {
            if (currentEngine === 'svg') {
                if (panZoomInstance) {
                    panZoomInstance.fit();
                    panZoomInstance.center();
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
                    ctx.globalAlpha = 0.5;
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

            const layerId = target.getAttribute('data-layer-id');

            if (target.type === 'checkbox') {
                if (target.checked) {
                    activeLayers.add(layerId);
                } else {
                    activeLayers.delete(layerId);
                }
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                else {
                    const el = document.getElementById('layer-group-' + layerId);
                    if (el) el.style.display = target.checked ? 'block' : 'none';
                }
            } else if (target.type === 'color') {
                layerColors[layerId] = target.value;
                if (currentEngine === 'canvas') draw();
                else if (currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
                else {
                    const el = document.getElementById('layer-group-' + layerId);
                    if (el) el.style.color = target.value;
                }
            }
        });

        recenterBtn.addEventListener('click', fitView);

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