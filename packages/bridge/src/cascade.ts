import { aliasesOf, shorthandsOf } from '@css-tuner/protocol';
import { compareSpec, resolveNested, specificityOf, splitTopLevel, subjectOf, type Spec } from './specificity';

export { aliasesOf };

export interface FlatRule {
  style: CSSStyleDeclaration;
  rule: CSSRule;
  sheetIndex: number;
  topSheet: CSSStyleSheet;
  ownerSheet: CSSStyleSheet;
  path: number[];
  selector: string;
  fullSelector: string;
  branches: string[];
  conditions: string[];
  layer: string | null;
  layerRank: number;
  order: number;
  ordinal: number;
  active: boolean;
  names?: Map<string, number>;
  /** 拿去试元素的分支（不含交互态的和只匹配伪元素的），第一次用到时算 */
  tests?: string[];
}

interface RuleLookup {
  byClass: Map<string, FlatRule[]>;
  byTag: Map<string, FlatRule[]>;
  loose: FlatRule[];
}

export interface RuleIndex {
  rules: FlatRule[];
  layerOrder: Map<string, number>;
  /** 按类名查规则用，第一次用到时建 */
  lookup?: RuleLookup;
}

interface Ctx {
  topSheet: CSSStyleSheet;
  ownerSheet: CSSStyleSheet;
  sheetIndex: number;
  path: number[];
  conditions: string[];
  layer: string | null;
  parent: string | null;
  active: boolean;
}

const has = (name: string) => typeof (globalThis as Record<string, unknown>)[name] === 'function';

function mediaMatches(text: string): boolean {
  if (!text || text === 'all') return true;
  try {
    return matchMedia(text).matches;
  } catch {
    return true;
  }
}

function supports(text: string): boolean {
  try {
    return CSS.supports(text);
  } catch {
    return true;
  }
}

export function collectRules(skipSheet: (s: CSSStyleSheet) => boolean): RuleIndex {
  const rules: FlatRule[] = [];
  const layerOrder = new Map<string, number>();
  let order = 0;
  let anon = 0;
  const regLayer = (name: string) => {
    if (!layerOrder.has(name)) layerOrder.set(name, layerOrder.size);
  };
  const push = (style: CSSStyleDeclaration, rule: CSSRule, selector: string, fullSelector: string, path: number[], ctx: Ctx) => {
    rules.push({
      style,
      rule,
      sheetIndex: ctx.sheetIndex,
      topSheet: ctx.topSheet,
      ownerSheet: ctx.ownerSheet,
      path,
      selector,
      fullSelector,
      branches: splitTopLevel(fullSelector),
      conditions: ctx.conditions,
      layer: ctx.layer,
      layerRank: 0,
      order: order++,
      ordinal: 0,
      active: ctx.active,
    });
  };

  const walk = (list: CSSRuleList, ctx: Ctx) => {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const path = [...ctx.path, i];
      if (r instanceof CSSStyleRule) {
        const full = resolveNested(ctx.parent, r.selectorText);
        push(r.style, r, r.selectorText, full, path, ctx);
        const nested = (r as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules;
        if (nested && nested.length) walk(nested, { ...ctx, path, parent: full });
      } else if (has('CSSNestedDeclarations') && r instanceof (globalThis as any).CSSNestedDeclarations) {
        if (ctx.parent) push((r as any).style, r, '&', ctx.parent, path, ctx);
      } else if (r instanceof CSSMediaRule) {
        const text = r.media.mediaText;
        walk(r.cssRules, { ...ctx, path, conditions: [...ctx.conditions, `@media ${text}`], active: ctx.active && mediaMatches(text) });
      } else if (r instanceof CSSSupportsRule) {
        walk(r.cssRules, { ...ctx, path, conditions: [...ctx.conditions, `@supports ${r.conditionText}`], active: ctx.active && supports(r.conditionText) });
      } else if (has('CSSLayerBlockRule') && r instanceof CSSLayerBlockRule) {
        const name = r.name || `<anon-${anon++}>`;
        const full = ctx.layer ? `${ctx.layer}.${name}` : name;
        regLayer(full);
        walk(r.cssRules, { ...ctx, path, conditions: [...ctx.conditions, `@layer ${r.name}`], layer: full });
      } else if (has('CSSLayerStatementRule') && r instanceof CSSLayerStatementRule) {
        for (const n of r.nameList) regLayer(ctx.layer ? `${ctx.layer}.${n}` : n);
      } else if (r instanceof CSSImportRule) {
        let sub: CSSStyleSheet | null = null;
        try {
          sub = r.styleSheet;
          if (sub) void sub.cssRules;
        } catch {
          sub = null;
        }
        if (!sub) continue;
        const media = r.media ? r.media.mediaText : '';
        const lname = (r as CSSImportRule & { layerName?: string | null }).layerName;
        let layer = ctx.layer;
        if (lname != null) {
          const n = lname || `<anon-${anon++}>`;
          layer = ctx.layer ? `${ctx.layer}.${n}` : n;
          regLayer(layer);
        }
        walk(sub.cssRules, {
          ...ctx,
          ownerSheet: sub,
          path,
          conditions: media ? [...ctx.conditions, `@import ${media}`] : ctx.conditions,
          layer,
          active: ctx.active && mediaMatches(media),
        });
      } else if (has('CSSContainerRule') && r instanceof (globalThis as any).CSSContainerRule) {
        walk((r as CSSGroupingRule).cssRules, { ...ctx, path, conditions: [...ctx.conditions, `@container ${(r as any).conditionText}`] });
      }
    }
  };

  const sheets = Array.from(document.styleSheets);
  sheets.forEach((sheet, sheetIndex) => {
    if (sheet.disabled || skipSheet(sheet)) return;
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      return;
    }
    const media = sheet.media ? sheet.media.mediaText : '';
    walk(list, { topSheet: sheet, ownerSheet: sheet, sheetIndex, path: [], conditions: [], layer: null, parent: null, active: mediaMatches(media) });
  });

  const seen = new Map<string, number>();
  for (const r of rules) {
    r.layerRank = r.layer == null ? Infinity : layerOrder.get(r.layer) ?? 0;
    const key = `${r.sheetIndex}|${r.fullSelector}|${r.conditions.join('|')}`;
    r.ordinal = seen.get(key) ?? 0;
    seen.set(key, r.ordinal + 1);
  }
  return { rules, layerOrder };
}

