/**
 * 命名色板（L4 风格层的具体色值）。
 *
 * 为什么是「命名色板」而不是让模型直接给颜色：
 *   弱模型写 `#3a2f6b` 这种十六进制几乎必然出错或选出难看的配色。
 *   让它从 6 个调好的色板里「选一个」则几乎不会失败（需求 §11）。
 *
 * 每个色板都提供**成对**的冷/暖区域色：
 *   室内（暖）/ 室外（冷）的对比是本项目视觉的基础，
 *   把它固化进色板可以保证无论模型怎么组合都不会出现「一片灰」。
 */

import type { Palette as PaletteName } from '../../spec/types.ts';

export interface PaletteColors {
  readonly name: PaletteName;
  /** 墙面主色（室内，暖） */
  readonly wall: string;
  /** 墙面受光处 */
  readonly wallLit: string;
  /** 地面 / 地板 */
  readonly floor: string;
  /** 家具木质 */
  readonly wood: string;
  /** 窗外天空（室外，冷） */
  readonly sky: string;
  /** 天空深处 */
  readonly skyDeep: string;
  /** 窗玻璃上的反光 */
  readonly glass: string;
  /** 雨水 */
  readonly rain: string;
  /** 灯光 / 暖光源 */
  readonly lamp: string;
  /** 点缀色（少数物体用它提亮） */
  readonly accent: string;
  /** 皮肤 */
  readonly skin: string;
  /** 头发 */
  readonly hair: string;
  /** 衣物 */
  readonly clothing: string;
  /** 描边（手绘线） */
  readonly line: string;
  /** 整体阴影叠加色 */
  readonly shadow: string;
}

export const PALETTES: Readonly<Record<PaletteName, PaletteColors>> = {
  // M0 主用：夜晚室内暖灯 + 窗外冷雨
  warm_night: {
    name: 'warm_night',
    wall: '#5c4030',
    wallLit: '#8a6242',
    floor: '#42301f',
    wood: '#6b4a2f',
    sky: '#2f3f60',
    skyDeep: '#151d33',
    glass: '#7d97bd',
    rain: '#b8ccea',
    lamp: '#ffce85',
    accent: '#e8a13c',
    skin: '#f2cda3',
    hair: '#2a1f33',
    clothing: '#dcc9a6',
    line: '#312436',
    shadow: '#1b1428',
  },

  dusk: {
    name: 'dusk',
    wall: '#6b4a52',
    wallLit: '#9c6f6f',
    floor: '#4a3138',
    wood: '#7a5340',
    sky: '#4a3a6b',
    skyDeep: '#241a3d',
    glass: '#a184b8',
    rain: '#d3c2e6',
    lamp: '#ffbd7a',
    accent: '#e0654f',
    skin: '#f0c39c',
    hair: '#2e1f2a',
    clothing: '#e3cdb4',
    line: '#2b1d2e',
    shadow: '#1d1424',
  },

  dawn: {
    name: 'dawn',
    wall: '#8a6a52',
    wallLit: '#c39a72',
    floor: '#6b4f3c',
    wood: '#8f6a48',
    sky: '#e8a978',
    skyDeep: '#7d6a9c',
    glass: '#f2c9a0',
    rain: '#ffe3c4',
    lamp: '#ffd9a0',
    accent: '#d96a4a',
    skin: '#f6d2ac',
    hair: '#3a2a2e',
    clothing: '#f0e0c8',
    line: '#3a2a28',
    shadow: '#2a1e22',
  },

  cool_blue: {
    name: 'cool_blue',
    wall: '#3f5068',
    wallLit: '#64809e',
    floor: '#33404f',
    wood: '#4e5f72',
    sky: '#6d93b8',
    skyDeep: '#2b4058',
    glass: '#9dc0dc',
    rain: '#d2e6f5',
    lamp: '#ffe0a8',
    accent: '#7fb0a8',
    skin: '#eccaa8',
    hair: '#232c3a',
    clothing: '#cdd9e4',
    line: '#1d2734',
    shadow: '#141d28',
  },

  sepia: {
    name: 'sepia',
    wall: '#8a7255',
    wallLit: '#b89b74',
    floor: '#6b5740',
    wood: '#8a6f4c',
    sky: '#a89371',
    skyDeep: '#5c4c38',
    glass: '#c4ae88',
    rain: '#e0d2b4',
    lamp: '#ffdca0',
    accent: '#a86a3c',
    skin: '#e8cba4',
    hair: '#3b2c22',
    clothing: '#ded0b4',
    line: '#33261c',
    shadow: '#241a14',
  },

  mono: {
    name: 'mono',
    wall: '#5a5a60',
    wallLit: '#82828a',
    floor: '#44444a',
    wood: '#5e5e66',
    sky: '#6e6e78',
    skyDeep: '#33333a',
    glass: '#9a9aa4',
    rain: '#d8d8de',
    lamp: '#e8e8ee',
    accent: '#a0a0a8',
    skin: '#d8d0c8',
    hair: '#2c2c32',
    clothing: '#c8c8d0',
    line: '#232328',
    shadow: '#1a1a1e',
  },
};

export function getPalette(name: PaletteName): PaletteColors {
  return PALETTES[name];
}

/** 把 hex 颜色按亮度缩放，用于派生阴影/高光。会被水彩模块复用。 */
export function shade(color: string, factor: number): string {
  const hex = color.match(/^#?([0-9a-f]{6})$/i);
  if (!hex?.[1]) return color;
  const h = hex[1];
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${f(parseInt(h.slice(0, 2), 16))},${f(parseInt(h.slice(2, 4), 16))},${f(parseInt(h.slice(4, 6), 16))})`;
}

/** 混合两个 hex 颜色，t=0 取 a，t=1 取 b */
export function mix(a: string, b: string, t: number): string {
  const pa = a.match(/^#?([0-9a-f]{6})$/i)?.[1];
  const pb = b.match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (!pa || !pb) return a;
  const g = (h: string, i: number): number => parseInt(h.slice(i, i + 2), 16);
  const out = [0, 2, 4].map((i) => Math.round(g(pa, i) + (g(pb, i) - g(pa, i)) * t));
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

/** 给颜色加 alpha */
export function alpha(color: string, a: number): string {
  const hex = color.match(/^#?([0-9a-f]{6})$/i)?.[1];
  const clamped = Math.max(0, Math.min(1, a));
  if (!hex) return color;
  return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${clamped})`;
}
