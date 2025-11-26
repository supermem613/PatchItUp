import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import * as cp from 'child_process';

const exec = promisify(cp.exec);

export class PatchPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'patchitup.panelView';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'createPatch':
                    await this.createPatch(data.sourceDir, data.projectName, data.destPath);
                    break;
                case 'applyPatch':
                    await this.applyPatch(data.patchFile, data.sourceDir);
                    break;
                case 'refreshPatches':
                    await this.refreshPatchList(data.destPath);
                    break;
                case 'getSettings':
                    await this.sendSettings();
                    break;
            }
        });

        // Send initial settings
        this.sendSettings();
    }

    private async sendSettings() {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('patchitup');
        const sourceDirectory = config.get<string>('sourceDirectory', '/tmp');
        const projectName = config.get<string>('projectName', 'project');
        const destinationPath = config.get<string>('destinationPath', '');

        this._view.webview.postMessage({
            type: 'settings',
            sourceDirectory,
            projectName,
            destinationPath
        });

        // Patches will be loaded asynchronously from the webview
    }

    private async refreshPatchList(destPath: string) {
        if (!this._view || !destPath) return;

        try {
            const isRemote = vscode.env.remoteName !== undefined;
            let patches: string[] = [];

            if (isRemote) {
                // In Codespace: read from local machine
                const dirUri = vscode.Uri.file(destPath).with({ scheme: 'vscode-local' });
                try {
                    const files = await vscode.workspace.fs.readDirectory(dirUri);
                    patches = files
                        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.patch'))
                        .map(([name]) => name)
                        .sort((a, b) => {
                            // Extract timestamp from filename (format: projectname_YYYYMMDDHHMMSS.patch)
                            const getTimestamp = (filename: string) => {
                                const match = filename.match(/_([0-9]{14})\.patch$/);
                                return match ? match[1] : '0';
                            };
                            return getTimestamp(b).localeCompare(getTimestamp(a)); // Descending
                        });
                } catch {
                    patches = [];
                }
            } else {
                // Local: read normally
                if (fs.existsSync(destPath)) {
                    patches = fs.readdirSync(destPath)
                        .filter(file => file.endsWith('.patch'))
                        .sort((a, b) => {
                            // Extract timestamp from filename (format: projectname_YYYYMMDDHHMMSS.patch)
                            const getTimestamp = (filename: string) => {
                                const match = filename.match(/_([0-9]{14})\.patch$/);
                                return match ? match[1] : '0';
                            };
                            return getTimestamp(b).localeCompare(getTimestamp(a)); // Descending
                        });
                }
            }

            this._view.webview.postMessage({
                type: 'patchList',
                patches
            });
        } catch (error) {
            console.error('Error refreshing patch list:', error);
        }
    }

    private async createPatch(sourceDir: string, projectName: string, destPath: string) {
        try {
            if (!destPath) {
                vscode.window.showErrorMessage('Please configure the destination path');
                return;
            }

            if (!fs.existsSync(sourceDir)) {
                vscode.window.showErrorMessage(`Source directory does not exist: ${sourceDir}`);
                return;
            }

            // Check for changes
            const statusCmd = `cd "${sourceDir}" && git status --porcelain`;
            const { stdout: statusOutput } = await exec(statusCmd);

            if (!statusOutput.trim()) {
                vscode.window.showInformationMessage('No changes to create a patch from.');
                return;
            }

            // Create the patch
            const patchCmd = `cd "${sourceDir}" && git diff HEAD`;
            const { stdout: patchContent } = await exec(patchCmd);

            if (!patchContent.trim()) {
                vscode.window.showInformationMessage('No changes to create a patch from.');
                return;
            }

            // Generate filename with timestamp
            const now = new Date();
            const timestamp = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0'),
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join('');
            
            const filename = `${projectName}_${timestamp}.patch`;
            
            // Write using VS Code's file system API
            const isRemote = vscode.env.remoteName !== undefined;
            let destinationUri: vscode.Uri;
            
            if (isRemote) {
                destinationUri = vscode.Uri.file(path.join(destPath, filename)).with({ scheme: 'vscode-local' });
            } else {
                destinationUri = vscode.Uri.file(path.join(destPath, filename));
            }

            const encoder = new TextEncoder();
            const patchBytes = encoder.encode(patchContent);
            
            const dirUri = vscode.Uri.joinPath(destinationUri, '..');
            try {
                await vscode.workspace.fs.createDirectory(dirUri);
            } catch {
                // Directory might already exist
            }
            
            await vscode.workspace.fs.writeFile(destinationUri, patchBytes);

            vscode.window.showInformationMessage(`Patch created: ${filename}`);
            await this.refreshPatchList(destPath);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create patch: ${errorMessage}`);
        }
    }

    private async applyPatch(patchFile: string, sourceDir: string) {
        try {
            if (!patchFile) {
                vscode.window.showWarningMessage('Please select a patch file');
                return;
            }

            if (!fs.existsSync(sourceDir)) {
                vscode.window.showErrorMessage(`Source directory does not exist: ${sourceDir}`);
                return;
            }

            const config = vscode.workspace.getConfiguration('patchitup');
            const destPath = config.get<string>('destinationPath', '');

            if (!destPath) {
                vscode.window.showErrorMessage('Destination path not configured');
                return;
            }

            // Read the patch file from local machine
            const isRemote = vscode.env.remoteName !== undefined;
            let patchContent: string;

            if (isRemote) {
                const patchUri = vscode.Uri.file(path.join(destPath, patchFile)).with({ scheme: 'vscode-local' });
                const patchBytes = await vscode.workspace.fs.readFile(patchUri);
                const decoder = new TextDecoder();
                patchContent = decoder.decode(patchBytes);
            } else {
                patchContent = fs.readFileSync(path.join(destPath, patchFile), 'utf8');
            }

            // Write patch content to a temp file in the Codespace
            const tempPatchPath = path.join(sourceDir, '.patchitup-temp.patch');
            fs.writeFileSync(tempPatchPath, patchContent, 'utf8');

            try {
                // Apply the patch
                const applyCmd = `cd "${sourceDir}" && git apply "${tempPatchPath}"`;
                await exec(applyCmd);

                vscode.window.showInformationMessage(`Patch applied successfully: ${patchFile}`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to apply patch: ${errorMessage}`);
            } finally {
                // Clean up temp file
                if (fs.existsSync(tempPatchPath)) {
                    fs.unlinkSync(tempPatchPath);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error applying patch: ${errorMessage}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Use nonce for security and cache busting
        const nonce = this.getNonce();
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>PatchItUp</title>
    <style>
        body {
            padding: 10px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            margin: 0;
        }
        .input-group {
            margin-bottom: 10px;
        }
        label {
            display: block;
            margin-bottom: 4px;
            font-size: 12px;
            color: var(--vscode-foreground);
        }
        input {
            width: 100%;
            padding: 6px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
        }
        .button-container {
            display: flex;
            margin-top: 10px;
            margin-bottom: 15px;
        }
        button {
            flex: 1;
            padding: 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            background: var(--vscode-button-secondaryBackground);
        }
        .secondary-button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .secondary-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .patch-list {
            margin-top: 10px;
            border: 1px solid var(--vscode-input-border);
            flex: 1;
            overflow-y: auto;
            background: var(--vscode-input-background);
        }
        .patch-item {
            padding: 8px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-input-border);
        }
        .patch-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .patch-item.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .section-title {
            font-size: 13px;
            font-weight: bold;
            margin: 15px 0 8px 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .refresh-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 0;
            margin: 0;
            font-size: 16px;
            opacity: 0.7;
            line-height: 1;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .refresh-button:hover {
            opacity: 1;
        }
        .button-container-bottom {
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="input-group">
        <label for="sourceDir">Source Directory</label>
        <input type="text" id="sourceDir" placeholder="/workspaces/odsp-next">
    </div>
    <div class="input-group">
        <label for="projectName">Project Name</label>
        <input type="text" id="projectName" placeholder="project">
    </div>
    <div class="input-group">
        <label for="destPath">Destination Path</label>
        <input type="text" id="destPath" placeholder="C:\\Users\\YourName\\patches">
    </div>
    
    <div class="button-container">
        <button id="createPatchBtn">Create Patch</button>
    </div>

    <div class="section-title">
        <span>Available Patches</span>
        <button id="refreshBtn" class="refresh-button" title="Refresh patch list">↻</button>
    </div>
    <div class="patch-list" id="patchList">
        <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
            No patches found
        </div>
    </div>

    <div class="button-container button-container-bottom">
        <button id="applyPatchBtn" class="secondary-button" disabled>Apply Selected Patch</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let selectedPatch = null;

        // Request settings on load
        vscode.postMessage({ type: 'getSettings' });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'settings':
                    document.getElementById('sourceDir').value = message.sourceDirectory;
                    document.getElementById('projectName').value = message.projectName;
                    document.getElementById('destPath').value = message.destinationPath;
                    // Load patches asynchronously after settings are loaded
                    if (message.destinationPath) {
                        setTimeout(() => {
                            vscode.postMessage({
                                type: 'refreshPatches',
                                destPath: message.destinationPath
                            });
                        }, 0);
                    }
                    break;
                case 'patchList':
                    updatePatchList(message.patches);
                    break;
            }
        });

        // Create patch button
        document.getElementById('createPatchBtn').addEventListener('click', () => {
            const sourceDir = document.getElementById('sourceDir').value;
            const projectName = document.getElementById('projectName').value;
            const destPath = document.getElementById('destPath').value;
            
            vscode.postMessage({
                type: 'createPatch',
                sourceDir,
                projectName,
                destPath
            });
        });

        // Refresh button
        document.getElementById('refreshBtn').addEventListener('click', () => {
            const destPath = document.getElementById('destPath').value;
            if (destPath) {
                vscode.postMessage({
                    type: 'refreshPatches',
                    destPath
                });
            }
        });

        // Apply patch button
        document.getElementById('applyPatchBtn').addEventListener('click', () => {
            if (!selectedPatch) {
                return;
            }
            const sourceDir = document.getElementById('sourceDir').value;
            
            vscode.postMessage({
                type: 'applyPatch',
                patchFile: selectedPatch,
                sourceDir
            });
        });

        // Update patch list
        function updatePatchList(patches) {
            const patchList = document.getElementById('patchList');
            const applyBtn = document.getElementById('applyPatchBtn');
            
            if (!patches || patches.length === 0) {
                patchList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No patches found</div>';
                selectedPatch = null;
                applyBtn.disabled = true;
                return;
            }

            patchList.innerHTML = '';
            patches.forEach(patch => {
                const item = document.createElement('div');
                item.className = 'patch-item';
                item.textContent = patch;
                item.addEventListener('click', () => {
                    document.querySelectorAll('.patch-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    selectedPatch = patch;
                    applyBtn.disabled = false;
                });
                patchList.appendChild(item);
            });
        }

        // Refresh patches when destination path changes
        document.getElementById('destPath').addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'refreshPatches',
                destPath: e.target.value
            });
        });
    </script>
</body>
</html>`;
    }

    private getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
