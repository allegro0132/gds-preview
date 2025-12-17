import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "gds-preview" is now active!');

    const disposable = vscode.commands.registerCommand('gds-preview.previewGds', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }

        const document = editor.document;
        const filePath = document.uri.fsPath;
        const fileExtension = path.extname(filePath).toLowerCase();

        const supportedExtensions = ['.gds', '.gdsii', '.oas'];
        if (!supportedExtensions.includes(fileExtension)) {
            vscode.window.showErrorMessage(`This command can only be used with ${supportedExtensions.join(', ')} files.`);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gdsPreview',
            `Preview: ${path.basename(filePath)}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(os.tmpdir())] // Allow access to temp dir
            }
        );

        const tempDir = path.join(os.tmpdir(), `gds_preview_data_${Date.now()}`);
        const pythonScriptPath = context.asAbsolutePath(path.join('scripts', 'gds_to_svg.py'));
        const pythonPath = 'python3';

        const process = cp.spawn(pythonPath, [pythonScriptPath, filePath, tempDir]);

        let stdout = '';
        let stderr = '';
        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code !== 0) {
                try {
                    const errJson = JSON.parse(stderr);
                    vscode.window.showErrorMessage(`Failed to convert GDS: ${errJson.error}`);
                } catch {
                    vscode.window.showErrorMessage(`Failed to convert GDS. Exit code: ${code}. Stderr: ${stderr}`);
                }
                panel.dispose();
                return;
            }

            try {
                const result = JSON.parse(stdout);
                panel.webview.html = getWebviewContent(result);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to parse layer data: ${e.message}`);
                panel.dispose();
            }
        });

        panel.onDidDispose(() => {
            fs.rm(tempDir, { recursive: true, force: true }, (err) => {
                if (err) {
                    console.error(`Failed to delete temporary directory: ${tempDir}`, err);
                }
            });
        });
    });

    context.subscriptions.push(disposable);
}

function getWebviewContent(data: { layers: string[], svg_fragments: { [key: string]: string }, bbox: any }): string {
    const nonce = getNonce();
    const svgPanZoomCdn = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";

    const defaultColors: { [key: string]: string } = {
        "0_0": "#C2185B", "1_0": "#512DA8", "2_0": "#00796B", "3_0": "#FBC02D",
        "4_0": "#E64A19", "5_0": "#303F9F", "6_0": "#D32F2F", "7_0": "#455A64",
        "default": "#888888"
    };

    let layersHtml = '';
    for (const layerKey of data.layers) {
        const defaultColor = defaultColors[layerKey] || defaultColors["default"];
        layersHtml += `
            <div class="layer-toggle">
                <input type="checkbox" id="toggle-${layerKey}" data-layer-id="layer-group-${layerKey}" checked>
                <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
                <input type="color" id="color-${layerKey}" data-layer-id="layer-group-${layerKey}" value="${defaultColor}">
            </div>
        `;
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
        svgGroupsHtml += `<g id="layer-group-${layerKey}" class="gds-layer" style="color: ${defaultColors[layerKey] || defaultColors["default"]};">
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
        .layer-toggle { display: flex; align-items: center; margin-bottom: 5px; white-space: nowrap; }
        .layer-toggle input[type="checkbox"] { margin-right: 5px; }
        .layer-toggle input[type="color"] { margin-left: auto; width: 30px; height: 20px; padding: 0; border: none; background: none;}
        #recenter-btn { margin-top: 10px; padding: 8px; background-color: #444; color: #fff; border: 1px solid #666; cursor: pointer; }
        #recenter-btn:hover { background-color: #555; }
        #layers-list { margin-top: 10px; flex-grow: 1; overflow-y: auto; }
    </style>
</head>
<body>
    <div id="controls">
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
        window.addEventListener('load', function() {
            function setLayerColor(layerId, color) {
                const layerGroupElement = document.getElementById(layerId);
                if (layerGroupElement) {
                    layerGroupElement.style.color = color;
                }
            }

            const controls = document.getElementById('controls');
            const recenterBtn = document.getElementById('recenter-btn');

            controls.addEventListener('change', function(event) {
                const target = event.target;
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
                maxZoom: 50
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