export interface Matched {
  fr: FlatRule;
  spec: Spec;
}

/** 交互态伪类：点选元素时鼠标正停在上面，不能把 :hover 规则当成元素的常态样式 */
const INTERACTIVE = /:(hover|active|focus|focus-visible|focus-within)(?![\w-])/;

export function matchRules(el: Element, idx: RuleIndex): Matched[] {
  return matchAmong(el, idx.rules);
}

/** 只匹配伪元素的分支（*, ::before, ::placeholder 里的后两段）哪个元素都命中不了，不用试 */
function testsOf(fr: FlatRule): string[] {
  return (fr.tests ??= fr.branches.filter((b) => !INTERACTIVE.test(b) && !subjectOf(b).never));
}

/** 规则按「最后一段选择器写着的类名、标签名」分好组：元素没有那个类、不是那个标签的规则不用试；loose 是哪个元素都得试的 */
function lookupOf(idx: RuleIndex): RuleLookup {
  if (idx.lookup) return idx.lookup;
  const byClass = new Map<string, FlatRule[]>();
  const byTag = new Map<string, FlatRule[]>();
  const loose: FlatRule[] = [];
  // 怪异模式下类名不分大小写，按类名查会漏掉
  const exact = document.compatMode !== 'BackCompat';
  const put = (map: Map<string, FlatRule[]>, key: string, fr: FlatRule) => {
    const list = map.get(key);
    if (!list) map.set(key, [fr]);
    else if (list[list.length - 1] !== fr) list.push(fr);
  };
  for (const fr of idx.rules) {
    if (!fr.active) continue;
    const subjects = testsOf(fr).map(subjectOf);
    if (!subjects.length) continue;
    if (!exact || subjects.some((s) => s.cls === null && s.tag === null)) {
      loose.push(fr);
      continue;
    }
    for (const s of subjects) {
      if (s.cls !== null) put(byClass, s.cls, fr);
      else put(byTag, s.tag!, fr);
    }
  }
  return (idx.lookup = { byClass, byTag, loose });
}

/** 元素可能命中的规则：哪个元素都得试的，加上它的标签名和类名带出来的；没有带出来的就是 loose 本身（不要改它） */
function candidatesFor(el: Element, idx: RuleIndex): FlatRule[] {
  const { byClass, byTag, loose } = lookupOf(idx);
  let rules: FlatRule[] | null = null;
  const add = (list: FlatRule[] | undefined) => {
    if (!list) return;
    rules ??= loose.slice();
    for (const fr of list) rules.push(fr);
  };
  // 标签名在 HTML 里不分大小写，SVG 的分（linearGradient）：都按小写查，多带出来的由 matches 筛掉
  add(byTag.get(el.localName.toLowerCase()));
  for (const cls of el.classList) add(byClass.get(cls));
  if (!rules) return loose;
  // 按样式表里的顺序排回去；选择器列表里有两段都对得上这个元素的规则会出现两次，只留一个
  (rules as FlatRule[]).sort((a, b) => a.order - b.order);
  return (rules as FlatRule[]).filter((fr, i, all) => i === 0 || fr !== all[i - 1]);
}

/** 试这个元素要过几条规则（估算一批差不多的元素要花多少时间用） */
export function candidateCount(el: Element, idx: RuleIndex): number {
  return candidatesFor(el, idx).length;
}

/**
 * 结果和 matchRules 一样，只试元素的标签名、类名可能命中的规则：一次要算很多元素（同源元素）时用。
 * spend 在动手之前拿到要试几回选择器（一条规则的选择器列表里有几段就试几回），调用的人据此记账，不想算了就在里面抛出
 */
