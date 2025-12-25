import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
    PATCHITUP_TMP_DIRNAME,
    getTempOutputLocation,
    getTempRootLocation,
    isRemoteSession,
    normalizeCwd,
    quoteShellArg,
    quoteShellArgs
} from '../../commandPathUtils';

describe('commandPathUtils', () => {
    it('isRemoteSession detects remote vs local', () => {
        assert.strictEqual(isRemoteSession(undefined), false);
        assert.strictEqual(isRemoteSession('ssh-remote'), true);
        assert.strictEqual(isRemoteSession('wsl'), true);
    });

    it('normalizeCwd uses forward slashes in remote sessions', () => {
        assert.strictEqual(normalizeCwd('  C:\\repo\\foo  ', undefined), 'C:\\repo\\foo');
        assert.strictEqual(normalizeCwd('  C:\\repo\\foo  ', 'ssh-remote'), 'C:/repo/foo');
        assert.strictEqual(normalizeCwd('/home/user/repo', 'ssh-remote'), '/home/user/repo');
    });

    it('normalizeCwd treats Codespaces as remote for slash normalization', () => {
        assert.strictEqual(normalizeCwd('C:\\repo\\foo', 'codespaces'), 'C:/repo/foo');
    });

    it('quoteShellArg only quotes when needed', () => {
        assert.strictEqual(quoteShellArg('plain'), 'plain');
        assert.strictEqual(quoteShellArg('has space'), '"has space"');
        assert.strictEqual(quoteShellArg('has"quote'), '"has\\"quote"');
    });

    it('quoteShellArg handles empty strings and tabs/newlines', () => {
        assert.strictEqual(quoteShellArg(''), '');
        assert.strictEqual(quoteShellArg('has\tTab'), '"has\tTab"');
        assert.strictEqual(quoteShellArg('has\nNewline'), '"has\nNewline"');
    });

    it('quoteShellArgs joins args for git command', () => {
        assert.strictEqual(quoteShellArgs(['apply', 'a.patch']), 'apply a.patch');
        assert.strictEqual(
            quoteShellArgs(['show', 'HEAD:dir with space/file.txt']),
            'show "HEAD:dir with space/file.txt"'
        );
    });

    it('getTempOutputLocation uses workspace temp dir for remote sessions', () => {
        const loc = getTempOutputLocation({
            remoteName: 'ssh-remote',
            workspaceRootPosixPath: '/home/user/proj',
            osTmpDir: os.tmpdir(),
            fileName: 'out.txt'
        });

        assert.strictEqual(loc.kind, 'workspace');
        assert.deepStrictEqual(loc.relativeSegments, [PATCHITUP_TMP_DIRNAME, 'out.txt']);
        assert.strictEqual(loc.shellPath, `/home/user/proj/${PATCHITUP_TMP_DIRNAME}/out.txt`);
    });

    it('getTempOutputLocation falls back to OS temp when remote but no workspace root', () => {
        const loc = getTempOutputLocation({
            remoteName: 'ssh-remote',
            workspaceRootPosixPath: undefined,
            osTmpDir: os.tmpdir(),
            fileName: 'out.txt'
        });

        assert.strictEqual(loc.kind, 'os');
        assert.strictEqual(loc.shellPath, path.join(os.tmpdir(), 'out.txt'));
    });

    it('getTempOutputLocation uses os.tmpdir for local sessions', () => {
        const loc = getTempOutputLocation({
            remoteName: undefined,
            workspaceRootPosixPath: '/home/user/proj',
            osTmpDir: os.tmpdir(),
            fileName: 'out.txt'
        });

        assert.strictEqual(loc.kind, 'os');
        assert.strictEqual(loc.shellPath, path.join(os.tmpdir(), 'out.txt'));
    });

    it('getTempRootLocation mirrors output location behavior', () => {
        const remoteRoot = getTempRootLocation({
            remoteName: 'ssh-remote',
            workspaceRootPosixPath: '/home/user/proj',
            osTmpDir: os.tmpdir(),
            folderName: 'diff-root'
        });
        assert.strictEqual(remoteRoot.kind, 'workspace');
        assert.strictEqual(
            remoteRoot.shellPath,
            `/home/user/proj/${PATCHITUP_TMP_DIRNAME}/diff-root`
        );

        const localRoot = getTempRootLocation({
            remoteName: undefined,
            workspaceRootPosixPath: '/home/user/proj',
            osTmpDir: os.tmpdir(),
            folderName: 'diff-root'
        });
        assert.strictEqual(localRoot.kind, 'os');
        assert.strictEqual(localRoot.shellPath, path.join(os.tmpdir(), 'diff-root'));
    });

    it('getTempRootLocation trims extraneous slashes when joining workspace paths', () => {
        const root = getTempRootLocation({
            remoteName: 'ssh-remote',
            workspaceRootPosixPath: '/home/user/proj/',
            osTmpDir: os.tmpdir(),
            folderName: '/diff-root/'
        });

        assert.strictEqual(root.kind, 'workspace');
        assert.strictEqual(root.shellPath, `/home/user/proj/${PATCHITUP_TMP_DIRNAME}/diff-root`);
    });
});
