import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

const git = (...args) => {
  const result = spawnSync('git', args, { maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Git 检查失败：' + args[0]);
  return result.stdout;
};
const split = buffer => buffer.toString('utf8').split('\0').filter(Boolean);
const findings = [];
const report = (path, reason, line) => findings.push({ path, reason, ...(line ? { line } : {}) });
const privatePath = /(^|\/)(?:projects|node_modules|coverage|\.engine|\.skill-backups|\.git|\.pi|\.aws|\.ssh|\.kube|\.auth|\.codex|\.agents)(\/|$)|(^|\/)\.research\/out(\/|$)|(^|\/)(?:prompt-history\.jsonl|run\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json|(?:service-account|client_secret|storage-state)[^/]*\.json|id_rsa[^/]*|id_ed25519[^/]*|\.env(?:\..*)?)(?![^/])|\.(?:pem|key|p12|pfx|keystore|ttf|otf|ttc|mp4|mov|wav|m4a|mp3|log|tar\.gz)$/i;
const rules = [
  ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['GitHub 凭据', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['模型服务凭据', /\b(?:sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{32,}|pplx-[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|nvapi-[A-Za-z0-9_-]{30,})\b/g],
  ['其他服务凭据', /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|(?:sk|rk)_live_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g],
  ['AWS 凭据', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google 凭据', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack 凭据', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['URL 内嵌凭据', /(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^/\s@]+@/g],
  ['签名或认证 URL', /(?:X-Amz-Signature=|X-Goog-Signature=|[?&](?:access_token|api_key|token)=)[A-Za-z0-9%_-]{12,}/gi],
  ['Webhook 凭据', /(?:discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+|hooks\.slack\.com\/services\/[A-Za-z0-9/]+)/g],
  ['JWT 凭据', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['个人目录', /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9_.-]+/g],
  ['写入的密钥或密码', /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password)["']?\s*[:=]\s*["']?([A-Za-z0-9_+\/-]{16,})/gi],
  ['Bearer 凭据', /Bearer\s+[A-Za-z0-9_.-]{32,}/g],
];
function checkImage(path, data) {
  let valid = false;
  const metadata = [];
  const text = [data.toString('utf8')];
  if (/\.png$/i.test(path) && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8;
    while (at + 12 <= data.length) {
      const size = data.readUInt32BE(at), kind = data.toString('ascii', at + 4, at + 8);
      if (at + 12 + size > data.length) break;
      text.push(data.toString('utf8', at + 8, at + 8 + size));
      if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(kind)) metadata.push(kind);
      at += 12 + size;
      if (kind === 'IEND') { valid = size === 0 && at === data.length; break; }
    }
  } else if (/\.webp$/i.test(path) && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    let at = 12;
    while (at + 8 <= data.length) {
      const size = data.readUInt32LE(at + 4), kind = data.toString('ascii', at, at + 4);
      if (at + 8 + size > data.length) break;
      text.push(data.toString('utf8', at + 8, at + 8 + size));
      if (['EXIF', 'XMP '].includes(kind)) metadata.push(kind.trim());
      at += 8 + size + size % 2;
    }
    valid = at === data.length && data.readUInt32LE(4) + 8 === data.length;
  } else if (/\.jpe?g$/i.test(path)) {
    valid = data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && data.subarray(-2).equals(Buffer.from([255, 217]));
    if (data.includes(Buffer.from('Exif\0\0')) || data.includes(Buffer.from('http://ns.adobe.com/xap/1.0/')) || data.includes(Buffer.from('Photoshop 3.0'))) metadata.push('EXIF/XMP/IPTC');
  }
  if (!valid) report(path, '图片格式、扩展名或文件边界不符');
  if (metadata.length) report(path, '图片含待审查的文字或 EXIF/XMP/IPTC 元数据：' + [...new Set(metadata)].join(', '));
  return text.join('\n');
}
let scanned = 0;
function scan(path, data, mode = '100644') {
  scanned++;
  const sharedAsset = /^assets\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:png|webp|jpe?g|json|md|mjs|html|js|txt)$/i.test(path);
  if (!sharedAsset && !/^(?:\.skill\/|\.research\/[^/]+\.md$|\.githooks\/|(?:README|AGENTS|REVIEW)\.md$|\.gitignore$|\.env\.example$)/.test(path)) report(path, '共享范围以外的文件');
  if (privatePath.test(path) && path !== '.env.example') report(path, '本地制作内容、依赖或敏感文件');
  if (mode === '120000') report(path, '符号链接');
  if (data.length > 5 * 1024 * 1024) report(path, '超过源码共享包的 5 MiB 单文件限制');
  const assetImage = sharedAsset && /\.(?:png|webp|jpe?g)$/i.test(path);
  if (!assetImage && data.includes(0)) { report(path, '源码共享范围以外的二进制内容'); return; }
  let content;
  try { content = assetImage ? checkImage(path, data) : new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { report(path, '源码文件需要 UTF-8 编码'); return; }
  for (const [reason, pattern] of rules) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match && !(match[1] && /^(?:YOUR_|EXAMPLE_|PLACEHOLDER|CHANGEME)/i.test(match[1]))) report(path, reason, content.slice(0, match.index).split('\n').length);
  }
}
const mode = process.argv[2] || '--worktree';
try {
  if (mode === '--worktree') {
    for (const path of new Set(split(git('ls-files', '-co', '--exclude-standard', '-z')))) {
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) { report(path, '符号链接'); continue; }
      if (stat.isFile()) scan(path, readFileSync(path));
    }
  } else if (mode === '--staged') {
    for (const entry of split(git('ls-files', '--stage', '-z'))) {
      const at = entry.indexOf('\t'), header = entry.slice(0, at), path = entry.slice(at + 1);
      const [fileMode, oid, stage] = header.split(' ');
      if (stage !== '0') { report(path, '尚未解决的合并冲突'); continue; }
      scan(path, git('cat-file', 'blob', oid), fileMode);
    }
  } else if (mode === '--history' || mode === '--push') {
    const refs = mode === '--history' ? process.argv.slice(3) : [];
    if (mode === '--push') {
      for (const row of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
        const [localRef, oid, remoteRef] = row.trim().split(/\s+/);
        if (/^0+$/.test(oid)) continue;
        if (!/^refs\/(heads|tags)\//.test(remoteRef)) report(localRef, '仅允许共享分支和标签');
        refs.push(oid);
      }
    }
    if (mode === '--history' && !refs.length) refs.push('HEAD');
    if (refs.length) {
      const entries = git('rev-list', '--objects', ...refs).toString('utf8').trim().split('\n');
      for (const entry of entries) {
        const at = entry.indexOf(' '), oid = at < 0 ? entry : entry.slice(0, at), path = at < 0 ? '(blob)' : entry.slice(at + 1);
        if (git('cat-file', '-t', oid).toString().trim() === 'blob') scan(path, git('cat-file', 'blob', oid));
      }
    }
  } else throw new Error('使用 --worktree、--staged、--history [ref] 或 --push');
  console.log(JSON.stringify({ ok: findings.length === 0, mode, scanned, findings }, null, 2));
  if (findings.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
