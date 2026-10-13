/**
 * VideoSpec 校验编排（需求 §13、§42）。
 *
 * 流程刻意是「先宽松收集，再修复，最后复核」：
 *
 *   1. 用 ajv 验证**原始输入** —— 目的不是拦截，而是把问题列清楚给模型看
 *   2. 交给 repair 层做确定性修复（三级分类）
 *   3. 用 ajv **复核修复后的结果** —— 若仍不合法，说明修复层有漏洞
 *      （而不是模型的问题），直接判 FATAL 而不是带着坏数据去渲染
 *
 * 第 3 步是这个模块存在的主要理由：它把「修复是否收敛到 schema 合法」
 * 变成了一个可断言的性质，而不是一句承诺。
 */

import { readFileSync } from 'node:fs';

import { Ajv, type ValidateFunction } from 'ajv';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { repairSpec, type Issue } from './repair.ts';
import { VIDEO_SPEC_SCHEMA } from './schema.ts';
import type { ResolvedVideoSpec } from './types.ts';

export interface ValidationOutcome {
  readonly ok: boolean;
  /** 仅在 ok 为 true 时有值 */
  readonly spec: ResolvedVideoSpec | null;
  /** 修复/告警/致命问题（已按严重度分级） */
  readonly issues: readonly Issue[];
  /** 针对原始输入的 schema 错误（纯诊断，不决定成败） */
  readonly schemaErrors: readonly string[];
  readonly counts: { readonly safeRepair: number; readonly warning: number; readonly fatal: number };
}

/**
 * ajv 实例。
 *
 * `strict: false` 是有意的：schema 是手写的，我们只用到标准关键字，
 * 而 strict 模式对 `$id`、未使用的定义等琐事报错会淹没有效信息。
 * schema 自身的正确性由 test/spec.test.ts 用脏输入覆盖。
 */
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });

let compiled: ValidateFunction | null = null;
function validator(): ValidateFunction {
  // 用局部变量而不是直接 `??=`：闭包会改动 compiled，TS 无法对模块级变量保持收窄
  let v = compiled;
  if (!v) {
    v = ajv.compile(VIDEO_SPEC_SCHEMA);
    compiled = v;
  }
  return v;
}

function countIssues(issues: readonly Issue[]): ValidationOutcome['counts'] {
  let safeRepair = 0;
  let warning = 0;
  let fatal = 0;
  for (const i of issues) {
    if (i.severity === 'SAFE_REPAIR') safeRepair++;
    else if (i.severity === 'WARNING') warning++;
    else fatal++;
  }
  return { safeRepair, warning, fatal };
}

/**
 * 校验并修复任意输入。
 *
 * 注意：FATAL 会抛 EngineError；调用方若想拿到 issues 列表做展示，
 * 应捕获它并读取 `err.details.issues`。
 */
export function validateSpec(raw: unknown): ValidationOutcome {
  const validate = validator();
  const schemaErrors = collectSchemaErrors(validate, raw);

  const { spec, issues } = repairSpec(raw);

  // --- 复核：修复结果必须能通过 schema ---
  const residual = collectSchemaErrors(validate, spec);
  if (residual.length > 0) {
    throw new EngineError(
      ERROR_CODES.SPEC_INVALID,
      `修复后的 VideoSpec 仍不合法——这是引擎修复层的缺陷，请报告`,
      {
        details: {
          residualSchemaErrors: residual,
          repairsApplied: issues.map((i) => `${i.severity} ${i.code} @ ${i.path}`),
        },
        hint: '这不是模型的问题；等价于引擎未覆盖到该输入形态',
      },
    );
  }

  const counts = countIssues(issues);
  return { ok: counts.fatal === 0, spec, issues, schemaErrors, counts };
}

/** 从文件读取并解析 VideoSpec。读取/解析失败抛 SPEC_UNREADABLE。 */
export function loadSpecFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new EngineError(ERROR_CODES.SPEC_UNREADABLE, `无法读取 spec 文件: ${path}`, {
      cause: err,
      hint: '确认路径正确，且文件存在',
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new EngineError(ERROR_CODES.SPEC_UNREADABLE, `spec 不是合法 JSON: ${path}`, {
      details: { reason: err instanceof Error ? err.message : String(err) },
      hint: '检查是否有尾随逗号、注释或未转义的引号',
    });
  }
}

/** 一行式摘要，供 CLI 与日志使用 */
export function summarizeIssues(issues: readonly Issue[]): string {
  const c = countIssues(issues);
  const parts: string[] = [];
  if (c.safeRepair) parts.push(`${c.safeRepair} 处自动修复`);
  if (c.warning) parts.push(`${c.warning} 处警告`);
  if (c.fatal) parts.push(`${c.fatal} 处致命`);
  return parts.length ? parts.join('，') : '无问题';
}
