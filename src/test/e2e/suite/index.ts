import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

function collectTestFiles(dir: string, predicate: (filePath: string) => boolean): string[] {
    const results: string[] = [];
    const stack: string[] = [dir];

    while (stack.length) {
        const current = stack.pop();
        if (!current) {
            break;
        }
        if (!fs.existsSync(current)) {
            continue;
        }

        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile() && predicate(fullPath)) {
                results.push(fullPath);
            }
        }
    }

    return results;
}

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 60_000
    });

    const testsRoot = path.resolve(__dirname);
    const testFiles = collectTestFiles(testsRoot, (p) => p.endsWith('.e2e.test.js'));
    for (const file of testFiles) {
        mocha.addFile(file);
    }

    await new Promise<void>((resolve, reject) => {
        mocha.run((failures: number) => {
            if (failures > 0) {
                reject(new Error(`${failures} e2e test(s) failed`));
            } else {
                resolve();
            }
        });
    });
}
