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

    try {
        return await fn();
    } finally {
        (Module as any)._load = originalLoad;
    }
};

describe('Logger', () => {
    it('writes timestamped lines and stringifies data when possible', async () => {
        const lines: string[] = [];
        const fakeChannel = {
            appendLine: (line: string) => lines.push(line),
            show: (_preserveFocus?: boolean) => undefined,
            dispose: () => undefined
        };

        await withMockedVscode({}, async () => {
            // Ensure we load the module with the current vscode stub.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            delete require.cache[require.resolve('../../logger')];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Logger } = require('../../logger') as typeof import('../../logger');

            const logger = new Logger(fakeChannel as any);
            logger.info('hello', { a: 1 });
            logger.warn('warn');
            logger.error('oops', { nested: { ok: true } });

            assert.strictEqual(lines.length, 3);
            assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T/);
            assert.ok(lines[0].includes('[INFO] hello'));
            assert.ok(lines[0].includes('{"a":1}'));
            assert.ok(lines[1].includes('[WARN] warn'));
            assert.ok(lines[2].includes('[ERROR] oops'));
        });
    });

    it('does not throw when data cannot be JSON-stringified', async () => {
        const lines: string[] = [];
        const fakeChannel = {
            appendLine: (line: string) => lines.push(line),
            show: (_preserveFocus?: boolean) => undefined,
            dispose: () => undefined
        };

        const circular: any = { name: 'c' };
        circular.self = circular;

        await withMockedVscode({}, async () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            delete require.cache[require.resolve('../../logger')];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Logger } = require('../../logger') as typeof import('../../logger');
            const logger = new Logger(fakeChannel as any);

            logger.info('circular', circular);

            assert.strictEqual(lines.length, 1);
            assert.ok(lines[0].includes('[INFO] circular'));
            // Fallback is String(data) => "[object Object]" for typical objects.
            assert.ok(lines[0].includes('[object Object]'));
        });
    });

    it('createLogger wires up a log output channel', async () => {
        const created: Array<{ name: string; options: unknown }> = [];
        const lines: string[] = [];

        const vscodeStub = {
            window: {
                createOutputChannel: (name: string, options: unknown) => {
                    created.push({ name, options });
                    return {
                        appendLine: (line: string) => lines.push(line),
                        show: (_preserveFocus?: boolean) => undefined,
                        dispose: () => undefined
                    };
                }
            }
        };

        await withMockedVscode(vscodeStub, async () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            delete require.cache[require.resolve('../../logger')];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { createLogger } = require('../../logger') as typeof import('../../logger');

            const logger = createLogger();
            logger.info('ok');

            assert.strictEqual(created.length, 1);
            assert.strictEqual(created[0].name, 'PatchItUp');
            assert.deepStrictEqual(created[0].options, { log: true });
            assert.strictEqual(lines.length, 1);
        });
    });
});
