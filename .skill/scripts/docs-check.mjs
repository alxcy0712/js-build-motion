import { GUIDE_FILES } from './guide-files.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stripCode = text => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
const slug = text => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');

function anchors(text) {
  const found = new Set(), counts = new Map();
  for (const match of stripCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = slug(match[1]), count = counts.get(base) ?? 0;
    found.add(count ? `${base}-${count}` : base);
    counts.set(base, count + 1);
  }
  return found;
}

/** Check inline local Markdown links against source files or a projected project snapshot. */
export function inspectLinks(documents, { exists = existsSync, read = path => readFileSync(path, 'utf8'), allowed = () => true } = {}) {
  const issues = []; let links = 0;
  for (const [source, text] of documents) {
    for (const match of stripCode(text).matchAll(/\[[^\]\n]+\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const url = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
      links++;
      let path, anchor;
      try { [path, anchor] = url.split('#').map(decodeURIComponent); }
      catch { issues.push({ source, url, reason: 'invalid-encoding' }); continue; }
      const target = path ? resolve(dirname(source), path) : source;
      let reason;
      if (!allowed(target)) reason = 'outside-document-scope';
      else if (!documents.has(target) && !exists(target)) reason = 'missing-file';
      else if (anchor && target.endsWith('.md') && !anchors(documents.get(target) ?? read(target)).has(anchor)) reason = 'missing-anchor';
      if (reason) issues.push({ source, url, reason });
    }
  }
  return { documents: documents.size, links, issues };
}

function markdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.research', 'projects', 'out', '.git'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? markdown(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

export function checkDocs() {
  const template = join(root, '.skill/assets/project');
  const files = [...['README.md', 'AGENTS.md', 'REVIEW.md'].map(name => join(root, name)),
    ...markdown(join(root, '.research')), ...markdown(join(root, 'assets')), ...markdown(join(root, '.skill'))]
    .filter(path => existsSync(path) && !path.startsWith(template + sep));
  const source = new Map(files.map(path => [path, readFileSync(path, 'utf8')]));
  const sources = inspectLinks(source, { allowed: path => !relative(root, path).startsWith('projects' + sep) });
  const project = join(root, '.research/out/document-projection');
  const guides = GUIDE_FILES.map(name => join(root, '.skill/references', name)).map(path => [join(project, 'guide', relative(join(root, '.skill/references'), path)), readFileSync(path, 'utf8')]);
  const templates = markdown(template).map(path => [join(project, relative(template, path)), readFileSync(path, 'utf8')]);
  const snapshot = inspectLinks(new Map([...guides, ...templates]), { exists: () => false,
    allowed: path => path.startsWith(project + sep) });
  const issues = [...sources.issues, ...snapshot.issues].map(issue => ({ ...issue, source: relative(root, issue.source) }));
  if (issues.length) throw new Error(`DOCUMENT_LINKS_INVALID: ${JSON.stringify(issues)}`);
  return { ok: true, sourceDocuments: sources.documents, sourceLinks: sources.links,
    snapshotDocuments: snapshot.documents, snapshotLinks: snapshot.links };
}
