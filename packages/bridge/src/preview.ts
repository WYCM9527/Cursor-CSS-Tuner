import { activeSegment, type PreviewTarget, type PropValue, type RuleRef } from '@css-tuner/protocol';
import { collectRules, type Reader } from './cascade';
import { linkedTo, linkScope } from './links';
import { movableKids, orderDecls } from './order';
import { clearAllProps, clearProp, hasPropPreview, previewProp } from './props';
import { sameSourceElements } from './source';
import { staticSelector } from './specificity';
import { clearAllTexts, clearTextPreview, hasTextPreview, previewText } from './text';
import { elOf, isOwnNode, isOwnSheet, sheetDevId, uidOf } from './util';

type Holder = { kind: 'inline'; el: HTMLElement } | { kind: 'rule'; style: CSSStyleDeclaration };
type InlineTarget = Extract<PreviewTarget, { kind: 'inline' }>;

interface Saved {
  holder: Holder;
  /** inline：原 style 属性（null 表示没有）；rule：原 cssText */
  original: string | null;
  probe: CSSStyleDeclaration;
}

interface Entry {
  id: string;
  target: PreviewTarget;
  decls: Record<string, string>;
  holders: Holder[];
  /** 换序：每个元素各自的 order / transform，和换序涉及的父元素 */
  per?: Map<HTMLElement, Record<string, string>>;
  parents?: Element[];
  /** 换序时各父元素下子元素的组成，React 把节点换掉了就重新摆 */
  shape?: string;
}

const entries = new Map<string, Entry>();
const saved = new Map<HTMLElement | CSSStyleDeclaration, Saved>();
/** 按 style 对象查 saved：算同源元素的写法时一次要读很多元素的原值，不能每次把 saved 扫一遍 */
const savedByStyle = new Map<CSSStyleDeclaration, Saved>();
const probeHost = () => document.createElement('div');

function keyOf(h: Holder) {
  return h.kind === 'inline' ? h.el : h.style;
}

function save(h: Holder) {
  const k = keyOf(h);
  if (saved.has(k)) return;
  const original = h.kind === 'inline' ? h.el.getAttribute('style') : h.style.cssText;
  const probe = probeHost().style;
  probe.cssText = original ?? '';
  const s: Saved = { holder: h, original, probe };
  saved.set(k, s);
  savedByStyle.set(styleOf(h), s);
}

function forget(k: HTMLElement | CSSStyleDeclaration) {
  const s = saved.get(k);
  if (!s) return;
  saved.delete(k);
  savedByStyle.delete(styleOf(s.holder));
}

function styleOf(h: Holder): CSSStyleDeclaration {
  return h.kind === 'inline' ? h.el.style : h.style;
}

function write(h: Holder, decls: Record<string, string>) {
  const style = styleOf(h);
  for (const [prop, value] of Object.entries(decls)) {
    if (h.kind === 'inline') style.setProperty(prop, value, 'important');
    else style.setProperty(prop, value, style.getPropertyPriority(prop));
  }
}

function restore(k: HTMLElement | CSSStyleDeclaration) {
  const s = saved.get(k);
  if (!s) return;
  if (s.holder.kind === 'inline') {
    if (s.original == null) {
      // 经 el.style 写过、又没读过 style 属性时，Chromium 删属性会留下一个空的 style=""：先读一下再删
      void s.holder.el.getAttribute('style');
      s.holder.el.removeAttribute('style');
    } else s.holder.el.setAttribute('style', s.original);
  } else {
    s.holder.style.cssText = s.original ?? '';
  }
}

/** 给层叠计算用：读预览之前的原值 */
export const originalReader: Reader = (style, prop) => {
  const s = savedByStyle.get(style);
  if (!s) return null;
  let index = -1;
  for (let i = 0; i < s.probe.length; i++) if (s.probe[i] === prop) index = i;
  if (index < 0 && !s.probe.getPropertyValue(prop)) return 'absent';
  return { value: s.probe.getPropertyValue(prop), priority: s.probe.getPropertyPriority(prop), ...(index >= 0 ? { index } : {}) };
};

