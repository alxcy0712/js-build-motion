import { productionHash, scriptSourceHash, shotsSourceHash, type ProductionBundle, type ProductionInit, type ProductionProposal } from '../../src/project/production.ts';

export const fixturePrompt = { timestamp: '2020-01-01T00:00:00.000Z', kind: 'prompt', text: '以“公园散步”为标题制作30秒视频，按推荐自行制作，保持原声。' };
export function productionInitFixture(): ProductionInit {
  return { version: '0.1', requested: { rawPrompt: fixturePrompt.text, sourcePrompt: { entry: 0, sha256: productionHash(fixturePrompt) },
    scenario: 'title-video', inputs: [{ inputId: 'input-title', role: 'title', text: '公园散步', file: null, catalog: null }],
    hardTargets: { durationSeconds: 30, aspect: null, fps: null, minWidth: null, minHeight: null }, originalAudio: 'preserve', approvalTasks: [] },
    effective: { goal: '记录步行中的细节', audience: '生活短片观众', style: '自然明亮', durationSeconds: 30, aspect: '16:9', fps: 30,
      originalAudio: 'preserve', preview: { width: 320, height: 180 }, delivery: { width: 1280, height: 720 }, videoLimits: null },
    decisions: [{ decisionId: 'authorization-local', kind: 'authorization', actor: 'user', sourcePrompt: { entry: 0, sha256: productionHash(fixturePrompt) }, rawText: fixturePrompt.text,
      scope: { action: 'plan', target: 'project', assetIds: [], provider: null, maxCost: 0 }, subjectHash: null, supersedes: null }] };
}
export function productionBundleFixture(): ProductionBundle {
  const i = productionInitFixture();
  const b: ProductionBundle = { version: '0.1', requirements: { requested: i.requested, effective: i.effective }, decisions: i.decisions, invalidations: [],
    script: { scriptId: 'script-main', sourceHash: '0'.repeat(64), sourceRefs: ['input-title'], lines: [
      { lineId: 'line-open', text: '走进公园，让脚步慢一点。', screenText: '让脚步慢一点', sourceRefs: ['input-title'] },
      { lineId: 'line-detail', text: '树影和微风，都是路上的小发现。', screenText: '路上的小发现', sourceRefs: ['input-title'] }] },
    shots: { sourceHash: '0'.repeat(64), items: [
      { shotId: 'shot-open', purpose: '建立散步路线', lineRefs: ['line-open'], composition: '树荫路径向远处延伸', camera: '缓慢推进', transition: 'cut',
        durationRange: { minSeconds: 12, maxSeconds: 15 }, events: [{ eventId: 'event-arrive', action: '路径和标题依次出现', lineRef: 'line-open' }] },
      { shotId: 'shot-detail', purpose: '发现沿途细节', lineRefs: ['line-detail'], composition: '树影近景接微风', camera: '轻微横移', transition: 'cut',
        durationRange: { minSeconds: 15, maxSeconds: 18 }, events: [{ eventId: 'event-shadow', action: '树影缓慢移动后停留', lineRef: 'line-detail' }] }
    ], assetPlan: { version: '0.2', kind: 'asset-plan', needs: [], uses: [] } } };
  b.script!.sourceHash = scriptSourceHash(b); b.shots!.sourceHash = shotsSourceHash(b); return b;
}
export function productionProposalFixture(revision: number, current: ProductionBundle, changes: ProductionProposal['changes']): ProductionProposal {
  return { version: '0.1', expectedRevision: revision, expectedSourceHash: productionHash(current), expectedViewHash: null, rawText: '模型按委托提交创作修订', changes, decisions: [], invalidations: [] };
}
