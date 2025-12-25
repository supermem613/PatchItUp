import * as assert from 'assert';
import { parseGitPatchFileEdits } from '../../patchParsing';

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
