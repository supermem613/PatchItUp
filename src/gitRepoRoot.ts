import * as vscode from 'vscode';
import { runGitTask } from './gitTaskRunner';

type GitExtension = {
    getAPI(version: 1): GitApi;
};

type GitApi = {
    readonly repositories: ReadonlyArray<GitRepository>;
    getRepository?(uri: vscode.Uri): GitRepository | null;
};

type GitRepository = {
    readonly rootUri: vscode.Uri;
};

export class NoGitRepositoryOpenError extends Error {
    constructor(message = 'PatchItUp: No git repository is currently open in VS Code') {
        super(message);
        this.name = 'NoGitRepositoryOpenError';
    }
}

const uriIsUnderRoot = (uri: vscode.Uri, root: vscode.Uri): boolean => {
    // Compare normalized, slash-terminated paths.
    const uriPath = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
    const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
    return uriPath.startsWith(rootPath);
};

const getCandidateWorkspaceFolderUri = (): vscode.Uri | undefined => {
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    const byActive = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri : undefined;
    return byActive ?? vscode.workspace.workspaceFolders?.[0]?.uri;
};

const tryResolveRepoRootViaGitTask = async (): Promise<string | undefined> => {
    const workspaceFolderUri = getCandidateWorkspaceFolderUri();
    if (!workspaceFolderUri) {
        return undefined;
    }

    try {
        const out = await runGitTask({
            args: ['rev-parse', '--show-toplevel'],
            cwd: workspaceFolderUri.fsPath,
            workspaceFolderUri
        });
        const trimmed = out.output.trim();
        return trimmed || undefined;
    } catch {
        return undefined;
    }
};

export async function getOpenGitRepositoryRootPath(): Promise<string> {
    // Preferred: use the Git extension API when it is available in this extension host.
    // In some remote setups (e.g. Codespaces), the built-in Git extension may not be
    // running in the same extension host as PatchItUp, so we need a fallback.
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');

    if (gitExt) {
        if (!gitExt.isActive) {
            try {
                await gitExt.activate();
            } catch {
                // ignore and fall back
            }
        }

        const gitApi = gitExt.exports?.getAPI?.(1);
        const repos = gitApi?.repositories ?? [];
        if (gitApi && repos.length > 0) {
            const activeUri = vscode.window.activeTextEditor?.document?.uri;

            let repo: GitRepository | undefined;
            if (activeUri && gitApi.getRepository) {
                repo = gitApi.getRepository(activeUri) ?? undefined;
            }

            if (!repo && activeUri) {
                repo = repos.find((r) => uriIsUnderRoot(activeUri, r.rootUri));
            }

            repo ??= repos[0];
            if (repo) {
                return repo.rootUri.scheme === 'file' ? repo.rootUri.fsPath : repo.rootUri.path;
            }
        }
    }

    // Fallback: ask git directly in the workspace environment.
    const viaGit = await tryResolveRepoRootViaGitTask();
    if (viaGit) {
        return viaGit;
    }

    throw new NoGitRepositoryOpenError();
}
