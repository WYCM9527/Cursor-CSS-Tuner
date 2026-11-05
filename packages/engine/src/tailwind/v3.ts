import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AtRule, ChildNode, Declaration, Rule } from 'postcss';
import { toPx } from '@css-tuner/protocol';
import type { RawDesignSystem } from './design';
import { splitCandidate } from './classes';

/**
 * Tailwind 3 的设计系统：用项目自己装的 tailwindcss 读 tailwind.config，按候选类生成 CSS，
 * 对外和 v4 的 __unstable__loadDesignSystem 一个样子（主题按 v4 的命名空间给，CSS 按 v4 的写法输出）。
 * 3.x 的 PostCSS 插件是异步的，这里直接用它同步的 JIT 内部函数（createContext / generateRules），3.0 到 3.4 都有。
 */

type Theme = Record<string, unknown>;

interface Tw3Config {
  theme: Theme;
}

type Jiti = (filename: string, opts: Record<string, unknown>) => (id: string) => unknown;

interface Tw3Modules {
  jiti: Jiti | null;
  loadConfig: ((path: string) => unknown) | null;
  resolveConfig: (config: unknown) => Tw3Config;
  createContext: (config: Tw3Config) => unknown;
  generateRules: (candidates: Set<string>, context: unknown) => Array<[unknown, ChildNode]>;
  getModuleDependencies: ((file: string) => Set<string>) | null;
}

const CONFIG_FILES = ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts', 'tailwind.config.cts', 'tailwind.config.mts'];

