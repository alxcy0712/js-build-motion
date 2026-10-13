import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest, fileHashes, json, writeJson } from '../engine/workspace.mjs';

export const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const root = dirname(skill);
export const engine = join(skill, 'engine');
export const backups = join(root, '.skill-backups');

export function sealCore() {
  const pkg = json(join(engine, 'package.json'));
  const dependencies = readdirSync(join(engine, 'node_modules')).sort().map(name => {
    const dependency = json(join(engine, 'node_modules', name, 'package.json'));
    return `${dependency.name}@${dependency.version}`;
  });
  const content = {
    version: '0.2', engineVersion: pkg.version,
    platform: process.platform, arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]), dependencies,
    skillFiles: fileHashes(skill, ['engine', 'manifest.json']),
    files: fileHashes(engine, ['test']), tests: fileHashes(join(engine, 'test')),
  };
  const manifest = { packageId: digest(JSON.stringify(content)), ...content };
  writeJson(join(skill, 'manifest.json'), manifest);
  return manifest;
}

export function verifyCore() {
  const { packageId, ...content } = json(join(skill, 'manifest.json'));
  if (digest(JSON.stringify(content)) !== packageId ||
      JSON.stringify(fileHashes(skill, ['engine', 'manifest.json'])) !== JSON.stringify(content.skillFiles) ||
      JSON.stringify(fileHashes(engine, ['test'])) !== JSON.stringify(content.files) ||
      JSON.stringify(fileHashes(join(engine, 'test'))) !== JSON.stringify(content.tests)) {
    throw new Error('SKILL_CHANGED: maintain the core explicitly, verify it, then seal its new version');
  }
  if (content.platform !== process.platform || content.arch !== process.arch || content.nodeMajor !== Number(process.versions.node.split('.')[0])) {
    throw new Error(`SKILL_PLATFORM: requires ${content.platform}/${content.arch}, Node ${content.nodeMajor}`);
  }
  return { packageId, ...content };
}

/** Snapshot each invocation; retain the two most recent successful snapshots. */
export function backupCore() {
  const manifest = verifyCore();
  mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const archive = join(backups, `skill-${stamp}-${randomUUID().slice(0, 8)}-${manifest.packageId.slice(0, 12)}.tar.gz`);
  const pending = archive + '.pending';
  try {
    const result = spawnSync('tar', ['-czf', pending, '--exclude=.DS_Store', '-C', skill, '.'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`SKILL_BACKUP: ${result.stderr || result.error}`);
    if (verifyCore().packageId !== manifest.packageId) throw new Error('SKILL_CHANGED_DURING_BACKUP');
    renameSync(pending, archive);
    const saved = readdirSync(backups).filter(name => /^skill-.*\.tar\.gz$/.test(name)).sort();
    for (const old of saved.slice(0, -2)) rmSync(join(backups, old), { force: true });
    return archive;
  } finally { if (existsSync(pending)) rmSync(pending); }
}
