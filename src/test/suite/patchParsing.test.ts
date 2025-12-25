import * as assert from 'assert';
import { parseGitPatchFileEdits } from '../../patchParsing';
import { applyUnifiedDiffToText, parseUnifiedDiffFiles } from '../../unifiedDiff';

describe('parseGitPatchFileEdits', () => {
    it('parses modified file with index blobs', () => {
        const patch = [
            'diff --git a/odsp-common/copilot/common/src/utilities/KillSwitches.ts b/odsp-common/copilot/common/src/utilities/KillSwitches.ts',
            'index 481b05b2d065..444f412501c4 100644',
            '--- a/odsp-common/copilot/common/src/utilities/KillSwitches.ts',
            '+++ b/odsp-common/copilot/common/src/utilities/KillSwitches.ts',
            '@@ -180,1 +180,1 @@',
            '-old',
            '+new'
        ].join('\n');

        const edits = parseGitPatchFileEdits(patch);
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].status, 'modified');
        assert.strictEqual(edits[0].oldPath, 'odsp-common/copilot/common/src/utilities/KillSwitches.ts');
        assert.strictEqual(edits[0].newPath, 'odsp-common/copilot/common/src/utilities/KillSwitches.ts');
        assert.strictEqual(edits[0].oldBlob, '481b05b2d065');
        assert.strictEqual(edits[0].newBlob, '444f412501c4');
    });

    it('parses added files', () => {
        const patch = [
            'diff --git a/odsp-common/embed-host/contracts/src/chatodsp/AgentSelectionOverride.ts b/odsp-common/embed-host/contracts/src/chatodsp/AgentSelectionOverride.ts',
            'new file mode 100644',
            'index 000000000000..0fc198303625',
            '--- /dev/null',
            '+++ b/odsp-common/embed-host/contracts/src/chatodsp/AgentSelectionOverride.ts',
            '@@ -0,0 +1,1 @@',
            '+export enum X { A = 1 }'
        ].join('\n');

        const edits = parseGitPatchFileEdits(patch);
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].status, 'added');
        assert.strictEqual(edits[0].oldPath, 'odsp-common/embed-host/contracts/src/chatodsp/AgentSelectionOverride.ts');
        assert.strictEqual(edits[0].newPath, 'odsp-common/embed-host/contracts/src/chatodsp/AgentSelectionOverride.ts');
        assert.strictEqual(edits[0].oldBlob, '000000000000');
        assert.strictEqual(edits[0].newBlob, '0fc198303625');
    });

    it('parses deleted files', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            'deleted file mode 100644',
            'index 0123456789ab..000000000000',
            '--- a/foo.txt',
            '+++ /dev/null'
        ].join('\n');

        const edits = parseGitPatchFileEdits(patch);
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].status, 'deleted');
        assert.strictEqual(edits[0].oldPath, 'foo.txt');
        assert.strictEqual(edits[0].newPath, 'foo.txt');
    });

    it('parses renames', () => {
        const patch = [
            'diff --git a/old/name.txt b/new/name.txt',
            'similarity index 100%',
            'rename from old/name.txt',
            'rename to new/name.txt'
        ].join('\n');

        const edits = parseGitPatchFileEdits(patch);
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].status, 'renamed');
        assert.strictEqual(edits[0].oldPath, 'old/name.txt');
        assert.strictEqual(edits[0].newPath, 'new/name.txt');
    });
});

describe('unified diff parsing + apply', () => {
    it('parses hunks for a modified file', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            'index 0123456..89abcde 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,3 @@',
            ' one',
            '-two',
            '+TWO',
            ' three'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].oldPath, 'foo.txt');
        assert.strictEqual(files[0].newPath, 'foo.txt');
        assert.strictEqual(files[0].hunks.length, 1);
        assert.strictEqual(files[0].hunks[0].oldStart, 1);
        assert.strictEqual(files[0].hunks[0].oldLines, 3);
    });

    it('applies a simple hunk', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,3 @@',
            ' one',
            '-two',
            '+TWO',
            ' three'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        const original = ['one', 'two', 'three', ''].join('\n');
        const result = applyUnifiedDiffToText(original, files[0]);

        assert.ok(result.appliedHunks >= 1);
        assert.strictEqual(result.rejectedHunks, 0);
        assert.strictEqual(result.text, ['one', 'TWO', 'three', ''].join('\n'));
    });

    it('applies multiple hunks in order', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,3 @@',
            ' one',
            '-two',
            '+TWO',
            ' three',
            '@@ -4,3 +4,3 @@',
            ' four',
            '-five',
            '+FIVE',
            ' six'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        const original = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\n');
        const result = applyUnifiedDiffToText(original, files[0]);

        assert.strictEqual(result.rejectedHunks, 0);
        assert.strictEqual(result.appliedHunks, 2);
        assert.strictEqual(result.text, ['one', 'TWO', 'three', 'four', 'FIVE', 'six', ''].join('\n'));
    });

    it('applies pure insertion hunks', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,2 +1,3 @@',
            ' one',
            '+INSERTED',
            ' two'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        const original = ['one', 'two', ''].join('\n');
        const result = applyUnifiedDiffToText(original, files[0]);

        assert.strictEqual(result.rejectedHunks, 0);
        assert.strictEqual(result.text, ['one', 'INSERTED', 'two', ''].join('\n'));
    });

    it('applies pure deletion hunks', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,2 @@',
            ' one',
            '-two',
            ' three'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        const original = ['one', 'two', 'three', ''].join('\n');
        const result = applyUnifiedDiffToText(original, files[0]);

        assert.strictEqual(result.rejectedHunks, 0);
        assert.strictEqual(result.text, ['one', 'three', ''].join('\n'));
    });

    it('rejects a hunk when context does not match', () => {
        const patch = [
            'diff --git a/foo.txt b/foo.txt',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,3 @@',
            ' one',
            '-two',
            '+TWO',
            ' three'
        ].join('\n');

        const files = parseUnifiedDiffFiles(patch);
        const original = ['one', 'DIFFERENT', 'three', ''].join('\n');
        const result = applyUnifiedDiffToText(original, files[0]);

        assert.strictEqual(result.appliedHunks, 0);
        assert.strictEqual(result.rejectedHunks, 1);
        assert.strictEqual(result.text, original);
    });
});
