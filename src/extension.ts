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

        const supportedExtensions = ['.gds', '.gdsii', '.oas', '.GDS', '.OAS'];
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
                localResourceRoots: [vscode.Uri.file(path.dirname(filePath))]
            }
        );

        const tempDir = os.tmpdir();
        const tempSvgPath = path.join(tempDir, `${path.basename(filePath)}.${Date.now()}.svg`);
        const pythonScriptPath = context.asAbsolutePath(path.join('scripts', 'gds_to_svg.py'));

        const pythonPath = 'python3'; 

        const process = cp.spawn(pythonPath, [pythonScriptPath, filePath, tempSvgPath]);

        let stderr = '';
        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code !== 0) {
                vscode.window.showErrorMessage(`Failed to convert GDS to SVG. Exit code: ${code}. Error: ${stderr}`);
                panel.dispose();
                return;
            }

            fs.readFile(tempSvgPath, 'utf8', (err, svgContent) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to read temporary SVG file: ${err.message}`);
                    panel.dispose();
                    return;
                }
                panel.webview.html = getWebviewContent(svgContent);
            });
        });

        panel.onDidDispose(() => {
            fs.unlink(tempSvgPath, (err) => {
                if (err) {
                    console.error(`Failed to delete temporary file: ${tempSvgPath}`, err);
                }
            });
        });
    });

    context.subscriptions.push(disposable);
}

function getWebviewContent(svgContent: string): string {
    const nonce = getNonce();
    const svgPanZoomCdn = "https://cdn.jsdelivr.net/npm/svg-pan-zoom/dist/svg-pan-zoom.min.js";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GDS Preview</title>
    <style>
        html, body, #gds-container {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #1e1e1e;
        }
        svg {
            width: 100%;
            height: 100%;
            display: block;
        }
    </style>
</head>
<body>
    <div id="gds-container" style="width: 100%; height: 100%;">
        ${svgContent}
    </div>
    <script src="${svgPanZoomCdn}"></script>
    <script nonce="${nonce}">
        window.addEventListener('load', function() {
            // Using the official svg-pan-zoom library API
            var panZoomInstance = svgPanZoom('#gds-container svg', {
                panEnabled: true,
                zoomEnabled: true,
                controlIconsEnabled: false,
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 50
            });

            // Handle window resize
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
