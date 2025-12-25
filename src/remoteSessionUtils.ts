export function isLocalhostHostname(hostname: string): boolean {
    const lowerHostname = hostname.toLowerCase();
    return (
        lowerHostname === 'localhost' ||
        lowerHostname === '127.0.0.1' ||
        lowerHostname === '::1' ||
        lowerHostname.endsWith('.local') ||
        lowerHostname.startsWith('localhost')
    );
}

/**
 * Pure, unit-testable version of PatchPanelProvider's remote-local-machine detection.
 *
 * - Returns false for non-remote sessions.
 * - Returns true for WSL.
 * - Returns true for dev containers / ssh-remote only when the hostname looks local.
 * - Returns false for Codespaces.
 * - Defaults to false for unknown remotes.
 */
export function detectIsRemoteLocalMachine(remoteName: string | undefined, hostname: string): boolean {
    if (remoteName === undefined) {
        return false;
    }

    if (remoteName === 'wsl') {
        return true;
    }

    if (remoteName === 'dev-container' || remoteName === 'attached-container') {
        return isLocalhostHostname(hostname);
    }

    if (remoteName === 'ssh-remote') {
        return isLocalhostHostname(hostname);
    }

    if (remoteName === 'codespaces' || remoteName === 'github-codespaces') {
        return false;
    }

    return false;
}

/**
 * Returns true only when running in a true remote environment (not local machine).
 */
export function shouldUseVscodeLocalScheme(remoteName: string | undefined, isRemoteLocalMachine: boolean): boolean {
    return remoteName !== undefined && !isRemoteLocalMachine;
}
