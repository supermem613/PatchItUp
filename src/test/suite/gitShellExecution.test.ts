import * as assert from 'assert';
import { buildGitShellExecution } from '../../gitShellExecution';

describe('buildGitShellExecution', () => {
    it('builds a bash -lc command with safe quoting and redirects', () => {
        const res = buildGitShellExecution({
            useBash: true,
            cwdForShell: "/home/me/repo with space",
            args: ['apply', "-p1", "--check", "HEAD:dir with space/file's.txt"],
            outPath: '/tmp/out.txt',
            codePath: '/tmp/code.txt',
            inPath: "/tmp/in file.txt"
        });

        assert.strictEqual(res.shellCommand, 'bash');
        assert.deepStrictEqual(res.shellArgs.slice(0, 1), ['-lc']);
        const cmd = res.shellArgs[1];

        // Key invariants, not exact string matching.
        assert.ok(cmd.includes("cd '/home/me/repo with space'"));
        assert.ok(cmd.includes("git 'apply' '-p1' '--check'"));
        assert.ok(cmd.includes("< '/tmp/in file.txt'"));
        assert.ok(cmd.includes("> '/tmp/out.txt' 2>&1"));
        assert.ok(cmd.includes("echo $? > '/tmp/code.txt'"));

        // Single quotes inside an arg should be escaped in a bash-safe way.
        assert.ok(cmd.includes("file'\\''s.txt"));
    });

    it('builds a cmd.exe command with delayed expansion and redirects', () => {
        const res = buildGitShellExecution({
            useBash: false,
            cwdForShell: 'C:\\repo path',
            args: ['apply', '-p0', '--check', 'HEAD:dir with space/file"name.txt'],
            outPath: 'C:\\temp\\out.txt',
            codePath: 'C:\\temp\\code.txt'
        });

        assert.strictEqual(res.shellCommand, 'cmd.exe');
        assert.deepStrictEqual(res.shellArgs.slice(0, 4), ['/d', '/v:on', '/s', '/c']);
        const cmd = res.shellArgs[4];

        assert.ok(cmd.includes('setlocal EnableDelayedExpansion'));
        assert.ok(cmd.includes('cd /d "C:\\repo path"'));
        assert.ok(cmd.includes('git "apply" "-p0" "--check"'));
        assert.ok(cmd.includes('> "C:\\temp\\out.txt" 2>&1'));
        assert.ok(cmd.includes('echo !ERRORLEVEL! > "C:\\temp\\code.txt"'));

        // Embedded quotes should be doubled inside "...".
        assert.ok(cmd.includes('file""name.txt'));
    });
});
