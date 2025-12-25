import * as path from 'path';

export const PATCHITUP_TMP_DIRNAME = '.patchitup-tmp';

export function isRemoteSession(remoteName: string | undefined): boolean {
    return remoteName !== undefined;
}

export function normalizeCwd(cwd: string, remoteName: string | undefined): string {
    const trimmed = cwd.trim();
    return isRemoteSession(remoteName) ? trimmed.replace(/\\/g, '/') : trimmed;
}

export function quoteShellArg(arg: string): string {
    // Minimal, cross-shell-ish quoting used by this extension.
    // We only quote when needed to preserve whitespace/quotes.
    if (!/[\s"]/g.test(arg)) {
        return arg;
    }
    return `"${arg.replace(/"/g, '\\"')}"`;
}

export function quoteShellArgs(args: string[]): string {
    return args.map(quoteShellArg).join(' ');
}

type WorkspaceTempLocation = {
    kind: 'workspace';
    relativeSegments: string[];
    shellPath: string;
};

type OsTempLocation = {
    kind: 'os';
    absolutePath: string;
    shellPath: string;
};

export type TempLocation = WorkspaceTempLocation | OsTempLocation;

function joinPosix(root: string, ...parts: string[]): string {
    const cleanedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
    const cleanedParts = parts
        .filter(Boolean)
        .map(p => p.replace(/^\/+/, '').replace(/\/+$/, ''))
        .filter(Boolean);
    return [cleanedRoot, ...cleanedParts].join('/');
}

export function getTempOutputLocation(params: {
    remoteName: string | undefined;
    workspaceRootPosixPath: string | undefined;
    osTmpDir: string;
    fileName?: string;
}): TempLocation {
    const fileName = params.fileName ?? `.patchitup-temp-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

    if (isRemoteSession(params.remoteName) && params.workspaceRootPosixPath) {
        return {
            kind: 'workspace',
            relativeSegments: [PATCHITUP_TMP_DIRNAME, fileName],
            shellPath: joinPosix(params.workspaceRootPosixPath, PATCHITUP_TMP_DIRNAME, fileName)
        };
    }

    const absolutePath = path.join(params.osTmpDir, fileName);
    return { kind: 'os', absolutePath, shellPath: absolutePath };
}

export function getTempRootLocation(params: {
    remoteName: string | undefined;
    workspaceRootPosixPath: string | undefined;
    osTmpDir: string;
    folderName?: string;
}): TempLocation {
    const folderName = params.folderName ?? `patchitup-diff-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (isRemoteSession(params.remoteName) && params.workspaceRootPosixPath) {
        return {
            kind: 'workspace',
            relativeSegments: [PATCHITUP_TMP_DIRNAME, folderName],
            shellPath: joinPosix(params.workspaceRootPosixPath, PATCHITUP_TMP_DIRNAME, folderName)
        };
    }

    const absolutePath = path.join(params.osTmpDir, folderName);
    return { kind: 'os', absolutePath, shellPath: absolutePath };
}
