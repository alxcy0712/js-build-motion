import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EngineError } from '../utils/errors.ts';
import { checkEnvironment, listProjectFontFiles, resolveFontFamily } from '../utils/env.ts';
import { frameCount } from '../timeline/frame.ts';
import type { Issue } from '../spec/repair.ts';
import { loadSpecFile, summarizeIssues, validateSpec } from '../spec/validate.ts';
import { resolveTarget } from '../project/manifest.ts';
import { requireTarget } from './shared.ts';

export function cmdEnv(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, 'out-dir': { type: 'string' } },
    allowPositionals: true,
  });
  const report = checkEnvironment({ checkOutput: true, ...(values['out-dir'] ? { outDir: values['out-dir'] } : {}) });

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }

  const mark = (b: boolean): string => (b ? '\u2713' : '\u2717');
  const line = (label: string, value: string): string => `  ${label.padEnd(22)} ${value}`;
  const out: string[] = ['环境报告', ''];

  out.push(line('Node', `${report.node.version} ${mark(report.node.supported)} (需要 ${report.node.required})`));
  out.push(line('ffmpeg', report.ffmpeg.available ? `${report.ffmpeg.version} ${mark(true)}` : `未找到 ${mark(false)}`));
  out.push(line('ffprobe', report.ffprobe.available ? `${report.ffprobe.version} ${mark(true)}` : `未找到 ${mark(false)}`));

  if (report.ffmpeg.available) {
    const enc = Object.entries(report.ffmpeg.encoders).map(([k, v]) => `${k}${mark(v)}`).join('  ');
    out.push(line('视频编码器', enc));
    const missing = Object.entries(report.ffmpeg.audioFilters).filter(([, v]) => !v).map(([k]) => k);
    out.push(line('音频滤镜', missing.length === 0 ? `全部就绪 ${mark(true)}` : `缺失: ${missing.join(', ')} ${mark(false)}`));
  }

  const f = report.fonts;
  out.push(line('项目字体', `${f.family}`));
  out.push(line('  字体文件', f.fileExists ? `${f.filePath} ${mark(true)}` : `缺失 ${mark(false)}`));
  out.push(line('  注册状态', f.registered ? `已注册 ${mark(true)}` : `未注册 ${mark(false)}`));
  out.push(line('  实际使用', resolveFontFamily(f.registered)));
  const extra = listProjectFontFiles();
  if (extra.length) out.push(line('  assets/fonts', extra.join(', ')));

  // 语音链路：新用户最容易被它坑——缺 python/edge-tts 时渲染"成功"但没真人配音
  const t = report.tts;
  const ttsMark = t.effective === 'edge' ? mark(true) : t.effective === 'file' ? '~' : '!';
  out.push(line('语音 provider', `${t.effective} ${ttsMark}`));
  out.push(
    line(
      '  edge-tts',
      t.edge.available ? `可用（${t.edge.python}）${mark(true)}` : `不可用：${t.edge.reason ?? '未知'} ${mark(false)}`,
    ),
  );
  out.push(line('  预制配音', t.voiceAsset.exists ? `存在 ${mark(true)}` : '不存在（file provider 不可用）'));
  if (t.effective !== 'edge') out.push(line('  修复建议', t.fixHint));

  out.push(line('非项目产物目录', `${report.paths.outDir} ${mark(report.paths.outWritable)}`));

  if (report.warnings.length) {
    out.push('', '警告:');
    for (const w of report.warnings) out.push(`  ! ${w}`);
  }
  if (report.errors.length) {
    out.push('', '错误:');
    for (const e of report.errors) out.push(`  \u2717 ${e}`);
  }

  out.push('', report.ok ? '环境检查通过。' : '环境检查未通过。');
  process.stdout.write(out.join('\n') + '\n');
  return report.ok ? 0 : 1;
}

// ------------------------------------------------------- 尚未实现的命令
export async function cmdValidate(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const { specPath } = resolveTarget(requireTarget(positionals, 'validate'));
  const raw = loadSpecFile(specPath);

  if (values.json) {
    try {
      const outcome = validateSpec(raw);
      process.stdout.write(JSON.stringify(serializeOutcome(specPath, outcome), null, 2) + '\n');
      return outcome.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof EngineError) {
        process.stdout.write(
          JSON.stringify(
            { ok: false, spec: specPath, code: err.code, message: err.message, ...err.toJSON() },
            null,
            2,
          ) + '\n',
        );
        return 1;
      }
      throw err;
    }
  }

  process.stdout.write(`校验 ${specPath}\n\n`);

  let outcome;
  try {
    outcome = validateSpec(raw);
  } catch (err) {
    if (err instanceof EngineError) {
      process.stdout.write(err.toLLMString() + '\n');
      return 1;
    }
    throw err;
  }

  printIssues(outcome.issues);

  const spec = outcome.spec;
  if (!spec) return 1;
  const frames = frameCount(spec.video.fps, spec.video.duration);
  const { width, height, fps, duration, seed } = spec.video;
  process.stdout.write(
    [
      `可渲染  ${width}x${height} @${fps}fps  ${duration}s (${frames} 帧)  seed=${seed}`,
      `        ${spec.scenes.length} 个场景  ` +
        `${spec.audio.narration.length} 条旁白  ${spec.audio.sfx.length} 个音效`,
      `        风格 ${spec.style.preset} / ${spec.style.palette} / ${spec.style.paper} / ${spec.style.line}`,
      `        字幕 ${spec.captions.enabled ? `开（${spec.captions.style}, ${spec.captions.mode}）` : '关'}`,
      `\n${summarizeIssues(outcome.issues)}`,
    ].join('\n') + '\n',
  );
  return 0;
}
function serializeOutcome(specPath: string, outcome: ReturnType<typeof validateSpec>): unknown {
  return {
    ok: outcome.ok,
    spec: specPath,
    counts: outcome.counts,
    schemaErrors: outcome.schemaErrors,
    issues: outcome.issues,
    resolved: outcome.spec,
  };
}

/** 按严重度分组打印，并按「是否可自动修复」排序，让弱模型先看到能自己改的那批 */
export function printIssues(issues: readonly Issue[]): void {
  if (issues.length === 0) {
    process.stdout.write('Schema 校验通过，无需修复。\n\n');
    return;
  }

  const groups: ReadonlyArray<readonly [string, string]> = [
    ['FATAL', '致命（必须修）'],
    ['WARNING', '警告（已降级处理，建议确认）'],
    ['SAFE_REPAIR', '自动修复（无需理会）'],
  ];

  for (const [severity, label] of groups) {
    const list = issues.filter((i) => i.severity === severity);
    if (list.length === 0) continue;
    process.stdout.write(`${label}  (${list.length})\n`);
    for (const i of list) {
      process.stdout.write(`  ${i.path || '(根)'}  ${i.code}\n`);
      process.stdout.write(`    ${i.message}\n`);
      if (i.allowed?.length) process.stdout.write(`    允许: ${i.allowed.join(' | ')}\n`);
      if (i.hint) process.stdout.write(`    建议: ${i.hint}\n`);
    }
    process.stdout.write('\n');
  }
}
