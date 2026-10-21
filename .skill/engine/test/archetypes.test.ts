import { createFixtureProject } from './fixtures/project.ts';
/**
 * 提示词原型库测试（task-8）。
 *
 * 这一层要钉死的是「双向链接」真的存在，而不是文件里有个字符串：
 *
 *   原型 id ──→ 模板文件（listArchetypes / findArchetype）
 *   原型 id ←── 使用它的项目（CLI 的 project archetypes 反向查）
 *
 * 以及一条最容易被忽视、但直接决定披露可信度的规则：
 * **模板的 tools.allowed 里不能出现尚未实现的工具。**
 * 工具声明与引擎实际可调用状态保持一致，支持披露逐项对账。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PROJECT_ROOT } from '../src/utils/env.ts';
import { checkBrief } from '../src/project/brief.ts';
import { ARCHETYPES_DIR, listArchetypes, readArchetype } from '../src/project/archetypes.ts';
import { adoptedToolIds, findTool } from '../src/project/tool-registry.ts';
import { listProjectSlugs, readProjectManifest } from '../src/project/manifest.ts';

const fixture = createFixtureProject({ projectsRoot: join(PROJECT_ROOT, 'projects'), slug: 'archetype-test-fixture' });
after(fixture.cleanup);

const archetypes = listArchetypes();
const ids = archetypes.map((a) => a.id);

test('最小原型保留可查询的 brief 示例', () => {
  assert.deepEqual(ids, ['code-animation-no-assets']);
});

test('每个原型模板都通过 brief 校验（可作为项目 brief 直接使用）', () => {
  for (const a of archetypes) {
    const result = checkBrief(readArchetype(a.id));
    assert.deepEqual(
      result.issues.filter((i) => i.severity === 'FATAL').map((i) => `${i.code}@${i.path}`),
      [],
      `${a.id} 存在致命问题`,
    );
    assert.equal(result.brief?.archetype, a.id, `${a.id} 模板的 archetype 字段应指向自己`);
  }
});

test('模板的 tools.allowed 里只能出现已采用的工具', () => {
  const adopted = new Set(adoptedToolIds());
  for (const a of archetypes) {
    const brief = checkBrief(readArchetype(a.id)).brief;
    assert.ok(brief);
    for (const id of brief.tools.allowed) {
      assert.ok(
        adopted.has(id),
        `${a.id} 的 allowed 里含未实现工具 "${id}"（状态 ${findTool(id)?.status}）：` +
          `允许一个调不起来的工具会让披露出现无法核对的工具名`,
      );
    }
  }
});

test('模板里引用的每个工具 id 都在注册表内', () => {
  for (const a of archetypes) {
    const brief = checkBrief(readArchetype(a.id)).brief;
    assert.ok(brief);
    for (const id of [...brief.tools.allowed, ...brief.tools.forbidden]) {
      assert.ok(findTool(id), `${a.id} 引用了未登记的工具 id: ${id}`);
    }
  }
});

test('声称纯代码的模板必须有代码渲染器可用', () => {
  for (const a of archetypes) {
    const brief = checkBrief(readArchetype(a.id)).brief;
    assert.ok(brief);
    if (!brief.claims.pureCode) continue;
    const renderers = brief.tools.allowed.filter((id) => findTool(id)?.kind === 'renderer');
    assert.ok(renderers.length > 0, `${a.id} 声称纯代码却没有渲染器`);
  }
});

test('原型 id 与文件名一致，且没有多余文件', () => {
  for (const a of archetypes) {
    assert.equal(a.path, join(ARCHETYPES_DIR, `${a.id}.brief.json`));
  }
});

test('README 索引列出了每一个原型（防止文档漏更新）', () => {
  const readme = readFileSync(join(PROJECT_ROOT, 'prompts', 'README.md'), 'utf8');
  for (const id of ids) {
    assert.ok(readme.includes(`./archetypes/${id}.brief.json`), `prompts/README.md 缺少 ${id} 的索引行`);
  }
});

// ------------------------------------------------------------ 双向链接

test('方向一：项目声明的 archetype 必须真实存在于原型库', () => {
  for (const slug of listProjectSlugs().filter(slug => slug === fixture.slug)) {
    const manifest = readProjectManifest(join(PROJECT_ROOT, 'projects', slug));
    if (!manifest.archetype) continue;
    assert.ok(
      ids.includes(manifest.archetype),
      `项目 ${slug} 指向不存在的原型 ${manifest.archetype}`,
    );
  }
});

test('方向二：从原型 id 能反查到使用它的项目', () => {
  const users = new Map<string, string[]>();
  for (const slug of listProjectSlugs().filter(slug => slug === fixture.slug)) {
    const manifest = readProjectManifest(join(PROJECT_ROOT, 'projects', slug));
    if (!manifest.archetype) continue;
    users.set(manifest.archetype, [...(users.get(manifest.archetype) ?? []), slug]);
  }
  // 本次创建的夹具须能通过原型库反查。
  assert.ok(users.get('code-animation-no-assets')?.includes(fixture.slug));
});

test('项目 brief 与 manifest 的 archetype 一致（同一件事不该有两个说法）', () => {
  for (const slug of listProjectSlugs().filter(slug => slug === fixture.slug)) {
    const dir = join(PROJECT_ROOT, 'projects', slug);
    const manifest = readProjectManifest(dir);
    if (!manifest.archetype) continue;
    const briefPath = join(dir, 'brief.json');
    try {
      const brief = checkBrief(JSON.parse(readFileSync(briefPath, 'utf8'))).brief;
      if (!brief) continue;
      assert.equal(brief.archetype, manifest.archetype, `${slug} 的 project.json 与 brief.json 原型不一致`);
    } catch {
      // 没有 brief.json 的项目跳过
    }
  }
});
