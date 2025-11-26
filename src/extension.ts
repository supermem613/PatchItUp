import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { PatchPanelProvider } from './patchPanel';

const exec = promisify(cp.exec);

export function activate(context: vscode.ExtensionContext) {
    console.log('PatchItUp extension is now active');

    // Register the webview panel provider
    const provider = new PatchPanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PatchPanelProvider.viewType, provider)
    );

    // Register command for creating patch
    let disposable = vscode.commands.registerCommand('patchitup.createPatch', async () => {
        await createAndSavePatch();
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

async function createAndSavePatch() {
    try {
        // Get configuration
        const config = vscode.workspace.getConfiguration('patchitup');
        const sourceDirectory = config.get<string>('sourceDirectory', '/tmp');
        const projectName = config.get<string>('projectName', 'project');
        const destinationPath = config.get<string>('destinationPath', '');

        // Validate configuration
        if (!destinationPath) {
            const result = await vscode.window.showErrorMessage(
                'Please configure the destination path in settings (patchitup.destinationPath)',
                'Open Settings'
            );
            if (result === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'patchitup.destinationPath');
            }
            return;
        }

        // Check if source directory exists
        if (!fs.existsSync(sourceDirectory)) {
            const result = await vscode.window.showErrorMessage(
                `Source directory does not exist: ${sourceDirectory}`,
                'Use Current Workspace',
                'Open Settings'
            );
            if (result === 'Use Current Workspace') {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    await config.update('sourceDirectory', workspaceFolder.uri.fsPath, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Source directory updated to: ${workspaceFolder.uri.fsPath}`);
                    // Retry with new path
                    return createAndSavePatch();
                }
            } else if (result === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'patchitup.sourceDirectory');
            }
            return;
        }

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Creating patch...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Checking for changes..." });

            // Check if there are any changes
            const statusCmd = `cd "${sourceDirectory}" && git status --porcelain`;
            const { stdout: statusOutput } = await exec(statusCmd);

            if (!statusOutput.trim()) {
                vscode.window.showInformationMessage('No changes to create a patch from.');
                return;
            }

            progress.report({ increment: 30, message: "Creating patch..." });

            // Create the patch - include both staged and unstaged changes
            const patchCmd = `cd "${sourceDirectory}" && git diff HEAD`;
            const { stdout: patchContent } = await exec(patchCmd);

            if (!patchContent.trim()) {
                // If no diff from HEAD, try getting untracked files as well
                const untrackedCmd = `cd "${sourceDirectory}" && git ls-files --others --exclude-standard`;
                const { stdout: untrackedFiles } = await exec(untrackedCmd);
                
                if (untrackedFiles.trim()) {
                    vscode.window.showInformationMessage('Only untracked files found. Please stage or commit files first to include them in the patch.');
                    return;
                }
                
                vscode.window.showInformationMessage('No changes to create a patch from.');
                return;
            }

            progress.report({ increment: 60, message: "Saving patch file..." });

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
            
            // Use vscode-userdata scheme to write to host machine
            // This ensures the file is saved to the local machine, not the Codespace
            let destinationUri: vscode.Uri;
            
            // Check if we're in a remote environment (Codespace)
            const isRemote = vscode.env.remoteName !== undefined;
            
            if (isRemote) {
                // In Codespace: use vscode-local scheme to write to host machine
                destinationUri = vscode.Uri.file(path.join(destinationPath, filename)).with({ scheme: 'vscode-local' });
            } else {
                // Local: use regular file scheme
                destinationUri = vscode.Uri.file(path.join(destinationPath, filename));
            }

            // Write the patch file using VS Code's file system API
            try {
                const encoder = new TextEncoder();
                const patchBytes = encoder.encode(patchContent);
                
                // Ensure directory exists
                const dirUri = vscode.Uri.joinPath(destinationUri, '..');
                try {
                    await vscode.workspace.fs.createDirectory(dirUri);
                } catch {
                    // Directory might already exist, that's okay
                }
                
                // Write the file
                await vscode.workspace.fs.writeFile(destinationUri, patchBytes);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Cannot write patch file: ${errorMsg}. Make sure the destination path exists on your local machine.`);
                return;
            }
            
            const fullPath = path.join(destinationPath, filename);

            progress.report({ increment: 100, message: "Done!" });

            // Show success message with option to open file location
            const result = await vscode.window.showInformationMessage(
                `Patch created successfully: ${filename}`,
                'Open Folder',
                'Copy Path'
            );

            if (result === 'Open Folder') {
                // Open the folder in file explorer
                if (process.platform === 'win32') {
                    cp.exec(`explorer "${destinationPath}"`);
                } else if (process.platform === 'darwin') {
                    cp.exec(`open "${destinationPath}"`);
                } else {
                    cp.exec(`xdg-open "${destinationPath}"`);
                }
            } else if (result === 'Copy Path') {
                vscode.env.clipboard.writeText(fullPath);
                vscode.window.showInformationMessage('Path copied to clipboard');
            }
        });

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to create patch: ${errorMessage}`);
        console.error('PatchItUp error:', error);
    }
}