export function matchRulesQuick(el: Element, idx: RuleIndex, spend?: (tests: number) => void): Matched[] {
  const rules = candidatesFor(el, idx);
  if (spend) {
    let tests = 0;
    for (const fr of rules) if (fr.active) tests += testsOf(fr).length;
    spend(tests);
  }
  return matchAmong(el, rules);
}

function matchAmong(el: Element, rules: FlatRule[]): Matched[] {
  const out: Matched[] = [];
  for (const fr of rules) {
    if (!fr.active) continue;
    let best: Spec | null = null;
    for (const sel of testsOf(fr)) {
      let ok = false;
      try {
        ok = el.matches(sel);
      } catch {
        ok = false;
      }
      if (ok) {
        const s = specificityOf(sel);
        if (!best || compareSpec(s, best) > 0) best = s;
      }
    }
    if (best) out.push({ fr, spec: best });
  }
  return out;
}

function namesOf(fr: { style: CSSStyleDeclaration; names?: Map<string, number> }): Map<string, number> {
  if (!fr.names) {
    const m = new Map<string, number>();
    for (let i = 0; i < fr.style.length; i++) m.set(fr.style[i], i);
    fr.names = m;
  }
  return fr.names;
}

export interface DeclRead {
  value: string;
  important: boolean;
  /** 在规则里的声明顺序，用于同一规则内物理/逻辑属性的先后 */
  index: number;
  via: string;
  shorthand: string | null;
}

/**
 * 读取声明的钩子：预览会临时改写规则和内联样式，快照要读改写前的原值。
 * 返回 'absent' 表示该属性是预览加进去的、原本不存在；返回 null 表示没被预览动过，直接读。
 * index 是改写前在声明块里的位置（删属性的预览把声明去掉了，规则里已经找不到它）
 */
export type Reader = (style: CSSStyleDeclaration, prop: string) => { value: string; priority: string; index?: number } | 'absent' | null;

const plain = (style: CSSStyleDeclaration, prop: string) => ({ value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) });
const plainReader: Reader = () => null;

/** 读一条规则对某个物理属性的声明（含逻辑别名和简写），没有声明返回 null */
export function readDecl(fr: { style: CSSStyleDeclaration; names?: Map<string, number> }, prop: string, reader: Reader = plainReader): DeclRead | null {
  const names = namesOf(fr);
  let best: DeclRead | null = null;
  for (const alias of aliasesOf(prop)) {
    const got = reader(fr.style, alias);
    if (got === 'absent') continue;
    const idx = got?.index ?? names.get(alias);
    if (idx === undefined) continue;
    const r = got ?? plain(fr.style, alias);
    let value = r.value;
    let shorthand: string | null = null;
    let important = r.priority === 'important';
    if (value === '') {
      for (const sh of shorthandsOf(alias)) {
        const sg = reader(fr.style, sh);
        const s = sg === 'absent' ? { value: '', priority: '' } : sg ?? plain(fr.style, sh);
        if (s.value) {
          value = s.value;
          shorthand = sh;
          important = s.priority === 'important';
          break;
        }
      }
      if (value === '') continue;
    }
    const d: DeclRead = { value, important, index: idx, via: alias, shorthand };
    if (!best || d.index > best.index) best = d;
  }
  return best;
}

export interface Winner {
  decl: DeclRead;
  fr: FlatRule | null;
  inline: boolean;
}

/**
 * 按层叠顺序挑出某属性的胜出声明：重要性 → 内联 → 层 → 优先级 → 出现顺序。
 * inline 为 false 时不看元素的内联样式，只在命中的规则里挑（命中同样规则的元素结果一样，可以共用）
 */
export function pickWinner(el: Element, matched: Matched[], prop: string, reader: Reader = plainReader, inline = true): Winner | null {
  let best: { w: Winner; key: number[] } | null = null;
  const consider = (w: Winner, key: number[]) => {
    if (!best) {
      best = { w, key };
      return;
    }
    for (let i = 0; i < key.length; i++) {
      if (key[i] !== best.key[i]) {
        if (key[i] > best.key[i]) best = { w, key };
        return;
      }
    }
    best = { w, key };
  };

  for (const m of matched) {
    const d = readDecl(m.fr, prop, reader);
    if (!d) continue;
    const rank = d.important ? -m.fr.layerRank : m.fr.layerRank;
    consider({ decl: d, fr: m.fr, inline: false }, [d.important ? 1 : 0, 0, rank, m.spec[0], m.spec[1], m.spec[2], m.fr.order, d.index]);
  }

  const inlineStyle = inline ? (el as HTMLElement).style : null;
  if (inlineStyle && inlineStyle.length) {
    const d = readDecl({ style: inlineStyle }, prop, reader);
    if (d && d.value !== '') consider({ decl: d, fr: null, inline: true }, [d.important ? 1 : 0, 1, 0, 0, 0, 0, Infinity, d.index]);
  }
  return best ? (best as { w: Winner }).w : null;
}
