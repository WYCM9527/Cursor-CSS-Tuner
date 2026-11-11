import { aliasesOf, PROP_NAMES, propMeta, type PropLink } from '@css-tuner/protocol';
import { candidateCount, matchRulesQuick, pickWinner, readDecl, type FlatRule, type Matched, type Reader, type RuleIndex, type Winner } from './cascade';
import { isTailwindSheet } from './util';

/**
 * 一批「同伴」元素（同一段代码渲染出来的几个，或者同一条规则命中的几个），改其中一个时哪些跟着变：只有「写法相同」的，
 * 也就是这个属性的值在它们身上由同一处声明决定。三张卡片的内边距都来自 p-6，一起变；中间那张的底色来自 featured 分支里的
 * bg-stone-900，另外两张来自 bg-white，各变各的。
 *
 * 同伴可能有几千个（长列表、大表格），不能每个元素、每个属性都把层叠算一遍：命中的规则和内联样式都相同的元素「形状」一样，
 * 层叠只算一次；形状相同、父元素那边的结果也相同的元素归到同一个「结点」，比较只在结点之间做。
 */

/** 属性的值由哪处声明决定：by 是规则，或者内联样式里写的值（值相同算同一种写法）；own 表示声明就落在元素自己身上，不是从祖先继承来的 */
export interface Decider {
  by: FlatRule | string;
  own: boolean;
}

/** 元素自己没定，要看父元素（没写，或者写的是 inherit） */
const UP = Symbol('up');
/** 一个属性在元素自己身上由谁决定：规则、内联样式的值、看父元素，或者没设置（null，就是初始值） */
type Local = FlatRule | string | typeof UP | null;

const INHERITS = PROP_NAMES.map((p) => !!propMeta(p)?.inherited);
/** 声明的属性名（含逻辑别名）→ 面板上那个属性的序号 */
const TRACKED = new Map<string, number>();
PROP_NAMES.forEach((p, i) => {
  for (const name of aliasesOf(p)) TRACKED.set(name, i);
});

interface Shape {
  id: number;
  local: Local[];
  /** 有属性要看父元素 */
  up: boolean;
  /** 这种形状的元素命中的规则 */
  matched: Matched[];
}

interface Node {
  id: number;
  shape: Shape;
  parent: Node | null;
  /** 各属性的结果，用到时才算 */
  deciders: Array<Decider | null | undefined>;
}

/** 一次计算里共用的东西：规则、读预览之前原值的钩子、算过的元素和形状不重复算 */
export interface LinkScope {
  idx: RuleIndex;
  reader: Reader;
  /** 元素原来的 style 属性（预览改写之前的），没有时为 null */
  inlineOf: (el: Element) => string | null;
  matched: Map<Element, Matched[]>;
  shapes: Map<string, Shape>;
  /** 一段内联样式动到了哪些属性 */
  touched: Map<string, number[]>;
  nodes: Map<Element, Node>;
  interned: Map<string, Node>;
  /** 还能花多少份（见 MAX_TESTS） */
  budget: number;
}

/**
 * 一次快照在这上面最多花这么多份，花完了剩下的就不算，照旧全部一起变。拿一个元素去试一回选择器算一份。
 * 实测（Chromium）一份不到 0.1 微秒，四十万份约 30 毫秒；一个元素要试几百回、选择器多过浏览器缓存得住的（256 个）时
 * 一份 0.3 微秒，约 120 毫秒。算到的元素是同伴加上它们各自的祖先（共用的祖先只算一遍）。
 * Tailwind 页面一个元素要试十回上下：同一个父元素下的长列表够两万个同伴，各有各的父元素的一万个，style 各不相同的六千个；
 * 同一个类名被三百条规则用到的样式表，一千个上下
 */
const MAX_TESTS = 400000;
/** 每算一个元素，试选择器之外的开销（找出要试的规则、读 style、查表）折合的份数 */
const ELEMENT_COST = 8;
/** 新算一种形状（把每个属性的胜出声明挑一遍）折合的份数；只是内联样式不同的形状只重挑它写到的那几个属性 */
const SHAPE_COST = 300;
const STYLE_SHAPE_COST = 25;

