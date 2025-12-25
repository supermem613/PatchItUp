export type UnifiedDiffLine =
    | { kind: 'context'; text: string }
    | { kind: 'add'; text: string }
    | { kind: 'del'; text: string };

export type UnifiedDiffHunk = {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: UnifiedDiffLine[];
};

export type UnifiedDiffFile = {
    oldPath: string;
    newPath: string;
    hunks: UnifiedDiffHunk[];
};

const parseHunkHeader = (line: string): Omit<UnifiedDiffHunk, 'lines'> | undefined => {
    // @@ -l,s +l,s @@ optional section header
    const match = /^@@\s+\-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) {
        return undefined;
    }

    const oldStart = Number(match[1]);
    const oldLines = match[2] ? Number(match[2]) : 1;
    const newStart = Number(match[3]);
    const newLines = match[4] ? Number(match[4]) : 1;

    return { oldStart, oldLines, newStart, newLines };
};

export function parseUnifiedDiffFiles(patchContent: string): UnifiedDiffFile[] {
    const lines = patchContent.split(/\r?\n/);
    const files: UnifiedDiffFile[] = [];

    let current: UnifiedDiffFile | undefined;
    let currentHunk: UnifiedDiffHunk | undefined;

    const pushHunk = () => {
        if (current && currentHunk) {
            current.hunks.push(currentHunk);
            currentHunk = undefined;
        }
    };

    const pushFile = () => {
        pushHunk();
        if (current) {
            files.push(current);
            current = undefined;
        }
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            pushFile();
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            if (!match) {
                continue;
            }
            current = { oldPath: match[1], newPath: match[2], hunks: [] };
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith('@@')) {
            pushHunk();
            const header = parseHunkHeader(line);
            if (!header) {
                continue;
            }
            currentHunk = { ...header, lines: [] };
            continue;
        }

        // Not in a hunk yet
        if (!currentHunk) {
            continue;
        }

        // Meta line inside diff; stop hunk parsing when a new file begins (handled above)
        if (line.startsWith('\\ No newline at end of file')) {
            // Ignore; diff viewers typically handle this themselves.
            continue;
        }

        const prefix = line[0];
        const text = line.substring(1);
        if (prefix === ' ') {
            currentHunk.lines.push({ kind: 'context', text });
        } else if (prefix === '+') {
            currentHunk.lines.push({ kind: 'add', text });
        } else if (prefix === '-') {
            currentHunk.lines.push({ kind: 'del', text });
        } else {
            // Unexpected line; ignore.
        }
    }

    pushFile();
    return files;
}

type SplitText = {
    lines: string[];
    eol: '\n' | '\r\n';
    endsWithNewline: boolean;
};

const splitText = (text: string): SplitText => {
    const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
    const endsWithNewline = text.endsWith('\n');
    const lines = text.length ? text.split(/\r?\n/) : [''];

    // If the text ends with a newline, split() will include a trailing empty string. Keep it;
    // joining with eol will preserve the newline.
    return { lines, eol, endsWithNewline };
};

const joinText = ({ lines, eol, endsWithNewline }: SplitText): string => {
    let joined = lines.join(eol);
    // When the original did NOT end with a newline, split() does not preserve that distinction
    // for some inputs. Best effort: if it did not end with newline originally, trim a trailing
    // empty line that would imply one.
    if (!endsWithNewline && joined.endsWith(eol)) {
        joined = joined.slice(0, -eol.length);
    }
    return joined;
};

const buildExpectedSourceLines = (hunk: UnifiedDiffHunk): string[] =>
    hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);

const matchesAt = (src: string[], pos: number, expected: string[]): boolean => {
    if (pos < 0 || pos + expected.length > src.length) {
        return false;
    }
    for (let i = 0; i < expected.length; i++) {
        if (src[pos + i] !== expected[i]) {
            return false;
        }
    }
    return true;
};

const findBestHunkPosition = (
    src: string[],
    expected: string[],
    preferredPos: number,
    lowerBoundPos: number
): number | undefined => {
    const lowerBound = Math.max(0, lowerBoundPos);

    if (expected.length === 0) {
        return Math.max(lowerBound, preferredPos);
    }

    // Search around the preferred position first.
    const window = 200;
    const start = Math.max(lowerBound, preferredPos - window);
    const end = Math.min(src.length - expected.length, preferredPos + window);

    for (let pos = start; pos <= end; pos++) {
        if (matchesAt(src, pos, expected)) {
            return pos;
        }
    }

    // Fallback: full scan, but never before lowerBound.
    for (let pos = lowerBound; pos <= src.length - expected.length; pos++) {
        if (matchesAt(src, pos, expected)) {
            return pos;
        }
    }

    return undefined;
};

export type ApplyUnifiedDiffResult = {
    text: string;
    appliedHunks: number;
    rejectedHunks: number;
};

export function applyUnifiedDiffToText(
    originalText: string,
    patch: UnifiedDiffFile
): ApplyUnifiedDiffResult {
    const original = splitText(originalText);

    // Normalize: treat a totally empty file as having 0 lines, not [''].
    const srcLines = originalText.length === 0 ? [] : original.lines;

    let srcPos = 0;
    const out: string[] = [];
    let appliedHunks = 0;
    let rejectedHunks = 0;

    for (const hunk of patch.hunks) {
        const expectedSrc = buildExpectedSourceLines(hunk);
        const preferredPos = Math.max(0, (hunk.oldStart || 1) - 1);
        const foundPos = findBestHunkPosition(srcLines, expectedSrc, preferredPos, srcPos);

        if (foundPos === undefined) {
            rejectedHunks++;
            continue;
        }

        // Commit the pre-hunk copy first.
        out.push(...srcLines.slice(srcPos, foundPos));

        // Apply hunk atomically (either fully or not at all).
        let tempSrcPos = foundPos;
        const tempOut: string[] = [];
        let ok = true;

        for (const line of hunk.lines) {
            if (line.kind === 'context') {
                if (srcLines[tempSrcPos] !== line.text) {
                    ok = false;
                    break;
                }
                tempOut.push(srcLines[tempSrcPos]);
                tempSrcPos++;
            } else if (line.kind === 'del') {
                if (srcLines[tempSrcPos] !== line.text) {
                    ok = false;
                    break;
                }
                tempSrcPos++;
            } else {
                tempOut.push(line.text);
            }
        }

        if (!ok) {
            // Undo the pre-hunk copy we just appended.
            out.splice(out.length - (foundPos - srcPos), foundPos - srcPos);
            rejectedHunks++;
            continue;
        }

        out.push(...tempOut);
        srcPos = tempSrcPos;
        appliedHunks++;
    }

    // Copy remainder.
    out.push(...srcLines.slice(srcPos));

    const resultText = joinText({
        lines: out,
        eol: original.eol,
        endsWithNewline: original.endsWithNewline
    });
    return { text: resultText, appliedHunks, rejectedHunks };
}
