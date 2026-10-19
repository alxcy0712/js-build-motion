/**
 * 字体注册与回退检测。注册顺序：engine/assets/fonts（随核心打包，优先）→ 系统路径。
 * 回退检测：同一样张分别用目标字体与不存在的字体测宽，宽度相同即判定为回退（字体未生效或缺字）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { ThemeTokens } from './types.ts';
import type { CanvasRenderingContext2D } from 'skia-canvas';

export interface FontLibraryLike { use(family: string, files: string[]): unknown; has?(family: string): boolean; readonly families?: readonly string[] }
export interface MeasureCtx { font: string; measureText(s: string): { width: number } }
export interface FontReport { family: string; file: string | null; registered: boolean }
export interface FontUsage {
  registered: { family: string; absPath: string; registered: boolean }[];
  families: string[];
}

/** 当前平台的系统字体目录（不存在的目录在扫描时自动跳过）。$JBM_FONT_DIRS 可追加自定义目录，优先于系统目录。 */
export function systemFontDirs(os: NodeJS.Platform = platform(), env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const extra = (env.JBM_FONT_DIRS ?? '').split(delimiter).filter(Boolean);
  const byOs: Record<string, string[]> = {
    darwin: ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(home, 'Library/Fonts')],
    linux: [join(home, '.local/share/fonts'), join(home, '.fonts'), '/usr/local/share/fonts', '/usr/share/fonts'],
    win32: [join(env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts')],
  };
  return [...extra, ...(byOs[os] ?? byOs.linux)];
}
const FONT_EXT = /\.(ttf|otf|ttc)$/i;
const indexCache = new Map<string, Map<string, string>>();
/** 递归（限深 5 层）建立「小写文件名 → 绝对路径」索引；每个目录只扫描一次。 */
export function indexFontDir(dir: string, depth = 5): Map<string, string> {
  const hit = indexCache.get(dir); if (hit) return hit;
  const out = new Map<string, string>();
  const walk = (d: string, left: number): void => {
    let names: string[]; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (left > 0) walk(p, left - 1); }
      else if (FONT_EXT.test(n) && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), p);
    }
  };
  walk(dir, depth); indexCache.set(dir, out); return out;
}
/**
 * 按文件名解析字体：bundled fontsDir（直接拼接）→ searchDirs（索引查找）。
 * 兼容旧写法 'fonts/x.ttf' 与绝对路径（存在才用）。
 */
export function resolveFontFile(file: string, fontsDir: string, searchDirs: readonly string[] = systemFontDirs()): string | null {
  if (isAbsolute(file)) return existsSync(file) ? file : null;
  const name = basename(file);
  const bundled = join(fontsDir, name);
  if (existsSync(bundled)) return bundled;
  for (const d of searchDirs) { const p = indexFontDir(d).get(name.toLowerCase()); if (p) return p; }
  return null;
}
/** 对一个字族，先在所有目录中找第一候选，再找第二候选……（候选顺序优先于目录顺序之外的 bundled 目录）。 */
export function resolveFace(files: readonly string[], fontsDir: string, searchDirs: readonly string[] = systemFontDirs()): string | null {
  for (const f of files) { const p = resolveFontFile(f, fontsDir, searchDirs); if (p) return p; }
  return null;
}
const registered = new WeakMap<object, Map<string, string>>();
export function registerThemeFonts(theme: ThemeTokens, lib: FontLibraryLike, fontsDir: string): FontReport[] {
  return theme.fonts.faces.map((face) => {
    const file = resolveFace(face.files, fontsDir, face.bundled ? [] : systemFontDirs());
    // 已注册的字族不重复加载：CJK 字体文件 20MB 级，每个渲染器重复注册会迅速耗尽内存
    const already = registered.get(lib)?.get(face.family) === file && (lib.has?.(face.family) ?? lib.families?.includes(face.family) ?? true);
    if (file && !already) { lib.use(face.family, [file]); if (!registered.has(lib)) registered.set(lib, new Map()); registered.get(lib)!.set(face.family, file); }
    return { family: face.family, file, registered: Boolean(file) };
  });
}

/** 从实际文字绘制的 Skia 字形 run 读取命中字族，包含逐字回退。每个 context 安装一次。 */
export function trackFontUsage(ctx: CanvasRenderingContext2D, families: Set<string>): void {
  for (const method of ['fillText', 'strokeText'] as const) {
    const original = ctx[method].bind(ctx);
    ctx[method] = (text, x, y, maxWidth) => {
      original(text, x, y, maxWidth);
      if (ctx.globalAlpha <= 0 || !String(text).trim()) return;
      for (const line of ctx.measureText(text, maxWidth).lines) for (const run of line.runs) families.add(run.family);
    };
  }
}
const MISSING = '__jbm_missing_font__';
export function detectFallback(ctx: MeasureCtx, family: string, probe: string, size = 64): boolean {
  ctx.font = `${size}px "${family}"`; const a = ctx.measureText(probe).width;
  ctx.font = `${size}px "${MISSING}"`; const b = ctx.measureText(probe).width;
  return Math.abs(a - b) < 0.01;
}
/** 严格模式：任一必需字体缺失或回退即抛错，避免不同机器出不同字形。 */
export function assertThemeFonts(theme: ThemeTokens, lib: FontLibraryLike, ctx: MeasureCtx, fontsDir: string, { strict = true } = {}): FontReport[] {
  const report = registerThemeFonts(theme, lib, fontsDir);
  const problems: string[] = [];
  for (const r of report) {
    if (!r.registered) problems.push(`${r.family}: 找不到字体文件`);
    else if (detectFallback(ctx, r.family, /CJK|SC/.test(r.family) ? theme.fonts.probe.replace(/[A-Za-z0-9]/g, '') : 'Hamburgefonstiv0123')) problems.push(`${r.family}: 已注册但渲染回退`);
  }
  if (problems.length && strict) throw new Error(`FONT_FALLBACK ${theme.id}: ${problems.join('；')}`);
  return report;
}
export function cssFontStack(families: readonly string[]): string {
  return [...families.map((f) => `"${f}"`), 'sans-serif'].join(', ');
}
