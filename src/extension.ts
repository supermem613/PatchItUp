import * as vscode from 'vscode';
import { PatchPanelProvider } from './patchPanel';
import { createLogger } from './logger';

export function activate(context: vscode.ExtensionContext) {
    const logger = createLogger();
    context.subscriptions.push(logger);
    logger.info('PatchItUp extension is now active', {
        remoteName: vscode.env.remoteName,
        uiKind: vscode.env.uiKind
    });

    // Register the webview panel provider
    const provider = new PatchPanelProvider(context.extensionUri, logger);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PatchPanelProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('patchitup.showLogs', () => {
            logger.show(true);
        })
    );

    // Register command for creating patch
    let disposable = vscode.commands.registerCommand('patchitup.createPatch', async () => {
        // Get configuration
        const config = vscode.workspace.getConfiguration('patchitup');
        const projectName = config.get<string>('projectName', 'project');
        const destinationPath = config.get<string>('destinationPath', '');

        // Validate configuration
        if (!destinationPath) {
            const result = await vscode.window.showErrorMessage(
                'Please configure the destination path in settings (patchitup.destinationPath)',
                'Open Settings'
            );
            if (result === 'Open Settings') {
                vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'patchitup.destinationPath'
                );
            }
            return;
        }

        // Call the provider's createPatch method
        await provider.createPatchFromCommand(projectName, destinationPath);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
