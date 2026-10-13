import { sealCore } from './core.mjs';

try { process.stdout.write(JSON.stringify({ packageId: sealCore().packageId }) + '\n'); }
catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
