import { describe, expect, it } from 'vitest';
import type { CallerLoc, DeclWinner, ElementSnapshot, PageInfo, PreviewTarget, PropLink, RuleRef, SourceLoc } from '@css-tuner/protocol';
import { groupByTarget, groupMark, linkedPreview, plan, scopeAll, siteKey, targetKey, type Plan, type PlanContext } from '../src/planner';
import type { ProjectResolver } from '../src/project';
import { siteOfKey } from '../src/records';
import type { SiteInfo } from '../src/sites';

const rule = (over: Partial<RuleRef> = {}): RuleRef => ({
  sheet: { index: 0, devId: null, href: null },
  path: [0],
  selector: '.card',
  fullSelector: '.card',
  conditions: [],
  layer: null,
  ordinal: 0,
  matchCount: 2,
  utility: null,
  ...over,
});

const page: PageInfo = {
  url: 'http://localhost:5173/',
  title: '',
  react: true,
  vite: true,
  sheets: [{ index: 0, devId: null, href: null, inline: false, tailwind: false, ruleCount: 3 }],
  rootVars: [],
};

const ctx: PlanContext = {
  page,
  project: { label: (f: string) => f.replace('/repo/', ''), sheetFile: () => '/repo/src/app.css', fileFor: () => null } as unknown as ProjectResolver,
  scope: 'source',
  classSite: () => null,
  classLiterals: () => null,
  ruleSource: () => null,
  isUtility: () => false,
  tailwindMajor: null,
};

/** 纯 CSS 项目里的 section.card，rules 按层叠优先级从低到高 */
const card = (rules: RuleRef[]): ElementSnapshot => ({
  uid: 'u1',
  tag: 'section',
  id: null,
  classes: ['card'],
  label: 'section.card',
  rect: { x: 0, y: 0, w: 100, h: 100 },
  breadcrumb: [],
  children: [],
  source: null,
  sameSource: 1,
  sourceIndex: 0,
  callers: [],
  classCounts: {},
  computed: {},
  winners: {},
  vars: [],
  rules,
  inline: {},
  fontSizePx: 16,
  rootFontSizePx: 16,
});

describe('没声明过的属性加到哪条规则', () => {
  const wide = rule({ path: [5, 0], conditions: ['@media (min-width: 768px)'] });

  it('跳过 @media 里同名的规则，不然换个窗口宽度加的样式就没了', () => {
    const p = plan(card([rule(), wide]), 'border-top-width', ctx);
    expect(p.write).toMatchObject({ kind: 'css', mode: 'add', selector: '.card', conditions: [] });
  });

  it('@layer 不算条件；只有带条件的规则时照样加进去', () => {
    const layered = rule({ conditions: ['@layer components'], layer: 'components' });
    expect(plan(card([layered, wide]), 'border-top-width', ctx).write).toMatchObject({ mode: 'add', conditions: ['@layer components'] });
    expect(plan(card([wide]), 'border-top-width', ctx).write).toMatchObject({ mode: 'add', conditions: ['@media (min-width: 768px)'] });
  });
});

const loc = (path: string, line: number, component: string | null = null): SourceLoc => ({ url: `http://localhost:5173${path}`, path, file: `/repo${path}`, line, column: 5, component, viaOwner: false });
const site = (over: Partial<SiteInfo> = {}): SiteInfo => ({ tokens: [], segments: [], hasClassName: false, merges: false, passesClassName: false, recipe: null, ...over });

/** Tailwind 项目：源码路径 /src/x.tsx 对应 /repo/src/x.tsx，类名的静态信息由 classSite 给 */
const twCtx = (classSite: PlanContext['classSite'], over: Partial<PlanContext> = {}): PlanContext => ({
  ...ctx,
  page: { ...page, sheets: [{ index: 0, devId: '/src/index.css', href: null, inline: false, tailwind: true, ruleCount: 10 }] },
  project: { label: (f: string) => f.replace('/repo/', ''), sheetFile: () => '/repo/src/index.css', fileFor: (_url: string, path: string) => `/repo${path}` } as unknown as ProjectResolver,
  classSite,
  classLiterals: () => [],
  ...over,
});

/** 值来自工具类 cls 生成的规则 */
const fromUtility = (cls: string): DeclWinner => ({
  value: '',
  important: false,
  origin: 'rule',
  rule: rule({ selector: `.${cls}`, fullSelector: `.${cls}`, conditions: ['@layer utilities'], layer: 'utilities', utility: cls, matchCount: 3 }),
  inheritedFrom: null,
  via: null,
});

