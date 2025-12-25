import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { type PatchFileEdit, parseGitPatchFileEdits } from './patchParsing';

export class PatchPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'patchitup.panelView';
    private _view?: vscode.WebviewView;
    private _isRemoteLocalMachine: boolean | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    /**
     * Determines if the current remote environment is actually the local machine.
     * This can happen with:
     * - WSL on the same Windows machine
     * - Dev Containers running locally
     * - SSH to localhost
     * 
     * When the remote IS the local machine, we can use regular file:// scheme
     * instead of vscode-local:// for better performance and simpler code paths.
     */
    private async isRemoteLocalMachine(): Promise<boolean> {
        // Cache the result since this shouldn't change during a session
        if (this._isRemoteLocalMachine !== undefined) {
            return this._isRemoteLocalMachine;
        }

        const remoteName = vscode.env.remoteName;
        
        // Not running remotely at all
        if (remoteName === undefined) {
            this._isRemoteLocalMachine = false;
            console.log('isRemoteLocalMachine: not remote, returning false');
            return false;
        }

        console.log('isRemoteLocalMachine: checking remote type:', remoteName);

        // WSL is always on the local machine
        if (remoteName === 'wsl') {
            this._isRemoteLocalMachine = true;
            console.log('isRemoteLocalMachine: WSL detected, returning true');
            return true;
        }

        // Dev Containers can be local or remote - check if Docker is running locally
        if (remoteName === 'dev-container' || remoteName === 'attached-container') {
            // Dev containers running locally typically have access to the same hostname
            // We can check if the container's hostname resolves to localhost-like addresses
            try {
                const hostname = os.hostname();
                // If we can get the hostname and it matches common local patterns, it's local
                const isLocal = this.isLocalhostHostname(hostname);
                this._isRemoteLocalMachine = isLocal;
                console.log('isRemoteLocalMachine: Dev Container, hostname:', hostname, 'isLocal:', isLocal);
                return isLocal;
            } catch {
                // If we can't determine, assume it's not local (safer default)
                this._isRemoteLocalMachine = false;
                return false;
            }
        }

        // SSH could be to localhost
        if (remoteName === 'ssh-remote') {
            // Try to detect if SSH is to localhost by checking environment or hostname
            try {
                const hostname = os.hostname();
                const isLocal = this.isLocalhostHostname(hostname);
                this._isRemoteLocalMachine = isLocal;
                console.log('isRemoteLocalMachine: SSH, hostname:', hostname, 'isLocal:', isLocal);
                return isLocal;
            } catch {
                this._isRemoteLocalMachine = false;
                return false;
            }
        }

        // Codespaces and other cloud-based remotes are never local
        if (remoteName === 'codespaces' || remoteName === 'github-codespaces') {
            this._isRemoteLocalMachine = false;
            console.log('isRemoteLocalMachine: Codespaces detected, returning false');
            return false;
        }

        // For unknown remote types, default to not local (safer)
        this._isRemoteLocalMachine = false;
        console.log('isRemoteLocalMachine: unknown remote type, returning false');
        return false;
    }

    /**
     * Checks if a hostname indicates localhost
     */
    private isLocalhostHostname(hostname: string): boolean {
        const lowerHostname = hostname.toLowerCase();
        return lowerHostname === 'localhost' ||
               lowerHostname === '127.0.0.1' ||
               lowerHostname === '::1' ||
               lowerHostname.endsWith('.local') ||
               lowerHostname.startsWith('localhost');
    }

    /**
     * Determines if we should use the vscode-local scheme for accessing local files.
     * Returns true only when running in a true remote environment (not local machine).
     */
    private async shouldUseVscodeLocalScheme(): Promise<boolean> {
        const isRemote = vscode.env.remoteName !== undefined;
        if (!isRemote) {
            return false;
        }
        
        const isLocalMachine = await this.isRemoteLocalMachine();
        // Use vscode-local only when remote AND not the local machine
        return !isLocalMachine;
    }

    /**
     * Gets the appropriate URI for a local file path, taking into account
     * whether we're in a remote environment that needs the vscode-local scheme.
     */
    private async getLocalFileUri(filePath: string): Promise<vscode.Uri> {
        const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
        if (useVscodeLocal) {
            return vscode.Uri.file(filePath).with({ scheme: 'vscode-local' });
        }
        return vscode.Uri.file(filePath);
    }

    // Execute git command and get output via temp file
    private async executeGitCommand(args: string[], cwd: string, allowedExitCodes: number[] = [0]): Promise<string> {
        // Prefer the first workspace folder when available, but allow running without one
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        // Remote inference: if we're running on a remote extension host, treat paths as posix.
        // This keeps behavior consistent even when no folder is opened.
        const isRemote = vscode.env.remoteName !== undefined;

        // Normalize the cwd based on environment
        const normalizedCwd = isRemote ? cwd.trim().replace(/\\/g, '/') : cwd.trim();
        const shellCwd = normalizedCwd;

        // Write command output to a temp file (avoids requiring write access to cwd)
        const tempOutputPath = path.join(os.tmpdir(), `.patchitup-temp-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
        const tempUri = vscode.Uri.file(tempOutputPath);

        console.log('executeGitCommand:', { cwd, normalizedCwd, shellCwd, isRemote, tempOutputPath, hasWorkspaceFolder: !!workspaceFolder });

        try {
            // Execute git command with output redirection
            const quotedArgs = args.map(a => {
                // Basic cross-shell quoting for args containing whitespace or quotes
                if (!/[\s"]/g.test(a)) {
                    return a;
                }
                return `"${a.replace(/"/g, '\\"')}"`;
            }).join(' ');
            const shellCmd = `git ${quotedArgs} > "${tempOutputPath}" 2>&1`;

            const execution = new vscode.ShellExecution(shellCmd, { cwd: shellCwd });
            const task = new vscode.Task(
                { type: 'shell' },
                workspaceFolder ?? vscode.TaskScope.Global,
                'Git Command',
                'patchitup',
                execution
            );

            await new Promise<void>((resolve, reject) => {
                vscode.tasks.executeTask(task).then(taskExecution => {
                    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                        if (e.execution === taskExecution) {
                            disposable.dispose();
                            if (allowedExitCodes.includes(e.exitCode ?? -1)) {
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
            // Try to read the output before cleaning up to get error details
            let errorOutput = '';
            try {
                const outputBytes = await vscode.workspace.fs.readFile(tempUri);
                const decoder = new TextDecoder();
                errorOutput = decoder.decode(outputBytes);
            } catch {}

            // Try to clean up temp file
            try {
                await vscode.workspace.fs.delete(tempUri);
            } catch {}
            
            // Include the git error output in the error message if available
            if (errorOutput.trim()) {
                const originalMessage = error instanceof Error ? error.message : String(error);
                throw new Error(`${originalMessage}\nGit output: ${errorOutput.trim()}`);
            }
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
                case 'diffPatch':
                    await this.diffPatch(data.patchFile, data.sourceDir);
                    break;
                case 'openPatch':
                    await this.openPatchForEdit(data.patchFile);
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
            const isRemoteLocal = await this.isRemoteLocalMachine();
            const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
            console.log('refreshPatchList:', { isRemote, isRemoteLocal, useVscodeLocal, remoteName: vscode.env.remoteName, destPath, uiKind: vscode.env.uiKind });
            let patches: string[] = [];

            // Use the appropriate URI scheme based on environment detection
            let dirUri = await this.getLocalFileUri(destPath);
            console.log('Using URI:', dirUri.toString());
            
            try {
                const files = await vscode.workspace.fs.readDirectory(dirUri);
                console.log('Found files:', files.length);
                
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
                // If vscode-local fails and we're using it, try regular file scheme as fallback
                console.log('Initial scheme failed, error:', error, 'code:', error.code, 'name:', error.name);
                if (useVscodeLocal && (error.code === 'ENOPRO' || error.name === 'EntryNotFound (FileSystemError)' || error.message?.includes('No file system provider'))) {
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
            const isRemoteLocal = await this.isRemoteLocalMachine();
            const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
            console.log('createPatch:', { isRemote, isRemoteLocal, useVscodeLocal, sourceDir, destPath });

            // Check for changes using executeGitCommand
            let patchContent: string;
            try {
                patchContent = await this.executeGitCommand(['diff', 'HEAD'], sourceDir);

                if (!patchContent.trim()) {
                    vscode.window.showInformationMessage('No changes to create a patch from.');
                    return;
                }
            } catch (error: any) {
                // Provide context-appropriate error message
                let msg: string;
                if (isRemote && !isRemoteLocal) {
                    msg = `Could not access source directory in remote environment: ${sourceDir}\n\n${error.message}`;
                } else if (isRemote && isRemoteLocal) {
                    msg = `Could not access source directory (local remote): ${sourceDir}\n\n${error.message}`;
                } else {
                    msg = `Could not access source directory: ${sourceDir}\n\n${error.message}`;
                }
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
            
            // Write using VS Code's file system API with appropriate scheme
            const encoder = new TextEncoder();
            const patchBytes = encoder.encode(patchContent);
            
            let destinationUri = await this.getLocalFileUri(path.join(destPath, filename));
            let dirUri = vscode.Uri.joinPath(destinationUri, '..');
            
            try {
                console.log('Attempting to write patch to:', destinationUri.toString());
                await vscode.workspace.fs.createDirectory(dirUri);
                await vscode.workspace.fs.writeFile(destinationUri, patchBytes);
                console.log('Successfully wrote patch');
            } catch (error: any) {
                // If vscode-local fails and we were using it, try regular file scheme as fallback
                console.log('Write failed, error:', error, 'code:', error.code);
                if (useVscodeLocal && (error.code === 'ENOPRO' || error.message?.includes('No file system provider'))) {
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

            const patchContent = await this.readPatchFromConfiguredDestination(patchFile);

            // Write patch to temp file in workspace and apply it using git command
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder open');
            }

            // Determine if we're in a remote environment
            const isRemote = !!workspaceFolder.uri.authority;
            
            // Normalize sourceDir based on environment
            const normalizedSourceDir = isRemote 
                ? sourceDir.trim().replace(/\\/g, '/')
                : sourceDir.trim();
            
            // Get the workspace path in the appropriate format
            const workspacePath = isRemote ? workspaceFolder.uri.path : workspaceFolder.uri.fsPath;

            // Construct URI for temp patch file in the workspace
            let cwdUri: vscode.Uri;
            if (normalizedSourceDir === workspacePath || normalizedSourceDir === workspaceFolder.uri.path || normalizedSourceDir === workspaceFolder.uri.fsPath) {
                cwdUri = workspaceFolder.uri;
            } else {
                if (isRemote) {
                    // Remote: ensure path starts with / and uses forward slashes
                    let remotePath = normalizedSourceDir;
                    if (!remotePath.startsWith('/')) {
                        remotePath = '/' + remotePath;
                    }
                    cwdUri = workspaceFolder.uri.with({ path: remotePath });
                } else {
                    // Local: use the path as-is
                    cwdUri = vscode.Uri.file(normalizedSourceDir);
                }
            }

            const tempPatchFileName = '.patchitup-apply-temp.patch';
            const tempPatchUri = vscode.Uri.joinPath(cwdUri, tempPatchFileName);
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(tempPatchUri, encoder.encode(patchContent));
            console.log('Wrote temp patch file:', tempPatchUri.toString());

            try {
                // Apply using git command via Task API (use relative filename)
                const output = await this.executeGitCommand(['apply', tempPatchFileName], sourceDir);
                console.log('Git apply output:', output);
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

    private async diffPatch(patchFile: string, sourceDir: string) {
        try {
            if (!patchFile) {
                vscode.window.showWarningMessage('Please select a patch file');
                return;
            }

            const patchContent = await this.readPatchFromConfiguredDestination(patchFile);
            const fileEdits = parseGitPatchFileEdits(patchContent);
            if (fileEdits.length === 0) {
                vscode.window.showWarningMessage('Selected patch contains no file diffs');
                return;
            }

            const isRemote = vscode.env.remoteName !== undefined;
            const normalizedSourceDir = isRemote ? sourceDir.trim().replace(/\\/g, '/') : sourceDir.trim();

            // A temp folder on the extension host: %TEMP% on Windows, /tmp on Linux.
            const tempRoot = path.join(os.tmpdir(), `patchitup-diff-${Date.now()}-${Math.random().toString(16).slice(2)}`);
            const originalRootUri = vscode.Uri.file(path.join(tempRoot, 'original'));
            const patchedRootUri = vscode.Uri.file(path.join(tempRoot, 'patched'));
            await vscode.workspace.fs.createDirectory(originalRootUri);
            await vscode.workspace.fs.createDirectory(patchedRootUri);

            const encoder = new TextEncoder();
            const createEmpty = async (uri: vscode.Uri) => {
                await this.ensureParentDirectory(uri);
                await vscode.workspace.fs.writeFile(uri, encoder.encode(''));
            };

            const sourceRootUri = this.getUriForDirectory(normalizedSourceDir);

            const readBaseBytes = async (edit: PatchFileEdit): Promise<Uint8Array> => {
                // Prefer blob IDs embedded in the patch (most accurate for old patches)
                if (edit.oldBlob && edit.oldBlob !== '0000000' && !/^0+$/.test(edit.oldBlob)) {
                    try {
                        const blobText = await this.executeGitCommand(['cat-file', '-p', edit.oldBlob], normalizedSourceDir);
                        return encoder.encode(blobText);
                    } catch {
                        // Blob not present in this repo/clone/branch; fall back below.
                    }
                }

                // Fallback: use HEAD version when blob not present (e.g., some patch formats)
                try {
                    const showText = await this.executeGitCommand(['show', `HEAD:${edit.oldPath}`], normalizedSourceDir);
                    return encoder.encode(showText);
                } catch {
                    // Final fallback: read from working tree if present
                    try {
                        const workingTreeUri = this.joinUriPath(sourceRootUri, edit.oldPath);
                        return await vscode.workspace.fs.readFile(workingTreeUri);
                    } catch {
                        return encoder.encode('');
                    }
                }
            };

            // Materialize pre-apply files into original/ and patched/ using the patch's base revision.
            for (const edit of fileEdits) {
                const originalRelPath = edit.status === 'added' ? edit.newPath : edit.oldPath;
                const patchedRelPath = edit.status === 'deleted' ? edit.oldPath : edit.newPath;

                const originalFileUri = this.joinUriPath(originalRootUri, originalRelPath);
                const patchedFileUri = this.joinUriPath(patchedRootUri, patchedRelPath);

                if (edit.status === 'added') {
                    await createEmpty(originalFileUri);
                    // patched file will be created by git apply, but make sure the directory exists
                    await this.ensureParentDirectory(patchedFileUri);
                    continue;
                }

                const contentBytes = await readBaseBytes(edit);

                await this.ensureParentDirectory(originalFileUri);
                await vscode.workspace.fs.writeFile(originalFileUri, contentBytes);

                // patched tree starts as a copy of the base content at the *oldPath* location,
                // so renames/deletes can apply cleanly.
                const patchedBaseUri = this.joinUriPath(patchedRootUri, edit.oldPath);
                await this.ensureParentDirectory(patchedBaseUri);
                await vscode.workspace.fs.writeFile(patchedBaseUri, contentBytes);

                // Ensure directories for the final path exist (e.g., rename to new folder).
                await this.ensureParentDirectory(patchedFileUri);
            }

            // Apply patch inside patched/.
            const tempPatchFileName = '.patchitup-diff-temp.patch';
            const tempPatchUri = vscode.Uri.joinPath(patchedRootUri, tempPatchFileName);
            await vscode.workspace.fs.writeFile(tempPatchUri, encoder.encode(patchContent));

            try {
                await this.executeGitCommand(['apply', tempPatchFileName], patchedRootUri.fsPath);
            } catch (error: any) {
                // Try a best-effort preview by allowing rejects so we can still show partial diffs.
                try {
                    await this.executeGitCommand(['apply', '--reject', '--whitespace=nowarn', tempPatchFileName], patchedRootUri.fsPath, [0, 1]);
                    vscode.window.showWarningMessage('Patch did not apply cleanly; showing best-effort diff preview with rejects.');
                } catch {
                    vscode.window.showErrorMessage(`Failed to apply patch for diff preview: ${error.message || error}`);
                    return;
                }
            } finally {
                try {
                    await vscode.workspace.fs.delete(tempPatchUri);
                } catch {
                    // Ignore cleanup errors
                }
            }

            // Open diffs for all impacted files.
            for (const edit of fileEdits) {
                const leftRelPath = edit.status === 'added' ? edit.newPath : edit.oldPath;
                const rightRelPath = edit.status === 'deleted' ? edit.oldPath : edit.newPath;

                const leftUri = this.joinUriPath(originalRootUri, leftRelPath);
                const rightUri = this.joinUriPath(patchedRootUri, rightRelPath);

                // If a file was deleted, the patched version may not exist anymore.
                // Create an empty placeholder so the diff editor can open.
                if (edit.status === 'deleted') {
                    try {
                        await vscode.workspace.fs.stat(rightUri);
                    } catch {
                        await createEmpty(rightUri);
                    }
                }

                const title = `Diff: ${rightRelPath} (${patchFile})`;
                await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
                    preview: false,
                    preserveFocus: true
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error diffing patch: ${errorMessage}`);
        }
    }

    private async readPatchFromConfiguredDestination(patchFile: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('patchitup');
        const destPath = config.get<string>('destinationPath', '');
        if (!destPath) {
            vscode.window.showErrorMessage('Destination path not configured');
            throw new Error('Destination path not configured');
        }

        const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
        console.log('readPatchFromConfiguredDestination:', { patchFile, destPath, useVscodeLocal });

        const decoder = new TextDecoder();
        try {
            const patchUri = await this.getLocalFileUri(path.join(destPath, patchFile));
            const patchBytes = await vscode.workspace.fs.readFile(patchUri);
            return decoder.decode(patchBytes);
        } catch (error: any) {
            // If vscode-local fails and we were using it, try regular file scheme as fallback
            if (useVscodeLocal && (error.code === 'ENOPRO' || error.message?.includes('No file system provider'))) {
                const patchUri = vscode.Uri.file(path.join(destPath, patchFile));
                const patchBytes = await vscode.workspace.fs.readFile(patchUri);
                return decoder.decode(patchBytes);
            }
            throw error;
        }
    }

    private async openPatchForEdit(patchFile: string): Promise<void> {
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

            const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
            let patchUri: vscode.Uri;
            try {
                patchUri = await this.getLocalFileUri(path.join(destPath, patchFile));
                await vscode.workspace.fs.stat(patchUri);
            } catch (error: any) {
                if (useVscodeLocal && (error?.code === 'ENOPRO' || error?.message?.includes('No file system provider'))) {
                    patchUri = vscode.Uri.file(path.join(destPath, patchFile));
                    await vscode.workspace.fs.stat(patchUri);
                } else {
                    throw error;
                }
            }

            const doc = await vscode.workspace.openTextDocument(patchUri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open patch: ${errorMessage}`);
        }
    }

    private getUriForDirectory(dirPath: string): vscode.Uri {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return vscode.Uri.file(dirPath);
        }

        const isRemote = !!workspaceFolder.uri.authority;
        if (!isRemote) {
            return vscode.Uri.file(dirPath);
        }

        let remotePath = dirPath.replace(/\\/g, '/');
        if (!remotePath.startsWith('/')) {
            remotePath = '/' + remotePath;
        }
        return workspaceFolder.uri.with({ path: remotePath });
    }

    private joinUriPath(base: vscode.Uri, relativePath: string): vscode.Uri {
        const parts = relativePath.split('/').filter(Boolean);
        return vscode.Uri.joinPath(base, ...parts);
    }

    private async ensureParentDirectory(fileUri: vscode.Uri): Promise<void> {
        const parent = vscode.Uri.joinPath(fileUri, '..');
        await vscode.workspace.fs.createDirectory(parent);
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
        <button id="diffPatchBtn" class="secondary-button" disabled>Diff Selected Patch</button>
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

        // Diff patch button
        document.getElementById('diffPatchBtn').addEventListener('click', () => {
            if (!selectedPatch) {
                return;
            }
            const sourceDir = document.getElementById('sourceDir').value;
            
            vscode.postMessage({
                type: 'diffPatch',
                patchFile: selectedPatch,
                sourceDir
            });
        });

        // Update patch list
        function updatePatchList(patches) {
            const patchList = document.getElementById('patchList');
            const applyBtn = document.getElementById('applyPatchBtn');
            const diffBtn = document.getElementById('diffPatchBtn');
            
            if (!patches || patches.length === 0) {
                patchList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No patches found</div>';
                selectedPatch = null;
                applyBtn.disabled = true;
                applyBtn.classList.add('secondary-button');
                diffBtn.disabled = true;
                diffBtn.classList.add('secondary-button');
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
                    applyBtn.classList.remove('secondary-button');
                    diffBtn.disabled = false;
                    diffBtn.classList.remove('secondary-button');
                });
                item.addEventListener('dblclick', () => {
                    // Double-click opens the patch file for editing
                    vscode.postMessage({
                        type: 'openPatch',
                        patchFile: patch
                    });
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
