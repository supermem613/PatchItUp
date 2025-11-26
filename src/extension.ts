import * as vscode from 'vscode';
import { PatchPanelProvider } from './patchPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('PatchItUp extension is now active');

    // Register the webview panel provider
    const provider = new PatchPanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PatchPanelProvider.viewType, provider)
    );

    // Register command for creating patch
    let disposable = vscode.commands.registerCommand('patchitup.createPatch', async () => {
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

        // Call the provider's createPatch method
        await provider.createPatchFromCommand(sourceDirectory, projectName, destinationPath);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
