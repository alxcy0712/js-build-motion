import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineArguments, importCommandOptions, importSourceArguments } from '../workspace.mjs';

test('local review and delivery retain the fixed project and production input boundary', () => {
  for (const command of ['review', 'credits', 'deliver']) {
    const args = [command, '--request', 'evidence/request.json'];
    assert.deepEqual(engineArguments('/fixture/project', args), [command, '/fixture/project', ...args.slice(1)]);
    assert.deepEqual(importCommandOptions(args), { importOnly: true, catalogOnly: true, productionOnly: true, deliveryOnly: true });
    assert.throws(() => importCommandOptions([command, '--source', '/other-film']), /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  }
});

test('video resource policy reaches preparation and verification through the unified entry', () => {
  for (const operation of ['request', 'verify']) {
    const args = ['video', `--${operation}`, 'inputs/fixture.json', '--limits', 'inputs/resource-policy.json'];
    assert.deepEqual(importCommandOptions(args), { importOnly: true, catalogOnly: true, videoOnly: true });
  }
  assert.throws(() => importCommandOptions(['video', '--request', 'inputs/fixture.json', '--limits']), /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/);
});

test('固定影片入口注入 audio lock 子命令的目标，并保留普通 audio 和 lock 片名', () => {
  const project = '/fixture/projects/lock';
  assert.deepEqual(engineArguments(project, ['audio', 'lock', '--tts-provider', 'file', '--no-network']), ['audio', 'lock', project, '--tts-provider', 'file', '--no-network']);
  assert.deepEqual(engineArguments(project, ['audio', '--tts-provider', 'file']), ['audio', project, '--tts-provider', 'file']);
  assert.deepEqual(engineArguments(project, ['render', '--audio-lock', 'assets/derived/audio/id/audio-lock.json']), ['render', project, '--audio-lock', 'assets/derived/audio/id/audio-lock.json']);
});

test('导入入口注入项目并保持空格、引号与 shell 字符的参数原文', () => {
  const project = '/fixture/projects/import';
  const source = "/fixture/selected notes 'quoted' $(literal).txt";
  assert.deepEqual(engineArguments(project, ['import', '--source', source]), ['import', project, '--source', source]);
  assert.deepEqual(engineArguments(project, ['import', '--verify', 'import-fixture']), ['import', project, '--verify', 'import-fixture']);
  assert.deepEqual(engineArguments(project, ['import', '--schema', 'manifest']), ['import', project, '--schema', 'manifest']);
  assert.deepEqual(importSourceArguments(['import', '--source', "../selected notes 'quoted' $(literal).txt"], '/fixture/projects'), ['import', '--source', source]);
  assert.deepEqual(importSourceArguments(['import', '--source=../selected notes.txt'], '/fixture/projects'), ['import', '--source=/fixture/selected notes.txt']);
  assert.deepEqual(importSourceArguments(['import', '--verify=--source=literal'], '/fixture/projects'), ['import', '--verify=--source=literal']);
  const repeated = importSourceArguments(['import', '--source', 'first.txt', '--source=last.txt'], '/fixture');
  assert.deepEqual(repeated, ['import', '--source', '/fixture/first.txt', '--source=/fixture/last.txt']);
  assert.deepEqual(importCommandOptions(repeated), { importOnly: true, readSource: '/fixture/last.txt' });
  assert.deepEqual(importSourceArguments(['import', '--source', ''], '/fixture'), ['import', '--source', '']);
  assert.deepEqual(importCommandOptions(['import', '--source', source]), { importOnly: true, readSource: source });
  assert.deepEqual(importCommandOptions(['import', '--verify', 'import-fixture']), { importOnly: true });
  assert.deepEqual(importCommandOptions(['render']), {});
  assert.throws(() => importCommandOptions(['import', '--source']), /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/);
});


test('展开入口保留本片原件选择参数并采用离线、原件只读边界', () => {
  const project = '/fixture/projects/film';
  const args = ['unpack', '--import', 'import-fixture', '--path', "notes 'quoted' $(literal).zip"];
  assert.deepEqual(engineArguments(project, args), ['unpack', project, ...args.slice(1)]);
  assert.deepEqual(importSourceArguments(args, '/fixture'), args);
  assert.deepEqual(importCommandOptions(args), { importOnly: true, unpackOnly: true });
  assert.deepEqual(importCommandOptions(['unpack', '--verify', 'unpack-fixture']), { importOnly: true, unpackOnly: true });
  assert.throws(() => importCommandOptions(['unpack', '--source', '/fixture/selected.zip']), /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});

test('catalog forwarding and offline options remain in the bound runtime', () => {
  assert.deepEqual(importCommandOptions(['catalog', '--import', 'id', '--path', 'notes.txt']), { importOnly: true, catalogOnly: true });
  assert.deepEqual(engineArguments('/film', ['catalog', '--schema', 'rights']), ['catalog', '/film', '--schema', 'rights']);
  assert.throws(() => importCommandOptions(['catalog', '--source', '/outside']), /Unknown option/);
});


test('production CAS options and subcommands reach the fixed project boundary', () => {
  const project = '/fixture/projects/film';
  for (const op of ['init', 'next', 'apply', 'resume', 'invalidate', 'view', 'compile']) {
    assert.deepEqual(engineArguments(project, ['production', op]), ['production', project, op]);
  }
  const args = ['production', 'invalidate', '--expected-revision', '3', '--source-hash', 'a'.repeat(64), '--key', 'line:line-open', '--reason', '用户修改'];
  assert.deepEqual(engineArguments(project, args), ['production', project, ...args.slice(1)]);
  assert.deepEqual(importCommandOptions(args), { importOnly: true, catalogOnly: true, productionOnly: true });
  for (const profile of ['rough', 'final']) {
    const compile = ['production', 'compile', '--profile', profile];
    assert.deepEqual(engineArguments(project, compile), ['production', project, ...compile.slice(1)]);
    assert.deepEqual(importCommandOptions(compile), { importOnly: true, catalogOnly: true, productionOnly: true, productionCompile: true });
  }
  assert.throws(() => importCommandOptions(['production', 'compile', '--profile']), /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/);
  assert.throws(() => importCommandOptions(['production', 'init', '--source', '/other-film']), /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  assert.throws(() => importCommandOptions(['production', 'apply', '--proposal']), /ERR_PARSE_ARGS_INVALID_OPTION_VALUE/);
});
