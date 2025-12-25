import type * as vscodeType from 'vscode';

// Note: unit tests in this repo run in a plain Node context where `require('vscode')`
// is not available. Lazily load VS Code APIs only when needed.
const getVscode = (): typeof vscodeType => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('vscode');
};

export function formatStepMessage(
    step: number,
    totalSteps: number,
    intent: string,
    detail?: string
): string {
    const boundedStep = Math.max(1, Math.min(step, totalSteps));
    const base = `Step ${boundedStep}/${totalSteps}: ${intent}`;
    return detail ? `${base} — ${detail}` : base;
}

export type StepProgressReporter = {
    next(intent: string, detail?: string): void;
    detail(detail: string): void;
};

export async function withStepProgress<T>(params: {
    title: string;
    totalSteps: number;
    task: (reporter: StepProgressReporter) => Promise<T>;
}): Promise<T> {
    const { title, totalSteps, task } = params;

    const vscode = getVscode();

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false
        },
        async (progress) => {
            const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
            status.text = `${title}`;
            status.show();

            let currentStep = 0;
            let progressSoFar = 0;
            let currentIntent = '';

            const report = (intent: string, detail: string | undefined, increment: number) => {
                currentIntent = intent;
                const msg = formatStepMessage(currentStep, totalSteps, intent, detail);
                progress.report({ message: msg, increment });
                status.text = `${title}: ${msg}`;
            };

            const reporter: StepProgressReporter = {
                next: (intent: string, detail?: string) => {
                    currentStep = Math.min(totalSteps, currentStep + 1);
                    const remaining = Math.max(0, 100 - progressSoFar);
                    const rawIncrement = 100 / totalSteps;
                    const increment = Math.min(remaining, rawIncrement);
                    progressSoFar += increment;
                    report(intent, detail, increment);
                },
                detail: (detail: string) => {
                    const stepToShow = currentStep > 0 ? currentStep : 1;
                    const msg = formatStepMessage(
                        stepToShow,
                        totalSteps,
                        currentIntent || 'Working',
                        detail
                    );
                    progress.report({ message: msg });
                    status.text = `${title}: ${msg}`;
                }
            };

            try {
                return await task(reporter);
            } finally {
                status.hide();
                status.dispose();
            }
        }
    );
}