/** 元素原来的 style 属性（预览改写之前的），没有时为 null */
export function originalInline(el: Element): string | null {
  const s = saved.get(el as HTMLElement);
  return s ? s.original : el.getAttribute('style');
}

function walkPath(sheet: CSSStyleSheet, path: number[]): CSSRule | null {
  let list: CSSRuleList;
  try {
    list = sheet.cssRules;
  } catch {
    return null;
  }
  let cur: CSSRule | null = null;
  for (const i of path) {
    cur = list[i] ?? null;
    if (!cur) return null;
    if (cur instanceof CSSImportRule) {
      if (!cur.styleSheet) return null;
      list = cur.styleSheet.cssRules;
    } else if ('cssRules' in cur) {
      list = (cur as CSSGroupingRule).cssRules;
    }
  }
  return cur;
}

function sheetMatches(sheet: CSSStyleSheet, ref: RuleRef['sheet']): boolean {
  if (ref.devId) return sheetDevId(sheet) === ref.devId;
  if (ref.href) return sheet.href === ref.href || stripQ(sheet.href) === stripQ(ref.href);
  return true;
}

function stripQ(u: string | null) {
  return u ? u.split('?')[0] : u;
}

/** 按 RuleRef 找回 CSSOM 里的规则；热更新后下标可能变化，就按样式表 + 选择器 + 条件重新找 */
export function resolveRule(ref: RuleRef): CSSStyleDeclaration | null {
  const sheets = Array.from(document.styleSheets);
  const direct = sheets[ref.sheet.index];
  if (direct && sheetMatches(direct, ref.sheet)) {
    const r = walkPath(direct, ref.path) as (CSSRule & { selectorText?: string; style?: CSSStyleDeclaration }) | null;
    if (r && r.style && (r.selectorText === ref.selector || (ref.selector === '&' && !r.selectorText))) return r.style;
  }
  const idx = collectRules(isOwnSheet);
  const hit = idx.rules.find(
    (fr) => fr.selector === ref.selector && fr.conditions.join('|') === ref.conditions.join('|') && sheetMatches(fr.topSheet, ref.sheet),
  );
  return hit ? hit.style : null;
}

/**
 * 一条内联预览的同伴，按页面顺序：同一段代码渲染出来的元素（sourceKey），或者同一条规则命中的元素（among）；
 * 都不是就只有 el 自己
 */
export async function peersOf(target: InlineTarget, el: Element): Promise<Element[]> {
  if (target.among) {
    let hits: Element[] = [];
    try {
      hits = Array.from(document.querySelectorAll(staticSelector(target.among))).filter((e) => !isOwnNode(e));
    } catch {
      /* 选择器浏览器不认：只管选中的这个 */
    }
    return hits.includes(el) ? hits : [el];
  }
  if (!target.sourceKey) return [el];
  const els = await sameSourceElements(el, target.depth ?? 0);
  return target.withClass ? els.filter((e) => e === el || e.classList.contains(target.withClass!)) : els;
}

/** 同伴里跟着 el 一起变的：类名用的是同一段字符串的（segs），这几个属性写法相同的（linked） */
function membersOf(target: InlineTarget, el: Element, peers: Element[]): Element[] {
  let els = peers;
  const { segs, seg } = target;
  if (segs && seg !== undefined) els = els.filter((e) => e === el || activeSegment(segs, (c) => e.classList.contains(c)) === seg);
  if (target.linked?.length && els.length > 1) els = linkedTo(el, els, target.linked, linkScope(collectRules(isOwnSheet), originalReader, originalInline));
  return els;
}

async function holdersFor(target: PreviewTarget): Promise<Holder[]> {
  if (target.kind === 'inline') {
    const el = elOf(target.uid);
    if (!el) return [];
    const els = membersOf(target, el, await peersOf(target, el));
    return els.filter((e): e is HTMLElement => e instanceof HTMLElement || e instanceof SVGElement).map((e) => ({ kind: 'inline', el: e as HTMLElement }));
  }
  if (target.kind === 'rule') {
    const style = resolveRule(target.rule);
    return style ? [{ kind: 'rule', style }] : [];
  }
  return [];
}