describe('「只改这个」和「全部」有没有区别', () => {
  /** Badge.tsx 第 3 行：<span className={cn('rounded-full', className)}>，App.tsx 第 15 行：<Badge /> */
  const sites: Record<string, SiteInfo> = {
    '/repo/src/Badge.tsx:3': site({ tokens: ['rounded-full'], hasClassName: true, merges: true, passesClassName: true }),
    '/repo/src/App.tsx:15': site(),
  };
  const tw = twCtx((f, line) => sites[`${f}:${line}`] ?? null, { scope: 'instance' });
  /** 页面上 3 个 Badge 里的 span */
  const badge = (callers: CallerLoc[]): ElementSnapshot => ({ ...card([]), tag: 'span', classes: ['rounded-full'], label: 'span.rounded-full', source: loc('/src/Badge.tsx', 3, 'Badge'), sameSource: 3, callers });
  const usedAt = (path: string, line: number): CallerLoc => ({ source: loc(path, line), component: 'Badge', same: 1 });

  it('组件用了 3 次、调用处能把类名传进来：两种范围写到不同地方，「全部」改 3 个', () => {
    const el = badge([usedAt('/src/App.tsx', 15)]);
    expect(plan(el, 'margin-top', tw).view.label).toBe('src/App.tsx:15 <Badge> className');
    expect(scopeAll(el, tw)).toBe(3);
    expect(scopeAll(el, { ...tw, scope: 'source' })).toBe(3);
  });

  it('没有外层调用处、或组件没把类名传下去：两种范围写到同一处，不给选', () => {
    expect(scopeAll(badge([]), tw)).toBeNull();
    const closed: PlanContext = { ...tw, classSite: (_f, line) => (line === 3 ? site({ tokens: ['rounded-full'], hasClassName: true }) : site()) };
    expect(scopeAll(badge([usedAt('/src/App.tsx', 15)]), closed)).toBeNull();
  });
});

