import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { captureLinuxMediaTools } from '../native-media.mjs';
import { digest, fileHashes, json, writeJson, verifyRuntime } from '../workspace.mjs';

const project = resolve(process.argv[2] ?? '.'), engine = join(project, '.engine'), workspace = json(join(project, 'workspace.json'));
if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24 || workspace.mode !== 'manual-linux') throw Error('LINUX_NODE24_WORKSPACE_REQUIRED');
if (workspace.packageId) throw Error('LINUX_RUNTIME_ALREADY_SEALED: preserve the pinned project runtime');
const source = json(join(engine, 'source-manifest.json')), { packageId: sourcePackageId, ...sourceContent } = source;
if (digest(JSON.stringify(sourceContent)) !== sourcePackageId || sourcePackageId !== workspace.sourcePackageId) throw Error('LINUX_SOURCE_MANIFEST_CHANGED');
for (const sourceFile of source.files.filter(file => /^(src\/|scripts\/|workspace\.mjs$|native-media\.mjs$)/.test(file.path))) {
  if (digest(readFileSync(join(engine, sourceFile.path))) !== sourceFile.sha256) throw Error('LINUX_SOURCE_CHANGED: ' + sourceFile.path);
}
writeJson(join(engine, 'media-dependencies.lock.json'), captureLinuxMediaTools());
const files = fileHashes(engine, ['engine-manifest.json', 'isolation.json']);
const content = { version: 'manual-0.2', sourcePackageId, platform: process.platform, arch: process.arch,
  nodeMajor: 24, files, sandbox: 'host-managed-unverified' };
const packageId = digest(JSON.stringify(content));
writeJson(join(engine, 'engine-manifest.json'), { packageId, ...content });
writeJson(join(project, 'workspace.json'), { ...workspace, version: 'manual-0.2', packageId,
  engineSha256: digest(JSON.stringify(files)), host: { platform: process.platform, arch: process.arch, node: process.version } });
writeFileSync(join(project, 'evidence/runtime-files.json'), JSON.stringify(files, null, 2) + '\n');
verifyRuntime(project);
process.stdout.write(JSON.stringify({ packageId, sourcePackageId, sandbox: content.sandbox }) + '\n');
