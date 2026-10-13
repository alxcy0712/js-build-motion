import { productionHash, type ProductionBundle } from './production.ts';
import { applicableDecisions, productionStages } from './production-policy.ts';

export function renderProductionView(bundle: ProductionBundle, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('PRODUCTION_VIEW_REVISION_INVALID');
  const applied = new Set(applicableDecisions(bundle).map(d => d.decisionId));
  const section = (title: string, value: unknown) => {
    const json = JSON.stringify(value, null, 2), fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `## ${title}\n\n${fence}json\n${json}\n${fence}\n`;
  };
  return `<!-- production revision=${revision} sourceHash=${productionHash(bundle)} -->\n# 创作计划\n\n` +
    section('阶段状态', productionStages(bundle)) + '\n' + section('Requested · 用户原文与硬目标', bundle.requirements.requested) + '\n' +
    section('Effective · 当前创作与预览／交付配置', bundle.requirements.effective) + '\n' + section('脚本与来源引用', bundle.script) + '\n' +
    section('分镜与素材选择', bundle.shots) + '\n' + (Object.hasOwn(bundle, 'timeline') ? section('固定音源与帧／样本时间线', bundle.timeline) + '\n' : '') + section('作用域决策记录', bundle.decisions.map(d => ({ ...d, applicability: applied.has(d.decisionId) ? 'applicable' : 'superseded' }))) + '\n' +
    section('当前失效原因', bundle.invalidations);
}

export function assertProductionViewHeader(text: string, revision: number, sourceHash: string): void {
  const match = /^<!-- production revision=([1-9][0-9]*) sourceHash=([a-f0-9]{64}) -->$/.exec(text.split(/\r?\n/, 1)[0]!);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error('PRODUCTION_VIEW_HEADER_INVALID');
  if (Number(match[1]) !== revision) throw Error('PRODUCTION_VIEW_REVISION_CONFLICT');
  if (match[2] !== sourceHash) throw Error('PRODUCTION_VIEW_SOURCE_CONFLICT');
}
