import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertContained } from './paths.ts';
import { sha256File } from '../utils/hash.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';

export const PROMPT_HISTORY_FILE = 'prompt-history.jsonl';
export const PROMPT_KINDS = ['prompt', 'question', 'answer'] as const;
export interface PromptEntry {
  readonly timestamp: string;
  readonly kind: typeof PROMPT_KINDS[number];
  readonly text: string;
}
export interface PromptHistorySnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly entries: number;
}

function historyPath(dir: string): string {
  const path = assertContained(dir, join(dir, PROMPT_HISTORY_FILE));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new EngineError(ERROR_CODES.PROJECT_ISOLATION_VIOLATION, '提示词记录须为本片独立文件');
    }
  }
  return path;
}

export function readPromptHistory(dir: string): PromptEntry[] {
  const path = historyPath(dir);
  if (!existsSync(path)) return [];
  const entries: PromptEntry[] = [];
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: PromptEntry;
    try { entry = JSON.parse(line); } catch {
      throw new EngineError(ERROR_CODES.PROJECT_INVALID, `提示词记录第 ${index + 1} 行 JSON 无效`);
    }
    if (!entry || !PROMPT_KINDS.includes(entry.kind) || typeof entry.text !== 'string' || !entry.text.trim() ||
        typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new EngineError(ERROR_CODES.PROJECT_INVALID, `提示词记录第 ${index + 1} 行结构无效`);
    }
    entries.push(entry);
  }
  if (entries.length && entries[0]!.kind !== 'prompt') {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, '提示词记录首条须为原始 prompt');
  }
  return entries;
}

/** Preserve the submitted text verbatim; later inputs only append new entries. */
export function appendPromptHistory(dir: string, kind: string, text: string): PromptEntry {
  if (!PROMPT_KINDS.includes(kind as PromptEntry['kind']) || typeof text !== 'string' || !text.trim()) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '记录需要 kind: prompt/question/answer 与非空原文');
  }
  if (!readPromptHistory(dir).length && kind !== 'prompt') {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, '先记录已核实的原始 prompt，再追加问答');
  }
  const entry: PromptEntry = { timestamp: new Date().toISOString(), kind: kind as PromptEntry['kind'], text };
  const path = historyPath(dir);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = previous.length && !previous.endsWith('\n') ? '\n' : '';
  appendFileSync(path, prefix + JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export function promptHistorySnapshot(dir: string): PromptHistorySnapshot | undefined {
  const entries = readPromptHistory(dir);
  return entries.length ? { path: PROMPT_HISTORY_FILE, sha256: sha256File(historyPath(dir)), entries: entries.length } : undefined;
}
