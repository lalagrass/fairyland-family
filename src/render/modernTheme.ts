/**
 * F13b：現代地圖的配色 token。畫面只讀這些顏色，不載入素材。
 * 預設值與 F13 的固定色相同；高對比是另一組 token。CSS 變數可覆寫。
 */
export type MapThemePreset = 'default' | 'high-contrast';

export interface ThemeColor {
  css: string;
  hex: number;
  rgba: readonly [number, number, number, number];
  alpha: number;
}

export interface ModernMapTheme {
  preset: MapThemePreset;
  key: string;
  bg: ThemeColor;
  walk: ThemeColor;
  block: ThemeColor;
  grid: ThemeColor;
  border: ThemeColor;
  member: ThemeColor;
  memberTarget: ThemeColor;
  npc: ThemeColor;
  shop: ThemeColor;
  exit: ThemeColor;
  exitUnimported: ThemeColor;
  gather: ThemeColor;
  routeWalk: ThemeColor;
  routeDest: ThemeColor;
  labelFg: ThemeColor;
  miniBg: ThemeColor;
  miniBorder: ThemeColor;
  miniView: ThemeColor;
}

interface KvStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export const MAP_THEME_STORAGE_KEY = 'fairyland_family:modern_map_theme:v1';

export const DEFAULT_MAP_THEME_TOKENS = {
  bg: '#0e1520',
  walk: '#1e4a3a',
  block: '#0e141e',
  grid: '#22344a',
  border: '#35506b',
  member: '#5fd0ff',
  memberTarget: '#ffffff',
  npc: '#f2c14e',
  shop: '#ff9a5c',
  exit: '#8be28b',
  exitUnimported: '#8b99ab',
  gather: '#b08cff',
  routeWalk: '#5fd0ff',
  routeDest: '#ffffff',
  labelFg: '#e8eef6',
  miniBg: 'rgba(10, 16, 24, 0.84)',
  miniBorder: '#5a7391',
  miniView: '#ffffff',
} as const;

export const HIGH_CONTRAST_MAP_THEME_TOKENS = {
  bg: '#05070b',
  walk: '#1a3a2f',
  block: '#020408',
  grid: '#3b5570',
  border: '#9bc4f0',
  member: '#00e5ff',
  memberTarget: '#ffffff',
  npc: '#ffd400',
  shop: '#ff7b00',
  exit: '#3dff7a',
  exitUnimported: '#ff6b6b',
  gather: '#cf99ff',
  routeWalk: '#00e5ff',
  routeDest: '#ffffff',
  labelFg: '#ffffff',
  miniBg: 'rgba(0, 0, 0, 0.92)',
  miniBorder: '#9bc4f0',
  miniView: '#ffffff',
} as const;

type ThemeTokenKey = keyof typeof DEFAULT_MAP_THEME_TOKENS;

const TOKEN_CSS_VARS: ReadonlyArray<readonly [ThemeTokenKey, string]> = [
  ['bg', '--map-bg'],
  ['walk', '--map-walk'],
  ['block', '--map-block'],
  ['grid', '--map-grid'],
  ['border', '--map-border'],
  ['member', '--map-member'],
  ['memberTarget', '--map-member-target'],
  ['npc', '--map-npc'],
  ['shop', '--map-shop'],
  ['exit', '--map-exit'],
  ['exitUnimported', '--map-exit-unimported'],
  ['gather', '--map-gather'],
  ['routeWalk', '--map-route-walk'],
  ['routeDest', '--map-route-dest'],
  ['labelFg', '--map-label-fg'],
  ['miniBg', '--map-mini-bg'],
  ['miniBorder', '--map-mini-border'],
  ['miniView', '--map-mini-view'],
];

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const clampAlpha = (v: number): number => Math.max(0, Math.min(1, v));

function buildThemeColor(r: number, g: number, b: number, alpha: number, css: string): ThemeColor {
  const rb = clampByte(r);
  const gb = clampByte(g);
  const bb = clampByte(b);
  const a = clampAlpha(alpha);
  return { css, hex: (rb << 16) | (gb << 8) | bb, rgba: [rb, gb, bb, 255], alpha: a };
}

