import {
  overColor,
  PROP_NAMES,
  parseColor,
  propMeta,
  toHex,
  type Crumb,
  type DeclWinner,
  type ElementSnapshot,
  type PropLink,
  type Rgba,
  type RuleRef,
  type UsedVar,
} from '@css-tuner/protocol';
import { countAssets } from './assets';
import { collectRules, matchRules, pickWinner, type FlatRule, type Matched, type RuleIndex } from './cascade';
import { orderInfo } from './order';
import { linkScope, linksOf, ruleLinksOf, type LinkScope } from './links';
import { kindOf } from './page';
import { originalInline, originalReader } from './preview';
import { propsInfo } from './props';
import { callersOf, ownerName, sameSourceElements, sourceOf } from './source';
import { staticSelector } from './specificity';
import { textInfo } from './text';
import { isOwnNode, isOwnSheet, isTailwindSheet, labelOf, sheetDevId, textOf, uidOf, unescapeIdent } from './util';

export function crumb(el: Element): Crumb {
  const text = textOf(el);
  return { uid: uidOf(el), label: labelOf(el), component: ownerName(el), kids: kidsOf(el).length, ...(text ? { text } : {}) };
}

function kidsOf(el: Element): Element[] {
  return Array.from(el.children).filter((c) => !isOwnNode(c) && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' && c.tagName !== 'LINK');
}

/** 规则若是元素自身某个类名生成的工具类（.md\:px-6、.hover\:x:hover），返回未转义的类名 */
export function utilityOf(selector: string, el: Element): string | null {
  if (!selector.startsWith('.')) return null;
  let i = 1;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) > 127) i++;
    else break;
  }
  const cls = unescapeIdent(selector.slice(1, i));
  const rest = selector.slice(i);
  if (rest && !rest.startsWith(':')) return null;
  if (/^[^()]*[\s>+~]/.test(rest)) return null;
  return el.classList.contains(cls) ? cls : null;
}

