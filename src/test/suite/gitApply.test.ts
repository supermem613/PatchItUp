import * as assert from 'assert';
import {
    applyPatchWithGit,
    getStripCandidates,
    guessPreferredStripLevel,
    selectStripLevelForPatch,
    type GitRunner
} from '../../gitApply';

describe('gitApply helpers', () => {
    it('guessPreferredStripLevel defaults to 1 when diff header missing', () => {
        const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n');
        assert.strictEqual(guessPreferredStripLevel(patch), 1);
    });

    it('guessPreferredStripLevel prefers 1 for a/ b/ paths', () => {
        const patch = [
            'diff --git a/src/a.txt b/src/a.txt',
            'index 0000000..1111111 100644',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -0,0 +1 @@',
            '+hello'
        ].join('\n');

        assert.strictEqual(guessPreferredStripLevel(patch), 1);
    });

    it('getStripCandidates is deterministic and de-dupes', () => {
        assert.deepStrictEqual(getStripCandidates(1), [1, 0, 2, 3]);
        assert.deepStrictEqual(getStripCandidates(0), [0, 1, 2, 3]);
        assert.deepStrictEqual(getStripCandidates(3), [3, 0, 1, 2]);
    });

    it('selectStripLevelForPatch uses stdin (-) for check/stat', async () => {
        const calls: Array<{ args: string[]; stdin?: string }> = [];

        const runGit: GitRunner = async ({ args, stdin }) => {
            calls.push({ args, stdin });
            // Make the first candidate fail, second succeed.
            const hasP1 = args.some((a) => a === '-p1');
            const isCheck = args.includes('--check');
            const isStat = args.includes('--stat');

            if (hasP1) {
                return { exitCode: 1, output: 'bad strip' };
            }

            if (isCheck) {
                return { exitCode: 0, output: '' };
            }

            if (isStat) {
                return { exitCode: 0, output: ' 1 file changed, 1 insertion(+)' };
            }

            return { exitCode: 0, output: '' };
        };

        const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n';

        const res = await selectStripLevelForPatch({
            patchContent: patch,
            cwd: '/repo',
            runGit,
            preferredStrip: 1
        });

        assert.strictEqual(res.selectedStrip, 0);

        // Every git call should use stdin and '-' sentinel.
        for (const call of calls) {
            assert.ok(call.args.includes('-'), `Expected '-' in args: ${call.args.join(' ')}`);
            assert.strictEqual(call.stdin, patch);
        }
    });

    it('selectStripLevelForPatch skips "0 files changed" stats', async () => {
        const calls: Array<{ args: string[]; stdin?: string }> = [];

        const runGit: GitRunner = async ({ args, stdin }) => {
            calls.push({ args, stdin });
            const hasP1 = args.some((a) => a === '-p1');
            const hasP0 = args.some((a) => a === '-p0');
            const isCheck = args.includes('--check');
            const isStat = args.includes('--stat');

            if (hasP1) {
                // Looks like it can apply, but stat is empty/meaningless.
                if (isCheck) {
                    return { exitCode: 0, output: '' };
                }
                if (isStat) {
                    return { exitCode: 0, output: '0 files changed' };
                }
            }

            if (hasP0) {
                if (isCheck) {
                    return { exitCode: 0, output: '' };
                }
                if (isStat) {
                    return { exitCode: 0, output: ' 1 file changed, 1 insertion(+)' };
                }
            }

            return { exitCode: 1, output: 'unexpected' };
        };

        const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n';
        const res = await selectStripLevelForPatch({
            patchContent: patch,
            cwd: '/repo',
            runGit,
            preferredStrip: 1
        });

        assert.strictEqual(res.selectedStrip, 0);
        for (const call of calls) {
            assert.ok(call.args.includes('-'), `Expected '-' in args: ${call.args.join(' ')}`);
            assert.strictEqual(call.stdin, patch);
        }
    });

    it('selectStripLevelForPatch falls back to preferred when all candidates fail', async () => {
        const runGit: GitRunner = async () => ({ exitCode: 1, output: 'nope' });
        const patch = 'diff --git a/a.txt b/a.txt\n';
        const res = await selectStripLevelForPatch({
            patchContent: patch,
            cwd: '/repo',
            runGit,
            preferredStrip: 3
        });

        assert.strictEqual(res.selectedStrip, 3);
        assert.deepStrictEqual(res.stripCandidates, [3, 0, 1, 2]);
    });

    it('applyPatchWithGit uses stdin (-) and nowarn whitespace', async () => {
        let seenArgs: string[] | undefined;
        let seenStdin: string | undefined;

        const runGit: GitRunner = async ({ args, stdin }) => {
            seenArgs = args;
            seenStdin = stdin;
            return { exitCode: 0, output: '' };
        };

        const patch = 'diff --git a/a.txt b/a.txt\n';
        await applyPatchWithGit({ patchContent: patch, cwd: '/repo', runGit, stripLevel: 1 });

        assert.ok(seenArgs?.includes('-'));
        assert.ok(seenArgs?.includes('--whitespace=nowarn'));
        assert.ok(seenArgs?.includes('-p1'));
        assert.strictEqual(seenStdin, patch);
    });
});
