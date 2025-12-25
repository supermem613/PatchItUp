import * as vscode from 'vscode';

export class Logger {
    constructor(private readonly channel: vscode.OutputChannel) {}

    public info(message: string, data?: unknown): void {
        this.append('INFO', message, data);
    }

    public warn(message: string, data?: unknown): void {
        this.append('WARN', message, data);
    }

    public error(message: string, data?: unknown): void {
        this.append('ERROR', message, data);
    }

    public show(preserveFocus = true): void {
        this.channel.show(preserveFocus);
    }

    public dispose(): void {
        this.channel.dispose();
    }

    private append(level: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
        this.channel.appendLine(`[${ts}] [${level}] ${message}${suffix}`);
    }
}

function safeStringify(data: unknown): string {
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export function createLogger(): Logger {
    // "log: true" creates a log output channel (shows under "Log (PatchItUp)")
    // and tends to be easier to find than raw Extension Host console logs.
    const channel = vscode.window.createOutputChannel('PatchItUp', { log: true });
    return new Logger(channel);
}