/** 入口 CSS 用的 tailwind.config：@config 指定的；否则从入口所在目录往上找，找到项目根（有 package.json 的目录）为止 */
export function findTailwindConfig(entryFile: string, css: string): string | null {
  const at = /@config\s+(['"])([^'"]+)\1/.exec(css);
  if (at) {
    const p = resolve(dirname(entryFile), at[2]);
    return existsSync(p) ? p : null;
  }
  let dir = dirname(entryFile);
  for (let i = 0; i < 12; i++) {
    for (const name of CONFIG_FILES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    if (existsSync(join(dir, 'package.json'))) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function modules(fromDir: string): Tw3Modules {
  const req = createRequire(join(fromDir, '__css_tuner__.js'));
  const optional = <T>(id: string): T | null => {
    try {
      return req(id) as T;
    } catch {
      return null;
    }
  };
  const named = <T>(id: string, name: string): T => {
    const m = req(id) as Record<string, unknown>;
    return (m[name] ?? (m.default as Record<string, unknown> | undefined)?.[name]) as T;
  };
  const deps = optional<{ default?: (f: string) => Set<string> } | ((f: string) => Set<string>)>('tailwindcss/lib/lib/getModuleDependencies');
  let jiti: Jiti | null = null;
  try {
    jiti = createRequire(req.resolve('tailwindcss/package.json'))('jiti') as Jiti;
  } catch {
    /* 没有 jiti 时退回 tailwindcss 的 loadConfig */
  }
  return {
    jiti: typeof jiti === 'function' ? jiti : null,
    loadConfig: optional<(path: string) => unknown>('tailwindcss/loadConfig'),
    resolveConfig: req('tailwindcss/resolveConfig') as Tw3Modules['resolveConfig'],
    createContext: named('tailwindcss/lib/lib/setupContextUtils', 'createContext'),
    generateRules: named('tailwindcss/lib/lib/generateRules', 'generateRules'),
    getModuleDependencies: typeof deps === 'function' ? deps : (deps?.default ?? null),
  };
}

async function readConfig(m: Tw3Modules, file: string): Promise<unknown> {
  // 用 tailwindcss 自带的 jiti 且不走缓存：Node 22 原生 require 进来的 ESM / TS 配置删不掉缓存，改了配置会一直读到旧的
  if (m.jiti) {
    try {
      const mod = m.jiti(file, { interopDefault: true, cache: false, requireCache: false })(file) as { default?: unknown };
      return mod.default ?? mod;
    } catch {
      /* 退回 loadConfig */
    }
  }
  if (m.loadConfig) return m.loadConfig(file);
  // 3.3 之前没有 loadConfig：CommonJS 直接 require，ESM 用 import（带上时间戳，改过的配置不吃缓存）
  try {
    const mod = createRequire(file)(file) as { default?: unknown };
    return mod.default ?? mod;
  } catch {
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default?: unknown };
    return mod.default ?? mod;
  }
}

/* ---------- 生成的规则按 v4 的格式输出 ---------- */

/** 字号令牌顺带设的行高、字距、字重：v4 写成 var(--tw-*, 默认值)，元素上另有 leading-* 等类时让位给它 */
const FONT_SIZE_COMPANIONS: Record<string, string> = { 'line-height': '--tw-leading', 'letter-spacing': '--tw-tracking', 'font-weight': '--tw-font-weight' };

function print(node: ChildNode, indent: string, soft: boolean, out: string[]) {
  if (node.type === 'decl') {
    const d = node as Declaration;
    const value = soft && FONT_SIZE_COMPANIONS[d.prop] ? `var(${FONT_SIZE_COMPANIONS[d.prop]}, ${d.value})` : d.value;
    out.push(`${indent}${d.prop}: ${value}${d.important ? ' !important' : ''};`);
    return;
  }
  if (node.type === 'atrule') {
    const a = node as AtRule;
    if (a.name === 'defaults') return;
    if (!a.nodes) {
      out.push(`${indent}@${a.name} ${a.params};`);
      return;
    }
    out.push(`${indent}@${a.name} ${a.params} {`);
    for (const c of a.nodes) print(c, `${indent}  `, soft, out);
    out.push(`${indent}}`);
    return;
  }
  if (node.type === 'rule') {
    const r = node as Rule;
    out.push(`${indent}${r.selector} {`);
    const kids = r.nodes ?? [];
    const sized = soft && kids.some((c) => c.type === 'decl' && (c as Declaration).prop === 'font-size');
    for (const c of kids) print(c, `${indent}  `, sized, out);
    out.push(`${indent}}`);
  }
}

/** text-lg 这种字号令牌：没写 /7 这样的行高修饰时，行高等只是默认值 */
function fontSizeToken(candidate: string): boolean {
  const { base } = splitCandidate(candidate);
  if (!base.startsWith('text-')) return false;
  let depth = 0;
  for (const ch of base) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === '/' && depth === 0) return false;
  }
  return true;
}

/* ---------- 值比较（规范写法用） ---------- */

function lengthPx(v: string, rem: number): number | null {
  const t = v.trim();
  if (t === '0') return 0;
  if (!/^-?(\d+\.?\d*|\.\d+)(px|rem|em)$/.test(t)) return null;
  return toPx(t, rem, rem);
}

function numberOf(v: string): number | null {
  const t = v.trim();
  if (/^-?(\d+\.?\d*|\.\d+)%$/.test(t)) return parseFloat(t) / 100;
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t);
  return null;
}

/** 两个 CSS 值是否等价：长度按 px 比，数字和百分比按数值比，其余忽略大小写和多余空白 */
export function sameValue(a: string, b: string, rem: number): boolean {
  const la = lengthPx(a, rem);
  const lb = lengthPx(b, rem);
  if (la !== null && lb !== null) return Math.abs(la - lb) < 0.01;
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 1e-6;
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/** 任意值类名的工具类前缀对应 v3 的哪几个主题键 */
const SECTIONS: Record<string, string[]> = {
  ...Object.fromEntries(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe'].map((r) => [r, ['padding']])),
  ...Object.fromEntries(['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'].map((r) => [r, ['margin']])),
  ...Object.fromEntries(['gap', 'gap-x', 'gap-y'].map((r) => [r, ['gap']])),
  ...Object.fromEntries(['inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end'].map((r) => [r, ['inset']])),
  ...Object.fromEntries(['rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-s', 'rounded-e', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee'].map((r) => [r, ['borderRadius']])),
  w: ['width'],
  h: ['height'],
  size: ['size'],
  'min-w': ['minWidth'],
  'max-w': ['maxWidth'],
  'min-h': ['minHeight'],
  'max-h': ['maxHeight'],
  text: ['fontSize', 'textColor'],
  bg: ['backgroundColor'],
  ...Object.fromEntries(['from', 'via', 'to'].map((r) => [r, ['gradientColorStops', 'gradientColorStopPositions']])),
  font: ['fontWeight'],
  leading: ['lineHeight'],
  tracking: ['letterSpacing'],
  opacity: ['opacity'],
  z: ['zIndex'],
  shadow: ['boxShadow'],
  'grid-cols': ['gridTemplateColumns'],
};

/** 主题里一个值的字符串形式：字号是 [大小, { lineHeight }]，颜色里的 <alpha-value> 当作不透明 */
function themeString(v: unknown): string | null {
  if (typeof v === 'string') return v.replace(/<alpha-value>/g, '1');
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/** fontFamily 的值：字符串、字体名数组，或 [字体名数组, { fontFeatureSettings }]；数组照 Tailwind 的做法用逗号连起来 */
function fontStack(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  if (Array.isArray(v[0]) || (typeof v[0] === 'string' && v.length === 2 && v[1] && typeof v[1] === 'object')) return fontStack(v[0]);
  return v.every((x) => typeof x === 'string') ? v.join(', ') : null;
}

/** 嵌套的主题对象（颜色）展开成 red-500 这样的键；DEFAULT 用父级的名字 */
function flatten(obj: unknown, prefix = '', out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k === 'DEFAULT' ? prefix : prefix ? `${prefix}-${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

/* ---------- 主题按 v4 的命名空间给出 ---------- */

const LENGTH = /^(-?\d*\.?\d+)(rem|px|em)$/;

export function namespaces(theme: Theme): { spaces: Map<string, Map<string | null, string>>; base: string | null } {
  const entries = (key: string) => flatten(theme[key]).flatMap(([k, v]): Array<[string, string]> => {
    const s = themeString(v);
    return s === null ? [] : [[k, s]];
  });
  const spacing = entries('spacing');
  const one = spacing.find(([k]) => k === '1')?.[1] ?? null;
  const unit = one ? LENGTH.exec(one) : null;
  const base = unit ? one : null;
  // 数字键刚好是基准的倍数时由刻度自己生成，这里只给另起名字或值对不上的
  const onBase = (k: string, v: string) => {
    if (!unit || !/^\d+(\.\d+)?$/.test(k)) return false;
    const t = v.trim();
    const m = LENGTH.exec(t);
    const n = t === '0' ? 0 : m ? parseFloat(m[1]) : null;
    if (n === null) return false;
    if (n === 0) return parseFloat(k) === 0;
    return m![2] === unit[2] && Math.abs(n - parseFloat(k) * parseFloat(unit[1])) < 1e-6;
  };
  const spaces = new Map<string, Map<string | null, string>>();
  const put = (ns: string, list: Array<[string | null, string]>) => spaces.set(ns, new Map(list));

  put('--spacing', [...(base ? [[null, base] as [null, string]] : []), ...spacing.filter(([k, v]) => !onBase(k, v) && !(k === 'px' && v === '1px'))]);
  put(
    '--container',
    entries('maxWidth').filter(([k]) => /^(\d*x[sl]|sm|md|lg)$/.test(k)),
  );
  put(
    '--radius',
    entries('borderRadius')
      .filter(([k]) => k !== 'none' && k !== 'full')
      .map(([k, v]) => [k === '' ? null : k, v]),
  );
  const text: Array<[string, string]> = [];
  for (const [k, v] of Object.entries((theme.fontSize ?? {}) as Record<string, unknown>)) {
    const size = themeString(v);
    if (size === null) continue;
    text.push([k, size]);
    const extra = Array.isArray(v) ? v[1] : null;
    const lh = typeof extra === 'string' ? extra : extra && typeof extra === 'object' ? (extra as { lineHeight?: unknown }).lineHeight : null;
    if (typeof lh === 'string') text.push([`${k}--line-height`, lh]);
  }
  put('--text', text);
  put(
    '--font',
    Object.entries((theme.fontFamily ?? {}) as Record<string, unknown>).flatMap(([k, v]): Array<[string, string]> => {
      const s = fontStack(v);
      return s === null ? [] : [[k, s]];
    }),
  );
  put('--font-weight', entries('fontWeight'));
  put(
    '--leading',
    entries('lineHeight').filter(([k, v]) => k !== 'none' && !onBase(k, v)),
  );
  put('--tracking', entries('letterSpacing'));
  put(
    '--shadow',
    entries('boxShadow')
      .filter(([k]) => k !== 'none')
      .map(([k, v]) => [k === '' ? null : k, v]),
  );
  put(
    '--color',
    entries('colors').filter(([k]) => k !== 'inherit' && k !== 'current' && k !== ''),
  );
  // screens 的值可以是 '768px'，也可以是 { min, max } 或 { raw }：只有下限的才是 md: 这种「从这个宽度起」的断点
  const screens: Array<[string, string]> = [];
  for (const [k, v] of Object.entries((theme.screens ?? {}) as Record<string, unknown>)) {
    const min = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) ? (v as { min?: unknown }).min : null;
    if (typeof min === 'string') screens.push([k, min]);
  }
  put('--breakpoint', screens);
  return { spaces, base };
}

/* ---------- 加载 ---------- */

export interface Tailwind3 {
  raw: RawDesignSystem;
  /** 读过的配置文件（含它相对引入的文件），调用方据此判断缓存是否过期 */
  files: string[];
}

export async function loadTailwind3(entryFile: string, css: string): Promise<Tailwind3> {
  const m = modules(dirname(entryFile));
  const configFile = findTailwindConfig(entryFile, css);
  const files = configFile ? (m.getModuleDependencies ? [...m.getModuleDependencies(configFile)] : [configFile]) : [];
  // 配置改过要重新读：和 tailwindcss 自己一样，先把配置和它引入的文件从 require 缓存里删掉
  const cache = createRequire(join(dirname(entryFile), '__css_tuner__.js')).cache;
  if (cache) for (const f of files) delete cache[f];
  const config = m.resolveConfig(configFile ? await readConfig(m, configFile) : {});
  const context = m.createContext(config);
  const { spaces, base } = namespaces(config.theme);

  const cssOf = (candidate: string): string | null => {
    let rules: Array<[unknown, ChildNode]>;
    try {
      rules = m.generateRules(new Set([candidate]), context);
    } catch {
      return null;
    }
    if (!rules.length) return null;
    const soft = fontSizeToken(candidate);
    const out: string[] = [];
    for (const [, node] of rules) print(node, '', soft, out);
    return out.length ? `${out.join('\n')}\n` : null;
  };

  const decls = (candidate: string): Map<string, string> | null => {
    const text = cssOf(candidate);
    if (!text) return null;
    const map = new Map<string, string>();
    for (const line of text.split('\n')) {
      const d = /^\s*([a-z-]+)\s*:\s*(.+?)\s*;$/.exec(line);
      if (d) map.set(d[1], d[2]);
    }
    return map;
  };
  const IMPORTANT = /\s*!important$/;
  const sameDecl = (x: string, y: string, rem: number) => IMPORTANT.test(x) === IMPORTANT.test(y) && sameValue(x.replace(IMPORTANT, ''), y.replace(IMPORTANT, ''), rem);
  const sameDecls = (a: Map<string, string>, b: Map<string, string>, rem: number) =>
    a.size === b.size && [...a].every(([p, v]) => b.has(p) && sameDecl(v, b.get(p)!, rem));

  const canonicalCache = new Map<string, string>();
  const canonical = (candidate: string, rem: number): string => {
    const key = `${rem}|${candidate}`;
    const hit = canonicalCache.get(key);
    if (hit !== undefined) return hit;
    let out = candidate;
    const { variant, base: b, important } = splitCandidate(candidate);
    const arb = /^([a-z][a-z-]*?)-\[(.+)\]$/.exec(b);
    const mine = arb ? decls(candidate) : null;
    if (arb && mine) {
      const [, root, inner] = arb;
      const typed = /^(length|color|number|percentage|absolute-size|relative-size):(.+)$/.exec(inner);
      const value = (typed ? typed[2] : inner).replace(/(?<!\\)_/g, ' ').replace(/\\_/g, '_');
      const make = (base: string) => `${variant}${important === 'prefix' ? '!' : ''}${base}`;
      for (const section of SECTIONS[root] ?? []) {
        for (const [k, v] of flatten(config.theme[section])) {
          const s = themeString(v);
          if (s === null || !sameValue(s, value, rem)) continue;
          const cand = make(k === '' ? root : `${root}-${k}`);
          const theirs = decls(cand);
          if (theirs && sameDecls(mine, theirs, rem)) {
            out = cand;
            break;
          }
        }
        if (out !== candidate) break;
      }
      // 不在主题里：去掉多余的类型提示（text-[length:19px] → text-[19px]）
      if (out === candidate && typed) {
        const cand = make(`${root}-[${typed[2]}]`);
        const theirs = decls(cand);
        if (theirs && sameDecls(mine, theirs, rem)) out = cand;
      }
    }
    canonicalCache.set(key, out);
    return out;
  };

  const raw: RawDesignSystem = {
    candidatesToCss: (candidates) => candidates.map(cssOf),
    canonicalizeCandidates: (candidates, opts) => candidates.map((c) => canonical(c, opts?.rem ?? 16)),
    theme: { namespace: (ns) => spaces.get(ns) ?? new Map() },
    resolveThemeValue: (path) => {
      if (path === '--spacing') return base ?? undefined;
      for (const [ns, map] of [...spaces].sort((a, b) => b[0].length - a[0].length)) {
        if (path.startsWith(`${ns}-`)) return map.get(path.slice(ns.length + 1));
      }
      return undefined;
    },
  };
  return { raw, files };
}
