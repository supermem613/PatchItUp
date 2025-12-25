export type PatchFileEdit = {
    oldPath: string;
    newPath: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    oldBlob?: string;
    newBlob?: string;
};

export function parseGitPatchFileEdits(patchContent: string): PatchFileEdit[] {
    const edits: PatchFileEdit[] = [];
    const lines = patchContent.split(/\r?\n/);
    let current: PatchFileEdit | undefined;

    const pushCurrent = () => {
        if (current) {
            edits.push(current);
            current = undefined;
        }
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            pushCurrent();
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            if (!match) {
                continue;
            }
            current = { oldPath: match[1], newPath: match[2], status: 'modified' };
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith('new file mode ')) {
            current.status = 'added';
            continue;
        }

        if (line.startsWith('deleted file mode ')) {
            current.status = 'deleted';
            continue;
        }

        if (line.startsWith('index ')) {
            // Example: index 83db48f..f735c2a 100644
            const idxMatch = /^index\s+([0-9a-fA-F]+)\.\.([0-9a-fA-F]+)(?:\s|$)/.exec(line);
            if (idxMatch) {
                current.oldBlob = idxMatch[1];
                current.newBlob = idxMatch[2];
            }
            continue;
        }

        if (line.startsWith('rename from ')) {
            current.status = 'renamed';
            current.oldPath = line.substring('rename from '.length).trim();
            continue;
        }

        if (line.startsWith('rename to ')) {
            current.status = 'renamed';
            current.newPath = line.substring('rename to '.length).trim();
            continue;
        }
    }

    pushCurrent();
    return edits;
}
