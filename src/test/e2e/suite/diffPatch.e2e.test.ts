import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PatchPanelProvider } from '../../../patchPanel';
import { createLogger } from '../../../logger';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return `${stdout ?? ''}${stderr ?? ''}`.trimEnd();
}

async function waitForPatchFile(dir: string, timeoutMs = 20_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const entries = await fs.readdir(dir);
        const patches = entries.filter((e) => e.endsWith('.patch'));
        if (patches.length > 0) {
            const withTimes = await Promise.all(
                patches.map(async (name) => {
                    const st = await fs.stat(path.join(dir, name));
                    return { name, mtimeMs: st.mtimeMs };
                })
            );
            withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
            return withTimes[0].name;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for patch file in ${dir}`);
}

async function listDiffTempDirs(): Promise<Set<string>> {
    const tmp = os.tmpdir();
    const entries = await fs.readdir(tmp, { withFileTypes: true });
    const dirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('patchitup-diff-'))
        .map((e) => e.name);
    return new Set(dirs);
}

const normalizeNewlines = (s: string) => s.replace(/\r\n/g, '\n');

describe('PatchItUp E2E: diffPatch', () => {
    it('creates a temp preview and does not modify the repo', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, 'Expected a workspace folder');
        const repoPath = workspaceFolder.uri.fsPath;

        const cfg = vscode.workspace.getConfiguration('patchitup');
        const destinationPath = cfg.get<string>('destinationPath');
        assert.ok(destinationPath, 'Expected patchitup.destinationPath in workspace settings');

        // Ensure repo is clean.
        await runGit(['reset', '--hard', 'HEAD'], repoPath);
        await runGit(['clean', '-fd'], repoPath);
        assert.strictEqual(
            (await runGit(['status', '--porcelain'], repoPath)).trim(),
            '',
            'Expected clean repo at start'
        );

        // Create a patch for a known change.
        const aTxt = path.join(repoPath, 'a.txt');
        await fs.writeFile(aTxt, 'two\n', 'utf8');
        await vscode.commands.executeCommand('patchitup.createPatch');
        const patchFile = await waitForPatchFile(destinationPath);

        // Reset back to clean before diffing.
        await runGit(['reset', '--hard', 'HEAD'], repoPath);
        await runGit(['clean', '-fd'], repoPath);
        assert.strictEqual(
            (await runGit(['status', '--porcelain'], repoPath)).trim(),
            '',
            'Expected clean repo before diffPatch'
        );

        const beforeDirs = await listDiffTempDirs();

        // Instantiate provider directly (no webview) and stub vscode.diff command.
        const ext = vscode.extensions.getExtension('supermem613.patchitup');
        assert.ok(ext, 'Expected PatchItUp extension to be available');

        const provider = new PatchPanelProvider(ext.extensionUri, createLogger());

        const diffCalls: Array<{ left: unknown; right: unknown; title: unknown }> = [];
        const originalExecute = vscode.commands.executeCommand;
        (vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
            if (command === 'vscode.diff') {
                diffCalls.push({ left: args[0], right: args[1], title: args[2] });
                return undefined;
            }
            return originalExecute(command, ...args);
        };

        let createdTempDirPath: string | undefined;
        try {
            await (provider as any).diffPatch(patchFile);

            // Repo must remain unchanged.
            assert.strictEqual(
                (await runGit(['status', '--porcelain'], repoPath)).trim(),
                '',
                'Expected repo to remain clean after diffPatch'
            );

            // Verify at least one diff would have been opened.
            assert.ok(diffCalls.length >= 1, 'Expected at least one vscode.diff call');

            const afterDirs = await listDiffTempDirs();
            const created = [...afterDirs].filter((d) => !beforeDirs.has(d));
            assert.ok(created.length >= 1, 'Expected a new patchitup-diff-* temp directory');

            // Pick the most recently created name by stat time.
            const tmp = os.tmpdir();
            const withTimes = await Promise.all(
                created.map(async (name) => {
                    const st = await fs.stat(path.join(tmp, name));
                    return { name, mtimeMs: st.mtimeMs };
                })
            );
            withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);

            const chosen = withTimes[0].name;
            createdTempDirPath = path.join(tmp, chosen);

            const originalPath = path.join(createdTempDirPath, 'original', 'a.txt');
            const patchedPath = path.join(createdTempDirPath, 'patched', 'a.txt');

            const originalText = normalizeNewlines(await fs.readFile(originalPath, 'utf8'));
            const patchedText = normalizeNewlines(await fs.readFile(patchedPath, 'utf8'));

            assert.strictEqual(originalText, 'one\n');
            assert.strictEqual(patchedText, 'two\n');
        } finally {
            // Restore command to avoid impacting other tests.
            (vscode.commands as any).executeCommand = originalExecute;

            // Best-effort cleanup of the created temp dir.
            if (createdTempDirPath) {
                try {
                    await fs.rm(createdTempDirPath, { recursive: true, force: true });
                } catch {
                    // ignore
                }
            }
        }
    });
});
