import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundCommand } from './.engine/workspace.mjs';

try {
  process.exitCode = runBoundCommand(dirname(fileURLToPath(import.meta.url)), process.argv.slice(2));
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
