import * as assert from 'assert';

type Disposable = { dispose: () => void };

const withMockedModules = async <T>(
    stubs: Record<string, unknown>,
    clear: string[],
    fn: () => Promise<T> | T
): Promise<T> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module') as typeof import('module');
    const originalLoad = (Module as unknown as { _load: unknown })._load as any;

    (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request in stubs) {
            return stubs[request];
        }
        return originalLoad.apply(this, arguments as any);
    };

    for (const rel of clear) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const resolved = require.resolve(rel);
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete require.cache[resolved];
        } catch {
            // ignore
        }
    }

    try {
        return await fn();
    } finally {
        (Module as any)._load = originalLoad;
    }
};

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

type UriLike = {
    scheme?: string;
    fsPath: string;
    path: string;
    toString: () => string;
};

const makeUri = (fsPath: string, path: string, scheme = 'file'): UriLike => ({
    scheme,
    fsPath,
    path,
    toString: () => `${scheme}:${path}`
});

const joinFs = (base: string, seg: string): string => {
    const sep = base.includes('\\') ? '\\' : '/';
    const trimmedBase = base.endsWith(sep) ? base.slice(0, -1) : base;
    const trimmedSeg = seg.startsWith(sep) ? seg.slice(1) : seg;
    return `${trimmedBase}${sep}${trimmedSeg}`;
};

const joinPosix = (base: string, seg: string): string => {
    const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const trimmedSeg = seg.startsWith('/') ? seg.slice(1) : seg;
    return `${trimmedBase}/${trimmedSeg}`;
};

