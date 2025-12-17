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

        const updateWebview = (cellName?: string) => {
            const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);
            const pythonScriptPath = this.context.asAbsolutePath(path.join('scripts', 'gds_to_svg.py'));
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
                    webviewPanel.webview.html = getWebviewContent(result);
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

        // Initial render
        updateWebview();

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            message => {
                console.log(`Received message: ${JSON.stringify(message)}`);
                switch (message.command) {
                    case 'changeCell':
                        updateWebview(message.cellName);
                        return;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }
}

function getWebviewContent(data: { cell_name: string, all_cells: string[], layers: string[], svg_fragments: { [key: string]: string }, bbox: any }): string {
    const nonce = getNonce();
    const svgPanZoomCdn = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";

    // Extended palette for automatic color assignment
    const palette = [
        "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#800000",
        "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
        "#008080", "#e6beff", "#9a6324", "#e6194b", "#fffac8",
        "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080"
    ];

    const layerColors: { [key: string]: string } = {};
    let layersHtml = '';

    for (const layerKey of data.layers) {
        // Determine color based on layer number
        let color = "#888888";
        const parts = layerKey.split('_');
        if (parts.length >= 1) {
            const layerNum = parseInt(parts[0]);
            if (!isNaN(layerNum)) {
                color = palette[layerNum % palette.length];
            } else {
                 // Hash string if not a number
                 let hash = 0;
                 for (let i = 0; i < layerKey.length; i++) {
                    hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                 }
                 color = palette[Math.abs(hash) % palette.length];
            }
        }
        layerColors[layerKey] = color;

        layersHtml += `
            <div class="layer-toggle">
                <input type="checkbox" id="toggle-${layerKey}" data-layer-id="layer-group-${layerKey}" checked>
                <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
                <input type="color" id="color-${layerKey}" data-layer-id="layer-group-${layerKey}" value="${color}">
            </div>
        `;
    }

    let cellsOptionsHtml = '';
    for (const cell of data.all_cells) {
        // Simple escaping for HTML attribute
        const safeCell = cell.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const selected = cell === data.cell_name ? 'selected' : '';
        cellsOptionsHtml += `<option value="${safeCell}" ${selected}>${safeCell}</option>`;
    }

    const bboxWidth = data.bbox.x_max - data.bbox.x_min;
    const bboxHeight = data.bbox.y_max - data.bbox.y_min;
    // Use the original, non-normalized viewBox from gdstk's bounding box
    // gdstk flips Y axis, so we need to adjust viewBox to match the flipped coordinates
    const viewBoxString = `${data.bbox.x_min} ${-data.bbox.y_max} ${bboxWidth} ${bboxHeight}`;

    let svgGroupsHtml = '';
    // Add the invisible "overall" rectangle first, to define the full extent for svg-pan-zoom

    for (const layerKey of data.layers) {
        const fragment = data.svg_fragments[layerKey];
        // The fragments are already correctly positioned in the original coordinate system
        svgGroupsHtml += `<g id="layer-group-${layerKey}" class="gds-layer" style="color: ${layerColors[layerKey]};">
            ${fragment}
        </g>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GDS Preview</title>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #1e1e1e; color: #ccc; display: flex; font-family: sans-serif; font-size: 14px;}
        #view-container { flex-grow: 1; position: relative; height: 100%; }
        #root-svg-for-panzoom { width: 100%; height: 100%; display: block; }
        .gds-layer path, .gds-layer polygon, .gds-layer text {
            fill: currentColor;
            stroke: currentColor;
        }
        #controls { width: 250px; height: 100%; overflow-y: auto; background-color: #252526; padding: 10px; box-sizing: border-box; display: flex; flex-direction: column;}
        .layer-toggle input[type="checkbox"] { margin-right: 5px; }
        .layer-toggle input[type="color"] { margin-left: auto; width: 30px; height: 20px; padding: 0; border: none; background: none;}
        #recenter-btn { margin-top: 10px; padding: 8px; background-color: #444; color: #fff; border: 1px solid #666; cursor: pointer; }
        #recenter-btn:hover { background-color: #555; }
        #layers-list { margin-top: 10px; flex-grow: 1; overflow-y: auto; }
        .control-group { margin-bottom: 15px; }
        .control-group label { display: block; margin-bottom: 5px; font-weight: bold; }
        select { width: 100%; padding: 5px; background-color: #3c3c3c; color: #ccc; border: 1px solid #555; }
    </style>
</head>
<body>
    <div id="controls">
        <div class="control-group">
            <label for="cell-select">Select Cell:</label>
            <select id="cell-select">
                ${cellsOptionsHtml}
            </select>
            <div id="status-msg" style="font-size: 12px; color: #888; margin-top: 5px;">Ready</div>
        </div>
        <h3>View Control</h3>
        <button id="recenter-btn">Center View</button>
        <hr style="width: 100%; border-color: #444; margin: 15px 0;">
        <h3>Layers</h3>
        <div id="layers-list">
            ${layersHtml}
        </div>
    </div>
    <div id="view-container">
        <svg id="root-svg-for-panzoom" viewBox="${viewBoxString}" width="100%" height="100%">
            ${svgGroupsHtml}
        </svg>
    </div>

    <script src="${svgPanZoomCdn}"></script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        console.log("GDS Preview: Script initialized");

        window.addEventListener('load', function() {
            function setLayerColor(layerId, color) {
                const layerGroupElement = document.getElementById(layerId);
                if (layerGroupElement) {
                    layerGroupElement.style.color = color;
                }
            }

            const controls = document.getElementById('controls');
            const recenterBtn = document.getElementById('recenter-btn');
            const cellSelect = document.getElementById('cell-select');
            const statusMsg = document.getElementById('status-msg');

            function updateStatus(msg) {
                if (statusMsg) statusMsg.textContent = msg;
                console.log("Status:", msg);
            }

            if (cellSelect) {
                cellSelect.addEventListener('change', function(e) {
                    const selectedCell = e.target.value;
                    updateStatus("Loading cell: " + selectedCell + "...");
                    console.log("GDS Preview: Cell selection changed to:", selectedCell);
                    vscode.postMessage({
                        command: 'changeCell',
                        cellName: selectedCell
                    });
                });
            } else {
                console.error("GDS Preview: Cell select element not found!");
            }

            controls.addEventListener('change', function(event) {
                const target = event.target;
                if (target.id === 'cell-select') return; // Handled separately

                const layerId = target.getAttribute('data-layer-id');
                const layerGroupElement = document.getElementById(layerId);

                if (layerGroupElement) {
                    if (target.type === 'checkbox') {
                        layerGroupElement.style.display = target.checked ? 'block' : 'none';
                    } else if (target.type === 'color') {
                        setLayerColor(layerId, target.value);
                    }
                }
            });

            document.querySelectorAll('#controls input[type="color"]').forEach(colorInput => {
                const layerId = colorInput.getAttribute('data-layer-id');
                setLayerColor(layerId, colorInput.value);
            });

            const panZoomInstance = svgPanZoom('#root-svg-for-panzoom', {
                panEnabled: true,
                zoomEnabled: true,
                controlIconsEnabled: false,
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 100
            });

            setTimeout(() => {
                panZoomInstance.resize();
                panZoomInstance.fit();
                panZoomInstance.center();
            }, 100);

            recenterBtn.addEventListener('click', function() {
                panZoomInstance.fit();
                panZoomInstance.center();
            });

            window.addEventListener('resize', function() {
                panZoomInstance.resize();
                panZoomInstance.fit();
                panZoomInstance.center();
            });
        });
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
export function deactivate() {}