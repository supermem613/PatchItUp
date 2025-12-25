import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { createTempGitRepo } from './tempRepo';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../..');

    const { repoPath } = await createTempGitRepo({
        projectName: 'e2e',
        initialFiles: {
            'a.txt': 'one\n'
        }
    });

    // Note: this path is inside the extension *development* repo, not the temp git repo.
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [repoPath, '--disable-extensions']
    });
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