function tryParseCssColor(raw: string): ThemeColor | null {
  const s = raw.trim();
  const hex3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (hex3) {
    const h = hex3[1];
    return buildThemeColor(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1, s);
  }
  const hex6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex6) {
    const h = hex6[1];
    return buildThemeColor(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1, s);
  }
  const rgb = /^rgba?\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)(?:\s*,\s*([+-]?\d*(?:\.\d+)?%?))?\s*\)$/i.exec(s);
  if (!rgb) return null;
  const r = Number(rgb[1]);
  const g = Number(rgb[2]);
  const b = Number(rgb[3]);
  if (![r, g, b].every(Number.isFinite)) return null;
  let a = 1;
  if (rgb[4] !== undefined) {
    a = rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    if (!Number.isFinite(a)) return null;
  }
  return buildThemeColor(r, g, b, a, s);
}

const ZERO_COLOR: ThemeColor = buildThemeColor(0, 0, 0, 1, '#000000');

/** 無效顏色退回 fallback，不拋錯。 */
export function parseCssColor(raw: string | null | undefined, fallback: string | ThemeColor): ThemeColor {
  const fb = typeof fallback === 'string' ? (tryParseCssColor(fallback) ?? ZERO_COLOR) : fallback;
  if (typeof raw !== 'string') return fb;
  return tryParseCssColor(raw) ?? fb;
}

export function parseMapThemePreset(v: unknown): MapThemePreset {
  return v === 'high-contrast' ? 'high-contrast' : 'default';
}

export function readMapThemePreset(storage?: KvStorage | null): MapThemePreset {
  if (!storage) return 'default';
  try {
    return parseMapThemePreset(storage.getItem(MAP_THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

export function writeMapThemePreset(preset: MapThemePreset, storage?: KvStorage | null): MapThemePreset {
  const clean = parseMapThemePreset(preset);
  if (storage) {
    try { storage.setItem(MAP_THEME_STORAGE_KEY, clean); } catch { /* 空間不可用仍回傳目前選擇 */ }
  }
  return clean;
}

function detectPreset(hostEl?: HTMLElement | null): MapThemePreset {
  const from = hostEl?.getAttribute?.('data-map-theme')
    ?? hostEl?.closest?.('[data-map-theme]')?.getAttribute?.('data-map-theme')
    ?? (typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('data-map-theme') : null);
  return parseMapThemePreset(from);
}

/** 讀宿主元素上的 `--map-*`。沒有樣式表時用預設或高對比 token。 */
export function resolveModernTheme(hostEl?: HTMLElement | null): ModernMapTheme {
  const preset = detectPreset(hostEl);
  const defaults = preset === 'high-contrast' ? HIGH_CONTRAST_MAP_THEME_TOKENS : DEFAULT_MAP_THEME_TOKENS;
  let computed: CSSStyleDeclaration | null = null;
  if (hostEl && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try { computed = window.getComputedStyle(hostEl); } catch { computed = null; }
  }
  const readVar = (varName: string): string => {
    const fromComputed = computed?.getPropertyValue?.(varName)?.trim();
    if (fromComputed) return fromComputed;
    return hostEl?.style?.getPropertyValue?.(varName)?.trim() ?? '';
  };
  const resolved = {} as Record<ThemeTokenKey, ThemeColor>;
  const keyParts: string[] = [preset];
  for (const [prop, cssVar] of TOKEN_CSS_VARS) {
    const color = parseCssColor(readVar(cssVar), defaults[prop]);
    resolved[prop] = color;
    keyParts.push(`${color.hex.toString(16).padStart(6, '0')}:${Math.round(color.alpha * 1000)}`);
  }
  return { preset, key: keyParts.join('|'), ...resolved };
}

/** 點陣圖用的不透明像素。顏色本身的 alpha 寫進第 4 通道。 */
export function themePixel(color: ThemeColor): readonly [number, number, number, number] {
  return [color.rgba[0], color.rgba[1], color.rgba[2], Math.round(color.alpha * 255)];
}