/** 额度花完了：这一批同伴不算了 */
class OverBudget extends Error {}

function spend(scope: LinkScope, cost: number) {
  if (cost > scope.budget) throw new OverBudget();
  scope.budget -= cost;
}

/**
 * matched 可以带上已经算好的元素（快照里选中元素和它的祖先）。
 * limited：快照里算分组用，有额度；预览和核对照着快照定下的分组做，不限
 */
export function linkScope(idx: RuleIndex, reader: Reader, inlineOf: (el: Element) => string | null, matched = new Map<Element, Matched[]>(), limited = false): LinkScope {
  return { idx, reader, inlineOf, matched, shapes: new Map(), touched: new Map(), nodes: new Map(), interned: new Map(), budget: limited ? MAX_TESTS : Infinity };
}

function matchedFor(el: Element, scope: LinkScope): Matched[] {
  let m = scope.matched.get(el);
  if (!m) {
    m = matchRulesQuick(el, scope.idx, (tests) => spend(scope, tests + ELEMENT_COST));
    scope.matched.set(el, m);
  }
  return m;
}

/** 命中的规则（和命中时的优先级）一样的元素，只在规则里挑的结果一样 */
function matchedKey(matched: Matched[]): string {
  let key = '';
  for (const m of matched) key += m.fr.branches.length > 1 ? `${m.fr.order}/${m.spec.join('.')},` : `${m.fr.order},`;
  return key;
}

/**
 * 胜出的声明算谁决定的：没写（或写的是 inherit）时，可继承的属性看父元素；不可继承的属性没写就是初始值。
 * 内联样式按值算：同一段代码里写着同样的 style 值的元素是同一种写法
 */
function classify(w: Winner | null, i: number): Local {
  if (!w) return INHERITS[i] ? UP : null;
  const v = w.decl.value;
  if (v === 'inherit' || (INHERITS[i] && v === 'unset')) return UP;
  return w.inline ? `style=${v}${w.decl.important ? ' !important' : ''}` : w.fr!;
}

let scratch: CSSStyleDeclaration | null = null;

/** 这段内联样式给哪些属性写了值（简写按展开后的算） */
function touchedBy(text: string, scope: LinkScope): number[] {
  let t = scope.touched.get(text);
  if (!t) {
    scratch ??= document.createElement('div').style;
    scratch.cssText = text;
    const set = new Set<number>();
    for (let i = 0; i < scratch.length; i++) {
      const at = TRACKED.get(scratch[i]);
      if (at !== undefined) set.add(at);
    }
    t = [...set];
    scope.touched.set(text, t);
  }
  return t;
}

function shapeOf(el: Element, scope: LinkScope): Shape {
  const matched = matchedFor(el, scope);
  const key = matchedKey(matched);
  let base = scope.shapes.get(key);
  if (!base) {
    spend(scope, SHAPE_COST);
    const local = PROP_NAMES.map((prop, i) => classify(pickWinner(el, matched, prop, scope.reader, false), i));
    base = { id: scope.shapes.size, local, up: local.includes(UP), matched };
    scope.shapes.set(key, base);
  }
  const text = scope.inlineOf(el);
  const touched = text ? touchedBy(text, scope) : [];
  if (!touched.length) return base;
  // 内联样式只动得了它写到的属性：这几个连着内联样式重新挑，其余的和只看规则时一样
  const own = `${key}\n${text}`;
  let shape = scope.shapes.get(own);
  if (!shape) {
    spend(scope, STYLE_SHAPE_COST);
    const local = base.local.slice();
    for (const i of touched) local[i] = classify(pickWinner(el, matched, PROP_NAMES[i], scope.reader), i);
    shape = { id: scope.shapes.size, local, up: local.includes(UP), matched };
    scope.shapes.set(own, shape);
  }
  return shape;
}

