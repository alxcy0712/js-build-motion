import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignScript } from '../src/adapters/alignment-map.ts';
import { DEFAULT_ALIGNMENT_POLICY, assertAlignment, type AlignmentLimits, type ParsedAlignment } from '../src/project/alignment.ts';

function parsed(pieces: string[], intervals = pieces.map((_, i) => [i * 1000, (i + 1) * 1000])): ParsedAlignment {
  let bytes = 0;
  return { text: Buffer.from(pieces.join('')), rawTokens: pieces.length, tokens: pieces.map((piece, ordinal) => {
    const byteStart = bytes; bytes += Buffer.byteLength(piece);
    return { id: `alignment-token-${ordinal}`, ordinal, segmentIndex: 0, tokenIndex: ordinal, providerId: 100,
      byteStart, byteEnd: bytes, sampleStart: intervals[ordinal]![0]!, sampleEnd: intervals[ordinal]![1]!, reason: 'TOKEN_ESTIMATE' };
  }) };
}
const run = (script: string, source: ParsedAlignment, limits: Partial<AlignmentLimits> = {}) =>
  alignScript(Buffer.from(script), source, 16000, { ...DEFAULT_ALIGNMENT_POLICY, ...limits });
const words = (text: string[]) => parsed(text.map((word, i) => `${i ? ' ' : ''}${word}`));

test('exact approved UTF8 partition preserves punctuation, CRLF, emoji, Han scalar and apostrophe', () => {
  const script = "Hi，𠀀🙂 CAN’T!\r\n";
  const map = run(script, parsed(["hi，", "𠀀🙂 ", "can't!"]));
  assert.equal(map.status, 'estimated'); assertAlignment('map', map);
  assert.deepEqual(map.units.map(u => [u.kind, u.byteStart, u.byteEnd, u.text]),
    [['word', 0, 2, 'Hi'], ['nonlexical', 2, 5, '，'], ['character', 5, 9, '𠀀'], ['nonlexical', 9, 14, '🙂 '],
      ['word', 14, 21, 'CAN’T'], ['nonlexical', 21, 24, '!\r\n']]);
  assert.deepEqual(Buffer.concat(map.units.map(u => Buffer.from(u.text))), Buffer.from('4869efbc8cf0a08080f09f99822043414ee2809954210d0a', 'hex'));
  assert.equal(map.coverage.lexicalUnits, 3); assert.equal(map.coverage.unknownUnits, 0);
  assert.ok(map.units.every(u => u.confidence === null)); assert.ok(map.units.filter(u => u.kind === 'nonlexical').every(u => u.basis === 'unknown' && u.sampleStart === null));
});
test('all optimal paths must contain one unique pair; insertions retain approved text', () => {
  for (const [script, recognized, expected] of [
    [['a'], ['a', 'a'], [null]], [['a', 'a'], ['a'], [null, null]],
    [['start', 'a', 'b', 'end'], ['start', 'b', 'a', 'end'], [0, null, null, 3]],
    [['a', 'b'], ['a', 'x', 'b'], [0, 2]],
  ] as [string[], string[], (number | null)[]][]) {
    const map = run(script.join(' '), words(recognized)), actual = map.units.filter(u => u.normalized !== null);
    assert.deepEqual(actual.map(u => u.basis === 'estimated' ? Number(u.tokenIds[0]!.split('-').at(-1)) : null), expected);
    assert.equal(map.units.map(u => u.text).join(''), script.join(' '));
  }
});
test('multiple token words use their bounding span; shared tokens retain identical ranges', () => {
  const map = run('hello 天气 a b', parsed(['hel', 'lo ', '天气 ', 'a b'], [[0, 1000], [2000, 3000], [4000, 6000], [7000, 9000]]));
  const lexical = map.units.filter(u => u.normalized !== null);
  assert.deepEqual(lexical.map(u => [u.text, u.sampleStart, u.sampleEnd]), [['hello', 0, 3000], ['天', 4000, 6000], ['气', 4000, 6000], ['a', 7000, 9000], ['b', 7000, 9000]]);
  assert.deepEqual(lexical[0]!.tokenIds, ['alignment-token-0', 'alignment-token-1']);
  assert.ok(lexical.slice(1).every(u => u.reason === 'TOKEN_ESTIMATE_SHARED_RANGE'));
  assert.ok(map.limitations.some(s => s.includes('share a provider token interval')));
});
test('unique text with missing token times stays located and unknown', () => {
  const source = parsed(['a ', 'b']); source.tokens[1]!.sampleStart = source.tokens[1]!.sampleEnd = null; source.tokens[1]!.reason = 'MISSING_TOKEN_TIME';
  const map = run('a b', source), lexical = map.units.filter(u => u.normalized !== null);
  assert.equal(map.status, 'partial'); assert.equal(map.coverage.unknownUnits, 1);
  assert.equal(lexical[1]!.recognizedByteStart, 2); assert.deepEqual(lexical[1]!.tokenIds, ['alignment-token-1']);
  assert.equal(lexical[1]!.sampleStart, null); assert.equal(lexical[1]!.reason, 'MISSING_TOKEN_TIME');
  assert.equal(run('xyz', source).status, 'unknown'); assert.equal(run('，🙂', parsed([])).coverage.lexicalUnits, 0);
});
test('ASCII case and curly apostrophe normalize; apostrophe removal and lexical changes stay unknown', () => {
  assert.equal(run("WE can’t", words(['we', "can't"])).status, 'estimated');
  assert.equal(run("can't", words(['cant'])).status, 'unknown');
  assert.equal(run('甲乙', parsed(['甲丙'])).status, 'partial');
});
test('byte, lexical-unit, matrix and serialized-map quotas admit exact boundaries', () => {
  const source = words(['a', 'b']), map = run('a b', source);
  assert.equal(run('a b', source, { maxScriptBytes: 3, maxScriptUnits: 2, maxRecognizedUnits: 2, maxMatrixCells: 9 }).status, 'estimated');
  assert.throws(() => run('a b', source, { maxScriptBytes: 2 }), /ALIGNMENT_SCRIPT_LIMIT/);
  assert.throws(() => run('a b', source, { maxScriptUnits: 1 }), /ALIGNMENT_SCRIPT_UNITS_LIMIT/);
  assert.throws(() => run('a b', source, { maxRecognizedUnits: 1 }), /ALIGNMENT_RECOGNIZED_UNITS_LIMIT/);
  assert.throws(() => run('a b', source, { maxMatrixCells: 8 }), /ALIGNMENT_MATRIX_LIMIT/);
  const bytes = Buffer.byteLength(JSON.stringify(map, null, 2) + '\n');
  assert.deepEqual(run('a b', source, { maxMapBytes: bytes }), map);
  assert.throws(() => run('a b', source, { maxMapBytes: bytes - 1 }), /ALIGNMENT_MAP_LIMIT/);
});
test('malformed direct parsed input and non-UTF8 script are rejected before alignment', () => {
  for (const mutate of [
    (p: ParsedAlignment) => { p.tokens[0]!.byteEnd = 2; },
    (p: ParsedAlignment) => { p.tokens[0]!.sampleEnd = 16001; },
    (p: ParsedAlignment) => { p.tokens[0]!.sampleEnd = null; },
    (p: ParsedAlignment) => { p.tokens[0]!.id = 'forged'; },
    (p: ParsedAlignment) => { p.tokens[0]!.segmentIndex = -1; },
    (p: ParsedAlignment) => { p.rawTokens = 0; },
  ]) { const source = parsed(['a']); mutate(source); assert.throws(() => run('a', source), /ALIGNMENT_PARSED_INVALID/); }
  assert.throws(() => alignScript(Buffer.from([255]), parsed([]), 16000, DEFAULT_ALIGNMENT_POLICY), /ALIGNMENT_TEXT_INVALID/);
  assert.throws(() => run('\ufeffa', parsed(['a'])), /ALIGNMENT_TEXT_INVALID/);
  const backward = parsed(['a ', 'b'], [[1000, 2000], [0, 1000]]);
  assert.throws(() => run('a b', backward), /ALIGNMENT_PARSED_INVALID/);
});