/** 一条预览挂在哪些地方，按挂的地方查：同源元素有几千上万个时，重放不能每个元素都把所有预览的 holders 扫一遍 */
const holderIndex = new WeakMap<Holder[], Map<HTMLElement | CSSStyleDeclaration, Holder>>();

function holderAt(e: Entry, k: HTMLElement | CSSStyleDeclaration): Holder | undefined {
  // holders 只会整个换掉，不会原地增删
  let at = holderIndex.get(e.holders);
  if (!at) {
    at = new Map(e.holders.map((h) => [keyOf(h), h]));
    holderIndex.set(e.holders, at);
  }
  return at.get(k);
}

function reapply(k: HTMLElement | CSSStyleDeclaration) {
  restore(k);
  let any = false;
  for (const e of entries.values()) {
    const h = holderAt(e, k);
    if (!h) continue;
    write(h, (h.kind === 'inline' && e.per?.get(h.el)) || e.decls);
    any = true;
  }
  if (!any) forget(k);
}

let chain: Promise<unknown> = Promise.resolve();

/** 拖动时预览请求很密，串行处理，避免同一 id 并发建出两条记录 */
export function preview(id: string, target: PreviewTarget, decls: Record<string, string>, text = '', prop: PropValue = null): Promise<number> {
  const run = chain.then(() => {
    if (target.kind === 'text') return previewText(id, target, text);
    if (target.kind === 'order') return previewOrder(id, target);
    if (target.kind === 'props') return previewProp(id, target, prop);
    return doPreview(id, target, decls);
  });
  chain = run.catch(() => undefined);
  return run;
}

const shapeOf = (parents: Element[]) => parents.map((p) => (p.isConnected ? movableKids(p).map(uidOf).join(',') : '-')).join('|');

/** 换序预览：每次按目标重新量、重新摆（先撤掉上一次的，量到的才是页面原本的位置） */
async function previewOrder(id: string, target: Extract<PreviewTarget, { kind: 'order' }>, hint?: Element): Promise<number> {
  const old = entries.get(id);
  if (old) clearPreview(id);
  const { decls, parents } = await orderDecls(target, hint ?? old?.parents?.[0]);
  if (!parents.length) return 0;
  const holders: Holder[] = [...decls.keys()].map((el) => ({ kind: 'inline', el }));
  for (const h of holders) save(h);
  entries.set(id, { id, target, decls: {}, holders, per: decls, parents, shape: shapeOf(parents) });
  for (const h of holders) reapply(keyOf(h));
  return parents.length;
}

/** 父元素下正在预览的新顺序（拖动时按页面上看到的顺序算位置） */
export function activeOrder(p: Element): number[] | null {
  let found: number[] | null = null;
  for (const e of entries.values()) if (e.target.kind === 'order' && e.parents?.includes(p)) found = e.target.order;
  return found;
}