/** 元素的结点：形状没有要看父元素的属性时不用管祖先；否则一路往上，算过的祖先直接接上 */
function nodeOf(el: Element, scope: LinkScope): Node {
  const chain: Array<{ el: Element; shape: Shape }> = [];
  let parent: Node | null = null;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const known = scope.nodes.get(cur);
    if (known) {
      parent = known;
      break;
    }
    const shape = shapeOf(cur, scope);
    chain.push({ el: cur, shape });
    if (!shape.up) break;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const { el: e, shape } = chain[i];
    const up = shape.up ? parent : null;
    const key = `${shape.id}/${up ? up.id : ''}`;
    let node = scope.interned.get(key);
    if (!node) {
      node = { id: scope.interned.size, shape, parent: up, deciders: [] };
      scope.interned.set(key, node);
    }
    scope.nodes.set(e, node);
    parent = node;
  }
  return parent!;
}

function decide(node: Node, i: number): Decider | null {
  let d = node.deciders[i];
  if (d === undefined) {
    const local = node.shape.local[i];
    if (local === UP) {
      const up = node.parent ? decide(node.parent, i) : null;
      d = up && up.own ? { by: up.by, own: false } : up;
    } else d = local === null ? null : { by: local, own: true };
    node.deciders[i] = d;
  }
  return d;
}

/** 都没设置也算相同；一个写在自己身上、一个是继承来的不算（改自己的类名改不到继承的那个） */
function sameDecider(a: Decider | null, b: Decider | null): boolean {
  return a ? !!b && a.by === b.by && a.own === b.own : !b;
}

/** peers 里这几个属性都和 el 写法相同的元素（el 自己总在里面）；不是面板上的属性不比 */
export function linkedTo(el: Element, peers: Element[], props: string[], scope: LinkScope): Element[] {
  const at = props.map((p) => PROP_NAMES.indexOf(p)).filter((i) => i >= 0);
  const mine = nodeOf(el, scope);
  const same = new Map<Node, boolean>([[mine, true]]);
  return peers.filter((peer) => {
    if (peer === el) return true;
    const node = nodeOf(peer, scope);
    let ok = same.get(node);
    if (ok === undefined) {
      ok = at.every((i) => sameDecider(decide(mine, i), decide(node, i)));
      same.set(node, ok);
    }
    return ok;
  });
}

