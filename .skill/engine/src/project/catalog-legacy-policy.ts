/** Frozen catalog policy fields retain media policy hashes across historical versions.
 * These schemas describe recorded policy bytes; document parsing is unavailable. */
import { DEFAULT_OCR_LIMITS, OCR_LIMITS_SCHEMA, type OcrLimits } from './ocr.ts';
export const INSPECT_POLICY_02_DOCUMENT_LIMITS = Object.freeze({ maxDocumentSourceBytes: 33554432, maxDocumentsPerAttempt: 20,
  maxPdfPages: 200, maxDocumentUnits: 20000, maxDocumentTextBytes: 8388608, maxDocumentMapBytes: 4194304,
  maxWorkerPayloadBytes: 33554432, maxDocxEntries: 2000, maxDocxDeclaredExpandedBytes: 67108864,
  maxXmlPartBytes: 8388608, maxXmlReadBytes: 33554432, maxPackagePathDepth: 16, maxXmlDepth: 64,
  maxXmlNodes: 200000, maxCompressionRatio: 200, workerOldSpaceMiB: 512, workerConcurrency: 1 });
export const DEFAULT_DOCUMENT_LIMITS = INSPECT_POLICY_02_DOCUMENT_LIMITS;
export type DocumentLimits = { [K in keyof typeof DEFAULT_DOCUMENT_LIMITS]: number };
export const DEFAULT_OFFICE_LIMITS = Object.freeze({ maxSlides: 200, maxWorksheets: 32, maxSharedStrings: 20000, maxTables: 64 });
export type OfficeLimits = { [K in keyof typeof DEFAULT_OFFICE_LIMITS]: number };
export const DEFAULT_DOCUMENT_RASTER_LIMITS = Object.freeze({ maxSourceBytes: 33554432, maxUnitsPerSource: 4,
  maxUnitsPerAttempt: 4, maxTotalPixels: 32000000, maxEmbeddedBytesPerUnit: 8388608, maxTotalEmbeddedBytes: 16777216,
  maxPixelsPerUnit: 16000000, maxEdge: 8192, maxRasterBytes: 48000128, maxWorkerPayloadBytes: 67108864,
  maxMapBytes: 4194304, maxPdfDocumentPages: 200, maxPdfObjects: 20000, maxPdfStructureTokens: 200000,
  maxPdfStructureDepth: 64, maxPdfDecodedStreamBytes: 67108864, maxImageOccurrences: 20000, maxCanvasLivePixels: 32000000,
  maxCanvasAllocationPixels: 64000000, maxRuntimeResourceBytes: 16777216, workerOldSpaceMiB: 512,
  workerElapsedMs: 30000, concurrency: 1 });
export type DocumentRasterLimits = { [K in keyof typeof DEFAULT_DOCUMENT_RASTER_LIMITS]: number };
export type DocumentOcrPolicy = DocumentRasterLimits & { enabled: boolean; pdfPages: number[]; docxImages: number[];
  dpi: 72 | 150 | 300; ocr: OcrLimits };
export const INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS = Object.freeze({ enabled: false, pdfPages: [] as number[],
  docxImages: [] as number[], dpi: 300 as const, ...DEFAULT_DOCUMENT_RASTER_LIMITS, ocr: DEFAULT_OCR_LIMITS });

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const limits = object(Object.fromEntries(Object.entries(INSPECT_POLICY_02_DOCUMENT_LIMITS).map(([key, maximum]) => [key,
  key === 'workerConcurrency' ? { const: 1 } : { ...integer, minimum: key === 'workerOldSpaceMiB' || key === 'maxCompressionRatio' ? 1 : 0, maximum }])));
export const DOCUMENT_LIMITS_SCHEMA = limits;
export const OFFICE_LIMITS_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_OFFICE_LIMITS).map(([key, maximum]) => [key, { ...integer, maximum }])));
const selection = { type: 'array', items: positive, uniqueItems: true, maxItems: DEFAULT_DOCUMENT_RASTER_LIMITS.maxUnitsPerSource };
const dpi = { enum: [72, 150, 300] };
export const DOCUMENT_RASTER_LIMITS_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_DOCUMENT_RASTER_LIMITS).map(([key, maximum]) =>
  [key, key === 'workerOldSpaceMiB' || key === 'concurrency' ? { const: maximum } : { ...integer, minimum: key === 'workerElapsedMs' ? 1 : 0, maximum }])));
export const DOCUMENT_OCR_POLICY_SCHEMA = object({ enabled: { type: 'boolean' }, pdfPages: selection, docxImages: selection, dpi,
  ...DOCUMENT_RASTER_LIMITS_SCHEMA.properties, ocr: OCR_LIMITS_SCHEMA });
export function validateDocumentOcrPolicy(policy: DocumentOcrPolicy): void {
  for (const list of [policy.pdfPages, policy.docxImages]) if (list.length > policy.maxUnitsPerSource || list.some((n, i) => i > 0 && n <= list[i - 1]!)) throw Error('DOCUMENT_OCR_SELECTION_INVALID');
}
