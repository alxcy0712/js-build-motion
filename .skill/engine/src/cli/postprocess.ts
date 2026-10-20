import { parseArgs } from 'node:util';
import { loadProject } from '../project/manifest.ts';
import { POSTPROCESS_FILE, POSTPROCESS_SCHEMAS, readPostprocess, registerPostprocess } from '../project/postprocess.ts';
import { readRunLog } from '../project/run-log.ts';
import { join } from 'node:path';

export function cmdPostprocess(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    schema: { type: 'string' }, request: { type: 'string' }, verify: { type: 'boolean' },
  } });
  if (positionals.length !== 1 || Object.keys(values).length !== 1 || Object.values(values).some(v => v === '')) throw Error('POSTPROCESS_USAGE: postprocess <project> --request <project JSON> | --verify | --schema request|record');
  if (values.schema) {
    if (values.schema !== 'request' && values.schema !== 'record') throw Error('POSTPROCESS_SCHEMA: request|record');
    process.stdout.write(JSON.stringify(POSTPROCESS_SCHEMAS[values.schema], null, 2) + '\n'); return 0;
  }
  const project = loadProject(positionals[0]!);
  const record = values.request ? registerPostprocess(project, values.request) : readPostprocess(project, readRunLog(join(project.dir, 'run.json')));
  if (!record) throw Error('POSTPROCESS_MISSING: ' + POSTPROCESS_FILE);
  process.stdout.write(JSON.stringify({ ok: true, path: POSTPROCESS_FILE, recordId: record.recordId, final: record.final }, null, 2) + '\n');
  return 0;
}
