import * as assert from 'assert';
import { withStepProgress } from '../../progressSteps';

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

describe('withStepProgress', () => {
    it('reports step progress with bounded increments and disposes status bar item', async () => {
        const reports: Array<{ message?: string; increment?: number }> = [];
        const statusEvents: string[] = [];

        const vscodeStub = {
            ProgressLocation: { Notification: 15 },
            StatusBarAlignment: { Left: 1 },
            window: {
                withProgress: async (_opts: unknown, task: (progress: any) => Promise<unknown>) => {
                    const progress = {
                        report: (payload: { message?: string; increment?: number }) => {
                            reports.push(payload);
                        }
                    };
                    return task(progress);
                },
                createStatusBarItem: (_align: unknown, _priority: number) => {
                    return {
                        text: '',
                        show: () => statusEvents.push('show'),
                        hide: () => statusEvents.push('hide'),
                        dispose: () => statusEvents.push('dispose')
                    };
                }
            }
        };

        await withMockedVscode(vscodeStub, async () => {
            const value = await withStepProgress({
                title: 'Work',
                totalSteps: 3,
                task: async (reporter) => {
                    reporter.detail('starting');
                    reporter.next('First');
                    reporter.next('Second', 'extra');
                    reporter.next('Third');
                    reporter.detail('finishing');
                    return 123;
                }
            });

            assert.strictEqual(value, 123);
        });

        // Status bar lifecycle should always complete.
        assert.deepStrictEqual(statusEvents, ['show', 'hide', 'dispose']);

        // First report comes from detail-before-next.
        assert.ok(reports.length >= 5);
        assert.ok(reports[0].message?.includes('Step 1/3: Working'));
        assert.ok(reports.some((r) => r.message?.includes('Step 1/3: First')));
        assert.ok(reports.some((r) => r.message?.includes('Step 2/3: Second — extra')));
        assert.ok(reports.some((r) => r.message?.includes('Step 3/3: Third')));

        const increments = reports
            .map((r) => r.increment)
            .filter((n): n is number => typeof n === 'number');

        // Three next() calls should each contribute an increment, totaling <= 100.
        assert.strictEqual(increments.length, 3);
        const sum = increments.reduce((a, b) => a + b, 0);
        assert.ok(sum <= 100 + 1e-9);
        for (const inc of increments) {
            assert.ok(inc > 0);
            assert.ok(inc <= 100 / 3 + 1e-9);
        }
    });

    it('disposes status bar item when task throws', async () => {
        const statusEvents: string[] = [];

        const vscodeStub = {
            ProgressLocation: { Notification: 15 },
            StatusBarAlignment: { Left: 1 },
            window: {
                withProgress: async (_opts: unknown, task: (progress: any) => Promise<unknown>) => {
                    const progress = { report: (_payload: unknown) => undefined };
                    return task(progress);
                },
                createStatusBarItem: (_align: unknown, _priority: number) => {
                    return {
                        text: '',
                        show: () => statusEvents.push('show'),
                        hide: () => statusEvents.push('hide'),
                        dispose: () => statusEvents.push('dispose')
                    };
                }
            }
        };

        await assert.rejects(
            () =>
                withMockedVscode(vscodeStub, async () => {
                    await withStepProgress({
                        title: 'Work',
                        totalSteps: 1,
                        task: async (_reporter) => {
                            throw new Error('boom');
                        }
                    });
                }),
            /boom/
        );

        assert.deepStrictEqual(statusEvents, ['show', 'hide', 'dispose']);
    });
});
