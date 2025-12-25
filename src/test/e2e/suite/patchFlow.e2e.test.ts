import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return `${stdout ?? ''}${stderr ?? ''}`.trimEnd();
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

async function waitForPatchFile(dir: string, timeoutMs = 20_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const entries = await fs.readdir(dir);
        const patches = entries.filter((e) => e.endsWith('.patch'));
        if (patches.length > 0) {
            // Newest-first by mtime as a simple heuristic.
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

describe('PatchItUp E2E: create + apply', () => {
    it('creates a patch from uncommitted changes and reapplies it cleanly', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, 'Expected a workspace folder');
        const repoPath = workspaceFolder.uri.fsPath;

        const cfg = vscode.workspace.getConfiguration('patchitup');
        const projectName = cfg.get<string>('projectName');
        const destinationPath = cfg.get<string>('destinationPath');
        assert.ok(projectName, 'Expected patchitup.projectName in workspace settings');
        assert.ok(destinationPath, 'Expected patchitup.destinationPath in workspace settings');

        // Preflight: git available and repo clean.
        await runGit(['status'], repoPath);
        const initialStatus = await runGit(['status', '--porcelain'], repoPath);
        assert.strictEqual(initialStatus.trim(), '', 'Expected clean repo at start');

        // Modify a tracked file.
        const aTxt = path.join(repoPath, 'a.txt');
        assert.ok(await fileExists(aTxt), 'Expected a.txt to exist');
        await fs.writeFile(aTxt, 'two\n', 'utf8');

        const dirtyStatus = await runGit(['status', '--porcelain'], repoPath);
        assert.ok(dirtyStatus.includes('a.txt'), 'Expected a.txt to be modified');

        // Create patch.
        await vscode.commands.executeCommand('patchitup.createPatch');
        const patchFile = await waitForPatchFile(destinationPath);
        assert.ok(
            new RegExp(`^${projectName}_[0-9]{14}\\.patch$`).test(patchFile),
            `Unexpected patch filename: ${patchFile}`
        );

        const patchPath = path.join(destinationPath, patchFile);
        const patchContent = await fs.readFile(patchPath, 'utf8');
        assert.ok(patchContent.includes('diff --git a/a.txt b/a.txt'));
        assert.ok(patchContent.includes('--- a/a.txt'));
        assert.ok(patchContent.includes('+++ b/a.txt'));

        // Reset working tree to clean.
        await runGit(['reset', '--hard', 'HEAD'], repoPath);
        await runGit(['clean', '-fd'], repoPath);

        const cleanStatus = await runGit(['status', '--porcelain'], repoPath);
        assert.strictEqual(cleanStatus.trim(), '', 'Expected clean repo before apply');

        // Apply patch (command takes filename arg).
        await vscode.commands.executeCommand('patchitup.applyPatch', patchFile);

        const afterApply = await fs.readFile(aTxt, 'utf8');
        assert.strictEqual(afterApply.replace(/\r\n/g, '\n'), 'two\n');

        const afterStatus = await runGit(['status', '--porcelain'], repoPath);
        assert.ok(afterStatus.includes('a.txt'), 'Expected repo to be dirty after apply');
    });
});
