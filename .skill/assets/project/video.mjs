import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineArguments, importCommandOptions, importSourceArguments, runBoundCommand } from './.engine/workspace.mjs';

const project = dirname(fileURLToPath(import.meta.url));
try {
  const args = importSourceArguments(process.argv.slice(2), project);
  process.exitCode = await runBoundCommand(project, [process.execPath, join(project, '.engine/src/cli/index.ts'), ...engineArguments(project, args)], importCommandOptions(args));
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
