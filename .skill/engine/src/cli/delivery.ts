import { parseArgs } from 'node:util';
import { loadProject } from '../project/manifest.ts';
import { DELIVERY_SCHEMAS, validateDelivery } from '../project/delivery.ts';
import { validateStructuredReview, validateCredits } from '../project/review-validation.ts';
import { readAssetFile } from '../application/asset-plan.ts';
import { deliveryDocumentFiles, readDeliveryContext, verifyDeliveryFiles } from '../application/delivery-context.ts';
import { deliverProject, verifyDelivery } from '../application/delivery.ts';

export async function cmdDelivery(command: 'review' | 'credits' | 'deliver', argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    schema: { type: 'string' }, subject: { type: 'boolean' }, request: { type: 'string' }, verify: { type: 'string' },
  } });
  if (positionals.length !== 1 || Object.keys(values).length !== 1 || Object.values(values).some(value => value === '')) throw Error('DELIVERY_USAGE: ' + command + ' <project> --schema <kind> | --subject | --request <project JSON> | --verify <deliveryId|current>');
  if (values.schema) {
    if (!Object.hasOwn(DELIVERY_SCHEMAS, values.schema)) throw Error('DELIVERY_SCHEMA_UNKNOWN');
    process.stdout.write(JSON.stringify(DELIVERY_SCHEMAS[values.schema as keyof typeof DELIVERY_SCHEMAS], null, 2) + '\n'); return 0;
  }
  const project = loadProject(positionals[0]);
  let result: unknown;
  if (values.subject && command !== 'deliver') result = await readDeliveryContext(project.dir);
  else if (values.verify && command === 'deliver') result = await verifyDelivery(project.dir, values.verify === 'current' ? undefined : values.verify);
  else if (values.request) {
    const raw = await readAssetFile(project.dir, values.request, 8 * 1024 * 1024);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.data));
    if (command === 'deliver') result = await deliverProject(project.dir, value);
    else {
      const context = await readDeliveryContext(project.dir);
      validateDelivery(command === 'review' ? 'review' : 'credits', value);
      await verifyDeliveryFiles(project.dir, deliveryDocumentFiles(value));
      const document = command === 'review' ? validateStructuredReview(value, context) : validateCredits(value, context);
      const review = document as { checks: { verdict: string }[]; references: { method: string }[] };
      const ready = command === 'credits' || review.checks.every(check => ['pass', 'not_applicable'].includes(check.verdict)) &&
        (!review.references.length || review.references.some(reference => ['normal-speed-playback', 'provided-observations'].includes(reference.method)));
      result = { ok: true, ready, scope: command === 'review' ? 'structured-review' : 'local-delivery-rights', subject: context.subject, document };
    }
  } else throw Error('DELIVERY_USAGE: unexpected operation');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
}
