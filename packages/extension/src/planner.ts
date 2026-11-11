import {
  activeSegment,
  PROP_NAMES,
  t,
  type ElementSnapshot,
  type OrderUnit,
  type PageInfo,
  type PreviewTarget,
  type PropLink,
  type RuleRef,
  type Scope,
  type SheetInfo,
  type SourceLoc,
  type Target,
  type TextOrigin,
} from '@css-tuner/protocol';
import type { MessageRef, OrderSite, PropSite, PropSiteInfo, TextSite } from '@css-tuner/engine';
import type { ProjectResolver } from './project';
import type { LiteralInfo, SiteInfo } from './sites';

/** 改动在代码里的位置，写进给 Agent 的提示词 */
export type WriteSpec =
  | {
      kind: 'tailwind';
      file: string;
      line: number;
      column: number;
      /** 当前生效的工具类（含变体），没有时表示新增类名 */
      utility: string | null;
      /** 含 @import "tailwindcss" 的 CSS 入口，用来加载项目的设计系统 */
      entry: string | null;
      /** (line, column) 是类名字符串字面量（变体、cva 基础类、类名常量） */
      literal?: boolean;
      /** 在调用处追加覆盖类，只改这一处实例 */
      override?: boolean;
    }
  | {
      kind: 'css';
      file: string;
      selector: string;
      fullSelector: string;
      conditions: string[];
      ordinal: number;
      /** edit：改命中规则里的声明；add：往元素自己的规则里加声明 */
      mode: 'edit' | 'add';
      /** 值来自哪个声明（简写 / 逻辑别名），引擎据此决定改哪一条 */
      via: string | null;
    }
  /** Tailwind 主题变量：改 @theme 里的声明，项目没声明过就加一条 */
  | { kind: 'theme'; file: string; name: string }
  /** (line, column) 处 JSX 元素的文字子节点，segment 是运行时 children 数组里的下标 */
  | { kind: 'jsxText'; file: string; line: number; column: number; segment: number }
  /** (line, column) 处 JSX 元素上的属性，如组件调用处的 title="..." */
  | { kind: 'jsxAttr'; file: string; line: number; column: number; name: string }
  /** 多语言 JSON 文件里的一条消息 */
  | { kind: 'message'; file: string; keyPath: string[] }
  /** 同一个父元素下的兄弟换序：sites 是各项在 JSX 里的位置（按页面上原来的顺序），新顺序第 k 个位置放原来的第 order[k] 项 */
  | { kind: 'jsxOrder'; file: string; sites: OrderSite[]; order: number[] }
  /** .map() 渲染的列表换序：(line, column) 是 map 回调里那一项的 JSX，引擎顺着找到数组字面量；count 是页面上的项数 */
  | { kind: 'arrayOrder'; file: string; line: number; column: number; count: number; order: number[] }
  /** 纯 HTML：path 是元素从 <html> 起逐层的子元素下标，tag 用来确认文件和页面对得上 */
  | { kind: 'htmlText'; file: string; path: number[]; tag: string; segment: number }
  /** 纯 HTML 换序：path 是父元素的，tags 是参与换序的子元素标签（按页面上原来的顺序） */
  | { kind: 'htmlOrder'; file: string; path: number[]; tags: string[]; order: number[] }
  /** (line, column) 处组件调用上的属性，值是任意字面量；tag 是组件名，列号对不上时用来确认找对了元素 */
  | { kind: 'jsxProp'; file: string; line: number; column: number; name: string; tag?: string }
  | { kind: 'agent'; reason: string };

export interface Plan {
  view: Target;
  preview: PreviewTarget;
  write: WriteSpec;
  /** 改这个属性只动一部分同伴（同源元素，或者规则命中的元素）：预览和改动只算这一组 */
  link?: PlanLink;
}

export interface PlanLink {
  /** 这一组的标识，记进改动的标识里：同一处代码上不同组的改动分开记 */
  key: string;
  /** 一次改几个属性时，group 相同的属性跟着变的是同一批元素，记成一条改动 */
  group: string;
  /** 这处代码渲染出的元素数；rule 为真时是规则命中的元素数 */
  total: number;
  /** 现在的值是继承来的，元素自己没写 */
  inherited: boolean;
  /** 按写法分的组：值由同一处声明决定的才一起变（见 ElementSnapshot.links） */
  byValue: boolean;
  /** 按类名字符串分的组：这个类在好几段里都写着（条件分支），只改元素用的这一段。值是这一段的类名 */
  segment?: string;
  /** 同伴是规则命中的元素（往 CSS 规则里加声明） */
  rule?: boolean;
}

export interface PlanContext {
  page: PageInfo;
  project: ProjectResolver;
  /** instance：尽量只改这一处实例；source：改组件定义 / 变体，所有用到的地方一起变 */
  scope: Scope;
  /** JSX 位置上 className 的静态信息，读不到或解析不了时为 null */
  classSite: (file: string, line: number, column: number) => SiteInfo | null;
  /** 文件里写类名的字符串字面量（变体、cva 基础类、类名常量） */
  classLiterals: (file: string) => LiteralInfo[] | null;
  /** 规则实际所在的文件（入口样式表 @import 进来的文件）和源文件里的选择器写法，找不到时为 null */
  ruleSource: (entry: string, ref: RuleRef) => { file: string; selector: string } | null;
  /** 类名是不是项目设计系统里的工具类（设计系统没加载时当作不是） */
  isUtility: (candidate: string) => boolean;
  /** 项目装的 Tailwind 主版本，不是 Tailwind 项目时为 null */
  tailwindMajor?: number | null;
}

