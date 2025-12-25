import * as vscode from 'vscode';
import * as os from 'os';
import { buildGitShellExecution } from './gitShellExecution';
import { getTempRootLocation, normalizeCwd, PATCHITUP_TMP_DIRNAME } from './commandPathUtils';

export type RunGitTaskArgs = {
    args: string[];
    cwd: string;
    allowedExitCodes?: number[];
    stdin?: string;
    workspaceFolder?: vscode.WorkspaceFolder;
    workspaceFolderUri?: vscode.Uri;
};

export async function runGitTask({
    args,
    cwd,
    allowedExitCodes = [0],
    stdin,
    workspaceFolder,
    workspaceFolderUri
}: RunGitTaskArgs): Promise<{ exitCode: number; output: string }> {
    const remoteName = vscode.env.remoteName;

    const normalizedCwd = normalizeCwd(cwd, remoteName);

    const baseWorkspaceUri = workspaceFolder?.uri ?? workspaceFolderUri;
    const workspaceRootPosixPath = baseWorkspaceUri?.path;

    const tempRootLocation = getTempRootLocation({
        remoteName,
        workspaceRootPosixPath,
        osTmpDir: os.tmpdir()
    });

    let tempRootUri: vscode.Uri;
    if (tempRootLocation.kind === 'workspace') {
        if (!baseWorkspaceUri) {
            // getTempRootLocation only returns 'workspace' when we provide a workspace root.
            throw new Error('PatchItUp: Internal error resolving workspace temp root');
        }

        const tmpDirUri = vscode.Uri.joinPath(baseWorkspaceUri, PATCHITUP_TMP_DIRNAME);
        await vscode.workspace.fs.createDirectory(tmpDirUri);
        tempRootUri = vscode.Uri.joinPath(baseWorkspaceUri, ...tempRootLocation.relativeSegments);
    } else {
        tempRootUri = vscode.Uri.file(tempRootLocation.absolutePath);
    }

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runDirUri = vscode.Uri.joinPath(tempRootUri, 'git', runId);
    await vscode.workspace.fs.createDirectory(runDirUri);

    const stdoutUri = vscode.Uri.joinPath(runDirUri, 'out.txt');
    const exitCodeUri = vscode.Uri.joinPath(runDirUri, 'code.txt');
    const stdinUri = stdin !== undefined ? vscode.Uri.joinPath(runDirUri, 'stdin.txt') : undefined;

    if (stdinUri && stdin !== undefined) {
        await vscode.workspace.fs.writeFile(stdinUri, new TextEncoder().encode(stdin));
    }

    const useBash = vscode.env.remoteName !== undefined || process.platform !== 'win32';

    const cwdForShell = useBash ? normalizedCwd : cwd;
    const outPath = useBash ? stdoutUri.fsPath.replace(/\\/g, '/') : stdoutUri.fsPath;
    const codePath = useBash ? exitCodeUri.fsPath.replace(/\\/g, '/') : exitCodeUri.fsPath;
    const inPath = stdinUri
        ? useBash
            ? stdinUri.fsPath.replace(/\\/g, '/')
            : stdinUri.fsPath
        : undefined;

    const { shellCommand, shellArgs } = buildGitShellExecution({
        useBash,
        cwdForShell,
        args,
        outPath,
        codePath,
        inPath
    });

    const task = new vscode.Task(
        { type: 'shell', task: 'patchitup.git' },
        workspaceFolder ?? vscode.TaskScope.Workspace,
        `PatchItUp: git (${runId})`,
        'PatchItUp',
        new vscode.ShellExecution(shellCommand, shellArgs)
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Never,
        focus: false,
        echo: false,
        panel: vscode.TaskPanelKind.Shared,
        showReuseMessage: false,
        clear: false
    };

    const exec = await vscode.tasks.executeTask(task);

    await new Promise<void>((resolve) => {
        const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
            if (e.execution !== exec) {
                return;
            }
            disposable.dispose();
            resolve();
        });

        // If a task never starts/ends, callers should provide their own timeouts.
        void disposable;
    });

    const decoder = new TextDecoder('utf-8');
    let output = '';
    let exitCode = -1;
    try {
        try {
            const outBytes = await vscode.workspace.fs.readFile(stdoutUri);
            output = decoder.decode(outBytes);
        } catch {
            output = '';
        }

        try {
            const codeBytes = await vscode.workspace.fs.readFile(exitCodeUri);
            const codeText = decoder.decode(codeBytes).trim();
            const parsed = Number.parseInt(codeText, 10);
            exitCode = Number.isFinite(parsed) ? parsed : -1;
        } catch {
            exitCode = -1;
        }
    } finally {
        try {
            await vscode.workspace.fs.delete(tempRootUri, { recursive: true, useTrash: false });
        } catch {
            // ignore cleanup failures
        }

        if (tempRootLocation.kind === 'workspace' && baseWorkspaceUri) {
            try {
                const tmpDirUri = vscode.Uri.joinPath(baseWorkspaceUri, PATCHITUP_TMP_DIRNAME);
                const remaining = await vscode.workspace.fs.readDirectory(tmpDirUri);
                if (remaining.length === 0) {
                    await vscode.workspace.fs.delete(tmpDirUri, { recursive: true, useTrash: false });
                }
            } catch {
                // ignore cleanup failures
            }
        }
    }

    if (!allowedExitCodes.includes(exitCode)) {
        const trimmed = output.trim();
        throw new Error(
            `Git command failed with exit code ${exitCode}${trimmed ? `\nGit output: ${trimmed}` : ''}`
        );
    }

    return { exitCode, output };
}
