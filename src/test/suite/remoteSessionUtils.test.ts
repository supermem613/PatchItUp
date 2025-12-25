import * as assert from 'assert';
import { detectIsRemoteLocalMachine, isLocalhostHostname, shouldUseVscodeLocalScheme } from '../../remoteSessionUtils';

describe('remoteSessionUtils', () => {
    it('isLocalhostHostname detects common localhost hostnames', () => {
        assert.strictEqual(isLocalhostHostname('localhost'), true);
        assert.strictEqual(isLocalhostHostname('LOCALHOST'), true);
        assert.strictEqual(isLocalhostHostname('127.0.0.1'), true);
        assert.strictEqual(isLocalhostHostname('::1'), true);
        assert.strictEqual(isLocalhostHostname('localhost.localdomain'), true);
        assert.strictEqual(isLocalhostHostname('mybox.local'), true);

        assert.strictEqual(isLocalhostHostname('codespaces-12345'), false);
        assert.strictEqual(isLocalhostHostname('example.com'), false);
    });

    it('detectIsRemoteLocalMachine returns false for local sessions', () => {
        assert.strictEqual(detectIsRemoteLocalMachine(undefined, 'localhost'), false);
        assert.strictEqual(detectIsRemoteLocalMachine(undefined, 'mybox.local'), false);
    });

    it('detectIsRemoteLocalMachine returns true for WSL', () => {
        assert.strictEqual(detectIsRemoteLocalMachine('wsl', 'anything'), true);
    });

    it('detectIsRemoteLocalMachine returns false for Codespaces', () => {
        assert.strictEqual(detectIsRemoteLocalMachine('codespaces', 'localhost'), false);
        assert.strictEqual(detectIsRemoteLocalMachine('github-codespaces', 'localhost'), false);
    });

    it('detectIsRemoteLocalMachine uses hostname heuristic for ssh-remote', () => {
        assert.strictEqual(detectIsRemoteLocalMachine('ssh-remote', 'localhost'), true);
        assert.strictEqual(detectIsRemoteLocalMachine('ssh-remote', 'mybox.local'), true);
        assert.strictEqual(detectIsRemoteLocalMachine('ssh-remote', 'remote-host'), false);
    });

    it('detectIsRemoteLocalMachine uses hostname heuristic for dev containers', () => {
        assert.strictEqual(detectIsRemoteLocalMachine('dev-container', 'localhost'), true);
        assert.strictEqual(detectIsRemoteLocalMachine('attached-container', 'localhost'), true);
        assert.strictEqual(detectIsRemoteLocalMachine('dev-container', 'container-123'), false);
    });

    it('shouldUseVscodeLocalScheme is true only for true remote envs', () => {
        assert.strictEqual(shouldUseVscodeLocalScheme(undefined, false), false);
        assert.strictEqual(shouldUseVscodeLocalScheme('wsl', true), false);
        assert.strictEqual(shouldUseVscodeLocalScheme('ssh-remote', true), false);
        assert.strictEqual(shouldUseVscodeLocalScheme('ssh-remote', false), true);
        assert.strictEqual(shouldUseVscodeLocalScheme('codespaces', false), true);
    });
});