test('default matrix ceiling admits 2048 by 2048 cells and refuses the next whole lexical row', () => {
  const text = Array.from({ length: 2047 }, () => 'a'), source = parsed(text.map((word, i) => (i ? ' ' : '') + word), text.map((_, i) => [i * 5, (i + 1) * 5]));
  assert.equal(run(text.join(' '), source).coverage.estimatedUnits, 2047);
  text.push('a'); source.text = Buffer.from(text.join(' '));
  source.tokens.push({ id: 'alignment-token-2047', ordinal: 2047, segmentIndex: 0, tokenIndex: 2047, providerId: 100,
    byteStart: 4093, byteEnd: 4095, sampleStart: 10235, sampleEnd: 10240, reason: 'TOKEN_ESTIMATE' }); source.rawTokens++;
  assert.throws(() => run(text.join(' '), source), /ALIGNMENT_MATRIX_LIMIT/);
});

test('bounded LCS agrees with an independent exhaustive optimal-path oracle', () => {
  const sequences: string[][] = [[]]; let level: string[][] = [[]];
  for (let length = 1; length <= 4; length++) { level = level.flatMap(a => ['a', 'b'].map(c => [...a, c])); sequences.push(...level); }
  function oracle(a: string[], b: string[]) {
    let length = 0, paths: [number, number][][] = [[]];
    function visit(from: number, to: number, path: [number, number][]) {
      if (path.length > length) { length = path.length; paths = [path]; } else if (path.length === length) paths.push(path);
      for (let i = from; i < a.length; i++) for (let j = to; j < b.length; j++) if (a[i] === b[j]) visit(i + 1, j + 1, [...path, [i, j]]);
    }
    visit(0, 0, []);
    return a.map((_, i) => {
      const candidate = paths[0]!.find(pair => pair[0] === i)?.[1];
      return candidate !== undefined && paths.every(path => path.some(pair => pair[0] === i && pair[1] === candidate)) ? candidate : null;
    });
  }
  let cases = 0;
  for (const a of sequences) for (const b of sequences) {
    const map = run(a.join(' '), words(b));
    const actual = map.units.filter(u => u.normalized !== null).map(u => u.basis === 'estimated' ? Number(u.tokenIds[0]!.split('-').at(-1)) : null);
    assert.deepEqual(actual, oracle(a, b), JSON.stringify({ a, b })); cases++;
  }
  assert.equal(cases, 961);
});
