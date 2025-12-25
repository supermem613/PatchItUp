export type GitRunResult = { exitCode: number; output: string };

export type GitRunner = (params: {
    args: string[];
    cwd: string;
    allowedExitCodes?: number[];
    stdin?: string;
}) => Promise<GitRunResult>;

export function guessPreferredStripLevel(patchContent: string): number {
    const firstDiffLine = patchContent.split(/\r?\n/).find(l => l.startsWith('diff --git '));
    if (!firstDiffLine) {
        return 1;
    }
    const parts = firstDiffLine.split(' ');
    const left = parts[2] ?? '';
    const right = parts[3] ?? '';
    if (left.startsWith('a/') || right.startsWith('b/')) {
        return 1;
    }
    return 0;
}

export function getStripCandidates(preferredStrip: number): number[] {
    // Preserve deterministic ordering while de-duping.
    const candidates = [preferredStrip, 0, 1, 2, 3];
    const seen = new Set<number>();
    const unique: number[] = [];
    for (const c of candidates) {
        if (!seen.has(c)) {
            seen.add(c);
            unique.push(c);
        }
    }
    return unique;
}

export async function selectStripLevelForPatch(params: {
    patchContent: string;
    cwd: string;
    runGit: GitRunner;
    preferredStrip?: number;
}): Promise<{ selectedStrip: number; stripCandidates: number[] }> {
    const preferredStrip = params.preferredStrip ?? guessPreferredStripLevel(params.patchContent);
    const stripCandidates = getStripCandidates(preferredStrip);

    for (const strip of stripCandidates) {
        try {
            const check = await params.runGit({
                args: ['apply', `-p${strip}`, '--check', '--whitespace=nowarn', '-'],
                cwd: params.cwd,
                allowedExitCodes: [0, 1],
                stdin: params.patchContent
            });

            const stat = await params.runGit({
                args: ['apply', `-p${strip}`, '--stat', '-'],
                cwd: params.cwd,
                allowedExitCodes: [0, 1],
                stdin: params.patchContent
            });

            const statOut = stat.output.trim();
            if (check.exitCode === 0 && stat.exitCode === 0 && statOut && statOut !== '0 files changed') {
                return { selectedStrip: strip, stripCandidates };
            }
        } catch {
            // ignore and try next candidate
        }
    }

    return { selectedStrip: preferredStrip, stripCandidates };
}

export async function applyPatchWithGit(params: {
    patchContent: string;
    cwd: string;
    runGit: GitRunner;
    stripLevel: number;
}): Promise<GitRunResult> {
    return params.runGit({
        args: ['apply', `-p${params.stripLevel}`, '--whitespace=nowarn', '-'],
        cwd: params.cwd,
        allowedExitCodes: [0, 1],
        stdin: params.patchContent
    });
}