function clip(s: string): string {
  if (s.length <= 96) return s;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.slice(0, 64)}…${(h >>> 0).toString(36)}`;
}

/** 决定这个属性的那处声明的标识：同一组里的元素算出来一样，用来把不同组的改动分开记；不含 | 和 ~（改动的标识用它们分段） */
function signature(d: Decider | null): string {
  if (!d) return 'none';
  const up = d.own ? '' : '^';
  if (typeof d.by === 'string') return `${up}${clip(d.by)}`.replace(/[|~]/g, '¦');
  const { fullSelector, conditions, ordinal } = d.by;
  return `${up}${clip(`${fullSelector}${conditions.length ? ` {${conditions.join(' ')}}` : ''}`)}${ordinal ? `#${ordinal}` : ''}`.replace(/[|~]/g, '¦');
}

/**
 * 同一个结点的元素每个属性都一样：先按结点数个数，比较在结点之间做。
 * 只有一个同伴、或者额度不够算完这一批时返回 null。动手之前先粗估一下：光是还没算过的同伴自己（按 el 要试的规则数算）就超了的，
 * 一份都不花，额度留给后面小一些的批；祖先要试多少到时候才知道，中途超了就停下
 */
function groupByNode(el: Element, peers: Element[], scope: LinkScope): { mine: Node; sizes: Map<Node, number> } | null {
  if (peers.length < 2) return null;
  let fresh = 0;
  for (const peer of peers) if (!scope.nodes.has(peer)) fresh++;
  if (fresh * (candidateCount(el, scope.idx) + ELEMENT_COST) > scope.budget) return null;
  try {
    const mine = nodeOf(el, scope);
    const sizes = new Map<Node, number>();
    for (const peer of peers) {
      const node = peer === el ? mine : nodeOf(peer, scope);
      sizes.set(node, (sizes.get(node) ?? 0) + 1);
    }
    return { mine, sizes };
  } catch (e) {
    if (e instanceof OverBudget) return null;
    throw e;
  }
}

/**
 * 各属性和 el 写法相同的同伴有哪些；skip 返回 true 的属性不列。
 * set：跟着变的元素完全相同的属性编成同一个号（一次改几个属性时，同号的记成一条改动）
 */
function linksAmong(mine: Node, sizes: Map<Node, number>, total: number, skip: (i: number, others: Node[]) => boolean): Record<string, PropLink> {
  const out: Record<string, PropLink> = {};
  const nodes = [...sizes.keys()];
  const sets = new Map<string, number>();
  PROP_NAMES.forEach((prop, i) => {
    const d = decide(mine, i);
    let n = 0;
    let members = '';
    const others: Node[] = [];
    nodes.forEach((node, k) => {
      if (node !== mine && !sameDecider(d, decide(node, i))) {
        others.push(node);
        return;
      }
      n += sizes.get(node)!;
      members += `${k},`;
    });
    if (n >= total || skip(i, others)) return;
    let set = sets.get(members);
    if (set === undefined) sets.set(members, (set = sets.size + 1));
    out[prop] = { n, by: signature(d), set, ...(d && !d.own ? { inherited: true } : {}) };
  });
  return out;
}

/**
 * 哪些属性只和一部分同伴写法相同（见 PropLink）。都相同的属性不列；
 * 只有一个元素、或者同伴多到算不起时返回 undefined
 */
export function linksOf(el: Element, peers: Element[], scope: LinkScope): Record<string, PropLink> | undefined {
  const groups = groupByNode(el, peers, scope);
  if (!groups) return undefined;
  return groups.sizes.size === 1 ? {} : linksAmong(groups.mine, groups.sizes, peers.length, () => false);
}

/** 往 rule 里加一条普通声明，会不会盖掉这个结点上属性 i 现在的值 */
function overrides(rule: FlatRule, node: Node, i: number, scope: LinkScope): boolean {
  const local = node.shape.local[i];
  // 元素自己没写：加上去的声明直接生效
  if (local === UP || local === null) return true;
  // 内联样式盖过规则里的普通声明
  if (typeof local === 'string') return false;
  if (local === rule) return true;
  const added = node.shape.matched.find((m) => m.fr === rule);
  const now = node.shape.matched.find((m) => m.fr === local);
  if (!added || !now || readDecl(local, PROP_NAMES[i], scope.reader)?.important) return false;
  const a = [rule.layerRank, ...added.spec, rule.order];
  const b = [local.layerRank, ...now.spec, local.order];
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return true;
}

/**
 * 往规则 rule 里给某个属性加声明时，rule 命中的元素 peers 里只该有一部分跟着变的属性（见 ElementSnapshot.ruleLinks）：
 * 有同伴和 el 写法不同（比如颜色是从另一个外层继承来的），加上去的声明又会盖掉它现在的值。
 * 写法不同、但加上去的声明盖不住它的（它有更具体的规则）不算：直接改规则它也不会变。
 * 只看 el 自己没写的属性（要加声明的就是这种）；Tailwind 页面上被预设样式定下的也算没写
 */
export function ruleLinksOf(el: Element, peers: Element[], rule: FlatRule, scope: LinkScope): Record<string, PropLink> | undefined {
  const groups = groupByNode(el, peers, scope);
  if (!groups || groups.sizes.size === 1) return undefined;
  const { mine, sizes } = groups;
  const out = linksAmong(mine, sizes, peers.length, (i, others) => {
    const local = mine.shape.local[i];
    if (typeof local === 'string' || (local !== UP && local !== null && !isTailwindSheet(local.topSheet))) return true;
    return !others.some((node) => overrides(rule, node, i, scope));
  });
  return Object.keys(out).length ? out : undefined;
}
