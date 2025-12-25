import * as assert from 'assert';

const withMockedVscode = async <T>(vscodeStub: unknown, fn: () => Promise<T> | T): Promise<T> => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module') as typeof import('module');
    const originalLoad = (Module as unknown as { _load: unknown })._load as any;

    (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === 'vscode') {
            return vscodeStub;
        }
        return originalLoad.apply(this, arguments as any);
    };

    // Ensure modules that import 'vscode' are re-evaluated per test.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const resolved = require.resolve('../../gitRepoRoot');
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete require.cache[resolved];
    } catch {
        // ignore if not resolvable yet
    }

    try {
        return await fn();
    } finally {
        (Module as any)._load = originalLoad;
    }
};

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

describe('getOpenGitRepositoryRootPath', () => {
    it('throws when the VS Code git extension is unavailable', async () => {
        const vscodeStub = {
            extensions: { getExtension: () => undefined },
            window: { activeTextEditor: undefined },
            workspace: { getWorkspaceFolder: () => undefined, workspaceFolders: undefined }
        };

        await assert.rejects(
            () =>
                withMockedVscode(vscodeStub, async () => {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const { getOpenGitRepositoryRootPath } = require('../../gitRepoRoot');
                    await getOpenGitRepositoryRootPath();
                }),
            /No git repository/i
        );
    });

    it('returns the active file repository root when available', async () => {
        const repoA = { rootUri: { scheme: 'file', fsPath: 'C:\\repoA', path: '/c:/repoA' } };
        const repoB = { rootUri: { scheme: 'file', fsPath: 'C:\\repoB', path: '/c:/repoB' } };

        const gitApi = {
            repositories: [repoA, repoB],
            getRepository: (_uri: any) => repoB
        };

        const vscodeStub = {
            extensions: {
                getExtension: () => ({
                    isActive: true,
                    activate: async () => undefined,
                    exports: { getAPI: () => gitApi }
                })
            },
            window: {
                activeTextEditor: { document: { uri: { path: '/c:/repoB/src/file.ts' } } }
            }
        };

        const root = await withMockedVscode(vscodeStub, async () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getOpenGitRepositoryRootPath } = require('../../gitRepoRoot');
            return await getOpenGitRepositoryRootPath();
        });

        assert.strictEqual(root, 'C:\\repoB');
    });

    it('falls back to the first repository when no active editor exists', async () => {
        const repoA = { rootUri: { scheme: 'file', fsPath: 'C:\\repoA', path: '/c:/repoA' } };
        const repoB = { rootUri: { scheme: 'file', fsPath: 'C:\\repoB', path: '/c:/repoB' } };

        const gitApi = {
            repositories: [repoA, repoB]
        };

        const vscodeStub = {
            extensions: {
                getExtension: () => ({
                    isActive: true,
                    activate: async () => undefined,
                    exports: { getAPI: () => gitApi }
                })
            },
            window: { activeTextEditor: undefined }
        };

        const root = await withMockedVscode(vscodeStub, async () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getOpenGitRepositoryRootPath } = require('../../gitRepoRoot');
            return await getOpenGitRepositoryRootPath();
        });

        assert.strictEqual(root, 'C:\\repoA');
    });

    it('falls back to running git when git API has no repositories (Codespaces/remote-safe)', async () => {
        const runGitTask = async (_params: any) => ({ exitCode: 0, output: ' /workspaces/proj \n' });

        const vscodeStub = {
            extensions: {
                getExtension: () => ({
                    isActive: true,
                    activate: async () => undefined,
                    exports: { getAPI: () => ({ repositories: [] }) }
                })
            },
            window: { activeTextEditor: undefined },
            workspace: {
                getWorkspaceFolder: () => undefined,
                workspaceFolders: [{ uri: { fsPath: '/workspaces/proj', path: '/workspaces/proj' } }]
            }
        };

        const root = await withMockedModules(
            {
                vscode: vscodeStub,
                './gitTaskRunner': { runGitTask }
            },
            ['../../gitRepoRoot'],
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { getOpenGitRepositoryRootPath } = require('../../gitRepoRoot');
                return await getOpenGitRepositoryRootPath();
            }
        );

        assert.strictEqual(root, '/workspaces/proj');
    });

    it('throws NoGitRepositoryOpenError when git API is missing and git fallback fails', async () => {
        const runGitTask = async (_params: any) => {
            throw new Error('git not found');
        };

        const vscodeStub = {
            extensions: { getExtension: () => undefined },
            window: { activeTextEditor: undefined },
            workspace: {
                getWorkspaceFolder: () => undefined,
                workspaceFolders: [{ uri: { fsPath: '/workspaces/proj', path: '/workspaces/proj' } }]
            }
        };

        await assert.rejects(
            () =>
                withMockedModules(
                    {
                        vscode: vscodeStub,
                        './gitTaskRunner': { runGitTask }
                    },
                    ['../../gitRepoRoot'],
                    async () => {
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const { getOpenGitRepositoryRootPath } = require('../../gitRepoRoot');
                        await getOpenGitRepositoryRootPath();
                    }
                ),
            /No git repository/i
        );
    });
});
