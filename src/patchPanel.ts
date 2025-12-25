import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { type PatchFileEdit, parseGitPatchFileEdits } from './patchParsing';
import { applyUnifiedDiffToText, parseUnifiedDiffFiles, type UnifiedDiffFile } from './unifiedDiff';
import { applyPatchWithGit, getStripCandidates, guessPreferredStripLevel, selectStripLevelForPatch } from './gitApply';
import {
    getTempRootLocation,
    isRemoteSession,
    normalizeCwd,
    PATCHITUP_TMP_DIRNAME
} from './commandPathUtils';
import { detectIsRemoteLocalMachine, isLocalhostHostname, shouldUseVscodeLocalScheme } from './remoteSessionUtils';
import { Logger } from './logger';
import { withStepProgress } from './progressSteps';

export class PatchPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'patchitup.panelView';
    private _view?: vscode.WebviewView;
    private _isRemoteLocalMachine: boolean | undefined;

    constructor(private readonly _extensionUri: vscode.Uri, private readonly logger: Logger) {}

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
            this.logger.info('isRemoteLocalMachine: not remote, returning false');
            return false;
        }

        this.logger.info('isRemoteLocalMachine: checking remote type', { remoteName });

        try {
            const hostname = os.hostname();
            const isLocal = detectIsRemoteLocalMachine(remoteName, hostname);
            this._isRemoteLocalMachine = isLocal;

            if (remoteName === 'wsl') {
                this.logger.info('isRemoteLocalMachine: WSL detected, returning true');
            } else if (remoteName === 'codespaces' || remoteName === 'github-codespaces') {
                this.logger.info('isRemoteLocalMachine: Codespaces detected, returning false');
            } else if (remoteName === 'dev-container' || remoteName === 'attached-container') {
                this.logger.info('isRemoteLocalMachine: Dev Container', { hostname, isLocal });
            } else if (remoteName === 'ssh-remote') {
                this.logger.info('isRemoteLocalMachine: SSH', { hostname, isLocal });
            } else {
                this.logger.info('isRemoteLocalMachine: unknown remote type, returning false', { remoteName });
            }

            return isLocal;
        } catch {
            // If we can't determine, assume it's not local (safer default)
            this._isRemoteLocalMachine = false;
            return false;
        }
    }

    /**
     * Determines if we should use the vscode-local scheme for accessing local files.
     * Returns true only when running in a true remote environment (not local machine).
     */
    private async shouldUseVscodeLocalScheme(): Promise<boolean> {
        const remoteName = vscode.env.remoteName;
        const isLocalMachine = await this.isRemoteLocalMachine();
        return shouldUseVscodeLocalScheme(remoteName, isLocalMachine);
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
        const result = await this.executeGitCommandResult(args, cwd, allowedExitCodes);
        return result.output;
    }

    private async executeGitCommandResult(
        args: string[],
        cwd: string,
        allowedExitCodes: number[] = [0],
        stdin?: string
    ): Promise<{ exitCode: number; output: string }> {
        const remoteName = vscode.env.remoteName;

        // Normalize the cwd based on session type. In remote Linux sessions we need forward slashes
        // even if the UI host is Windows.
        const normalizedCwd = normalizeCwd(cwd, remoteName);

        // IMPORTANT: Use child_process instead of VS Code Tasks to avoid opening terminals / console windows.
        // In a remote session, the extension host runs remotely, so this still executes in the right place.
        const timeoutMs = 30000;
        const maxOutputBytes = 20 * 1024 * 1024;

        this.logger.info('executeGitCommand', {
            cwd,
            normalizedCwd,
            remoteName,
            args
        });

        const result = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
            const child = spawn('git', args, {
                cwd: normalizedCwd,
                windowsHide: true,
                stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
            });

            if (stdin !== undefined) {
                try {
                    child.stdin?.write(stdin, 'utf8');
                    child.stdin?.end();
                } catch (e) {
                    try {
                        child.kill();
                    } catch {}
                    reject(e);
                    return;
                }
            }

            const chunks: Buffer[] = [];
            let total = 0;

            const onData = (data: Buffer) => {
                chunks.push(data);
                total += data.length;
                if (total > maxOutputBytes) {
                    try {
                        child.kill();
                    } catch {}
                    reject(new Error(`Git output exceeded ${maxOutputBytes} bytes`));
                }
            };

            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);

            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch {}
                reject(new Error('Command timeout'));
            }, timeoutMs);

            child.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                const combined = Buffer.concat(chunks).toString('utf8');

                const exitCode = code ?? -1;
                if (!allowedExitCodes.includes(exitCode)) {
                    const trimmed = combined.trim();
                    this.logger.error('executeGitCommand non-allowed exit code', { exitCode, output: trimmed });
                    reject(new Error(`Git command failed with exit code ${exitCode}${trimmed ? `\nGit output: ${trimmed}` : ''}`));
                    return;
                }

                if (combined.trim()) {
                    this.logger.info('executeGitCommand.output', { exitCode, output: combined.trim() });
                } else {
                    this.logger.info('executeGitCommand.output', { exitCode, output: '' });
                }

                resolve({ exitCode, output: combined });
            });
        });

        return result;
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
        await withStepProgress({
            title: 'PatchItUp: Create patch',
            totalSteps: 6,
            task: async (steps) => {
                try {
                    steps.next('Validate settings');
                    if (!destPath) {
                        vscode.window.showErrorMessage('Please configure the destination path');
                        return;
                    }

                    steps.next('Detect environment');
                    const isRemote = vscode.env.remoteName !== undefined;
                    const isRemoteLocal = await this.isRemoteLocalMachine();
                    const useVscodeLocal = await this.shouldUseVscodeLocalScheme();
                    console.log('createPatch:', { isRemote, isRemoteLocal, useVscodeLocal, sourceDir, destPath });

                    steps.next('Generate patch');
                    // Check for changes using executeGitCommand
                    let patchContent: string;
                    try {
                        steps.detail('Running git diff');
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

                    steps.next('Create patch file');
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
                        steps.detail('Writing patch file');
                        console.log('Attempting to write patch to:', destinationUri.toString());
                        await vscode.workspace.fs.createDirectory(dirUri);
                        await vscode.workspace.fs.writeFile(destinationUri, patchBytes);
                        console.log('Successfully wrote patch');
                    } catch (error: any) {
                        // If vscode-local fails and we were using it, try regular file scheme as fallback
                        console.log('Write failed, error:', error, 'code:', error.code);
                        if (useVscodeLocal && (error.code === 'ENOPRO' || error.message?.includes('No file system provider'))) {
                            steps.detail('Retrying write with file scheme');
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

                    steps.next('Refresh patch list');
                    vscode.window.showInformationMessage(`Patch created: ${filename}`);
                    await this.refreshPatchList(destPath);

                    steps.next('Done');
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to create patch: ${errorMessage}`);
                }
            }
        });
    }

    private async applyPatch(patchFile: string, sourceDir: string) {
        await withStepProgress({
            title: 'PatchItUp: Apply patch',
            totalSteps: 5,
            task: async (steps) => {
                try {
                    steps.next('Validate selection');
                    if (!patchFile) {
                        vscode.window.showWarningMessage('Please select a patch file');
                        return;
                    }

                    steps.next('Load patch content');
                    const patchContent = await this.readPatchFromConfiguredDestination(patchFile);

                    try {
                        steps.next('Detect strip level');
                        steps.detail('Running git apply --check/--stat');
                        const preferredStrip = guessPreferredStripLevel(patchContent);

                        const selection = await selectStripLevelForPatch({
                            patchContent,
                            cwd: sourceDir,
                            preferredStrip,
                            runGit: async ({ args, cwd, allowedExitCodes, stdin }) =>
                                this.executeGitCommandResult(args, cwd, allowedExitCodes ?? [0], stdin)
                        });

                        this.logger.info('applyPatch: selected git apply strip level', {
                            selectedStrip: selection.selectedStrip,
                            stripCandidates: selection.stripCandidates
                        });

                        steps.next('Apply patch');
                        steps.detail('Running git apply');
                        const result = await applyPatchWithGit({
                            patchContent,
                            cwd: sourceDir,
                            stripLevel: selection.selectedStrip,
                            runGit: async ({ args, cwd, allowedExitCodes, stdin }) =>
                                this.executeGitCommandResult(args, cwd, allowedExitCodes ?? [0], stdin)
                        });

                        const trimmed = result.output.trim();
                        this.logger.info('applyPatch: git apply output', { exitCode: result.exitCode, output: trimmed });

                        const isSkippedOutput = (out: string) => /Skipped patch/i.test(out);
                        if (result.exitCode !== 0 || isSkippedOutput(trimmed)) {
                            throw new Error(trimmed || `git apply returned exit code ${result.exitCode}`);
                        }

                        steps.next('Done');
                        vscode.window.showInformationMessage(`Patch applied successfully: ${patchFile}`);
                    } catch (error: any) {
                        this.logger.error('applyPatch failed', { error: error?.message ?? String(error) });
                        vscode.window.showErrorMessage(`Failed to apply patch: ${error.message || error}`);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.logger.error('applyPatch threw', { error: errorMessage });
                    vscode.window.showErrorMessage(`Error applying patch: ${errorMessage}`);
                }
            }
        });
    }

    private async diffPatch(patchFile: string, sourceDir: string) {
        if (!patchFile) {
            vscode.window.showWarningMessage('Please select a patch file');
            return;
        }

        await withStepProgress({
            title: 'PatchItUp: Diff patch',
            totalSteps: 7,
            task: async (steps) => {
                try {
                    steps.next('Load patch content');
                    const patchContent = await this.readPatchFromConfiguredDestination(patchFile);
                    this.logger.info('diffPatch: loaded patch', { patchFile, bytes: patchContent.length, sourceDir });

            // Quick sanity stats for the patch content.
            // Helps identify cases where the patch has headers but no hunks.
            const patchLines = patchContent.split(/\r?\n/);
            const hunkCount = patchLines.filter(l => l.startsWith('@@')).length;
            let addLines = 0;
            let delLines = 0;
            for (const line of patchLines) {
                if (line.startsWith('+++') || line.startsWith('---')) {
                    continue;
                }
                if (line.startsWith('+')) {
                    addLines++;
                } else if (line.startsWith('-')) {
                    delLines++;
                }
            }
            this.logger.info('diffPatch: patch stats', { hunkCount, addLines, delLines });

                    steps.next('Parse patch file list');
                    const fileEdits = parseGitPatchFileEdits(patchContent);
            if (fileEdits.length === 0) {
                vscode.window.showWarningMessage('Selected patch contains no file diffs');
                return;
            }

            this.logger.info('diffPatch: parsed file edits', { count: fileEdits.length, sample: fileEdits.slice(0, 5) });

            const guessPreferredStripLevel = (content: string): number => {
                const firstDiffLine = content.split(/\r?\n/).find(l => l.startsWith('diff --git '));
                if (!firstDiffLine) {
                    return 1;
                }
                const parts = firstDiffLine.split(' ');
                const left = parts[2] ?? '';
                const right = parts[3] ?? '';
                if (left.startsWith('a/') || right.startsWith('b/')) {
                    return 1;
                }
                return 0;
            };

                    steps.next('Prepare preview workspace');
                    const remoteName = vscode.env.remoteName;
            const isRemote = isRemoteSession(remoteName);
            const normalizedSourceDir = normalizeCwd(sourceDir, remoteName);

            // Temp folder must live in the same environment where git runs.
            // In remote sessions, tasks execute remotely, so create temp folders under the workspace.
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const tempRootLocation = getTempRootLocation({
                remoteName,
                workspaceRootPosixPath: workspaceFolder?.uri.path,
                osTmpDir: os.tmpdir()
            });

            let tempRootUri: vscode.Uri;
            if (tempRootLocation.kind === 'workspace') {
                if (!workspaceFolder) {
                    throw new Error('No workspace folder open');
                }
                const tmpDirUri = vscode.Uri.joinPath(workspaceFolder.uri, PATCHITUP_TMP_DIRNAME);
                await vscode.workspace.fs.createDirectory(tmpDirUri);
                tempRootUri = vscode.Uri.joinPath(workspaceFolder.uri, ...tempRootLocation.relativeSegments);
            } else {
                tempRootUri = vscode.Uri.file(tempRootLocation.absolutePath);
            }

            const originalRootUri = vscode.Uri.joinPath(tempRootUri, 'original');
            const patchedRootUri = vscode.Uri.joinPath(tempRootUri, 'patched');
            await vscode.workspace.fs.createDirectory(originalRootUri);
            await vscode.workspace.fs.createDirectory(patchedRootUri);

            this.logger.info('diffPatch: temp roots', {
                tempRootUri: tempRootUri.toString(),
                originalRootUri: originalRootUri.toString(),
                patchedRootUri: patchedRootUri.toString(),
                remoteName
            });

            const encoder = new TextEncoder();
            const createEmpty = async (uri: vscode.Uri) => {
                await this.ensureParentDirectory(uri);
                await vscode.workspace.fs.writeFile(uri, encoder.encode(''));
            };

            const sourceRootUri = this.getUriForDirectory(normalizedSourceDir);
            this.logger.info('diffPatch: source root uri', { sourceRootUri: sourceRootUri.toString(), normalizedSourceDir, remoteName });

            // Compare workspace file content hashes against patch index blobs.
            // If the working tree matches the patch's *newBlob*, the patch will appear "already applied".
            // If it matches *oldBlob*, the patch should produce differences.
            // If it matches neither, the patch may be from a different base.
            try {
                const hashComparisons: Array<{
                    path: string;
                    oldBlob?: string;
                    newBlob?: string;
                    hash?: string;
                    matches?: 'old' | 'new' | 'neither' | 'unknown';
                    error?: string;
                }> = [];

                for (const edit of fileEdits) {
                    if (edit.status !== 'modified') {
                        continue;
                    }

                    const filePath = edit.oldPath;
                    try {
                        // `git hash-object` works even outside of a git repo (it just hashes a file).
                        const hashText = await this.executeGitCommand(['hash-object', filePath], normalizedSourceDir);
                        const hash = hashText.trim();

                        const oldBlob = edit.oldBlob;
                        const newBlob = edit.newBlob;
                        let matches: 'old' | 'new' | 'neither' | 'unknown' = 'unknown';
                        if (oldBlob && newBlob && hash) {
                            if (hash.startsWith(oldBlob)) {
                                matches = 'old';
                            } else if (hash.startsWith(newBlob)) {
                                matches = 'new';
                            } else {
                                matches = 'neither';
                            }
                        }

                        hashComparisons.push({ path: filePath, oldBlob, newBlob, hash, matches });
                    } catch (e) {
                        hashComparisons.push({
                            path: filePath,
                            oldBlob: edit.oldBlob,
                            newBlob: edit.newBlob,
                            matches: 'unknown',
                            error: e instanceof Error ? e.message : String(e)
                        });
                    }
                }

                this.logger.info('diffPatch: hash comparisons', { hashComparisons });
            } catch (e) {
                this.logger.warn('diffPatch: hash comparison pass failed', { error: e instanceof Error ? e.message : String(e) });
            }

            const readBaseBytes = async (edit: PatchFileEdit): Promise<Uint8Array> => {
                // Goal: make preview independent of the current working tree state.
                // A unified diff doesn't contain a full "before" file, only hunks, so we must
                // fetch a baseline. Best source is the patch's `index` old blob (exact bytes).
                // If that object isn't available in the local clone (common in partial clones),
                // fall back to `HEAD:<path>`, then finally the working tree.

                // 1) Patch-annotated old blob (most correct, if available)
                if (edit.oldBlob && edit.oldBlob !== '0000000' && !/^0+$/.test(edit.oldBlob)) {
                    try {
                        const blobText = await this.executeGitCommand(['cat-file', '-p', edit.oldBlob], normalizedSourceDir);
                        return encoder.encode(blobText);
                    } catch {
                        // ignore
                    }
                }

                // 2) Committed baseline
                try {
                    const showText = await this.executeGitCommand(['show', `HEAD:${edit.oldPath}`], normalizedSourceDir);
                    return encoder.encode(showText);
                } catch {
                    // ignore
                }

                // 3) Working tree (last resort)
                try {
                    const workingTreeUri = this.joinUriPath(sourceRootUri, edit.oldPath);
                    return await vscode.workspace.fs.readFile(workingTreeUri);
                } catch {
                    // ignore
                }

                return encoder.encode('');
            };

                    steps.next('Materialize baseline files');
                    steps.detail(`0/${fileEdits.length} files`);

            // Materialize pre-apply files into original/ using the workspace as a source.
            // We'll later copy original/ -> patched/ and apply the patch there.
                    for (let i = 0; i < fileEdits.length; i++) {
                        const edit = fileEdits[i];
                        if (i === 0 || i % 5 === 0 || i === fileEdits.length - 1) {
                            steps.detail(`${Math.min(i, fileEdits.length)}/${fileEdits.length} files`);
                        }
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

                // Ensure directories for the final path exist (e.g., rename to new folder).
                await this.ensureParentDirectory(patchedFileUri);
            }

                    steps.detail(`${fileEdits.length}/${fileEdits.length} files`);

            // Fast-path preview: if we can read both old/new blobs from the local object DB,
            // we can build an exact before/after preview without running `git apply` at all.
            // This matches the user's expectation: diff is derived from the patch's annotated
            // old/new versions, not the current workspace state.
            const readBlobBytes = async (blob: string | undefined): Promise<Uint8Array | undefined> => {
                if (!blob || blob === '0000000' || /^0+$/.test(blob)) {
                    return undefined;
                }
                try {
                    const blobText = await this.executeGitCommand(['cat-file', '-p', blob], normalizedSourceDir);
                    return encoder.encode(blobText);
                } catch {
                    return undefined;
                }
            };

                    steps.next('Build patched preview');
                    steps.detail('Trying exact blob preview');

            let usedBlobPreview = true;
            for (const edit of fileEdits) {
                if (edit.status === 'deleted') {
                    // Represent deletion as an empty right side.
                    const deletedUri = this.joinUriPath(patchedRootUri, edit.oldPath);
                    await createEmpty(deletedUri);
                    continue;
                }

                const newBytes = await readBlobBytes(edit.newBlob);
                if (!newBytes) {
                    usedBlobPreview = false;
                    break;
                }

                const outRelPath = edit.status === 'added' ? edit.newPath : edit.newPath;
                const outUri = this.joinUriPath(patchedRootUri, outRelPath);
                await this.ensureParentDirectory(outUri);
                await vscode.workspace.fs.writeFile(outUri, newBytes);
            }

            if (usedBlobPreview) {
                this.logger.info('diffPatch: using patch old/new blobs for preview (skipping git apply)', {
                    patchFile,
                    sourceDir,
                    files: fileEdits.map(e => ({ path: e.newPath, status: e.status, oldBlob: e.oldBlob, newBlob: e.newBlob }))
                });
            }

            // Second fast-path: when new blobs aren't available (common in partial clones),
            // generate the "patched" side by applying unified-diff hunks in-process.
            // This avoids relying on `git apply` (which has been observed to silently skip patches
            // in some remote environments).
                    let usedInProcessApplyPreview = false;
            if (!usedBlobPreview) {
                try {
                    steps.detail('Applying hunks in-process');
                    const diffFiles = parseUnifiedDiffFiles(patchContent);

                    const byPath = new Map<string, UnifiedDiffFile>();
                    for (const df of diffFiles) {
                        byPath.set(df.newPath, df);
                        byPath.set(df.oldPath, df);
                    }

                    let appliedAny = false;
                    const perFile: Array<{ path: string; appliedHunks: number; rejectedHunks: number }> = [];

                    for (const edit of fileEdits) {
                        if (edit.status === 'deleted') {
                            const deletedUri = this.joinUriPath(patchedRootUri, edit.oldPath);
                            await createEmpty(deletedUri);
                            perFile.push({ path: edit.oldPath, appliedHunks: 0, rejectedHunks: 0 });
                            continue;
                        }

                        const patchForFile = byPath.get(edit.newPath) ?? byPath.get(edit.oldPath);
                        if (!patchForFile || patchForFile.hunks.length === 0) {
                            // No hunks for this file (rename-only, mode-only, etc.)
                            const originalRelPath = edit.status === 'added' ? edit.newPath : edit.oldPath;
                            const originalUri = this.joinUriPath(originalRootUri, originalRelPath);
                            const baseline = await vscode.workspace.fs.readFile(originalUri);
                            const outUri = this.joinUriPath(patchedRootUri, edit.newPath);
                            await this.ensureParentDirectory(outUri);
                            await vscode.workspace.fs.writeFile(outUri, baseline);
                            perFile.push({ path: edit.newPath, appliedHunks: 0, rejectedHunks: 0 });
                            continue;
                        }

                        const baselineText =
                            edit.status === 'added'
                                ? ''
                                : new TextDecoder().decode(
                                      await vscode.workspace.fs.readFile(this.joinUriPath(originalRootUri, edit.oldPath))
                                  );

                        const result = applyUnifiedDiffToText(baselineText, patchForFile);
                        if (result.appliedHunks > 0) {
                            appliedAny = true;
                        }
                        perFile.push({ path: edit.newPath, appliedHunks: result.appliedHunks, rejectedHunks: result.rejectedHunks });

                        const outUri = this.joinUriPath(patchedRootUri, edit.newPath);
                        await this.ensureParentDirectory(outUri);
                        await vscode.workspace.fs.writeFile(outUri, encoder.encode(result.text));
                    }

                    if (appliedAny) {
                        usedInProcessApplyPreview = true;
                        this.logger.info('diffPatch: built preview by applying hunks in-process (skipping git apply)', {
                            patchFile,
                            sourceDir,
                            perFile
                        });
                    } else {
                        this.logger.warn('diffPatch: in-process hunk apply produced no changes; will fall back to git apply', {
                            patchFile,
                            sourceDir,
                            perFile
                        });
                    }
                } catch (e) {
                    this.logger.warn('diffPatch: in-process hunk apply failed; falling back to git apply', {
                        error: e instanceof Error ? e.message : String(e)
                    });
                }
            }

            // If blobs aren't available, fall back to trying to apply the patch in a temp tree.
            const originalRootShellPath = originalRootUri.scheme === 'file' ? originalRootUri.fsPath : originalRootUri.path;
            const patchedRootShellPath = patchedRootUri.scheme === 'file' ? patchedRootUri.fsPath : patchedRootUri.path;

            if (!usedBlobPreview && !usedInProcessApplyPreview) {
                steps.detail('Applying patch in temp workspace');
                const isSkippedOutput = (out: string) => /Skipped patch/i.test(out);

                const preferredStrip = guessPreferredStripLevel(patchContent);
                const stripCandidates = getStripCandidates(preferredStrip);

                const expectedPaths = fileEdits
                    .map(e => (e.status === 'deleted' ? e.oldPath : e.newPath))
                    .filter(Boolean);

                const detectStripLevel = async (): Promise<number> => {
                    for (const strip of stripCandidates) {
                        try {
                            const stat = await this.executeGitCommandResult(
                                ['apply', `-p${strip}`, '--stat', '-'],
                                originalRootShellPath,
                                [0, 1],
                                patchContent
                            );
                            const statOut = stat.output.trim();

                            // Heuristic: choose the first strip level that produces a non-empty diffstat
                            // and references at least one expected path.
                            if (
                                stat.exitCode === 0 &&
                                statOut &&
                                statOut !== '0 files changed' &&
                                expectedPaths.some(p => statOut.includes(p))
                            ) {
                                return strip;
                            }
                        } catch {
                            // ignore
                        }
                    }

                    // Fallback: if none reference expected paths, still prefer the first non-empty diffstat.
                    for (const strip of stripCandidates) {
                        try {
                            const stat = await this.executeGitCommandResult(
                                ['apply', `-p${strip}`, '--stat', '-'],
                                originalRootShellPath,
                                [0, 1],
                                patchContent
                            );
                            const statOut = stat.output.trim();
                            if (stat.exitCode === 0 && statOut && statOut !== '0 files changed') {
                                return strip;
                            }
                        } catch {
                            // ignore
                        }
                    }

                    return preferredStrip;
                };

                steps.detail('Detecting strip level');
                const stripLevel = await detectStripLevel();
                this.logger.info('diffPatch: selected git apply strip level', { stripLevel, stripCandidates, preferredStrip });

                // Show how git interprets the patch paths/stat.
                try {
                    const stat = await this.executeGitCommandResult(['apply', `-p${stripLevel}`, '--stat', '-'], originalRootShellPath, [0, 1], patchContent);
                    this.logger.info('diffPatch: git apply --stat', { exitCode: stat.exitCode, output: stat.output.trim() });
                } catch (e) {
                    this.logger.warn('diffPatch: git apply --stat failed', { error: e instanceof Error ? e.message : String(e) });
                }

            const hashInTree = async (treeCwd: string, relPath: string): Promise<string | undefined> => {
                try {
                    const out = await this.executeGitCommand(['hash-object', relPath], treeCwd);
                    return out.trim() || undefined;
                } catch {
                    return undefined;
                }
            };

            const logTreeHashes = async (label: string, treeCwd: string) => {
                const hashes: Array<{ path: string; hash?: string }> = [];
                for (const edit of fileEdits) {
                    if (edit.status === 'deleted') {
                        continue;
                    }
                    const p = edit.status === 'added' ? edit.newPath : edit.oldPath;
                    hashes.push({ path: p, hash: await hashInTree(treeCwd, p) });
                }
                this.logger.info(label, { treeCwd, hashes });
            };

                // Preflight checks on original/ (based on baseline content).
                // - `--check` exit 0 => can apply cleanly (but does not apply)
                // - `--reverse --check` exit 0 => patch appears already applied to this base
                let reverseCheckExitCode = 1;
                try {
                    const check = await this.executeGitCommandResult(
                        ['apply', `-p${stripLevel}`, '--check', '--whitespace=nowarn', '-'],
                        originalRootShellPath,
                        [0, 1],
                        patchContent
                    );
                    this.logger.info('diffPatch: git apply --check', { exitCode: check.exitCode, output: check.output.trim() });

                    const reverseCheck = await this.executeGitCommandResult(
                        ['apply', `-p${stripLevel}`, '--reverse', '--check', '--whitespace=nowarn', '-'],
                        originalRootShellPath,
                        [0, 1],
                        patchContent
                    );
                    reverseCheckExitCode = reverseCheck.exitCode;
                    this.logger.info('diffPatch: git apply --reverse --check', { exitCode: reverseCheck.exitCode, output: reverseCheck.output.trim() });
                } catch (e) {
                    this.logger.warn('diffPatch: preflight checks failed', { error: e instanceof Error ? e.message : String(e) });
                }

                // If the patch appears already applied to the baseline, we want to show
                // the patch content anyway. Do this by reverse-applying into original/ to get the
                // pre-patch baseline, then apply forward into patched/.
                if (reverseCheckExitCode === 0) {
                    this.logger.info('diffPatch: patch appears already applied; generating baseline by reverse-applying into original');
                    await logTreeHashes('diffPatch: original hashes (pre reverse-apply)', originalRootShellPath);
                    try {
                        const reverseApply = await this.executeGitCommandResult(
                            ['apply', `-p${stripLevel}`, '--reverse', '--verbose', '--whitespace=nowarn', '-'],
                            originalRootShellPath,
                            [0, 1],
                            patchContent
                        );
                        const trimmed = reverseApply.output.trim();
                        this.logger.info('diffPatch: git apply --reverse --verbose', { exitCode: reverseApply.exitCode, output: trimmed });
                        if (isSkippedOutput(trimmed)) {
                            this.logger.warn('diffPatch: reverse-apply skipped patches', { stripLevel, output: trimmed });
                        }
                    } catch (e) {
                        this.logger.warn('diffPatch: reverse-apply baseline failed; falling back to direct apply', { error: e instanceof Error ? e.message : String(e) });
                    }
                    await logTreeHashes('diffPatch: original hashes (post reverse-apply)', originalRootShellPath);
                }

                // Copy original/ -> patched/ (only the impacted files) so the forward apply happens from the baseline.
                for (const edit of fileEdits) {
                    const baselineRelPath = edit.status === 'added' ? edit.newPath : edit.oldPath;
                    const baselineUri = this.joinUriPath(originalRootUri, baselineRelPath);

                    // For deletes, the file may not exist in the baseline; that's fine.
                    let baselineBytes: Uint8Array | undefined;
                    try {
                        baselineBytes = await vscode.workspace.fs.readFile(baselineUri);
                    } catch {
                        baselineBytes = undefined;
                    }

                    // Write baseline into patched tree at the old path location so renames/deletes apply cleanly.
                    const patchedBaseUri = this.joinUriPath(patchedRootUri, edit.oldPath);
                    await this.ensureParentDirectory(patchedBaseUri);
                    await vscode.workspace.fs.writeFile(patchedBaseUri, baselineBytes ?? encoder.encode(''));

                    // Ensure directories for the final path exist.
                    const finalRelPath = edit.status === 'deleted' ? edit.oldPath : edit.newPath;
                    await this.ensureParentDirectory(this.joinUriPath(patchedRootUri, finalRelPath));
                }

                // Apply patch inside patched/.
                try {
                    await logTreeHashes('diffPatch: patched hashes (pre apply)', patchedRootShellPath);
                    const apply = await this.executeGitCommandResult(
                        ['apply', `-p${stripLevel}`, '--verbose', '--whitespace=nowarn', '-'],
                        patchedRootShellPath,
                        [0, 1],
                        patchContent
                    );
                    const trimmed = apply.output.trim();
                    this.logger.info('diffPatch: git apply --verbose', { exitCode: apply.exitCode, output: trimmed });
                    if (isSkippedOutput(trimmed)) {
                        this.logger.warn('diffPatch: apply skipped patches', { stripLevel, output: trimmed });
                    }
                    await logTreeHashes('diffPatch: patched hashes (post apply)', patchedRootShellPath);
                } catch (error: any) {
                    // Try a best-effort preview by allowing rejects so we can still show partial diffs.
                    try {
                        await this.executeGitCommandResult(
                            ['apply', `-p${stripLevel}`, '--reject', '--whitespace=nowarn', '-'],
                            patchedRootShellPath,
                            [0, 1],
                            patchContent
                        );
                        vscode.window.showWarningMessage('Patch did not apply cleanly; showing best-effort diff preview with rejects.');
                    } catch {
                        vscode.window.showErrorMessage(`Failed to apply patch for diff preview: ${error.message || error}`);
                        return;
                    }
                }
            }

                    steps.next('Verify preview has changes');

                // If the patched preview tree produced no differences, avoid opening empty diffs.
            // This commonly happens when all hunks were rejected or the patch is already applied.
            let hasAnyDiff = false;
            const diffSummary: Array<{ path: string; changed: boolean; leftBytes?: number; rightBytes?: number }> = [];
            for (const edit of fileEdits) {
                const leftRelPath = edit.status === 'added' ? edit.newPath : edit.oldPath;
                const rightRelPath = edit.status === 'deleted' ? edit.oldPath : edit.newPath;
                const leftUri = this.joinUriPath(originalRootUri, leftRelPath);
                const rightUri = this.joinUriPath(patchedRootUri, rightRelPath);

                try {
                    const leftBytes = await vscode.workspace.fs.readFile(leftUri);
                    let rightBytes: Uint8Array;
                    try {
                        rightBytes = await vscode.workspace.fs.readFile(rightUri);
                    } catch {
                        rightBytes = encoder.encode('');
                    }

                    if (leftBytes.length !== rightBytes.length) {
                        hasAnyDiff = true;
                        diffSummary.push({ path: rightRelPath, changed: true, leftBytes: leftBytes.length, rightBytes: rightBytes.length });
                        break;
                    }
                    for (let i = 0; i < leftBytes.length; i++) {
                        if (leftBytes[i] !== rightBytes[i]) {
                            hasAnyDiff = true;
                            diffSummary.push({ path: rightRelPath, changed: true, leftBytes: leftBytes.length, rightBytes: rightBytes.length });
                            break;
                        }
                    }
                    if (hasAnyDiff) {
                        break;
                    }

                    diffSummary.push({ path: rightRelPath, changed: false, leftBytes: leftBytes.length, rightBytes: rightBytes.length });
                } catch {
                    // If we can't read one side, still try opening diffs below.
                    hasAnyDiff = true;
                    diffSummary.push({ path: rightRelPath, changed: true });
                    break;
                }
            }

            if (!hasAnyDiff) {
                this.logger.warn('diffPatch: preview produced no diffs', { patchFile, sourceDir, fileEdits, diffSummary });
                vscode.window.showWarningMessage('Patch preview produced no differences. The patch may already be applied, or all hunks were rejected in this workspace.');
                return;
            }

                    steps.next('Open diff editors');
                    steps.detail(`0/${fileEdits.length} files`);

            // Open diffs for all impacted files.
            for (let i = 0; i < fileEdits.length; i++) {
                const edit = fileEdits[i];
                if (i === 0 || i % 5 === 0 || i === fileEdits.length - 1) {
                    steps.detail(`${Math.min(i, fileEdits.length)}/${fileEdits.length} files`);
                }
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
                    steps.detail(`${fileEdits.length}/${fileEdits.length} files`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('diffPatch threw', { error: errorMessage });
            vscode.window.showErrorMessage(`Error diffing patch: ${errorMessage}`);
        }
            }
        });
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
        // joinPath(..., '..') does not reliably compute parents across URI schemes.
        // Compute the directory using the appropriate path semantics.
        const parentUri = fileUri.scheme === 'file'
            ? vscode.Uri.file(path.dirname(fileUri.fsPath))
            : fileUri.with({ path: path.posix.dirname(fileUri.path) });
        await vscode.workspace.fs.createDirectory(parentUri);
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
