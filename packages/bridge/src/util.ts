import { webpackCssSources } from './next';
import { decodeDataUrl, extractMapUrl, filePathOf, sourcesOf, type SourceMap } from './sourcemap';

export const OWN_ATTR = 'data-css-tuner';

const byEl = new WeakMap<Element, string>();
const byId = new Map<string, WeakRef<Element>>();
let seq = 0;
/** 每次加载页面不同：扩展里存着的旧 uid 在刷新后必须失效，不能碰巧指到别的元素 */
const DOC = Math.random().toString(36).slice(2, 6);

export function uidOf(el: Element): string {
  let u = byEl.get(el);
  if (!u) {
    u = `${DOC}${(++seq).toString(36)}`;
    byEl.set(el, u);
    byId.set(u, new WeakRef(el));
  }
  return u;
}

export function elOf(uid: string): Element | null {
  const el = byId.get(uid)?.deref();
  return el && el.isConnected ? el : null;
}

export function isOwnNode(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (node instanceof Element && node.hasAttribute(OWN_ATTR)) return true;
  const root = node.getRootNode();
  return root instanceof ShadowRoot && root.host.hasAttribute(OWN_ATTR);
}

export function isOwnSheet(sheet: CSSStyleSheet): boolean {
  return isOwnNode(sheet.ownerNode);
}

export function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** 外链样式表对应的本地源文件（href 去掉查询串作键），null 表示看过了但对不上单个文件 */
const linkSources = new Map<string, string | null>();

/**
 * 样式表对应的源文件：Vite 注入的 <style data-vite-dev-id>，
 * 或打包器（Turbopack 等）的外链 CSS 的 sourcemap 里唯一的本地 .css 源。
 */
export function sheetDevId(sheet: CSSStyleSheet): string | null {
  const owner = sheet.ownerNode as Element | null;
  const vite = owner && typeof owner.getAttribute === 'function' ? owner.getAttribute('data-vite-dev-id') : null;
  if (vite) return vite;
  return sheet.href ? (linkSources.get(stripQuery(sheet.href)) ?? null) : null;
}

/**
 * 读新出现的同源外链样式表的 sourcemap，记下对应的源文件；有新发现时返回 true。
 * 没有 sourcemap 时看 webpack 的 pathinfo 注释，记下相对项目根的路径（扩展按项目根解析）
 */
export async function loadSheetSources(): Promise<boolean> {
  const hrefs = Array.from(document.styleSheets)
    .map((s) => s.href)
    .filter((h): h is string => !!h && h.startsWith(location.origin) && !linkSources.has(stripQuery(h)));
  let learned = false;
  await Promise.all(
    hrefs.map(async (href) => {
      const key = stripQuery(href);
      linkSources.set(key, null);
      try {
        const text = await (await fetch(href)).text();
        const ref = extractMapUrl(text);
        if (!ref) {
          const files = webpackCssSources(text);
          if (files.length === 1) {
            linkSources.set(key, files[0].replace(/^\.\//, '/'));
            learned = true;
          }
          return;
        }
        const json = ref.startsWith('data:') ? decodeDataUrl(ref) : await (await fetch(new URL(ref, href))).text();
        const files = [...new Set(sourcesOf(JSON.parse(json) as SourceMap).map(filePathOf))];
        if (files.length === 1 && files[0] && /\.css$/i.test(files[0])) {
          linkSources.set(key, files[0]);
          learned = true;
        }
      } catch {
        /* 读不到 sourcemap 就按 href 找文件 */
      }
    }),
  );
  return learned;
}

const twCache = new WeakMap<CSSStyleSheet, boolean>();

/**
 * Tailwind 生成的样式表：Vite 注入的 <style> 带版权横幅；外链 CSS 读不到注释，
 * v4 看有没有 theme + utilities 两个层，v3 没有层，看开头的预设样式里有没有定义 --tw-* 变量
 */
export function isTailwindSheet(sheet: CSSStyleSheet): boolean {
  let v = twCache.get(sheet);
  if (v !== undefined) return v;
  const owner = sheet.ownerNode as Element | null;
  const text = owner && owner.textContent ? owner.textContent.slice(0, 300) : '';
  v = text.includes('tailwindcss v');
  if (!v) {
    try {
      const names = new Set<string>();
      let twVars = false;
      const rules = sheet.cssRules;
      for (let i = 0; i < Math.min(rules.length, 12); i++) {
        const r = rules[i];
        if (typeof CSSLayerStatementRule === 'function' && r instanceof CSSLayerStatementRule) r.nameList.forEach((n) => names.add(n));
        else if (typeof CSSLayerBlockRule === 'function' && r instanceof CSSLayerBlockRule) names.add(r.name);
        else if (r instanceof CSSStyleRule && /^(\*|::before|::after|::backdrop)/.test(r.selectorText)) {
          for (let j = 0; j < r.style.length; j++) if (r.style[j].startsWith('--tw-')) twVars = true;
        }
      }
      v = (names.has('theme') && names.has('utilities')) || (names.size === 0 && twVars);
    } catch {
      v = false;
    }
  }
  twCache.set(sheet, v);
  return v;
}

export function labelOf(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls = Array.from(el.classList).slice(0, 2);
  for (const c of cls) s += `.${c.length > 24 ? c.slice(0, 23) + '…' : c}`;
  if (el.classList.length > 2) s += '…';
  return s;
}

/** 按钮、链接、标题这类元素的文字常包在子元素里，取全部文字；容器只取自己直接写的，免得把整块里的字连成一串 */
const WHOLE_TEXT = new Set(['A', 'BUTTON', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'SUMMARY', 'FIGCAPTION', 'LEGEND', 'OPTION', 'CAPTION']);
const TEXT_NODE = 3;

/** 面板上给人认元素用的文字开头；没有文字时用 alt、aria-label、title、placeholder，都没有为空 */
export function textOf(el: Element): string {
  let s = '';
  if (WHOLE_TEXT.has(el.tagName)) s = el.textContent ?? '';
  else for (const n of Array.from(el.childNodes)) if (n.nodeType === TEXT_NODE) s += n.textContent ?? '';
  if (!s.trim()) s = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
  return clip(s, 30);
}

/** 空白压成一个空格，超过 max 个字符截断加省略号 */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function unescapeIdent(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, esc: string) => {
    if (/^[0-9a-fA-F]/.test(esc) && esc.trim().length > 0 && /^[0-9a-fA-F]+\s?$/.test(esc)) {
      return String.fromCodePoint(parseInt(esc.trim(), 16));
    }
    return esc;
  });
}

/** 下标（从小到大）写成区间：0,2-5,9。一批同伴里记下其中一部分用（见 PeerBase） */
export function ranges(indexes: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < indexes.length; i++) {
    const from = indexes[i];
    while (i + 1 < indexes.length && indexes[i + 1] === indexes[i] + 1) i++;
    out.push(from === indexes[i] ? `${from}` : `${from}-${indexes[i]}`);
  }
  return out.join(',');
}

/** ranges 写出来的区间读回下标 */
export function indexesIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const part of text ? text.split(',') : []) {
    const [from, to = from] = part.split('-').map(Number);
    for (let i = from; i <= to; i++) out.add(i);
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