/** React 重渲染换掉了子元素：按原来的目标在新节点上重新摆 */
export function reapplyOrders(): Promise<unknown> {
  const run = chain.then(async () => {
    for (const e of Array.from(entries.values())) {
      if (e.target.kind !== 'order' || !e.parents || shapeOf(e.parents) === e.shape) continue;
      await previewOrder(e.id, e.target, e.parents.find((p) => p.isConnected));
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

export function hasOrderPreviews(): boolean {
  for (const e of entries.values()) if (e.target.kind === 'order') return true;
  return false;
}

async function doPreview(id: string, target: PreviewTarget, decls: Record<string, string>): Promise<number> {
  let entry = entries.get(id);
  if (entry && !sameTarget(entry.target, target)) {
    clearPreview(id);
    entry = undefined;
  }
  // 挂着的规则 / 元素都不在页面上了（热更新换掉了样式表、重建了元素）：按目标重新找，之前设的值接着用
  if (entry && entry.holders.length && !entry.holders.some(holderLive)) {
    decls = { ...entry.decls, ...decls };
    clearPreview(id);
    entry = undefined;
  }
  if (!entry) {
    const holders = await holdersFor(target);
    for (const h of holders) save(h);
    entry = { id, target, decls: {}, holders };
  }
  // 挪到末尾：多个预览改同一属性时，最近一次编辑的那条最后应用、最终生效
  entries.delete(id);
  entries.set(id, entry);
  entry.decls = { ...entry.decls, ...decls };
  for (const h of entry.holders) reapply(keyOf(h));
  return entry.holders.length;
}

function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function clearPreview(id: string): boolean {
  if (clearTextPreview(id) || clearProp(id)) return true;
  const e = entries.get(id);
  if (!e) return false;
  entries.delete(id);
  for (const h of e.holders) {
    const k = keyOf(h);
    if (h.kind === 'rule' && !isLive(h.style)) {
      forget(k);
      continue;
    }
    reapply(k);
  }
  return true;
}

export function clearAll(): number {
  const n = entries.size;
  for (const id of Array.from(entries.keys())) clearPreview(id);
  return n + clearAllTexts() + clearAllProps();
}

export function hasPreview(id: string): boolean {
  return entries.has(id) || hasTextPreview(id) || hasPropPreview(id);
}

/** 样式预览还作用在页面上：内联预览挂在 el（或任一个还在页面上的元素）上，规则预览的规则没被热更新换掉 */
export function previewAttached(id: string, el?: Element | null): boolean {
  const e = entries.get(id);
  if (!e) return false;
  return e.holders.some((h) => holderLive(h) && (h.kind === 'rule' || !el || h.el === el));
}

/** 这条内联预览挂在哪些元素上（只算还在页面上的）；不是内联预览、或者已经撤掉了为 null */
export function previewElements(id: string): Element[] | null {
  const e = entries.get(id);
  if (!e || e.target.kind !== 'inline') return null;
  return e.holders.flatMap((h) => (h.kind === 'inline' && h.el.isConnected ? [h.el] : []));
}

/** 热更新换掉了样式表：挂在旧规则上的预览到新样式表里找回同一条规则，重新挂上 */
export function reattachRules() {
  for (const e of Array.from(entries.values())) {
    if (e.target.kind !== 'rule' || !e.holders.length || e.holders.some(holderLive)) continue;
    const style = resolveRule(e.target.rule);
    if (!style) continue;
    e.holders = [{ kind: 'rule', style }];
    save(e.holders[0]);
    reapply(style);
  }
}

/** 读预览底下源码给的样式：临时撤下全部样式预览，读完按撤下前的样子放回（同一个任务里做完，页面不会闪） */
export function beneath<T>(read: () => T): T {
  const was = Array.from(saved.keys(), (k) => [k, k instanceof CSSStyleDeclaration ? k.cssText : k.getAttribute('style')] as const);
  for (const [k] of was) restore(k);
  try {
    return read();
  } finally {
    for (const [k, text] of was) {
      if (k instanceof CSSStyleDeclaration) k.cssText = text ?? '';
      else if (text == null) k.removeAttribute('style');
      else k.setAttribute('style', text);
    }
  }
}

/** 热更新替换 <style> 后，旧 CSSOM 规则就脱离了文档 */
function isLive(style: CSSStyleDeclaration): boolean {
  const rule = style.parentRule;
  if (!rule) return false;
  let sheet = rule.parentStyleSheet;
  while (sheet && sheet.ownerRule) sheet = sheet.ownerRule.parentStyleSheet;
  return !!sheet && Array.from(document.styleSheets).includes(sheet);
}

const holderLive = (h: Holder) => (h.kind === 'inline' ? h.el.isConnected : isLive(h.style));

/** 页面刷新或 DOM 重建后清掉指向失效节点的记录 */
export function prune() {
  for (const [k, s] of Array.from(saved.entries())) {
    if (!holderLive(s.holder)) forget(k);
  }
}
