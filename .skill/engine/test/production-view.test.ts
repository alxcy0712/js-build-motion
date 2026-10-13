import test from 'node:test';
import assert from 'node:assert/strict';
import { productionBundleFixture } from './fixtures/production.ts';
import { productionHash } from '../src/project/production.ts';
import { assertProductionViewHeader, renderProductionView } from '../src/project/production-view.ts';

test('one deterministic readable view carries requested, effective, stable references, scoped decisions and completion', () => {
  const b = productionBundleFixture(), view = renderProductionView(b, 7);
  assert.equal(view.split('\n')[0], `<!-- production revision=7 sourceHash=${productionHash(b)} -->`);
  assertProductionViewHeader(view, 7, productionHash(b));
  assert.equal(renderProductionView(b, 7), view);
  for (const value of [b.requirements.requested.rawPrompt, 'Requested', 'Effective', 'line-open', 'shot-open', 'event-arrive', 'authorization-local', 'sourcePrompt', 'assetPlan', 'delivery', 'preview', 'complete']) assert.ok(view.includes(value), value);
});

test('view CAS rejects an old revision, old source hash and malformed metadata', () => {
  const b = productionBundleFixture(), view = renderProductionView(b, 1);
  assert.throws(() => assertProductionViewHeader(view, 2, productionHash(b)), /PRODUCTION_VIEW_REVISION_CONFLICT/);
  b.requirements.effective.goal = '新目标';
  assert.throws(() => assertProductionViewHeader(view, 1, productionHash(b)), /PRODUCTION_VIEW_SOURCE_CONFLICT/);
  for (const invalid of ['# 计划\n' + view, view.replace('revision=1', 'revision=0'), view.replace('sourceHash=', 'hash=')]) assert.throws(() => assertProductionViewHeader(invalid, 1, productionHash(b)), /PRODUCTION_VIEW_HEADER_INVALID/);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => renderProductionView(b, revision), /PRODUCTION_VIEW_REVISION_INVALID/);
});

test('view preserves the scope and original records for superseded authorization', () => {
  const b = productionBundleFixture(), original = b.decisions[0]!;
  b.decisions.push({ ...original, decisionId: 'authorization-narrow', supersedes: original.decisionId, scope: { ...original.scope, target: 'script' } });
  const view = renderProductionView(b, 2);
  assert.ok(view.includes('"applicability": "superseded"')); assert.ok(view.includes('"applicability": "applicable"'));
  assert.ok(view.includes('authorization-local')); assert.ok(view.includes('authorization-narrow'));
  assert.ok(view.includes('"target": "project"')); assert.ok(view.includes('"target": "script"'));
});

test('embedded fence text remains inside the derived JSON block', () => {
  const b = productionBundleFixture(); b.requirements.requested.rawPrompt += '\n```json\n示例\n```';
  const view = renderProductionView(b, 1);
  assert.match(view, /## Requested[^]*?\n\n````json\n/);
  assertProductionViewHeader(view.replaceAll('\n', '\r\n'), 1, productionHash(b));
});
