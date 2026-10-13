/**
 * JSON Schema 错误格式化（需求 §42）。
 *
 * 为什么单独一个模块：VideoSpec、project manifest、brief 三份 schema
 * 必须给出**同一种**错误语言。弱模型自修的前提是「错误长什么样」到处一致，
 * 而不是每个校验器各写一套中文。
 *
 * 输出刻意只保留「位置 + 实际值 + 允许值」，不带堆栈、不带 ajv 原始对象。
 */

import type { ErrorObject, ValidateFunction } from 'ajv';

/** 把 ajv 的 ErrorObject 变成弱模型能直接照做的中文说明 */
export function formatSchemaError(e: ErrorObject): string {
  const path = e.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(根)';
  const params = e.params as Record<string, unknown>;

  if (e.keyword === 'enum' && Array.isArray(params['allowedValues'])) {
    return `${path}: 取值 "${String(
      (e as unknown as { data?: unknown }).data,
    )}" 不受支持。允许: ${(params['allowedValues'] as unknown[]).join(' | ')}`;
  }
  if (e.keyword === 'additionalProperties') {
    return `${path}: 出现未知字段 "${String(params['additionalProperty'])}"，请删除或改用允许的字段`;
  }
  if (e.keyword === 'required') {
    return `${path}: 缺少必填字段 "${String(params['missingProperty'])}"`;
  }
  if (e.keyword === 'type') {
    return `${path}: 类型应为 ${String(params['type'])}，实际是 ${describeType(
      (e as unknown as { data?: unknown }).data,
    )}`;
  }
  if (e.keyword === 'minimum' || e.keyword === 'maximum' || e.keyword === 'exclusiveMinimum') {
    return `${path}: ${e.message ?? '超出取值范围'} (${String(params['limit'] ?? '')})`;
  }
  if (e.keyword === 'pattern') {
    return `${path}: 取值 "${String(
      (e as unknown as { data?: unknown }).data,
    )}" 不匹配要求 ${JSON.stringify(String(params['pattern'] ?? ''))}`;
  }
  return `${path}: ${e.message ?? '不合法'}`;
}

/** 供错误信息复用的类型描述：null / array 都需要单独说清 */
export function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 校验并按格式返回全部错误（空数组代表通过） */
export function collectSchemaErrors(validate: ValidateFunction, data: unknown): string[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map(formatSchemaError);
}