describe('同源元素里只有一部分跟着变', () => {
  /** 页面上 3 个 Plan 卡片，都是 Plan.tsx 第 9 行渲染的；选中的是普通的那种 */
  const planCard = (classes: string[], over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
    ...card([]),
    tag: 'div',
    classes,
    label: `div.${classes[0]}`,
    source: loc('/src/Plan.tsx', 9, 'Plan'),
    sameSource: 3,
    ...over,
  });
  const inlineOf = (el: ElementSnapshot) => ({ kind: 'inline' as const, uid: el.uid, sourceKey: '/src/Plan.tsx:9:5' });
  const twWrite = { kind: 'tailwind', file: '/repo/src/Plan.tsx', line: 9, column: 5, entry: '/repo/src/index.css' };

  describe('Tailwind：两个分支的底色类不一样', () => {
    /** <div className={clsx('rounded-2xl p-6', featured ? 'bg-stone-900 text-white' : 'bg-white')}> */
    const segments = [['rounded-2xl', 'p-6'], ['bg-stone-900', 'text-white'], ['bg-white']];
    const tw = twCtx(() => site({ tokens: segments.flat(), segments, hasClassName: true }));
    const side = planCard(['rounded-2xl', 'p-6', 'bg-white'], {
      classCounts: { 'rounded-2xl': 3, 'p-6': 3, 'bg-white': 2, 'bg-stone-900': 1, 'text-white': 1 },
      winners: { 'background-color': fromUtility('bg-white'), 'padding-top': fromUtility('p-6') },
      links: { 'background-color': { n: 2, by: '.bg-white', set: 1 } },
    });

    it('底色只带上另一个写着 bg-white 的，改动按这一组记', () => {
      const p = plan(side, 'background-color', tw);
      expect(p.preview).toEqual({ ...inlineOf(side), linked: ['background-color'] });
      expect(p.view).toEqual({ kind: 'tailwind', label: 'src/Plan.tsx:9 className', file: '/repo/src/Plan.tsx', line: 9, column: 5, affects: 2, declared: true });
      expect(p.link).toEqual({ key: '.bg-white', group: '1', total: 3, inherited: false, byValue: true });
      expect(p.write).toEqual({ ...twWrite, utility: 'bg-white' });
      expect(targetKey(p, side)).toBe('tw|/repo/src/Plan.tsx|9|5~.bg-white');
    });

    it('三个都一样的内边距照旧一起变', () => {
      const p = plan(side, 'padding-top', tw);
      expect(p.preview).toEqual(inlineOf(side));
      expect(p.view.affects).toBe(3);
      expect(p).not.toHaveProperty('link');
      expect(targetKey(p, side)).toBe('tw|/repo/src/Plan.tsx|9|5');
    });

    it('没写过的属性（要加类名）也按写法分：文字颜色两个是继承来的，一个是分支里写的', () => {
      const inherited: DeclWinner = { value: 'rgb(28, 25, 23)', important: false, origin: 'inherited', rule: null, inheritedFrom: { uid: 'u0', label: 'body' }, via: null };
      const el = { ...side, winners: { ...side.winners, color: inherited }, links: { ...side.links, color: { n: 2, by: '^body', set: 1, inherited: true } } };
      const p = plan(el, 'color', tw);
      expect(p.preview).toEqual({ ...inlineOf(el), linked: ['color'] });
      expect(p.view).toMatchObject({ kind: 'tailwind', affects: 2 });
      expect(p.view).not.toHaveProperty('declared');
      expect(p.link).toEqual({ key: '^body', group: '1', total: 3, inherited: true, byValue: true });
      expect(p.write).toEqual({ ...twWrite, utility: null });
    });

    it('同源元素的写法没算过（只有一个、或者多到算不起）时照旧全部一起变', () => {
      const { links: _, ...uncounted } = side;
      const p = plan(uncounted, 'background-color', tw);
      expect(p.preview).toEqual(inlineOf(side));
      expect(p.view.affects).toBe(3);
      expect(p).not.toHaveProperty('link');
    });
  });

  describe('Tailwind：同一个类在两个分支里都写着', () => {
    /** <div className={clsx('rounded-2xl p-6', featured ? 'bg-white ring-2' : 'bg-white border')}> */
    const segments = [['rounded-2xl', 'p-6'], ['bg-white', 'ring-2'], ['bg-white', 'border']];
    const tw = twCtx(() => site({ tokens: [...new Set(segments.flat())], segments, hasClassName: true }));
    const counts = { 'rounded-2xl': 3, 'p-6': 3, 'bg-white': 3, border: 2, 'ring-2': 1 };
    const winners = { 'background-color': fromUtility('bg-white'), 'padding-top': fromUtility('p-6') };
    const side = planCard(['rounded-2xl', 'p-6', 'bg-white', 'border'], { classCounts: counts, winners, links: {} });
    const featured = planCard(['rounded-2xl', 'p-6', 'bg-white', 'ring-2'], { classCounts: counts, winners, links: {} });
    const segs = [['bg-white', 'ring-2'], ['bg-white', 'border']];

    it('只改元素用的那个分支：预览带上用同一段类名的，个数按这一段里最少见的类估', () => {
      const p = plan(side, 'background-color', tw);
      expect(p.preview).toEqual({ ...inlineOf(side), segs, seg: 1 });
      expect(p.view.affects).toBe(2);
      expect(p.link).toEqual({ key: '@2', group: '@1.2/1', total: 3, inherited: false, byValue: false, segment: 'bg-white border' });
      expect(targetKey(p, side)).toBe('tw|/repo/src/Plan.tsx|9|5~@2');
    });

    it('另一个分支的元素记成另一组', () => {
      const p = plan(featured, 'background-color', tw);
      expect(p.preview).toEqual({ ...inlineOf(featured), segs, seg: 0 });
      expect(p.view.affects).toBe(1);
      expect(p.link).toEqual({ key: '@1', group: '@1.2/0', total: 3, inherited: false, byValue: false, segment: 'bg-white ring-2' });
      expect(targetKey(p, featured)).toBe('tw|/repo/src/Plan.tsx|9|5~@1');
    });

    it('只写在一段里的类不分', () => {
      const p = plan(side, 'padding-top', tw);
      expect(p.preview).toEqual(inlineOf(side));
      expect(p).not.toHaveProperty('link');
    });

    it('同一个分支里还有写法不同的（style 里另写了底色）：两样都要对上', () => {
      const el = { ...side, links: { 'background-color': { n: 2, by: '.bg-white', set: 1 } } };
      const p = plan(el, 'background-color', tw);
      expect(p.preview).toEqual({ ...inlineOf(el), linked: ['background-color'], segs, seg: 1 });
      expect(p.view.affects).toBe(2);
      expect(p.link).toEqual({ key: '.bg-white@2', group: '1@1.2/1', total: 3, inherited: false, byValue: true, segment: 'bg-white border' });
    });
  });

  describe('Tailwind：类写在变体字符串里', () => {
    /**
     * Button.tsx：第 4 行 primary: 'bg-blue-600 text-white'，第 5 行 ghost: 'bg-transparent text-white'，
     * 第 8 行 <button className={cn('rounded', variants[variant])}>。页面上 4 个按钮，只有选中的这个是 ghost
     */
    const literals = [
      { line: 4, column: 14, name: 'variants.primary', tokens: ['bg-blue-600', 'text-white'] },
      { line: 5, column: 12, name: 'variants.ghost', tokens: ['bg-transparent', 'text-white'] },
    ];
    const tw = twCtx(() => site({ tokens: ['rounded'], segments: [['rounded']], hasClassName: true }), { classLiterals: () => literals });
    const ghost: ElementSnapshot = {
      ...card([]),
      tag: 'button',
      classes: ['rounded', 'bg-transparent', 'text-white'],
      label: 'button.rounded',
      source: loc('/src/Button.tsx', 8, 'Button'),
      sameSource: 4,
      classCounts: { rounded: 4, 'text-white': 4, 'bg-blue-600': 3, 'bg-transparent': 1 },
      winners: { color: fromUtility('text-white'), 'background-color': fromUtility('bg-transparent') },
      links: {},
    };

    it('两个变体都写着的类：只带上用这个变体的，改动记在这个变体的字符串上', () => {
      const p = plan(ghost, 'color', tw);
      expect(p.preview).toEqual({ kind: 'inline', uid: 'u1', sourceKey: '/src/Button.tsx:8:5', withClass: 'text-white', segs: literals.map((l) => l.tokens), seg: 1 });
      expect(p.view).toEqual({ kind: 'tailwind', label: 'src/Button.tsx:5 variants.ghost', file: '/repo/src/Button.tsx', line: 5, column: 12, affects: 1, declared: true });
      expect(p.link).toEqual({ key: '', group: '@4:14.5:12/1', total: 4, inherited: false, byValue: false, segment: 'bg-transparent text-white' });
      expect(p.write).toEqual({ kind: 'tailwind', file: '/repo/src/Button.tsx', line: 5, column: 12, utility: 'text-white', entry: '/repo/src/index.css', literal: true });
      // 变体字符串自己就是位置，不用再加记号
      expect(targetKey(p, ghost)).toBe('tw|/repo/src/Button.tsx|5|12');
    });

    it('只有一个变体写着的类：带着这个类的都跟着变', () => {
      const p = plan(ghost, 'background-color', tw);
      expect(p.preview).toEqual({ kind: 'inline', uid: 'u1', sourceKey: '/src/Button.tsx:8:5', withClass: 'bg-transparent' });
      expect(p.view.affects).toBe(1);
      expect(p).not.toHaveProperty('link');
    });
  });

  describe('CSS：往规则里加声明', () => {
    /** .title 命中 3 个标题，文字颜色没写过：两个从 .page 继承，一个从深色卡片继承 */
    const title = rule({ selector: '.title', fullSelector: '.title', matchCount: 3 });
    const inherited: DeclWinner = { value: 'rgb(28, 25, 23)', important: false, origin: 'inherited', rule: rule({ selector: '.page', fullSelector: '.page', matchCount: 1 }), inheritedFrom: { uid: 'u0', label: 'main.page' }, via: null };
    const h3 = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({ ...card([title]), tag: 'h3', classes: ['title'], label: 'h3.title', winners: { color: inherited }, ...over });
    const write = { kind: 'css', file: '/repo/src/app.css', selector: '.title', fullSelector: '.title', conditions: [], ordinal: 0, mode: 'add', via: null };

    it('规则命中的元素里只有一部分写法相同：预览只作用于这一部分，代码位置还是这条规则', () => {
      const el = h3({ ruleLinks: { 0: { color: { n: 2, by: '^.page', set: 1, inherited: true } } } });
      const p = plan(el, 'color', ctx);
      expect(p.preview).toEqual({ kind: 'inline', uid: 'u1', sourceKey: null, among: '.title', linked: ['color'] });
      expect(p.view).toEqual({ kind: 'css', label: 'src/app.css .title', file: '/repo/src/app.css', affects: 2 });
      expect(p.link).toEqual({ key: '^.page', group: '1', total: 3, inherited: true, byValue: true, rule: true });
      expect(p.write).toEqual(write);
      expect(targetKey(p, el)).toBe('css|/repo/src/app.css|.title||0~^.page');
    });

    it('都相同（没列出来）时直接改规则', () => {
      for (const el of [h3(), h3({ ruleLinks: { 0: { 'font-size': { n: 2, by: 'none', set: 1 } } } })]) {
        const p = plan(el, 'color', ctx);
        expect(p.preview).toEqual({ kind: 'rule', rule: title, uid: 'u1' });
        expect(p.view.affects).toBe(3);
        expect(p).not.toHaveProperty('link');
        expect(p.write).toEqual(write);
        expect(targetKey(p, el)).toBe('css|/repo/src/app.css|.title||0');
      }
    });

    it('按拿来加声明的那条规则查：别的规则的不算', () => {
      const some = { color: { n: 2, by: '^.page', set: 1, inherited: true } };
      const heading = rule({ selector: 'h3', fullSelector: 'h3', path: [1], matchCount: 5 });
      // 加到 .title 里（rules 里的第 2 条）：它命中的元素里只有一部分写法相同
      const second = { ...h3({ ruleLinks: { 1: some } }), rules: [heading, title] };
      expect(plan(second, 'color', ctx)).toMatchObject({ view: { affects: 2 }, preview: { kind: 'inline', among: '.title' }, link: { total: 3, rule: true } });
      // 只有 h3 那条规则命中的元素里写法不同：加到 .title 里的不受影响
      const other = { ...h3({ ruleLinks: { 0: some } }), rules: [heading, title] };
      expect(plan(other, 'color', ctx).preview).toEqual({ kind: 'rule', rule: title, uid: 'u1' });
    });

    it('改规则里已经写着的声明：规则命中的都跟着变，不分', () => {
      const own: DeclWinner = { value: '20px', important: false, origin: 'rule', rule: title, inheritedFrom: null, via: null };
      const el = h3({ winners: { 'font-size': own }, ruleLinks: { 0: { 'font-size': { n: 2, by: '.title', set: 1 } } } });
      const p = plan(el, 'font-size', ctx);
      expect(p.preview).toEqual({ kind: 'rule', rule: title, uid: 'u1' });
      expect(p.view).toMatchObject({ affects: 3, declared: true });
      expect(p).not.toHaveProperty('link');
    });
  });

  describe('找不到写在哪、交给 Agent 的（值写在 style 里）', () => {
    const styled: DeclWinner = { value: 'red', important: false, origin: 'inline', rule: null, inheritedFrom: null, via: null };
    const el = (over: Partial<ElementSnapshot> = {}) => planCard(['card'], { winners: { 'background-color': styled }, ...over });

    it('只有一部分 style 里写着同样的值：只带上这一部分', () => {
      const one = el({ links: { 'background-color': { n: 2, by: 'style=red', set: 1 } } });
      const p = plan(one, 'background-color', ctx);
      expect(p.preview).toEqual({ ...inlineOf(one), linked: ['background-color'] });
      expect(p.view).toMatchObject({ kind: 'agent', affects: 2, declared: true });
      expect(p.link).toEqual({ key: 'style=red', group: '1', total: 3, inherited: false, byValue: true });
      expect(p.write.kind).toBe('agent');
      expect(targetKey(p, one)).toBe('agent|/src/Plan.tsx:9:5~style=red');
    });

    it('都一样：同源元素一起预览', () => {
      const p = plan(el({ links: {} }), 'background-color', ctx);
      expect(p.preview).toEqual(inlineOf(el()));
      expect(p.view.affects).toBe(3);
      expect(p).not.toHaveProperty('link');
    });

    it('写法没算过、或者元素没有源码位置：只预览选中的这个', () => {
      for (const one of [el(), el({ source: null, links: { 'background-color': { n: 2, by: 'style=red', set: 1 } } })]) {
        const p = plan(one, 'background-color', ctx);
        expect(p.preview).toEqual({ kind: 'inline', uid: 'u1', sourceKey: null });
        expect(p.view.affects).toBe(1);
        expect(p).not.toHaveProperty('link');
      }
    });
  });
});