const VAR_REF = /var\(\s*(--[\w-]+)/g;
const MAX_VARS = 12;

const countCache = new Map<string, number>();

function matchCount(sel: string): number {
  const s = staticSelector(sel);
  let n = countCache.get(s);
  if (n === undefined) {
    try {
      n = document.querySelectorAll(s).length;
    } catch {
      n = 0;
    }
    countCache.set(s, n);
  }
  return n;
}

export function ruleRef(fr: FlatRule, el: Element): RuleRef {
  return {
    sheet: { index: fr.sheetIndex, devId: sheetDevId(fr.topSheet), href: fr.ownerSheet.href ?? fr.topSheet.href },
    path: fr.path,
    selector: fr.selector,
    fullSelector: fr.fullSelector,
    conditions: fr.conditions,
    layer: fr.layer,
    ordinal: fr.ordinal,
    matchCount: matchCount(fr.fullSelector),
    utility: isTailwindSheet(fr.topSheet) && (fr.layer === 'utilities' || fr.layer === null) ? utilityOf(fr.selector, el) : null,
  };
}

function toWinner(el: Element, w: ReturnType<typeof pickWinner>, origin: DeclWinner['origin'], from: Element | null): DeclWinner | null {
  if (!w) return null;
  return {
    value: w.decl.value,
    important: w.decl.important,
    origin: w.inline ? (origin === 'inherited' ? 'inherited' : 'inline') : origin,
    rule: w.fr ? ruleRef(w.fr, from ?? el) : null,
    inheritedFrom: from ? crumb(from) : null,
    via: w.decl.shorthand ?? w.decl.via,
  };
}

function hasTailwind(): boolean {
  return Array.from(document.styleSheets).some((s) => !isOwnSheet(s) && isTailwindSheet(s));
}

/** 给几条规则算「往里加声明时哪些元素跟着变」：扩展挑规则时还要看文件找不找得到，多备几条 */
const MAX_ADD_RULES = 6;
/** 规则命中的元素多过这个数就不算（* 和标签选择器），照旧整条规则一起变 */
const MAX_RULE_PEERS = 3000;
const FRAMEWORK_LAYERS = new Set(['theme', 'base', 'properties']);

/**
 * 没写过的属性要往元素的规则里加声明（见扩展 planner 的 ownRule，挑规则的先后和那边一致：最后一段选择器写着元素自己的类名或 id 的、
 * 不在 @media 这类条件里的优先）。这些规则各自命中的元素里，哪些属性只该有一部分跟着变。键是规则在 rules 里的下标
 */
function addLinks(el: Element, matched: Matched[], scope: LinkScope): Record<number, Record<string, PropLink>> | undefined {
  const subject = (fr: FlatRule) => fr.fullSelector.split(/\s*[\s>+~]\s*/).pop() ?? '';
  const own = (fr: FlatRule) => {
    const last = subject(fr);
    return Array.from(el.classList).some((c) => last.includes(`.${c}`)) || (!!el.id && last.includes(`#${el.id}`));
  };
  const always = (fr: FlatRule) => fr.conditions.every((c) => c.startsWith('@layer'));
  const rank = (fr: FlatRule) => (own(fr) ? 0 : 2) + (always(fr) ? 0 : 1);
  // Tailwind 生成的预设样式和工具类不是加声明的地方
  const generated = (fr: FlatRule) => {
    if (!isTailwindSheet(fr.topSheet)) return false;
    if (fr.layer !== null && FRAMEWORK_LAYERS.has(fr.layer.split('.')[0])) return true;
    return (fr.layer === 'utilities' || fr.layer === null) && !!utilityOf(fr.selector, el);
  };
  const candidates = matched
    .map((m, i) => ({ fr: m.fr, i }))
    .reverse()
    .filter(({ fr }) => !generated(fr))
    .map((c, at) => ({ ...c, at, rank: rank(c.fr) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, MAX_ADD_RULES);
  const out: Record<number, Record<string, PropLink>> = {};
  for (const { fr, i } of candidates) {
    let hits: Element[];
    try {
      hits = Array.from(document.querySelectorAll(staticSelector(fr.fullSelector))).filter((e) => !isOwnNode(e));
    } catch {
      continue;
    }
    if (hits.length < 2 || hits.length > MAX_RULE_PEERS || !hits.includes(el)) continue;
    const links = ruleLinksOf(el, hits, fr, scope);
    if (links) out[i] = links;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 元素后面露出来的底色：祖先的背景色从近到远一层层叠，叠到不透明的那层为止，最底下是浏览器默认的白色画布 */
function backdropOf(el: Element): string {
  const layers: Rgba[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const c = parseColor(getComputedStyle(p).backgroundColor);
    if (!c || c.a <= 0) continue;
    layers.push(c);
    if (c.a >= 0.999) break;
  }
  return toHex(layers.reduceRight<Rgba>((under, c) => overColor(c, under), { r: 1, g: 1, b: 1, a: 1 }));
}

export async function snapshot(el: Element, idx: RuleIndex = collectRules(isOwnSheet)): Promise<ElementSnapshot> {
  countCache.clear();
  const matchedCache = new Map<Element, Matched[]>();
  const matchedFor = (e: Element) => {
    let m = matchedCache.get(e);
    if (!m) {
      m = matchRules(e, idx);
      matchedCache.set(e, m);
    }
    return m;
  };
  const matched = matchedFor(el);
  const cs = getComputedStyle(el);
  const computed: Record<string, string> = {};
  const winners: Record<string, DeclWinner> = {};
  for (const prop of PROP_NAMES) {
    computed[prop] = cs.getPropertyValue(prop).trim();
    let w = toWinner(el, pickWinner(el, matched, prop, originalReader), 'rule', null);
    if (!w && propMeta(prop)?.inherited) {
      for (let p = el.parentElement; p && p !== document.documentElement.parentElement; p = p.parentElement) {
        const pw = pickWinner(p, matchedFor(p), prop, originalReader);
        if (pw && pw.decl.value !== 'inherit') {
          w = toWinner(el, pw, 'inherited', p);
          break;
        }
      }
    }
    winners[prop] = w ?? { value: computed[prop], important: false, origin: 'initial', rule: null, inheritedFrom: null, via: null };
  }

  // 变量会继承：从元素往上找第一个声明了它的元素，那里的胜出声明就是定义
  const using = new Map<string, string[]>();
  for (const prop of PROP_NAMES) {
    const w = winners[prop];
    if (w.origin === 'initial') continue;
    for (const m of w.value.matchAll(VAR_REF)) {
      if (m[1].startsWith('--tw-')) continue;
      const list = using.get(m[1]) ?? [];
      if (!list.includes(prop)) list.push(prop);
      using.set(m[1], list);
    }
  }
  const vars: UsedVar[] = [];
  for (const [name, props] of [...using].slice(0, MAX_VARS)) {
    const value = cs.getPropertyValue(name).trim();
    let w: DeclWinner | null = null;
    for (let p: Element | null = el; p && !w; p = p.parentElement) {
      w = toWinner(el, pickWinner(p, matchedFor(p), name, originalReader), p === el ? 'rule' : 'inherited', p === el ? null : p);
    }
    computed[name] = value;
    winners[name] = w ? { ...w, value: w.value.trim() } : { value, important: false, origin: 'initial', rule: null, inheritedFrom: null, via: null };
    vars.push({ name, value, kind: kindOf(value), props });
  }

  const inline: Record<string, string> = {};
  const style = (el as HTMLElement).style;
  if (style) {
    for (let i = 0; i < style.length; i++) {
      const r = originalReader(style, style[i]);
      if (r === 'absent') continue;
      inline[style[i]] = r ? r.value : style.getPropertyValue(style[i]);
    }
  }

  const breadcrumb: Crumb[] = [];
  for (let p: Element | null = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) breadcrumb.unshift(crumb(p));

  const source = await sourceOf(el);
  const peers = source ? await sameSourceElements(el) : [el];
  const scope = linkScope(idx, originalReader, originalInline, matchedCache, true);
  const links = peers.length > 1 ? linksOf(el, peers, scope) : undefined;
  // Tailwind 页面上有源码位置的元素，没写过的属性加的是类名，不往规则里加声明
  const ruleLinks = source && hasTailwind() ? undefined : addLinks(el, matched, scope);
  const rect = el.getBoundingClientRect();

  return {
    uid: uidOf(el),
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList),
    label: labelOf(el),
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    breadcrumb,
    children: kidsOf(el).slice(0, 40).map(crumb),
    source,
    sameSource: peers.length,
    sourceIndex: Math.max(0, peers.indexOf(el)),
    callers: source ? await callersOf(el, peers) : [],
    classCounts: Object.fromEntries(Array.from(el.classList, (c) => [c, peers.filter((p) => p.classList.contains(c)).length])),
    ...(links ? { links } : {}),
    ...(ruleLinks ? { ruleLinks } : {}),
    computed,
    winners,
    vars,
    rules: matched.map((m) => ruleRef(m.fr, el)),
    inline,
    fontSizePx: parseFloat(cs.fontSize) || 16,
    rootFontSizePx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    backdrop: backdropOf(el),
    text: await textInfo(el, source),
    order: await orderInfo(el),
    props: await propsInfo(el),
    assets: countAssets(el),
  };
}
