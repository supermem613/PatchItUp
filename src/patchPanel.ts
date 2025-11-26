import * as vscode from 'vscode';
import * as path from 'path';

export class PatchPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'patchitup.panelView';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    // Execute git command and get output via temp file
    private async executeGitCommand(args: string[], cwd: string): Promise<string> {
        // Get any workspace folder (or use the first one if available)
        let workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        // Create temp file for output
        const tempFileName = `.patchitup-temp-${Date.now()}.txt`;
        
        // If cwd matches the workspace path, use it directly; otherwise construct the URI
        // This handles cases where cwd might be the full path like /workspaces/odsp-web
        let cwdUri: vscode.Uri;
        if (cwd === workspaceFolder.uri.fsPath || cwd === workspaceFolder.uri.path) {
            cwdUri = workspaceFolder.uri;
        } else if (cwd.startsWith('/') && workspaceFolder.uri.path === cwd) {
            // Remote path matches exactly
            cwdUri = workspaceFolder.uri;
        } else {
            // Try to construct URI with the cwd as is - it might be an absolute path in remote
            cwdUri = workspaceFolder.uri.with({ path: cwd });
        }
            
        const tempUri = vscode.Uri.joinPath(cwdUri, tempFileName);
        console.log('executeGitCommand:', { cwd, workspacePath: workspaceFolder.uri.path, cwdUri: cwdUri.toString(), tempUri: tempUri.toString() });

        try {
            // Execute git command with output redirection (use relative path)
            const shellCmd = `git ${args.join(' ')} > "${tempFileName}" 2>&1`;
            
            const execution = new vscode.ShellExecution(shellCmd, { cwd });
            const task = new vscode.Task(
                { type: 'shell' },
                workspaceFolder,
                'Git Command',
                'patchitup',
                execution
            );

            await new Promise<void>((resolve, reject) => {
                vscode.tasks.executeTask(task).then(taskExecution => {
                    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                        if (e.execution === taskExecution) {
                            disposable.dispose();
                            if (e.exitCode === 0) {
                                resolve();
                            } else {
                                reject(new Error(`Git command failed with exit code ${e.exitCode}`));
                            }
                        }
                    });

                    setTimeout(() => {
                        disposable.dispose();
                        reject(new Error('Command timeout'));
                    }, 30000);
                });
            });

            // Read the output file using workspace fs API
            const outputBytes = await vscode.workspace.fs.readFile(tempUri);
            const decoder = new TextDecoder();
            const output = decoder.decode(outputBytes);

            // Clean up
            await vscode.workspace.fs.delete(tempUri);

            return output;
        } catch (error) {
            // Try to clean up temp file
            try {
                await vscode.workspace.fs.delete(tempUri);
            } catch {}
            throw error;
        }
    }

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
                case 'updateSetting':
                    await this.updateSetting(data.key, data.value);
                    break;
            }
        });

        // Send initial settings
        this.sendSettings();
    }

    private async updateSetting(key: string, value: string) {
        const config = vscode.workspace.getConfiguration('patchitup');
        await config.update(key, value, vscode.ConfigurationTarget.Global);
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
        console.log('refreshPatchList called:', { hasView: !!this._view, destPath });
        
        if (!this._view) {
            console.log('refreshPatchList: view not available');
            vscode.window.showWarningMessage('PatchItUp: View not available for refresh');
            return;
        }
        
        if (!destPath) {
            console.log('refreshPatchList: destPath not provided');
            vscode.window.showWarningMessage('PatchItUp: Destination path not configured');
            this._view.webview.postMessage({
                type: 'patchList',
                patches: []
            });
            return;
        }

        try {
            const isRemote = vscode.env.remoteName !== undefined;
            console.log('refreshPatchList:', { isRemote, remoteName: vscode.env.remoteName, destPath, uiKind: vscode.env.uiKind });
            let patches: string[] = [];

            // Always try vscode-local first (for remote scenarios), fall back to regular file
            let dirUri = vscode.Uri.file(destPath).with({ scheme: 'vscode-local' });
            console.log('Trying vscode-local URI:', dirUri.toString());
            
            try {
                const files = await vscode.workspace.fs.readDirectory(dirUri);
                console.log('Found files with vscode-local:', files.length);
                
                // Get file stats for each patch file
                const patchFiles = files
                    .filter(([name, type]) => {
                        const isPatch = type === vscode.FileType.File && name.endsWith('.patch');
                        if (isPatch) console.log('Found patch file:', name);
                        return isPatch;
                    })
                    .map(([name]) => name);
                
                // Get creation times for all patch files
                const filesWithStats = await Promise.all(
                    patchFiles.map(async (name) => {
                        const fileUri = vscode.Uri.joinPath(dirUri, name);
                        const stat = await vscode.workspace.fs.stat(fileUri);
                        return { name, ctime: stat.ctime };
                    })
                );
                
                // Sort by creation time, newest first
                patches = filesWithStats
                    .sort((a, b) => {
                        console.log('Comparing:', a.name, '(', a.ctime, ') vs', b.name, '(', b.ctime, '), result:', b.ctime - a.ctime);
                        return b.ctime - a.ctime;
                    })
                    .map(f => f.name);
                console.log('Filtered patches:', patches);
            } catch (error: any) {
                // If vscode-local fails, try regular file scheme (for local-only scenarios)
                console.log('vscode-local failed, error:', error, 'code:', error.code, 'name:', error.name);
                if (error.code === 'ENOPRO' || error.name === 'EntryNotFound (FileSystemError)' || error.message?.includes('No file system provider')) {
                    console.log('Fallback: trying regular file scheme');
                    try {
                        dirUri = vscode.Uri.file(destPath);
                        console.log('Using file URI:', dirUri.toString());
                        const files = await vscode.workspace.fs.readDirectory(dirUri);
                        console.log('Found files with file scheme:', files.length);
                        
                        // Get file stats for each patch file
                        const patchFiles = files
                            .filter(([name, type]) => {
                                const isPatch = type === vscode.FileType.File && name.endsWith('.patch');
                                if (isPatch) console.log('Found patch file:', name);
                                return isPatch;
                            })
                            .map(([name]) => name);
                        
                        // Get creation times for all patch files
                        const filesWithStats = await Promise.all(
                            patchFiles.map(async (name) => {
                                const fileUri = vscode.Uri.joinPath(dirUri, name);
                                const stat = await vscode.workspace.fs.stat(fileUri);
                                return { name, ctime: stat.ctime };
                            })
                        );
                        
                        // Sort by creation time, newest first
                        patches = filesWithStats
                            .sort((a, b) => {
                                console.log('Comparing:', a.name, '(', a.ctime, ') vs', b.name, '(', b.ctime, '), result:', b.ctime - a.ctime);
                                return b.ctime - a.ctime;
                            })
                            .map(f => f.name);
                        console.log('Filtered patches:', patches);
                    } catch (innerError: any) {
                        console.error('Error reading with file scheme:', innerError);
                        vscode.window.showErrorMessage(`Could not read patches from ${destPath}: ${innerError.message || innerError}`);
                        patches = [];
                    }
                } else {
                    console.error('Error reading directory (not fallback case):', error);
                    vscode.window.showErrorMessage(`Could not read patches from ${destPath}: ${error.message || error}`);
                    patches = [];
                }
            }

            console.log('Sending patch list to webview:', patches.length, 'patches');
            this._view.webview.postMessage({
                type: 'patchList',
                patches
            });
        } catch (error: any) {
            console.error('Error refreshing patch list:', error);
            vscode.window.showErrorMessage(`Error refreshing patch list: ${error.message || error}`);
        }
    }

    // Public method that can be called from the command
    public async createPatchFromCommand(sourceDir: string, projectName: string, destPath: string) {
        await this.createPatch(sourceDir, projectName, destPath);
    }

    private async createPatch(sourceDir: string, projectName: string, destPath: string) {
        try {
            if (!destPath) {
                vscode.window.showErrorMessage('Please configure the destination path');
                return;
            }

            const isRemote = vscode.env.remoteName !== undefined;
            console.log('createPatch:', { isRemote, sourceDir, destPath });

            // Check for changes using executeGitCommand
            let patchContent: string;
            try {
                patchContent = await this.executeGitCommand(['diff', 'HEAD'], sourceDir);

                if (!patchContent.trim()) {
                    vscode.window.showInformationMessage('No changes to create a patch from.');
                    return;
                }
            } catch (error: any) {
                const msg = isRemote 
                    ? `Could not access source directory in Codespace: ${sourceDir}\n\n${error.message}`
                    : `Could not access source directory: ${sourceDir}\n\n${error.message}`;
                vscode.window.showErrorMessage(msg);
                return;
            }

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
            
            // Write using VS Code's file system API - try vscode-local first, fall back to file
            const encoder = new TextEncoder();
            const patchBytes = encoder.encode(patchContent);
            
            let destinationUri = vscode.Uri.file(path.join(destPath, filename)).with({ scheme: 'vscode-local' });
            let dirUri = vscode.Uri.joinPath(destinationUri, '..');
            
            try {
                console.log('Attempting to write patch with vscode-local scheme to:', destinationUri.toString());
                await vscode.workspace.fs.createDirectory(dirUri);
                await vscode.workspace.fs.writeFile(destinationUri, patchBytes);
                console.log('Successfully wrote patch with vscode-local');
            } catch (error: any) {
                // If vscode-local fails, try regular file scheme
                console.log('vscode-local write failed, error:', error, 'code:', error.code);
                if (error.code === 'ENOPRO' || error.message?.includes('No file system provider')) {
                    console.log('Fallback: trying regular file scheme for write');
                    destinationUri = vscode.Uri.file(path.join(destPath, filename));
                    dirUri = vscode.Uri.joinPath(destinationUri, '..');
                    await vscode.workspace.fs.createDirectory(dirUri);
                    await vscode.workspace.fs.writeFile(destinationUri, patchBytes);
                    console.log('Successfully wrote patch with file scheme');
                } else {
                    throw error;
                }
            }

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

            const config = vscode.workspace.getConfiguration('patchitup');
            const destPath = config.get<string>('destinationPath', '');

            if (!destPath) {
                vscode.window.showErrorMessage('Destination path not configured');
                return;
            }

            console.log('applyPatch:', { patchFile, sourceDir, destPath });

            // Read the patch file from local machine - try vscode-local first
            let patchContent: string;
            const decoder = new TextDecoder();

            try {
                console.log('Attempting to read patch with vscode-local scheme');
                const patchUri = vscode.Uri.file(path.join(destPath, patchFile)).with({ scheme: 'vscode-local' });
                const patchBytes = await vscode.workspace.fs.readFile(patchUri);
                patchContent = decoder.decode(patchBytes);
                console.log('Successfully read patch with vscode-local');
            } catch (error: any) {
                // If vscode-local fails, try regular file scheme
                console.log('vscode-local read failed, error:', error, 'code:', error.code);
                if (error.code === 'ENOPRO' || error.message?.includes('No file system provider')) {
                    console.log('Fallback: trying regular file scheme for read');
                    const patchUri = vscode.Uri.file(path.join(destPath, patchFile));
                    const patchBytes = await vscode.workspace.fs.readFile(patchUri);
                    patchContent = decoder.decode(patchBytes);
                    console.log('Successfully read patch with file scheme');
                } else {
                    throw error;
                }
            }

            // Write patch to temp file in workspace and apply it using git command
            const tempPatchFile = path.join(sourceDir, '.patchitup-temp.patch');
            const tempPatchUri = vscode.Uri.file(tempPatchFile);
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(tempPatchUri, encoder.encode(patchContent));

            try {
                // Apply using git command via Task API
                await this.executeGitCommand(['apply', tempPatchFile], sourceDir);
                vscode.window.showInformationMessage(`Patch applied successfully: ${patchFile}`);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to apply patch: ${error.message || error}`);
            } finally {
                // Clean up temp file
                try {
                    await vscode.workspace.fs.delete(tempPatchUri);
                } catch {
                    // Ignore cleanup errors
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
            font-size: 12px;
            opacity: 0.7;
            line-height: 1;
            width: 14px;
            height: 14px;
            min-width: 14px;
            min-height: 14px;
            max-width: 14px;
            max-height: 14px;
            flex: none;
            flex-shrink: 0;
            flex-grow: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            box-sizing: border-box;
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
        <button id="refreshBtn" class="refresh-button" title="Refresh patch list" aria-label="Refresh">↻</button>
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
            const destPath = e.target.value;
            vscode.postMessage({
                type: 'updateSetting',
                key: 'destinationPath',
                value: destPath
            });
            vscode.postMessage({
                type: 'refreshPatches',
                destPath: destPath
            });
        });

        // Update settings when source directory changes
        document.getElementById('sourceDir').addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'sourceDirectory',
                value: e.target.value
            });
        });

        // Update settings when project name changes
        document.getElementById('projectName').addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'updateSetting',
                key: 'projectName',
                value: e.target.value
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
