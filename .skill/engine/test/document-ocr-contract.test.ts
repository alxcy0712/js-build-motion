import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05, INSPECT_POLICY_06, LEGACY_INSPECT_POLICY, INSPECT_POLICY_02, INSPECT_POLICY_03, adoptInspectPolicy, assertInspectPolicy, assertCatalog } from '../src/project/catalog.ts';
import { DEFAULT_DOCUMENT_RASTER_LIMITS, INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS, assertDocumentOcr } from '../src/project/document-ocr.ts';

test('document OCR opt-in preserves defaults and all historical adoption identities', () => {
  assert.equal(DEFAULT_INSPECT_POLICY.version, '0.4'); assert.equal(INSPECT_POLICY_06.documentOcr.enabled, false);
  assert.deepEqual(adoptInspectPolicy(INSPECT_POLICY_06), INSPECT_POLICY_06);
  for (const source of [LEGACY_INSPECT_POLICY, INSPECT_POLICY_02, INSPECT_POLICY_03, DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05]) {
    assert.deepEqual(adoptInspectPolicy(source, source.version), source);
    const adopted = adoptInspectPolicy(source, '0.6'); assert.equal(adopted.version, '0.6');
    assert.deepEqual(adopted.documentOcr, INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS);
  }
  assert.throws(() => adoptInspectPolicy(INSPECT_POLICY_06, '0.5'), /VERSION_INVALID/);
});
test('unit selections are finite ascending unique positive ordinals', () => {
  const policy = { ...INSPECT_POLICY_06, documentOcr: { ...INSPECT_POLICY_06.documentOcr, enabled: true, pdfPages: [1, 4], docxImages: [2, 3] } };
  assert.deepEqual(assertInspectPolicy(policy), policy);
  for (const pdfPages of [[0], [-1], [1.5], [1, 1], [2, 1], [1, 2, 3, 4, 5]])
    assert.throws(() => assertInspectPolicy({ ...policy, documentOcr: { ...policy.documentOcr, pdfPages } }), /INVALID/);
  assert.throws(() => assertInspectPolicy({ ...policy, documentOcr: { ...policy.documentOcr, maxUnitsPerSource: 1 } }), /INVALID/);
});
test('source and attempt limits stay separate with closed bounded policy fields', () => {
  const policy = { ...INSPECT_POLICY_06, documentOcr: { ...INSPECT_POLICY_06.documentOcr, maxTotalPixels: 0, maxUnitsPerAttempt: 0 } };
  assert.equal(assertInspectPolicy(policy).documentOcr.maxPixelsPerUnit, 16000000);
  for (const [key, value] of Object.entries(DEFAULT_DOCUMENT_RASTER_LIMITS))
    assert.throws(() => assertInspectPolicy({ ...policy, documentOcr: { ...policy.documentOcr, [key]: value + 1 } }), /INVALID/);
  for (const patch of [{ dpi: 96 }, { enabled: 'true' }, { extra: true }, { ocr: { ...policy.documentOcr.ocr, extra: true } }])
    assert.throws(() => assertInspectPolicy({ ...policy, documentOcr: { ...policy.documentOcr, ...patch } }), /INVALID/);
});
test('disabled descriptor records native coverage and publishes no file group', () => {
  const descriptor = { version: '0.1', status: 'disabled', reason: 'policy-disabled', nativeStatus: 'partial', scope: 'selected-docx-embedded-source-pixels',
    selection: [], totalUnits: null, completedUnits: 0, mapEvidenceId: null, runtime: null, engine: null };
  assert.deepEqual(assertDocumentOcr('descriptor', descriptor), descriptor);
  assert.throws(() => assertDocumentOcr('descriptor', { ...descriptor, appearanceCoverage: 'full' }), /INVALID/);
  assert.throws(() => assertCatalog('document-ocr-map', descriptor), /INVALID/);
});