describe('runGitTask', () => {
    it('writes stdin and passes inPath to buildGitShellExecution', async () => {
        let captured: any;
        const buildGitShellExecution = (params: any) => {
            captured = params;
            return { shellCommand: 'cmd.exe', shellArgs: ['/c', 'echo ok'] };
        };

        const createdDirs: string[] = [];
        const writtenFiles: Array<{ path: string; content: string }> = [];
        const deleted: string[] = [];
        const readDirectoryCalls: string[] = [];

        let endListener: ((e: any) => void) | undefined;
        let lastExec: any;
        const execObj = { id: 1 };

        const vscodeStub = {
            env: { remoteName: undefined },
            TaskScope: { Workspace: 1 },
            TaskRevealKind: { Never: 2 },
            TaskPanelKind: { Shared: 3 },
            Uri: {
                file: (p: string) => makeUri(p, p.replace(/\\/g, '/'), 'file'),
                joinPath: (base: UriLike, ...segs: string[]) => {
                    let fsPath = base.fsPath;
                    let path = base.path;
                    for (const s of segs) {
                        fsPath = joinFs(fsPath, s);
                        path = joinPosix(path, s);
                    }
                    return makeUri(fsPath, path, base.scheme ?? 'file');
                }
            },
            ShellExecution: class {
                // eslint-disable-next-line @typescript-eslint/no-useless-constructor
                constructor(public command: string, public args: string[]) {}
            },
            Task: class {
                public presentationOptions: any;
                constructor(
                    public definition: any,
                    public scope: any,
                    public name: string,
                    public source: string,
                    public execution: any
                ) {}
            },
            tasks: {
                executeTask: async (_task: any) => {
                    lastExec = execObj;
                    if (endListener) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return lastExec;
                },
                onDidEndTaskProcess: (cb: (e: any) => void): Disposable => {
                    endListener = cb;
                    if (lastExec) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return { dispose: () => undefined };
                }
            },
            workspace: {
                fs: {
                    createDirectory: async (uri: UriLike) => {
                        createdDirs.push(uri.fsPath);
                    },
                    writeFile: async (uri: UriLike, bytes: Uint8Array) => {
                        writtenFiles.push({ path: uri.fsPath, content: new TextDecoder().decode(bytes) });
                    },
                    readFile: async (uri: UriLike) => {
                        if (uri.fsPath.endsWith('out.txt')) {
                            return textBytes('OUTPUT');
                        }
                        if (uri.fsPath.endsWith('code.txt')) {
                            return textBytes('0');
                        }
                        return textBytes('');
                    },
                    delete: async (uri: UriLike) => {
                        deleted.push(uri.fsPath);
                    },
                    readDirectory: async (uri: UriLike) => {
                        readDirectoryCalls.push(uri.fsPath);
                        // Return empty to trigger tmp-root cleanup.
                        return [] as any;
                    }
                }
            }
        };

        await withMockedModules(
            {
                vscode: vscodeStub,
                './gitShellExecution': { buildGitShellExecution }
            },
            ['../../gitTaskRunner'],
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { runGitTask } = require('../../gitTaskRunner');

                const workspaceFolderUri = makeUri(
                    'C:\\repo',
                    '/c:/repo',
                    'file'
                );

                const res = await runGitTask({
                    args: ['status'],
                    cwd: 'C:\\repo',
                    stdin: 'HELLO',
                    workspaceFolderUri
                });

                assert.strictEqual(res.exitCode, 0);
                assert.strictEqual(res.output, 'OUTPUT');
            }
        );

        assert.ok(captured);
        assert.strictEqual(captured.inPath?.includes('stdin.txt'), true);

        assert.ok(writtenFiles.some((f) => f.path.endsWith('stdin.txt') && f.content === 'HELLO'));
        assert.ok(createdDirs.some((d) => d.includes('git')));
        assert.ok(deleted.length >= 1);
        assert.ok(readDirectoryCalls.length >= 0);
    });

    it('accepts non-zero exit codes when allowedExitCodes includes them', async () => {
        const buildGitShellExecution = (_params: any) => ({
            shellCommand: 'cmd.exe',
            shellArgs: ['/c', 'exit 1']
        });

        let endListener: ((e: any) => void) | undefined;
        let lastExec: any;
        const execObj = { id: 2 };

        const vscodeStub = {
            env: { remoteName: undefined },
            TaskScope: { Workspace: 1 },
            TaskRevealKind: { Never: 2 },
            TaskPanelKind: { Shared: 3 },
            Uri: {
                file: (p: string) => makeUri(p, p.replace(/\\/g, '/'), 'file'),
                joinPath: (base: UriLike, ...segs: string[]) => {
                    let fsPath = base.fsPath;
                    let path = base.path;
                    for (const s of segs) {
                        fsPath = joinFs(fsPath, s);
                        path = joinPosix(path, s);
                    }
                    return makeUri(fsPath, path, base.scheme ?? 'file');
                }
            },
            ShellExecution: class {
                constructor(public command: string, public args: string[]) {}
            },
            Task: class {
                public presentationOptions: any;
                constructor(
                    public definition: any,
                    public scope: any,
                    public name: string,
                    public source: string,
                    public execution: any
                ) {}
            },
            tasks: {
                executeTask: async (_task: any) => {
                    lastExec = execObj;
                    if (endListener) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return lastExec;
                },
                onDidEndTaskProcess: (cb: (e: any) => void): Disposable => {
                    endListener = cb;
                    if (lastExec) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return { dispose: () => undefined };
                }
            },
            workspace: {
                fs: {
                    createDirectory: async (_uri: UriLike) => undefined,
                    writeFile: async (_uri: UriLike, _bytes: Uint8Array) => undefined,
                    readFile: async (uri: UriLike) => {
                        if (uri.fsPath.endsWith('out.txt')) {
                            return textBytes('ERR');
                        }
                        if (uri.fsPath.endsWith('code.txt')) {
                            return textBytes('1');
                        }
                        return textBytes('');
                    },
                    delete: async (_uri: UriLike) => undefined,
                    readDirectory: async (_uri: UriLike) => [] as any
                }
            }
        };

        await withMockedModules(
            {
                vscode: vscodeStub,
                './gitShellExecution': { buildGitShellExecution }
            },
            ['../../gitTaskRunner'],
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { runGitTask } = require('../../gitTaskRunner');

                const res = await runGitTask({
                    args: ['check'],
                    cwd: 'C:\\repo',
                    allowedExitCodes: [0, 1]
                });

                assert.strictEqual(res.exitCode, 1);
                assert.strictEqual(res.output, 'ERR');
            }
        );
    });

    it('throws with git output when exit code is not allowed', async () => {
        const buildGitShellExecution = (_params: any) => ({
            shellCommand: 'cmd.exe',
            shellArgs: ['/c', 'exit 2']
        });

        let endListener: ((e: any) => void) | undefined;
        let lastExec: any;
        const execObj = { id: 3 };

        const vscodeStub = {
            env: { remoteName: undefined },
            TaskScope: { Workspace: 1 },
            TaskRevealKind: { Never: 2 },
            TaskPanelKind: { Shared: 3 },
            Uri: {
                file: (p: string) => makeUri(p, p.replace(/\\/g, '/'), 'file'),
                joinPath: (base: UriLike, ...segs: string[]) => {
                    let fsPath = base.fsPath;
                    let path = base.path;
                    for (const s of segs) {
                        fsPath = joinFs(fsPath, s);
                        path = joinPosix(path, s);
                    }
                    return makeUri(fsPath, path, base.scheme ?? 'file');
                }
            },
            ShellExecution: class {
                constructor(public command: string, public args: string[]) {}
            },
            Task: class {
                public presentationOptions: any;
                constructor(
                    public definition: any,
                    public scope: any,
                    public name: string,
                    public source: string,
                    public execution: any
                ) {}
            },
            tasks: {
                executeTask: async (_task: any) => {
                    lastExec = execObj;
                    if (endListener) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return lastExec;
                },
                onDidEndTaskProcess: (cb: (e: any) => void): Disposable => {
                    endListener = cb;
                    if (lastExec) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return { dispose: () => undefined };
                }
            },
            workspace: {
                fs: {
                    createDirectory: async (_uri: UriLike) => undefined,
                    writeFile: async (_uri: UriLike, _bytes: Uint8Array) => undefined,
                    readFile: async (uri: UriLike) => {
                        if (uri.fsPath.endsWith('out.txt')) {
                            return textBytes('fatal: nope');
                        }
                        if (uri.fsPath.endsWith('code.txt')) {
                            return textBytes('2');
                        }
                        return textBytes('');
                    },
                    delete: async (_uri: UriLike) => undefined,
                    readDirectory: async (_uri: UriLike) => [] as any
                }
            }
        };

        await assert.rejects(
            () =>
                withMockedModules(
                    {
                        vscode: vscodeStub,
                        './gitShellExecution': { buildGitShellExecution }
                    },
                    ['../../gitTaskRunner'],
                    async () => {
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const { runGitTask } = require('../../gitTaskRunner');
                        await runGitTask({ args: ['x'], cwd: 'C:\\repo' });
                    }
                ),
            /Git command failed with exit code 2[\s\S]*fatal: nope/
        );
    });

    it('converts backslashes to forward slashes for bash paths in remote sessions', async () => {
        let captured: any;
        const buildGitShellExecution = (params: any) => {
            captured = params;
            return { shellCommand: 'bash', shellArgs: ['-lc', 'echo ok'] };
        };

        let endListener: ((e: any) => void) | undefined;
        let lastExec: any;
        const execObj = { id: 4 };

        const vscodeStub = {
            env: { remoteName: 'ssh-remote' },
            TaskScope: { Workspace: 1 },
            TaskRevealKind: { Never: 2 },
            TaskPanelKind: { Shared: 3 },
            Uri: {
                file: (p: string) => makeUri(p, p.replace(/\\/g, '/'), 'file'),
                joinPath: (base: UriLike, ...segs: string[]) => {
                    let fsPath = base.fsPath;
                    let path = base.path;
                    for (const s of segs) {
                        fsPath = joinFs(fsPath, s);
                        path = joinPosix(path, s);
                    }
                    return makeUri(fsPath, path, base.scheme ?? 'file');
                }
            },
            ShellExecution: class {
                constructor(public command: string, public args: string[]) {}
            },
            Task: class {
                public presentationOptions: any;
                constructor(
                    public definition: any,
                    public scope: any,
                    public name: string,
                    public source: string,
                    public execution: any
                ) {}
            },
            tasks: {
                executeTask: async (_task: any) => {
                    lastExec = execObj;
                    if (endListener) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return lastExec;
                },
                onDidEndTaskProcess: (cb: (e: any) => void): Disposable => {
                    endListener = cb;
                    if (lastExec) {
                        queueMicrotask(() => endListener?.({ execution: lastExec }));
                    }
                    return { dispose: () => undefined };
                }
            },
            workspace: {
                fs: {
                    createDirectory: async (_uri: UriLike) => undefined,
                    writeFile: async (_uri: UriLike, _bytes: Uint8Array) => undefined,
                    readFile: async (uri: UriLike) => {
                        if (uri.fsPath.endsWith('out.txt')) {
                            return textBytes('OK');
                        }
                        if (uri.fsPath.endsWith('code.txt')) {
                            return textBytes('0');
                        }
                        return textBytes('');
                    },
                    delete: async (_uri: UriLike) => undefined,
                    readDirectory: async (_uri: UriLike) => [] as any
                }
            }
        };

        await withMockedModules(
            {
                vscode: vscodeStub,
                './gitShellExecution': { buildGitShellExecution }
            },
            ['../../gitTaskRunner'],
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { runGitTask } = require('../../gitTaskRunner');

                await runGitTask({
                    args: ['status'],
                    cwd: 'C:\\repo\\sub',
                    stdin: 'X'
                });
            }
        );

        assert.ok(captured);
        assert.ok(typeof captured.cwdForShell === 'string');
        assert.strictEqual(captured.cwdForShell.includes('C:/repo/sub'), true);
        assert.strictEqual(captured.outPath.includes('\\'), false);
        assert.strictEqual(captured.codePath.includes('\\'), false);
        assert.strictEqual(captured.inPath.includes('\\'), false);
    });
});
