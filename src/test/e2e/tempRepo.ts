import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return `${stdout ?? ''}${stderr ?? ''}`;
}

export async function createTempGitRepo(params: {
    projectName: string;
    initialFiles: Record<string, string>;
}): Promise<{ repoPath: string; patchesDir: string }>
{
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'patchitup-e2e-repo-'));
    const patchesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patchitup-e2e-patches-'));

    await runGit(['init'], repoPath);
    await runGit(['config', 'user.email', 'e2e@example.com'], repoPath);
    await runGit(['config', 'user.name', 'PatchItUp E2E'], repoPath);

    // Keep workspace-specific VS Code files from dirtying the repo.
    await fs.writeFile(path.join(repoPath, '.gitignore'), '.vscode/\n', 'utf8');

    for (const [rel, content] of Object.entries(params.initialFiles)) {
        const abs = path.join(repoPath, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
    }

    await runGit(['add', '.'], repoPath);
    await runGit(['commit', '-m', 'init'], repoPath);

    // Workspace-scoped settings so tests don't mutate user/global settings.
    const vscodeDir = path.join(repoPath, '.vscode');
    await fs.mkdir(vscodeDir, { recursive: true });

    const settingsPath = path.join(vscodeDir, 'settings.json');
    const settings = {
        'patchitup.projectName': params.projectName,
        'patchitup.destinationPath': patchesDir
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 4), 'utf8');

    return { repoPath, patchesDir };
}
