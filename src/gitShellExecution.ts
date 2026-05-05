export type GitShellExecution = {
    shellCommand: string;
    shellArgs: string[];
};

const quoteBash = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const quoteCmd = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export function buildGitShellExecution(params: {
    useBash: boolean;
    cwdForShell: string;
    args: string[];
    outPath: string;
    errPath: string;
    codePath: string;
    inPath?: string;
}): GitShellExecution {
    const { useBash, cwdForShell, args, outPath, errPath, codePath, inPath } = params;

    const gitArgsJoined = useBash
        ? args.map((a) => quoteBash(a)).join(' ')
        : args.map((a) => quoteCmd(a)).join(' ');

    if (useBash) {
        const cdPart = `cd ${quoteBash(cwdForShell)} || { echo "Failed to cd to ${cwdForShell}" > ${quoteBash(errPath)}; echo 1 > ${quoteBash(codePath)}; exit 0; }`;
        const redirIn = inPath ? ` < ${quoteBash(inPath)}` : '';
        // Stdout and stderr are written to SEPARATE files so binary diff output (stdout) is
        // never corrupted by git progress/warnings (stderr).
        const gitPart = `git ${gitArgsJoined}${redirIn} > ${quoteBash(outPath)} 2> ${quoteBash(errPath)}; echo $? > ${quoteBash(codePath)}; exit 0`;
        return { shellCommand: 'bash', shellArgs: ['-lc', `${cdPart}; ${gitPart}`] };
    }

    // cmd.exe is used so we can reliably use input/output redirection (<, >, 2>)
    const cdPart = `cd /d ${quoteCmd(cwdForShell)}`;
    const redirIn = inPath ? ` < ${quoteCmd(inPath)}` : '';
    const gitPart = `git ${gitArgsJoined}${redirIn} > ${quoteCmd(outPath)} 2> ${quoteCmd(errPath)}`;

    // IMPORTANT: %ERRORLEVEL% is expanded when the whole command line is parsed, not after git runs.
    // Use delayed expansion (!ERRORLEVEL!) so we capture the real git exit code on Windows.
    const codePart = `echo !ERRORLEVEL! > ${quoteCmd(codePath)}`;
    const cmdLine = `setlocal EnableDelayedExpansion & ${cdPart} && ${gitPart} & ${codePart} & exit /b 0`;

    return { shellCommand: 'cmd.exe', shellArgs: ['/d', '/v:on', '/s', '/c', cmdLine] };
}