describe('样式改动记在哪', () => {
  const el: ElementSnapshot = { ...card([]), source: loc('/src/Plan.tsx', 9, 'Plan'), sameSource: 3 };
  const inline: PreviewTarget = { kind: 'inline', uid: 'u1', sourceKey: '/src/Plan.tsx:9:5' };
  const view = { kind: 'tailwind' as const, label: 'src/Plan.tsx:9 className', affects: 3 };
  /** Plan.tsx 第 9 行的 className 上的改动；link 是这个属性只和一部分同源元素写法相同 */
  const onClass = (prop: string, link?: PropLink): Plan => ({
    view,
    preview: link ? { ...inline, linked: [prop] } : inline,
    write: { kind: 'tailwind', file: '/repo/src/Plan.tsx', line: 9, column: 5, utility: null, entry: null },
    ...(link ? { link: { key: link.by, group: String(link.set), total: 3, inherited: false, byValue: true } } : {}),
  });
  const onRule = (over: Partial<RuleRef> = {}, link?: PropLink): Plan => {
    const r = rule(over);
    return {
      view: { kind: 'css', label: 'src/app.css', affects: 2 },
      preview: link ? { kind: 'inline', uid: 'u1', sourceKey: null, among: r.fullSelector, linked: ['opacity'] } : { kind: 'rule', rule: r, uid: 'u1' },
      write: { kind: 'css', file: '/repo/src/app.css', selector: r.selector, fullSelector: r.fullSelector, conditions: r.conditions, ordinal: r.ordinal, mode: 'add', via: null },
      ...(link ? { link: { key: link.by, group: String(link.set), total: 2, inherited: false, byValue: true, rule: true } } : {}),
    };
  };
  const toAgent = (preview: PreviewTarget, link?: PropLink): Plan => ({
    view: { kind: 'agent', label: 'Agent', affects: 1, reason: 'why' },
    preview,
    write: { kind: 'agent', reason: 'why' },
    ...(link ? { link: { key: link.by, group: String(link.set), total: 3, inherited: false, byValue: true } } : {}),
  });

  it('同一处代码一个标识；只动一部分同伴的再接上这一组的记号', () => {
    expect(siteKey(onClass('padding-top'), el)).toBe('tw|/repo/src/Plan.tsx|9|5');
    expect(targetKey(onClass('padding-top'), el)).toBe('tw|/repo/src/Plan.tsx|9|5');
    const some = onClass('background-color', { n: 2, by: '.bg-white', set: 1 });
    expect(siteKey(some, el)).toBe('tw|/repo/src/Plan.tsx|9|5');
    expect(groupMark(some)).toBe('~.bg-white');
    expect(targetKey(some, el)).toBe('tw|/repo/src/Plan.tsx|9|5~.bg-white');
    expect(groupMark(undefined)).toBe('');
    // 变体字符串上的改动有分组、没有记号
    expect(groupMark({ ...some, link: { ...some.link!, key: '' } })).toBe('');
  });

  it('各种代码位置', () => {
    const wide = { selector: '.a ~ .b', fullSelector: '.a ~ .b', conditions: ['@layer components', '@media (width >= 48rem)'], ordinal: 2 };
    expect(siteKey(onRule(wide), el)).toBe('css|/repo/src/app.css|.a ~ .b|@layer components|@media (width >= 48rem)|2');
    expect(siteKey({ ...onClass('color'), write: { kind: 'theme', file: '/repo/src/index.css', name: '--color-brand' } }, el)).toBe('theme|/repo/src/index.css|--color-brand');
    // 交给 Agent 的：有对应的规则按规则记，不然按元素的源码位置，再不然按元素
    expect(siteKey(toAgent({ kind: 'rule', rule: rule({ sheet: { index: 4, devId: null, href: null }, ordinal: 1 }), uid: 'u1' }), el)).toBe('agent|rule|4|.card||1');
    expect(siteKey(toAgent(inline), el)).toBe('agent|/src/Plan.tsx:9:5');
    expect(siteKey(toAgent({ kind: 'inline', uid: 'u1', sourceKey: null }), { ...el, source: null })).toBe('agent|u1');
  });

  it('从改动的标识里能取回代码位置：标识里的 ~ 后面都还有 |，和记号分得开', () => {
    const link: PropLink = { n: 2, by: 'none', set: 1 };
    const tilde: ElementSnapshot = { ...el, source: loc('/src/~lib/Plan.tsx', 9, 'Plan') };
    const inHome: Plan['write'] = { kind: 'tailwind', file: '/Users/me/~work/src/Plan.tsx', line: 9, column: 5, utility: null, entry: null };
    const cases: Array<[Plan, ElementSnapshot]> = [
      [onClass('color'), el],
      [onClass('color', link), el],
      [{ ...onClass('color'), write: inHome }, el],
      [{ ...onClass('color', link), write: inHome }, el],
      [onRule({ selector: '.a ~ .b', fullSelector: '.a ~ .b' }), el],
      [onRule({ selector: '.a ~ .b', fullSelector: '.a ~ .b' }, link), el],
      [onRule({ conditions: ['@container card (width > 1px)', '@supports (a: b)'] }, link), el],
      [toAgent(inline), el],
      [toAgent({ ...inline, linked: ['color'] }, { n: 2, by: 'style=red', set: 1 }), el],
      [toAgent({ ...inline, sourceKey: '/src/~lib/Plan.tsx:9:5' }), tilde],
      [toAgent({ ...inline, sourceKey: '/src/~lib/Plan.tsx:9:5', linked: ['color'] }, link), tilde],
    ];
    for (const [p, on] of cases) expect(siteOfKey(`${targetKey(p, on)}|color`)).toBe(siteKey(p, on));
    expect(siteKey(toAgent(inline), tilde)).toBe('agent|/src/¦lib/Plan.tsx:9:5');
  });

  describe('一次改几个属性', () => {
    const sides = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];

    it('同一处代码上跟着变的元素一样的属性记成一条', () => {
      const plans: Record<string, Plan> = Object.fromEntries(sides.map((p) => [p, onClass(p)]));
      expect(groupByTarget((p) => plans[p], el, sides)).toEqual([{ tk: 'tw|/repo/src/Plan.tsx|9|5', plan: plans['border-top-color'], props: sides }]);
    });

    it('跟着变的元素不一样的分开记：上边只有选中的这个写了，另外三边还有别的元素也写着', () => {
      const plans: Record<string, Plan> = {
        'border-top-color': onClass('border-top-color', { n: 1, by: '.border-t-red-500', set: 1 }),
        'border-right-color': onClass('border-right-color', { n: 2, by: '.border-x-stone-200', set: 2 }),
        'border-bottom-color': onClass('border-bottom-color', { n: 2, by: '.border-b-stone-200', set: 2 }),
        'border-left-color': onClass('border-left-color', { n: 2, by: '.border-x-stone-200', set: 2 }),
      };
      const groups = groupByTarget((p) => plans[p], el, sides);
      expect(groups.map((g) => g.props)).toEqual([['border-top-color'], ['border-right-color', 'border-bottom-color', 'border-left-color']]);
      // 记号取排在最前面的属性的；预览要这几个属性都和选中的写法相同
      expect(groups.map((g) => g.tk)).toEqual(['tw|/repo/src/Plan.tsx|9|5~.border-t-red-500', 'tw|/repo/src/Plan.tsx|9|5~.border-b-stone-200']);
      expect(groups[1].plan.preview).toEqual({ ...inline, linked: ['border-bottom-color', 'border-left-color', 'border-right-color'] });
      expect(groups[1].plan.link).toEqual(plans['border-right-color'].link);
      expect(groups[0].plan).toEqual(plans['border-top-color']);
    });

    it('写在不同地方的分开记；没定位过的属性跳过', () => {
      const plans: Record<string, Plan> = { 'padding-top': onClass('padding-top'), 'padding-bottom': onRule(), 'padding-left': onClass('padding-left') };
      const groups = groupByTarget((p) => plans[p], el, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
      expect(groups.map((g) => [g.tk, g.props])).toEqual([
        ['tw|/repo/src/Plan.tsx|9|5', ['padding-top', 'padding-left']],
        ['css|/repo/src/app.css|.card||0', ['padding-bottom']],
      ]);
      expect(groupByTarget(() => undefined, el, sides)).toEqual([]);
    });
  });

  it('只带上写法相同的同伴的预览：管几个属性就要这几个都相同；别的预览不动', () => {
    expect(linkedPreview({ ...inline, linked: ['color'] }, ['padding-top', 'margin-top'])).toEqual({ ...inline, linked: ['margin-top', 'padding-top'] });
    expect(linkedPreview(inline, ['padding-top'])).toBe(inline);
    const byRule: PreviewTarget = { kind: 'rule', rule: rule(), uid: 'u1' };
    expect(linkedPreview(byRule, ['padding-top'])).toBe(byRule);
  });
});
