import type { ZipSpec } from './zip.ts';
export const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const T = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const C = 'application/vnd.openxmlformats-officedocument.';
export function relationships(values: { id: string; type: string; target: string; mode?: string }[]): string {
  return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + values.map(v =>
    '<Relationship Id="' + v.id + '" Type="' + R + v.type + '" Target="' + v.target + '"' + (v.mode ? ' TargetMode="' + v.mode + '"' : '') + '/>').join('') + '</Relationships>';
}
export const contentTypes = (values: [string, string][]) => '<Types xmlns="' + T + '">' + values.map(([part, type]) =>
  '<Override PartName="/' + part + '" ContentType="' + C + type + '+xml"/>').join('') + '</Types>';
export const paragraph = (text: string) => '<a:p><a:r><a:t>' + text + '</a:t></a:r></a:p>';
export const shape = (text: string, placeholder = '') => '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Fictional"/><p:cNvSpPr/><p:nvPr>' + placeholder +
  '</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/>' + paragraph(text) + '</p:txBody></p:sp>';
export const slide = (body: string) => '<p:sld xmlns:p="' + P + '" xmlns:a="' + A + '"><p:cSld><p:spTree>' + body + '</p:spTree></p:cSld></p:sld>';
export function pptxParts(options: { order?: number[]; notes?: boolean; texts?: string[]; extraBody?: string } = {}): ZipSpec[] {
  const texts = options.texts ?? ['中文&amp; English'], order = options.order ?? texts.map((_, i) => i + 1), notes = options.notes ?? true;
  const values: [string, string][] = [['ppt/presentation.xml', 'presentationml.presentation.main'],
    ...texts.map((_, i) => ['ppt/slides/slide' + (i + 1) + '.xml', 'presentationml.slide'] as [string, string]),
    ...(notes ? [['ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide'] as [string, string]] : [])];
  return [{ name: '[Content_Types].xml', data: contentTypes(values) },
    { name: '_rels/.rels', data: relationships([{ id: 'office', type: 'officeDocument', target: 'ppt/presentation.xml' }]) },
    { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="' + P + '" xmlns:r="' + R.slice(0, -1) + '"><p:sldIdLst>' +
      order.map(i => '<p:sldId id="' + (255 + i) + '" r:id="s' + i + '"/>').join('') + '</p:sldIdLst></p:presentation>' },
    { name: 'ppt/_rels/presentation.xml.rels', data: relationships(texts.map((_, i) => ({ id: 's' + (i + 1), type: 'slide', target: 'slides/slide' + (i + 1) + '.xml' }))) },
    ...texts.map((text, i) => ({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: slide(shape(text) + (i ? '' : options.extraBody ?? '')) })),
    ...(notes ? [{ name: 'ppt/slides/_rels/slide1.xml.rels', data: relationships([{ id: 'notes', type: 'notesSlide', target: '../notesSlides/notesSlide1.xml' }]) },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes xmlns:p="' + P + '" xmlns:a="' + A + '"><p:cSld><p:spTree>' +
        shape('讲者笔记', '<p:ph type="body"/>') + shape('99', '<p:ph type="sldNum"/>') + '</p:spTree></p:cSld></p:notes>' }] : [])];
}
export const worksheet = (body: string, tables = '') => '<worksheet xmlns="' + S + '" xmlns:r="' + R.slice(0, -1) + '"><sheetData>' + body + '</sheetData>' + tables + '</worksheet>';
export function xlsxParts(options: { table?: boolean; order?: number[]; sheets?: string[]; cells?: string; strings?: string; range?: string } = {}): ZipSpec[] {
  const sheets = options.sheets ?? ['数据'], order = options.order ?? sheets.map((_, i) => i + 1), table = options.table ?? true;
  const values: [string, string][] = [['xl/workbook.xml', 'spreadsheetml.sheet.main'], ['xl/sharedStrings.xml', 'spreadsheetml.sharedStrings'],
    ...sheets.map((_, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', 'spreadsheetml.worksheet'] as [string, string]),
    ...(table ? [['xl/tables/table1.xml', 'spreadsheetml.table'] as [string, string]] : [])];
  const cells = options.cells ?? '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><r><t>文本</t></r><r><t>Text</t></r></is></c><c r="B2"><v>42</v></c></row>' +
    '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3"><f>B2*2</f><v>84</v></c></row>';
  return [{ name: '[Content_Types].xml', data: contentTypes(values) },
    { name: '_rels/.rels', data: relationships([{ id: 'office', type: 'officeDocument', target: 'xl/workbook.xml' }]) },
    { name: 'xl/workbook.xml', data: '<workbook xmlns="' + S + '" xmlns:r="' + R.slice(0, -1) + '"><sheets>' + order.map(i =>
      '<sheet name="' + sheets[i - 1] + '" sheetId="' + i + '" r:id="s' + i + '"/>').join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: relationships([...sheets.map((_, i) => ({ id: 's' + (i + 1), type: 'worksheet', target: 'worksheets/sheet' + (i + 1) + '.xml' })),
      { id: 'str', type: 'sharedStrings', target: 'sharedStrings.xml' }]) },
    { name: 'xl/sharedStrings.xml', data: '<sst xmlns="' + S + '">' + (options.strings ?? '<si><t>名称</t></si><si><r><t>值</t></r><r><t>Value</t></r></si>') + '</sst>' },
    ...sheets.map((_, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: worksheet(i ? '<row r="1"><c r="A1" t="inlineStr"><is><t>Second</t></is></c></row>' : cells,
      !i && table ? '<tableParts count="1"><tablePart r:id="t1"/></tableParts>' : '') })),
    ...(table ? [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: relationships([{ id: 't1', type: 'table', target: '../tables/table1.xml' }]) },
      { name: 'xl/tables/table1.xml', data: '<table xmlns="' + S + '" id="1" name="FictionalTable" displayName="FictionalTable" ref="' + (options.range ?? 'A1:B3') + '"><tableColumns count="2"><tableColumn id="1" name="名称"/><tableColumn id="2" name="值Value"/></tableColumns></table>' }] : [])];
}
