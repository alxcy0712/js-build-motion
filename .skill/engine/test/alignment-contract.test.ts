import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignmentArguments, alignmentInputPath, alignmentSubjectSha256, ALIGNMENT_SCHEMAS, assertAlignment, DEFAULT_ALIGNMENT_POLICY, validateAlignmentScript } from '../src/project/alignment.ts';
import { asrArguments } from '../src/project/asr.ts';
import { engineArguments, importCommandOptions } from '../workspace.mjs';

const approved = (text = "A paper boat. 蓝色纸船。\n") => {
  const s = { version: '0.1' as const, kind: 'alignment-script' as const, language: 'en' as const, lineId: 'line-1', text };
  return { ...s, approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'fixture-decision',
    sourceRef: { path: 'inputs/approval.txt', bytes: 3, sha256: 'a'.repeat(64) }, subjectSha256: alignmentSubjectSha256(s) } };
};

test('closed alignment schemas publish draft-07 and enforce policy ceilings', () => {
  for (const value of Object.values(ALIGNMENT_SCHEMAS)) assert.equal(value.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(assertAlignment('policy', DEFAULT_ALIGNMENT_POLICY), DEFAULT_ALIGNMENT_POLICY);
  for (const key of Object.keys(DEFAULT_ALIGNMENT_POLICY).filter(k => k !== 'version')) {
    assert.throws(() => assertAlignment('policy', { ...DEFAULT_ALIGNMENT_POLICY, [key]: Number(DEFAULT_ALIGNMENT_POLICY[key]) + 1 }), /INVALID/);
  }
  assert.throws(() => assertAlignment('policy', { ...DEFAULT_ALIGNMENT_POLICY, unknown: true }), /INVALID/);
  assert.throws(() => assertAlignment('policy', { ...DEFAULT_ALIGNMENT_POLICY, maxRawBytes: 0 }), /INVALID/);
});

test('approval binds exact subject text, language and line with safe project input paths', () => {
  const s = approved(); assert.deepEqual(validateAlignmentScript(s), s);
  for (const change of [{ text: s.text + 'x' }, { lineId: 'line-2' }, { language: 'zh' }]) {
    assert.throws(() => validateAlignmentScript({ ...s, ...change }), /APPROVAL_INVALID/);
  }
  for (const p of ['inputs/approval.txt', 'assets/notes.txt', 'production/script.json', 'prompt-history.jsonl']) assert.equal(alignmentInputPath(p), true);
  for (const p of ['/absolute', '../escape', 'inputs/../escape', '.engine/code', 'runs/receipt.json', 'inputs/a\\b', 'inputs/a:b', 'assets/alignment.json', 'assets/derived/alignment/frozen/script.json']) {
    assert.equal(alignmentInputPath(p), false);
    assert.throws(() => validateAlignmentScript({ ...s, approval: { ...s.approval, sourceRef: { ...s.approval.sourceRef, path: p } } }), /INVALID/);
  }
  assert.throws(() => validateAlignmentScript({ ...s, approval: { ...s.approval, confidence: 1 } }), /INVALID/);
});

test('approved text has bounded UTF8 bytes and excludes malformed scalar/control data', () => {
  const valid = approved('蓝\t船\n岛\r'); assert.doesNotThrow(() => validateAlignmentScript(valid, { ...DEFAULT_ALIGNMENT_POLICY, maxScriptBytes: Buffer.byteLength(valid.text) }));
  assert.throws(() => validateAlignmentScript(valid, { ...DEFAULT_ALIGNMENT_POLICY, maxScriptBytes: Buffer.byteLength(valid.text) - 1 }), /SCRIPT_LIMIT/);
  for (const text of ['\u0000', '\u0001', '\u000b', '\u007f', '\ufeff', '\ud800', '\udc00']) assert.throws(() => validateAlignmentScript(approved(text)), /SCRIPT_INVALID/);
  assert.doesNotThrow(() => validateAlignmentScript(approved('𠀀 🚢')));
});

test('fixed provider argv adds full JSON token output and forwarding preserves literal strings', () => {
  const model = '/film/.engine/assets/model', audio = "/film/out/quoted ' $(literal).wav";
  assert.deepEqual(alignmentArguments('zh', model, audio), asrArguments('zh', model, audio).map(v => v === '-oj' ? '-ojf' : v));
  const args = ['align', '--catalog', 'catalog-fixture', '--asset', 'asset-fixture', '--version', 'version-fixture', '--script', "inputs/quoted ' $(literal).json"];
  assert.deepEqual(engineArguments('/film', args), ['align', '/film', ...args.slice(1)]);
  assert.deepEqual(importCommandOptions(args), { importOnly: true, catalogOnly: true, alignmentOnly: true });
  for (const args of [['align', '--verify', 'alignment-fixture'], ['align', '--recover'], ['align', '--schema', 'map']]) {
    assert.deepEqual(importCommandOptions(args), { importOnly: true, catalogOnly: true, alignmentOnly: true });
  }
  assert.throws(() => importCommandOptions(['align', '--source', '/outside']), /UNKNOWN_OPTION|Unknown option/);
});
