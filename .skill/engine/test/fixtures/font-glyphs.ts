import assert from 'node:assert/strict';

/** Unicode cmap lookup for the pinned/test fonts (OpenType formats 4 and 12). Glyph 0 is .notdef. */
export function fontGlyphIndex(data: Buffer): (ch: string) => number {
  let cmap = -1;
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    if (data.toString('ascii', entry, entry + 4) === 'cmap') cmap = data.readUInt32BE(entry + 8);
  }
  assert.ok(cmap >= 0, 'fixture font requires a cmap');
  const tables: { offset: number; format: number }[] = [];
  for (let i = 0; i < data.readUInt16BE(cmap + 2); i++) {
    const entry = cmap + 4 + i * 8, platform = data.readUInt16BE(entry), encoding = data.readUInt16BE(entry + 2);
    const offset = cmap + data.readUInt32BE(entry + 4), format = data.readUInt16BE(offset);
    if ((platform === 0 || platform === 3 && [1, 10].includes(encoding)) && [4, 12].includes(format)) tables.push({ offset, format });
  }
  const selected = tables.sort((a, b) => b.format - a.format)[0];
  assert.ok(selected, 'fixture font requires Unicode cmap format 4 or 12');
  const { offset: p, format } = selected;
  return ch => {
    const code = ch.codePointAt(0)!;
    if (format === 12) {
      for (let i = 0; i < data.readUInt32BE(p + 12); i++) {
        const group = p + 16 + i * 12, start = data.readUInt32BE(group), end = data.readUInt32BE(group + 4);
        if (code >= start && code <= end) return data.readUInt32BE(group + 8) + code - start;
      }
    } else if (code <= 0xffff) {
      const count = data.readUInt16BE(p + 6) / 2, ends = p + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, ranges = deltas + count * 2;
      for (let i = 0; i < count; i++) if (code >= data.readUInt16BE(starts + i * 2) && code <= data.readUInt16BE(ends + i * 2)) {
        const delta = data.readInt16BE(deltas + i * 2), word = ranges + i * 2, range = data.readUInt16BE(word);
        const glyph = range ? data.readUInt16BE(word + range + (code - data.readUInt16BE(starts + i * 2)) * 2) : code;
        return range && glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
    }
    return 0;
  };
}

export function assertFontGlyphs(text: string, fonts: ((ch: string) => number)[]) {
  const missing = [...new Set([...text])].filter(ch => !/\s/.test(ch) && fonts.every(glyph => glyph(ch) === 0));
  assert.deepEqual(missing, [], `FONT_GLYPHS_MISSING: ${missing.map(ch => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).join(' ')}`);
}
