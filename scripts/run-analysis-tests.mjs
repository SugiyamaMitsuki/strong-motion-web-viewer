import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(repositoryRoot, '.test-dist');
const localTsc = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
    });
  });
}

await rm(outputDirectory, { recursive: true, force: true });
if (existsSync(localTsc)) await run(process.execPath, [localTsc, '-p', 'tsconfig.test.json']);
else await run('tsc', ['-p', 'tsconfig.test.json']);
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
await run(process.execPath, ['--test', 'tests/analysis.test.cjs']);