/** Tailwind 4 的工具类都在 @layer utilities 里；不在层里的类名规则（v3 全都不在层里）要按设计系统认 */
function utilityOf(ref: RuleRef, ctx: PlanContext): string | null {
  if (!ref.utility) return null;
  return ref.layer !== null || ctx.isUtility(ref.utility) ? ref.utility : null;
}

interface ClassWriteSite {
  file: string;
  line: number;
  column: number;
  affects: number;
  /** 0 是元素自己的组件，n 是第 n 层组件调用处 */
  depth: number;
  label: string;
  literal: boolean;
  override: boolean;
  /** 写在变体字符串里：预览只作用于带这个类的同源元素 */
  withClass?: string;
  /** 这个类在好几段类名字符串里都写着，只改元素用的那一段 */
  branch?: Branch;
}

interface Branch {
  /** 写着这个类的几段各自的类名 */
  segs: string[][];
  /** 元素用的是 segs 里的第几段 */
  at: number;
  /** 这一段在这处代码里的序号（变体字符串自己就是位置，没有） */
  index?: number;
  /** 是哪几段、用的哪一段：一样的属性跟着变的是同一批元素 */
  id: string;
}

/** 类名 token 写在 segs 的好几段里时，元素（带着 classes 这些类）用的是哪一段；只写在一段里就不用分 */
function branchOf(segs: string[][], token: string, classes: string[]): Branch | undefined {
  const holding = segs.map((tokens, index) => ({ tokens, index })).filter((s) => s.tokens.includes(token));
  if (holding.length < 2) return undefined;
  const at = activeSegment(holding.map((s) => s.tokens), (c) => classes.includes(c));
  return { segs: holding.map((s) => s.tokens), at, index: holding[at].index, id: `${holding.map((s) => s.index).join('.')}/${at}` };
}

const FRAMEWORK_LAYERS = new Set(['theme', 'base', 'properties']);

function sheetOf(page: PageInfo, ref: RuleRef): SheetInfo | undefined {
  return page.sheets.find((s) => s.index === ref.sheet.index);
}

function isFramework(page: PageInfo, ref: RuleRef, ctx: PlanContext): boolean {
  const s = sheetOf(page, ref);
  if (!s?.tailwind) return false;
  if (ref.layer !== null) return FRAMEWORK_LAYERS.has(ref.layer.split('.')[0]);
  // Tailwind 3 不保留 @layer：预设样式（preflight）这类框架生成的规则，在 CSS 入口里找不到对应的写法
  if (ctx.tailwindMajor !== 3 || utilityOf(ref, ctx)) return false;
  const file = ctx.project.sheetFile(page.url, ref.sheet);
  return !file || !ctx.ruleSource(file, ref);
}

/** 页面上 Tailwind 样式表对应的 CSS 入口文件 */
export function tailwindEntry(page: PageInfo, project: ProjectResolver): string | null {
  for (const s of page.sheets) {
    if (!s.tailwind || (!s.devId && !s.href)) continue;
    const f = project.sheetFile(page.url, s);
    if (f) return f;
  }
  return null;
}

/** 嵌套规则显示展开后的选择器：`& .row` → `.panel .row` */
export function prettySelector(ref: RuleRef): string {
  if (!ref.selector.includes('&')) return ref.selector;
  return ref.fullSelector.replace(/:is\(([^(),]+)\)/g, '$1');
}

export function sourceKeyOf(el: ElementSnapshot): string | null {
  return el.source ? `${el.source.path}:${el.source.line}:${el.source.column}` : null;
}

/** 给选中元素的某个属性找到代码位置、决定预览方式；值来自作者写的声明时标上 declared（面板上可以删） */
export function plan(el: ElementSnapshot, prop: string, ctx: PlanContext): Plan {
  const p = planTarget(el, prop, ctx);
  const w = el.winners[prop];
  const declared = w?.origin === 'inline' || (w?.origin === 'rule' && !!w.rule && !isFramework(ctx.page, w.rule, ctx));
  return declared ? { ...p, view: { ...p.view, declared: true } } : p;
}

/**
 * 「只改这个」和「全部」有没有区别：有属性在两种范围下写到不同的地方时，返回选「全部」会改到几个元素；
 * 两种范围都写到同一处时为 null，面板就不给这个选项。current 是当前范围下已经算好的目标
 */
export function scopeAll(el: ElementSnapshot, ctx: PlanContext, current?: Record<string, Target>): number | null {
  if (!el.source || !el.callers?.length) return null;
  const other: PlanContext = { ...ctx, scope: ctx.scope === 'instance' ? 'source' : 'instance' };
  let n = 0;
  for (const prop of PROP_NAMES) {
    const now = current?.[prop] ?? planTarget(el, prop, ctx).view;
    const alt = planTarget(el, prop, other).view;
    if (now.label !== alt.label) n = Math.max(n, (ctx.scope === 'source' ? now : alt).affects, 1);
  }
  return n || null;
}

