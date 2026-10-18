import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLinks } from '../../scripts/docs-check.mjs';

test('文档链接：中文标题、重复锚点和带空格路径可以解析', () => {
  const docs = new Map([
    ['/docs/start.md', '[主线](guide.md#创作主线) [再次](guide.md#创作主线-1) [空格](<sample file.md>)'],
    ['/docs/guide.md', '# 创作主线\n## 创作主线\n'],
    ['/docs/sample file.md', '# 样例'],
  ]);
  assert.deepEqual(inspectLinks(docs), { documents: 3, links: 3, issues: [] });
});

test('文档链接：报告缺失文件、锚点和已存在的越界目标', () => {
  const docs = new Map([
    ['/docs/start.md', '[丢失](gone.md) [标题](guide.md#missing) [生成区](/projects/film/notes.md)'],
    ['/docs/guide.md', '# 正文'],
  ]);
  const result = inspectLinks(docs, { exists: () => false, allowed: (path: string) => path.startsWith('/docs/') });
  assert.deepEqual(result.issues.map((issue: { reason: string }) => issue.reason), ['missing-file', 'missing-anchor', 'outside-document-scope']);
});

test('新片快照：根入口链接到 guide，guide 的仓库相对链接会被拦截', () => {
  const docs = new Map([
    ['/film/AGENTS.md', '[主线](guide/motion.md#创作主线)'],
    ['/film/guide/motion.md', '# 创作主线\n[旧封面路径](../../assets/cover.md)'],
  ]);
  const result = inspectLinks(docs, { exists: () => true, allowed: (path: string) => path.startsWith('/film/') });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].reason, 'outside-document-scope');
});

test('文档链接：外部 URL 和代码示例独立于本地路径校验', () => {
  const text = '[外部](https://example.com/missing)\n```md\n[示例](missing.md)\n```\n[坏转义](broken%xx.md)';
  const result = inspectLinks(new Map([['/docs/start.md', text]]), { exists: () => false });
  assert.equal(result.links, 1);
  assert.equal(result.issues[0].reason, 'invalid-encoding');
});