function planTarget(el: ElementSnapshot, prop: string, ctx: PlanContext): Plan {
  const { page, project } = ctx;
  const pageUrl = page.url;
  const w = el.winners[prop];
  const srcFile = el.source ? project.fileFor(pageUrl, el.source.path, el.source.file) : null;
  const srcLabel = srcFile && el.source ? `${project.label(srcFile)}:${el.source.line} ${classAttr(srcFile)}` : '';
  const inline: PreviewTarget = { kind: 'inline', uid: el.uid, sourceKey: sourceKeyOf(el) };
  const instanceAffects = el.source ? el.sameSource : 1;
  const twPage = page.sheets.some((s) => s.tailwind);
  // 同源元素里只有一部分和选中的写法相同（类名写在条件分支里、style 里的值不一样、值是从不同的外层继承来的）
  const partial = inline.sourceKey ? el.links?.[prop] : undefined;
  const valueLink = (link: PropLink, total: number): PlanLink => ({ key: link.by, group: String(link.set), total, inherited: !!link.inherited, byValue: true });

  const agent = (reason: string, preview: PreviewTarget = { kind: 'inline', uid: el.uid, sourceKey: null }): Plan => ({
    view: { kind: 'agent', label: t('plan.agent'), affects: preview.kind === 'inline' && preview.sourceKey ? instanceAffects : 1, reason },
    preview,
    write: { kind: 'agent', reason },
  });

  /**
   * 找不到具体写在哪、但知道是哪段代码渲染的（style 属性、没有对应规则的元素）：Agent 改的是那段代码，同源元素一起预览；
   * 只有一部分写法相同时只带上这一部分。没算过写法（只有一个元素、同源元素太多）就只预览选中的这个
   */
  const together = (reason: string): Plan => {
    if (!inline.sourceKey || !el.links) return agent(reason);
    if (!partial) return agent(reason, inline);
    const p = agent(reason, { ...inline, linked: [prop] });
    return { ...p, view: { ...p.view, affects: Math.min(instanceAffects, partial.n) }, link: valueLink(partial, instanceAffects) };
  };

  /**
   * 类名写在哪：元素自己的 JSX、外层组件调用处（经 className 参数传进来）、或定义文件里的变体字符串。
   * instance 范围下，组件用 cn / twMerge 合并类名时，在调用处追加覆盖类，只改这一处实例。
   */
  const classSite = (utility: string | null): ClassWriteSite | { reason: string } => {
    const own: ClassWriteSite = { file: srcFile!, line: el.source!.line, column: el.source!.column, affects: instanceAffects, depth: 0, label: srcLabel, literal: false, override: false };
    const ownInfo = ctx.classSite(own.file, own.line, own.column);
    const callers = (el.callers ?? []).flatMap((c, i) => {
      const file = project.fileFor(pageUrl, c.source.path, c.source.file);
      const info = file ? ctx.classSite(file, c.source.line, c.source.column) : null;
      return file && info ? [{ c, depth: i + 1, file, info }] : [];
    });
    type Caller = (typeof callers)[number];
    const atCaller = (x: Caller, override: boolean): ClassWriteSite => ({
      file: x.file,
      line: x.c.source.line,
      column: x.c.source.column,
      affects: x.c.same,
      depth: x.depth,
      label: `${project.label(x.file)}:${x.c.source.line} <${x.c.component ?? t('plan.component')}> ${classAttr(x.file)}${override ? t('plan.override') : ''}`,
      literal: false,
      override,
    });
    // 调用处写的类会落到这个元素上：字面量里的类都在元素上；或调用处没写 className，而组件把 className 参数传了下去
    const passes = (x: Caller) =>
      x.info.tokens.length ? x.info.tokens.every((t) => el.classes.includes(t)) : x.depth === 1 && !x.info.hasClassName && !!ownInfo?.passesClassName;
    // 变体字符串：含这个类、且其余类大多也在元素上（排除别的变体）；同分取靠后的，cn / cva 里后写的覆盖先写的
    const literalIn = (file: string, depth: number, token: string): ClassWriteSite | null => {
      const holding = (ctx.classLiterals(file) ?? []).filter((l) => l.tokens.includes(token)).sort((a, b) => a.line - b.line || a.column - b.column);
      const best = holding
        .map((l) => ({ l, s: l.tokens.filter((t) => el.classes.includes(t)).length / l.tokens.length }))
        .filter((x) => x.s >= 0.5)
        .sort((a, b) => b.s - a.s || b.l.line - a.l.line || b.l.column - a.l.column)[0]?.l;
      if (!best) return null;
      return {
        file,
        line: best.line,
        column: best.column,
        affects: el.classCounts?.[token] ?? instanceAffects,
        depth,
        label: `${project.label(file)}:${best.line} ${best.name || t('plan.classString')}`,
        literal: true,
        override: false,
        withClass: token,
        // 好几个变体都写着这个类：带着它的同源元素里，只有用这个变体的跟着变
        ...(holding.length > 1
          ? { branch: { segs: holding.map((l) => l.tokens), at: holding.indexOf(best), id: `${holding.map((l) => `${l.line}:${l.column}`).join('.')}/${holding.indexOf(best)}` } }
          : {}),
      };
    };
    const recipeBase = (): ClassWriteSite | null => {
      const r = ownInfo?.recipe;
      if (!r) return null;
      const lit = ctx.classLiterals(own.file)?.find((l) => l.line === r.line && l.column === r.column);
      return { ...own, line: r.line, column: r.column, label: `${project.label(own.file)}:${r.line} ${lit?.name || t('plan.componentBase')}`, literal: true };
    };

    if (!utility) {
      if (ctx.scope === 'instance') {
        const x = callers.find((x) => passes(x) && x.c.same <= own.affects);
        if (x) return atCaller(x, false);
      }
      if (ownInfo?.hasClassName && !ownInfo.tokens.length) return recipeBase() ?? own;
      return own;
    }

    // 同一个类在三元的两个分支里都写着时，只改元素用的那个分支
    const inBranch = (site: ClassWriteSite, info: SiteInfo | null): ClassWriteSite => {
      const branch = info ? branchOf(info.segments, utility, el.classes) : undefined;
      return branch ? { ...site, branch } : site;
    };
    let where: ClassWriteSite | null = null;
    if (!ownInfo || ownInfo.tokens.includes(utility)) where = inBranch(own, ownInfo);
    else {
      const x = callers.find((x) => x.info.tokens.includes(utility));
      if (x) where = inBranch(atCaller(x, false), x.info);
    }
    where ??= literalIn(own.file, 0, utility);
    for (const x of callers) where ??= literalIn(x.file, x.depth, utility);
    if (!where) return { reason: t('plan.utilityNowhere', { cls: utility }) };

    if (ctx.scope === 'instance' && where.depth === 0 && where.affects > 1 && ownInfo?.merges) {
      const narrower = callers.find((x) => passes(x) && x.c.same < where!.affects);
      if (narrower) return atCaller(narrower, true);
    }
    return where;
  };

  const tailwind = (utility: string | null): Plan => {
    if (!srcFile || !el.source) return agent(t('plan.noJsxSource'));
    const site = classSite(utility);
    if ('reason' in site) return agent(site.reason);
    // 只带上和选中的写法相同、类名又来自同一段字符串的那一部分同源元素
    const { branch } = site;
    const preview: PreviewTarget = {
      ...inline,
      ...(site.depth ? { depth: site.depth } : {}),
      ...(site.withClass ? { withClass: site.withClass } : {}),
      ...(partial ? { linked: [prop] } : {}),
      ...(branch ? { segs: branch.segs, seg: branch.at } : {}),
    };
    // 规划时只能估个数（这一段的类名里最少见的那个有几个元素带着），记进改动时按预览实际作用到的算
    const affects = Math.min(site.affects, partial?.n ?? site.affects, ...(branch ? branch.segs[branch.at].map((c) => el.classCounts?.[c] ?? site.affects) : []));
    const link: PlanLink | undefined =
      partial || branch
        ? {
            key: `${partial ? partial.by : ''}${branch?.index !== undefined ? `@${branch.index}` : ''}`,
            group: `${partial ? partial.set : ''}${branch ? `@${branch.id}` : ''}`,
            total: site.affects,
            inherited: !!partial?.inherited,
            byValue: !!partial,
            ...(branch ? { segment: branch.segs[branch.at].join(' ') } : {}),
          }
        : undefined;
    return {
      view: { kind: 'tailwind', label: site.label, file: site.file, line: site.line, column: site.column, affects },
      ...(link ? { link } : {}),
      preview,
      write: {
        kind: 'tailwind',
        file: site.file,
        line: site.line,
        column: site.column,
        utility,
        entry: tailwindEntry(page, project),
        ...(site.literal ? { literal: true } : {}),
        ...(site.override ? { override: true } : {}),
      },
    };
  };

  /**
   * some：往规则里加声明、而规则命中的元素里只有一部分和选中的写法相同（比如颜色是从不同的外层继承来的）。
   * 直接改规则会让它们全都变，预览改成只作用于这一部分，交给 Agent 时说清只改这几个
   */
  const css = (ref: RuleRef, mode: 'edit' | 'add', via: string | null, some?: PropLink): Plan => {
    const file = project.sheetFile(pageUrl, ref.sheet);
    if (!file) return agent(t('plan.noRuleFile'), { kind: 'rule', rule: ref, uid: el.uid });
    const src = ctx.ruleSource(file, ref);
    const real = src?.file ?? file;
    return {
      view: { kind: 'css', label: `${project.label(real)} ${src?.selector ?? prettySelector(ref)}`, file: real, affects: some ? Math.min(ref.matchCount, some.n) : ref.matchCount },
      ...(some ? { link: { ...valueLink(some, ref.matchCount), rule: true } } : {}),
      preview: some ? { kind: 'inline', uid: el.uid, sourceKey: null, among: ref.fullSelector, linked: [prop] } : { kind: 'rule', rule: ref, uid: el.uid },
      write: { kind: 'css', file, selector: ref.selector, fullSelector: ref.fullSelector, conditions: ref.conditions, ordinal: ref.ordinal, mode, via },
    };
  };

  if (w?.origin === 'inline') return together(t('plan.inlineStyle'));

  if (w?.origin === 'rule' && w.rule && !isFramework(page, w.rule, ctx)) {
    const utility = utilityOf(w.rule, ctx);
    if (utility) return tailwind(utility);
    if (/^\s*>|:has\(|:hover|:focus/.test(w.rule.selector) && w.rule.matchCount > 1 && sheetOf(page, w.rule)?.tailwind) {
      return agent(t('plan.parentTwSelector'));
    }
    return css(w.rule, 'edit', w.via);
  }

  // 没有作者声明（继承、初始值或只命中了 Tailwind 预设样式）：Tailwind 项目加类名，CSS 项目加到元素自己的规则里
  if (twPage && el.source && srcFile) return tailwind(null);
  const own = ownRule(el, page, ctx, (r) => !utilityOf(r, ctx) && !!project.sheetFile(pageUrl, r.sheet));
  if (own) return css(own, 'add', null, el.ruleLinks?.[el.rules.indexOf(own)]?.[prop]);
  return together(t('plan.noWritableRule'));
}

/**
 * 同一处代码的标识：Tailwind 是 JSX 调用位置，CSS 是那条规则，找不到位置的是元素。
 * 后面可能接 `~这一组的记号`（见 groupMark），所以标识里的 ~ 后面一定还有 |：文件路径、选择器后面都还有别的段，
 * 元素的源码位置排在最后，里面的 ~ 换掉
 */
export function siteKey(p: Plan, el: ElementSnapshot): string {
  const w = p.write;
  if (w.kind === 'tailwind') return `tw|${w.file}|${w.line}|${w.column}`;
  if (w.kind === 'css') return `css|${w.file}|${w.fullSelector}|${w.conditions.join('|')}|${w.ordinal}`;
  if (w.kind === 'theme') return `theme|${w.file}|${w.name}`;
  if (p.preview.kind === 'rule') return `agent|rule|${p.preview.rule.sheet.index}|${p.preview.rule.fullSelector}|${p.preview.rule.conditions.join('|')}|${p.preview.rule.ordinal}`;
  return `agent|${(sourceKeyOf(el) ?? el.uid).replace(/~/g, '¦')}`;
}

/** 这一组的记号：改这个属性只动一部分同伴时（类名写在条件分支里、值是从不同的外层继承来的），各组的改动分开记 */
export const groupMark = (p: Plan | undefined) => (p?.link?.key ? `~${p.link.key}` : '');

/** 样式改动记在哪：代码位置，加上这一组的记号。改动的标识是它后面接 `|属性`（见 records 的 siteOfKey） */
export function targetKey(p: Plan, el: ElementSnapshot): string {
  return `${siteKey(p, el)}${groupMark(p)}`;
}

/** 只带上写法相同的同伴的预览：一条改动管几个属性，就要这几个属性都相同 */
export function linkedPreview(preview: PreviewTarget, props: string[]): PreviewTarget {
  return preview.kind === 'inline' && preview.linked ? { ...preview, linked: [...props].sort() } : preview;
}

/**
 * 按代码位置分组：同一组的属性记成一条改动。同一处代码上跟着变的元素不一样的属性分开记
 * （四边的描边色里上边只有选中的这个用、另外三边还有别的元素也用：上边一条，另外三边一条）。
 * tk 是这一组改动记在哪（见 targetKey），记号取排在最前面的属性的：同一组里各属性由不同的声明决定时记号不一样
 */
export function groupByTarget(planOf: (prop: string) => Plan | undefined, el: ElementSnapshot, props: string[]): Array<{ tk: string; plan: Plan; props: string[] }> {
  const groups = new Map<string, { plan: Plan; props: string[] }>();
  for (const prop of props) {
    const p = planOf(prop);
    if (!p) continue;
    const k = `${siteKey(p, el)}~${p.link?.group ?? ''}`;
    const g = groups.get(k) ?? { plan: p, props: [] };
    g.props.push(prop);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({
    tk: targetKey(planOf([...g.props].sort()[0])!, el),
    plan: { ...g.plan, preview: linkedPreview(g.plan.preview, g.props) },
    props: g.props,
  }));
}

/**
 * 改元素用到的 CSS 变量：预览改定义它的那条规则，页面上用到它的地方一起变；
 * 代码里要改的是定义处，Tailwind 的主题变量在 @theme 里。
 */
export function planVar(el: ElementSnapshot, name: string, ctx: PlanContext): Plan {
  const { page, project } = ctx;
  const w = el.winners[name];
  const agent = (reason: string, preview: PreviewTarget = { kind: 'inline', uid: el.uid, sourceKey: null }): Plan => ({
    view: { kind: 'agent', label: t('plan.agent'), affects: 1, reason },
    preview,
    write: { kind: 'agent', reason },
  });
  if (!w || w.origin === 'initial') return agent(t('plan.varNotFound'));
  if (!w.rule) return agent(t('plan.varInline'));
  const preview: PreviewTarget = { kind: 'rule', rule: w.rule, uid: el.uid };
  const file = project.sheetFile(page.url, w.rule.sheet);
  if (!file) return agent(t('plan.varNoFile'), preview);
  if (sheetOf(page, w.rule)?.tailwind && w.rule.layer?.split('.')[0] === 'theme') {
    return { view: { kind: 'css', label: `${project.label(file)} @theme ${name}`, file, affects: 0 }, preview, write: { kind: 'theme', file, name } };
  }
  if (isFramework(page, w.rule, ctx)) return agent(t('plan.varInPreset'), preview);
  const src = ctx.ruleSource(file, w.rule);
  const real = src?.file ?? file;
  return {
    view: { kind: 'css', label: `${project.label(real)} ${src?.selector ?? prettySelector(w.rule)} ${name}`, file: real, affects: 0 },
    preview,
    write: { kind: 'css', file, selector: w.rule.selector, fullSelector: w.rule.fullSelector, conditions: w.rule.conditions, ordinal: w.rule.ordinal, mode: 'edit', via: null },
  };
}

export interface TextPlan extends Plan {
  origin: TextOrigin;
  /** 文字来自翻译调用、但没找到对应的多语言文件时，交给 Agent 附上那段调用 */
  code?: string;
}

export interface TextContext {
  page: PageInfo;
  project: ProjectResolver;
  /** (line, column) 处 JSX 元素的第 index 个子节点；文件读不到时为 null */
  textChild: (file: string, line: number, column: number, index: number) => TextSite | { error: string } | null;
  textAttr: (file: string, line: number, column: number, name: string) => TextSite | { error: string } | null;
  /** 在 near 所属的项目里找消息对应的多语言文件和键；langs 是页面语言的线索，靠前的优先 */
  message: (near: string, ref: MessageRef, text: string, langs: ReadonlyArray<string | null>) => { file: string; keyPath: string[] } | { reason: string };
}

/** 地址第一段像语言代码（/zh/、/en-US/）时返回它：按语言分路由的站点里，<html lang> 可能写死在根布局里 */
export function routeLocale(url: string): string | null {
  let seg: string;
  try {
    seg = new URL(url).pathname.split('/')[1] ?? '';
  } catch {
    return null;
  }
  if (!/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(seg)) return null;
  try {
    return Intl.getCanonicalLocales(seg.replace(/_/g, '-'))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 元素第 segment 段文字写在哪：纯 HTML 文件、元素自己 JSX 里的字面量或 t() 调用、
 * 外层组件调用处传进来的 prop（children 或属性）；都不是就交给 Agent，并说明文字来自哪段代码
 */
export function planText(el: ElementSnapshot, segment: number, ctx: TextContext): TextPlan {
  const { page, project } = ctx;
  const info = el.text;
  const seg = info?.segments[segment];
  const text = seg?.value.trim() ?? '';
  const preview: PreviewTarget = { kind: 'text', uid: el.uid, sourceKey: sourceKeyOf(el), segment };
  const agent = (reason: string): TextPlan => ({
    origin: 'dynamic',
    view: { kind: 'agent', label: t('plan.agent'), affects: el.source ? el.sameSource : 1, reason },
    preview,
    write: { kind: 'agent', reason },
  });
  if (!info || !seg) return agent(t('plan.text.none'));

  if (!el.source && info.htmlPath) {
    const file = project.htmlFileFor(page.url);
    if (!file) return agent(t('plan.text.noHtmlFile'));
    return {
      origin: 'html',
      view: { kind: 'source', label: `${project.label(file)} <${el.tag}>`, file, affects: 1 },
      preview: { kind: 'text', uid: el.uid, sourceKey: null, segment, htmlPath: info.htmlPath },
      write: { kind: 'htmlText', file, path: info.htmlPath, tag: el.tag, segment },
    };
  }
  if (!el.source) return agent(t('plan.noJsxSource'));
  if (isSfc(el.source.path)) return agent(t('plan.sfc.cssOnly'));

  /** 这一层位置写着的文字：字面量直接改，t() 调用改多语言文件；动态的记下原因，接着往外层找 */
  const reasons: string[] = [];
  let code: string | undefined;
  const at = (site: TextSite | { error: string } | null, file: string, loc: SourceLoc, depth: number, affects: number, write: WriteSpec, label: string): TextPlan | null => {
    if (!site || 'error' in site) return null;
    const p: PreviewTarget = depth ? { ...preview, depth } : preview;
    if (site.kind === 'literal') {
      if (site.value.trim() === text) {
        return { origin: depth || el.source!.viaOwner ? 'prop' : 'jsx', view: { kind: 'source', label, file, line: loc.line, column: loc.column, affects }, preview: p, write };
      }
      reasons.push(t('engine.text.changed', { now: site.value.trim().slice(0, 40) }));
      return null;
    }
    if (site.kind === 'message') {
      const m = ctx.message(file, site.ref, text, [routeLocale(page.url), info.lang]);
      if ('reason' in m) {
        if (!reasons.length) code = site.code;
        reasons.push(m.reason);
        return null;
      }
      return {
        origin: 'message',
        view: { kind: 'source', label: `${project.label(m.file)} ${m.keyPath.join('.')}`, file: m.file, affects },
        preview: p,
        write: { kind: 'message', file: m.file, keyPath: m.keyPath },
      };
    }
    reasons.push(t('plan.text.dynamic', { code: site.code }));
    return null;
  };

  const own = project.fileFor(page.url, el.source.path, el.source.file);
  if (own && seg.child !== null) {
    const { line, column } = el.source;
    const found = at(ctx.textChild(own, line, column, seg.child), own, el.source, 0, el.sameSource, { kind: 'jsxText', file: own, line, column, segment: seg.child }, `${project.label(own)}:${line}`);
    if (found) return found;
  }
  for (const p of seg.props) {
    const caller = p.depth ? el.callers[p.depth - 1] : null;
    const loc = caller ? caller.source : el.source;
    const file = project.fileFor(page.url, loc.path, loc.file);
    if (!file) continue;
    const affects = caller ? caller.same : el.sameSource;
    const where = `${project.label(file)}:${loc.line} <${caller?.component ?? el.source.component ?? t('plan.component')}>`;
    const found =
      p.name === 'children'
        ? at(ctx.textChild(file, loc.line, loc.column, p.child ?? 0), file, loc, p.depth, affects, { kind: 'jsxText', file, line: loc.line, column: loc.column, segment: p.child ?? 0 }, `${where} children`)
        : at(ctx.textAttr(file, loc.line, loc.column, p.name), file, loc, p.depth, affects, { kind: 'jsxAttr', file, line: loc.line, column: loc.column, name: p.name }, `${where} ${p.name}`);
    if (found) return found;
  }
  const fallback = agent(reasons[0] ?? t('plan.text.unknown'));
  return code ? { ...fallback, code } : fallback;
}

/** 文字改动的标识：同一处源码（同一个字面量、同一条消息）上的改动合并成一条 */
export function textKey(p: Plan, el: ElementSnapshot, segment: number): string {
  const w = p.write;
  if (w.kind === 'jsxText') return `text|jsx|${w.file}|${w.line}|${w.column}|${w.segment}`;
  if (w.kind === 'jsxAttr') return `text|attr|${w.file}|${w.line}|${w.column}|${w.name}`;
  if (w.kind === 'message') return `text|msg|${w.file}|${w.keyPath.join('.')}`;
  if (w.kind === 'htmlText') return `text|html|${w.file}|${w.path.join('.')}|${w.segment}`;
  return `text|agent|${sourceKeyOf(el) ?? el.uid}|${segment}`;
}

/** 文字折成一行：面板和改动清单里都按一行显示和比较 */
export const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export interface OrderContext {
  page: PageInfo;
  project: ProjectResolver;
  /** 这几处 JSX 是不是同一个父元素下的几项；文件读不到时为 null */
  jsxOrder: (file: string, sites: OrderSite[]) => { ok: true; parent: string; line: number; column: number } | { error: string } | null;
  /** .map() 列表对应的数组字面量在哪；文件读不到时为 null */
  arraySite: (file: string, line: number, column: number, count: number) => { file: string; line: number; column: number; name: string } | { error: string } | null;
}

export interface OrderPlan {
  view: Target;
  /** 改动的标识：同一组兄弟上的换序合并成一条 */
  key: string;
  units: OrderUnit[];
  preview: (order: number[]) => PreviewTarget;
  write: (order: number[]) => WriteSpec;
}

const locOf = (s: SourceLoc) => `${s.path}:${s.line}:${s.column}`;

/** Vue / Svelte 组件：只定位样式（类名和样式块），文字、换序和属性让 Agent 自己找 */
const isSfc = (path: string) => /\.(?:vue|svelte)(?:[?#]|$)/i.test(path);

/** 标签上显示的类名属性名 */
const classAttr = (file: string) => (isSfc(file) ? 'class' : 'className');

/**
 * 选中元素所在兄弟组的换序写到哪：纯 HTML 改 HTML 文件，.map() 渲染的列表改数组字面量，
 * 写死的兄弟改 JSX；都不行就交给 Agent，并说明原因
 */
export function planOrder(el: ElementSnapshot, ctx: OrderContext): OrderPlan | null {
  const info = el.order;
  if (!info || info.units.length < 2) return null;
  const { page, project } = ctx;
  const anchor = el.source ? { path: el.source.path, line: el.source.line, column: el.source.column, index: el.sourceIndex } : undefined;
  const preview = (order: number[]): PreviewTarget => ({
    kind: 'order',
    uid: el.uid,
    order,
    mapped: info.mapped,
    ...(anchor ? { anchor } : {}),
    ...(info.htmlPath ? { htmlPath: info.htmlPath } : {}),
  });
  const units = info.units;
  const agent = (reason: string, key: string): OrderPlan => ({
    key,
    units,
    preview,
    view: { kind: 'agent', label: t('plan.agent'), affects: 1, reason },
    write: () => ({ kind: 'agent', reason }),
  });
  const parentLabel = el.breadcrumb[el.breadcrumb.length - 2]?.label ?? 'body';

  if (info.htmlPath) {
    const path = info.htmlPath.slice(0, -1);
    const file = project.htmlFileFor(page.url);
    if (!file) return agent(t('plan.text.noHtmlFile'), `order|html|?|${path.join('.')}`);
    const tags = units.map((u) => u.name);
    return {
      key: `order|html|${file}|${path.join('.')}`,
      units,
      preview,
      view: { kind: 'source', label: `${project.label(file)} <${parentLabel}>`, file, affects: 1 },
      write: (order) => ({ kind: 'htmlOrder', file, path, tags, order }),
    };
  }

  const fallbackKey = `order|agent|${units.map((u) => (u.source ? locOf(u.source) : u.uids[0])).join(',')}`;
  if (el.source && isSfc(el.source.path)) return agent(t('plan.sfc.cssOnly'), fallbackKey);
  if (info.mapped) {
    const src = units[0].source;
    const file = src ? project.fileFor(page.url, src.path, src.file) : null;
    if (!src || !file) return agent(t('plan.order.noSource'), `order|map|${info.mapped}`);
    const a = ctx.arraySite(file, src.line, src.column, units.length);
    if (!a || 'error' in a) return agent(a ? a.error : t('engine.readFailed', { file }), `order|map|${info.mapped}`);
    return {
      key: `order|array|${a.file}|${a.line}|${a.column}`,
      units,
      preview,
      view: { kind: 'source', label: `${project.label(a.file)}:${a.line} ${a.name}`, file: a.file, line: a.line, column: a.column, affects: 1 },
      write: (order) => ({ kind: 'arrayOrder', file, line: src.line, column: src.column, count: units.length, order }),
    };
  }

  const files = units.map((u) => (u.source ? project.fileFor(page.url, u.source.path, u.source.file) : null));
  if (files.some((f) => !f)) return agent(t('plan.order.noSource'), fallbackKey);
  const file = files[0]!;
  if (files.some((f) => f !== file)) return agent(t('plan.order.files'), fallbackKey);
  const sites: OrderSite[] = units.map((u) => ({ line: u.source!.line, column: u.source!.column, name: u.name }));
  const check = ctx.jsxOrder(file, sites);
  if (!check || 'error' in check) return agent(check ? check.error : t('engine.readFailed', { file }), fallbackKey);
  return {
    key: `order|jsx|${file}|${sites.map((s) => `${s.line}:${s.column}`).join(',')}`,
    units,
    preview,
    view: { kind: 'source', label: `${project.label(file)}:${check.line} ${check.parent}`, file, line: check.line, column: check.column, affects: 1 },
    write: (order) => ({ kind: 'jsxOrder', file, sites, order }),
  };
}

export interface PropContext {
  page: PageInfo;
  project: ProjectResolver;
  /** (line, column) 处组件调用上属性 name 的写法；文件读不到时为 null */
  propSite: (file: string, line: number, column: number, name: string, tag?: string) => PropSiteInfo | { error: string } | null;
}

export interface PropPlan extends Plan {
  /** 调用处现在的写法，找不到位置时没有 */
  site?: PropSite;
  /** 调用处有 {...spread} 时的提醒 */
  warn?: string;
}

/** 组件属性写在哪：调用处写的字面量就地改，没写的加上；是表达式、或找不到调用处的交给 Agent */
export function planProp(el: ElementSnapshot, name: string, ctx: PropContext): PropPlan {
  const { page, project } = ctx;
  const info = el.props;
  const anchor = el.source ? { path: el.source.path, line: el.source.line, column: el.source.column, index: el.sourceIndex } : undefined;
  const preview: PreviewTarget = { kind: 'props', uid: el.uid, name, ...(anchor ? { anchor } : {}) };
  const affects = info?.same ?? 1;
  const agent = (reason: string): PropPlan => ({ view: { kind: 'agent', label: t('plan.agent'), affects, reason }, preview, write: { kind: 'agent', reason } });
  const loc = info?.source;
  const file = loc ? project.fileFor(page.url, loc.path, loc.file) : null;
  if (!info || !loc || !file) return agent(t('plan.prop.noSource'));
  const tag = info.component === '?' ? undefined : info.component;
  const site = ctx.propSite(file, loc.line, loc.column, name, tag);
  if (!site || 'error' in site) return agent(site ? site.error : t('engine.readFailed', { file }));
  if (site.site.kind === 'dynamic') return agent(t('engine.prop.dynamic', { name, code: oneLine(site.site.code).slice(0, 60) }));
  const warn = site.spread === 'after' ? t('plan.prop.spreadAfter') : site.spread === 'before' && site.site.kind === 'missing' ? t('plan.prop.spreadBefore') : undefined;
  return {
    view: { kind: 'source', label: `${project.label(file)}:${loc.line} <${info.component}> ${name}`, file, line: loc.line, column: loc.column, affects },
    preview,
    write: { kind: 'jsxProp', file, line: loc.line, column: loc.column, name, ...(tag ? { tag } : {}) },
    site: site.site,
    ...(warn ? { warn } : {}),
  };
}

/** 属性改动的标识：同一个调用处的同一个属性合并成一条 */
export function propKey(p: Plan, el: ElementSnapshot, name: string): string {
  const w = p.write;
  if (w.kind === 'jsxProp') return `prop|${w.file}|${w.line}|${w.column}|${w.name}`;
  return `prop|agent|${el.props?.source ? locOf(el.props.source) : (sourceKeyOf(el) ?? el.uid)}|${name}`;
}

/**
 * 加声明用的规则：最后一段选择器写着元素自己的类名或 id 的作者规则，优先级高的优先；
 * 不在 @media / @supports 这类条件里的优先，不然加的样式换个窗口宽度就没了
 */
function ownRule(el: ElementSnapshot, page: PageInfo, ctx: PlanContext, writable: (r: RuleRef) => boolean): RuleRef | null {
  const candidates = [...el.rules].reverse().filter((r) => !isFramework(page, r, ctx) && writable(r));
  const subject = (r: RuleRef) => r.fullSelector.split(/\s*[\s>+~]\s*/).pop() ?? '';
  const own = (r: RuleRef) => {
    const last = subject(r);
    return el.classes.some((c) => last.includes(`.${c}`)) || (!!el.id && last.includes(`#${el.id}`));
  };
  const always = (r: RuleRef) => r.conditions.every((c) => c.startsWith('@layer'));
  return candidates.find((r) => own(r) && always(r)) ?? candidates.find(own) ?? candidates.find(always) ?? candidates[0] ?? null;
}
