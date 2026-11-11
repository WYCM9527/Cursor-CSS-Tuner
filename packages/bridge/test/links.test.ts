import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchRules, matchRulesQuick, type FlatRule, type RuleIndex } from '../src/cascade';
import { linkedTo, linkScope, linksOf, ruleLinksOf } from '../src/links';
import { splitTopLevel, subjectOf } from '../src/specificity';
import { indexesIn, ranges } from '../src/util';

/** 假的声明块：`color: red; padding-top: 4px !important`，属性名按写的顺序排，cssText 可以重新赋值 */
function block(text: string | null): CSSStyleDeclaration {
  const names: string[] = [];
  const decls = new Map<string, { value: string; priority: string }>();
  const style = Object.assign(names, {
    getPropertyValue: (p: string) => decls.get(p)?.value ?? '',
    getPropertyPriority: (p: string) => decls.get(p)?.priority ?? '',
  });
  Object.defineProperty(style, 'cssText', {
    set(css: string) {
      names.length = 0;
      decls.clear();
      for (const part of css.split(';')) {
        const at = part.indexOf(':');
        if (at < 0) continue;
        const name = part.slice(0, at).trim();
        const raw = part.slice(at + 1).trim();
        if (!decls.has(name)) names.push(name);
        decls.set(name, { value: raw.replace(/\s*!important$/, ''), priority: /!important$/.test(raw) ? 'important' : '' });
      }
    },
  });
  (style as unknown as { cssText: string }).cssText = text ?? '';
  return style as unknown as CSSStyleDeclaration;
}

interface Fake {
  localName: string;
  classList: string[];
  parentElement: Fake | null;
  /** 写在标签上的 style 属性 */
  attr: string | null;
  style: CSSStyleDeclaration;
  matches(sel: string): boolean;
}

/** 只认标签名、类名、* 和后代 / 子代组合符，测试里的规则够用；别的写法在 also 里直接列出来 */
function matchesSimple(el: Fake, sel: string): boolean {
  const tokens = sel
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/);
  const compound = (e: Fake, c: string) => {
    const tag = /^[a-z][\w-]*/i.exec(c)?.[0].toLowerCase();
    const classes = Array.from(c.matchAll(/\.([\w-]+)/g), (m) => m[1]);
    return (!tag || tag === e.localName) && classes.every((k) => e.classList.includes(k));
  };
  const from = (e: Fake | null, i: number): boolean => {
    if (!e || !compound(e, tokens[i])) return false;
    if (i === 0) return true;
    if (tokens[i - 1] === '>') return from(e.parentElement, i - 2);
    for (let up = e.parentElement; up; up = up.parentElement) if (from(up, i - 1)) return true;
    return false;
  };
  return from(el, tokens.length - 1);
}

/** 没写 style 的元素共用一个空的声明块（测试里不会去改它） */
const NO_STYLE = block(null);

function node(tag: string, classes: string, parent: Fake | null = null, over: { style?: string; also?: string[] } = {}): Element {
  const el: Fake = {
    localName: tag,
    classList: classes.split(/\s+/).filter(Boolean),
    parentElement: parent,
    attr: over.style ?? null,
    style: over.style ? block(over.style) : NO_STYLE,
    matches: (sel) => !!over.also?.includes(sel) || matchesSimple(el, sel),
  };
  return el as unknown as Element;
}

const up = (el: Element) => el as unknown as Fake;
const sheet = { ownerNode: null, cssRules: [] } as unknown as CSSStyleSheet;

/** 一张样式表：规则按写的先后排，`selector { decls }` */
function sheetOf(...rules: Array<[selector: string, decls: string, over?: Partial<FlatRule>]>): RuleIndex {
  return {
    layerOrder: new Map(),
    rules: rules.map(([selector, decls, over], order) => ({
      style: block(decls),
      rule: {} as CSSRule,
      sheetIndex: 0,
      topSheet: sheet,
      ownerSheet: sheet,
      path: [order],
      selector,
      fullSelector: selector,
      branches: splitTopLevel(selector),
      conditions: [],
      layer: null,
      layerRank: Infinity,
      order,
      ordinal: 0,
      active: true,
      ...over,
    })),
  };
}

const scopeFor = (idx: RuleIndex, limited = false) => linkScope(idx, () => null, (el) => up(el).attr, new Map(), limited);
const rulesOf = (idx: RuleIndex, el: Element) => ({
  quick: matchRulesQuick(el, idx).map((m) => `${m.fr.selector} ${m.spec.join('')}`),
  full: matchRules(el, idx).map((m) => `${m.fr.selector} ${m.spec.join('')}`),
});

beforeAll(() => {
  vi.stubGlobal('document', { compatMode: 'CSS1Compat', createElement: () => ({ style: block(null) }) });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('选择器最后一段靠什么认元素', () => {
  it('类名和标签名取最后一段的；转义的类名还原', () => {
    expect(subjectOf('.card')).toEqual({ cls: 'card', tag: null, never: false });
    expect(subjectOf('div.card > H3.title')).toEqual({ cls: 'title', tag: 'h3', never: false });
    expect(subjectOf('ul li')).toEqual({ cls: null, tag: 'li', never: false });
    expect(subjectOf('.a ~ .b.c')).toMatchObject({ cls: 'b', tag: null });
    expect(subjectOf('.a + p')).toMatchObject({ cls: null, tag: 'p' });
    expect(subjectOf('.md\\:p-4')).toMatchObject({ cls: 'md:p-4' });
    expect(subjectOf('#app.shell')).toMatchObject({ cls: 'shell' });
  });

  it('括号里的不算：:is() / :not() 里写的类名元素不一定有', () => {
    expect(subjectOf(':is(.a, .b) .c')).toMatchObject({ cls: 'c' });
    expect(subjectOf('a:not(.x)')).toMatchObject({ cls: null, tag: 'a' });
    expect(subjectOf(':is(.a, .b)')).toEqual({ cls: null, tag: null, never: false });
    expect(subjectOf('[lang|=en]')).toEqual({ cls: null, tag: null, never: false });
  });

  it('带伪元素的命中不了元素自己', () => {
    expect(subjectOf('.card::before').never).toBe(true);
    expect(subjectOf('.card:after').never).toBe(true);
    expect(subjectOf('input::placeholder').never).toBe(true);
    expect(subjectOf('.card:hover').never).toBe(false);
    expect(subjectOf('.card::before .x').never).toBe(false);
  });

  it('看不出最后匹配的是谁时什么都不认：没展开的嵌套、带命名空间的标签、通配符', () => {
    const unknown = { cls: null, tag: null, never: false };
    expect(subjectOf('& .row')).toEqual(unknown);
    expect(subjectOf('svg|rect')).toEqual(unknown);
    expect(subjectOf('*')).toEqual(unknown);
  });
});

describe('只试元素的标签名、类名可能命中的规则', () => {
  const idx = sheetOf(
    ['*', 'box-sizing: border-box'],
    ['*, ::before, ::after', 'border-top-width: 0'],
    ['h3', 'font-size: 20px'],
    ['.card', 'padding-top: 24px'],
    ['.card, .panel', 'border-top-left-radius: 8px'],
    ['.card:hover', 'opacity: 0.9'],
    ['.card::before', 'opacity: 0'],
    ['.grid > .card', 'margin-top: 0'],
    ['.grid .title', 'color: red'],
    ['.panel', 'opacity: 0.5', { active: false }],
    ['section.card.panel', 'row-gap: 4px'],
  );
  const grid = node('div', 'grid');
  const card = node('section', 'card panel', up(grid));
  const title = node('h3', 'title', up(card));
  const plain = node('p', '', up(card));

  it('结果和逐条规则试一遍相同：顺序、优先级、选择器列表里两段都对得上的只算一次', () => {
    for (const el of [grid, card, title, plain]) {
      const { quick, full } = rulesOf(idx, el);
      expect(quick).toEqual(full);
    }
    expect(rulesOf(idx, card).quick).toEqual(['* 000', '*, ::before, ::after 000', '.card 010', '.card, .panel 010', '.grid > .card 020', 'section.card.panel 021']);
    expect(rulesOf(idx, title).quick).toEqual(['* 000', '*, ::before, ::after 000', 'h3 001', '.grid .title 020']);
  });

  it('要试几回报给调用的人：交互态和伪元素的分支不试，没生效的规则不算', () => {
    const tests = (el: Element) => {
      let n = -1;
      matchRulesQuick(el, idx, (t) => (n = t));
      return n;
    };
    // 两条通配的各试一回（::before、::after 那两段不试）
    expect(tests(plain)).toBe(2);
    // 再加 .card、.card, .panel（两段）、.grid > .card、section.card.panel
    expect(tests(card)).toBe(2 + 1 + 2 + 1 + 1);
    expect(tests(title)).toBe(2 + 1 + 1);
  });

  it('不想算了就在回调里抛出，一条规则都不试', () => {
    let tried = 0;
    const probe = node('section', 'card');
    up(probe).matches = () => {
      tried++;
      return false;
    };
    expect(() =>
      matchRulesQuick(probe, idx, () => {
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(tried).toBe(0);
  });
});

describe('同源元素里哪些跟着一起变', () => {
  /** 三张价格卡：中间那张走 featured 分支，底色和文字颜色跟两边不一样 */
  const idx = sheetOf(
    ['.page', 'color: #1c1917'],
    ['.p-6', 'padding-top: 1.5rem; padding-bottom: 1.5rem'],
    ['.bg-white', 'background-color: #fff'],
    ['.bg-stone-900', 'background-color: #1c1917'],
    ['.text-white', 'color: #fff'],
    ['.title', 'font-size: 14px'],
  );
  const page = node('main', 'page');
  const cards = ['p-6 bg-white', 'p-6 bg-stone-900 text-white', 'p-6 bg-white'].map((c) => node('section', c, up(page)));
  const titles = cards.map((c) => node('h3', 'title', up(c)));
  const [left, middle, right] = cards;

  it('值由同一处声明决定的才一起变；都相同的属性不列', () => {
    const links = linksOf(left, cards, scopeFor(idx))!;
    expect(links['background-color']).toMatchObject({ n: 2, by: '.bg-white' });
    expect(links['padding-top']).toBeUndefined();
    expect(links['font-size']).toBeUndefined();
    expect(linksOf(middle, cards, scopeFor(idx))!['background-color']).toMatchObject({ n: 1, by: '.bg-stone-900' });
  });

  it('继承来的值看是从哪处声明继承的：标题的颜色跟着卡片走', () => {
    const mine = linksOf(titles[0], titles, scopeFor(idx))!;
    expect(mine).toEqual({ color: { n: 2, by: '^.page', set: 1, inherited: true } });
    expect(linksOf(titles[1], titles, scopeFor(idx))).toEqual({ color: { n: 1, by: '^.text-white', set: 1, inherited: true } });
  });

  it('写在自己身上的和继承来的不算同一种写法，哪怕是同一条规则', () => {
    const inner = node('span', '', up(middle));
    const pair = [middle, inner];
    expect(linksOf(middle, pair, scopeFor(idx))!.color).toEqual({ n: 1, by: '.text-white', set: expect.any(Number) });
    expect(linksOf(inner, pair, scopeFor(idx))!.color).toEqual({ n: 1, by: '^.text-white', set: expect.any(Number), inherited: true });
  });

  it('写着 inherit 的看父元素：可继承的属性和没写一样，不继承的属性就是跟着父元素的声明', () => {
    const inherit = sheetOf(['.page', 'color: #1c1917; background-color: #fafaf9'], ['.keep', 'color: inherit'], ['.fill', 'background-color: inherit'], ['.reset', 'color: unset; background-color: unset']);
    const root = node('main', 'page');
    const [bare, keep, fill, reset] = ['', 'keep', 'fill', 'reset'].map((k) => node('p', k, up(root)));
    const three = [bare, keep, fill];
    expect(linksOf(bare, three, scopeFor(inherit))).toEqual({ 'background-color': { n: 2, by: 'none', set: 1 } });
    expect(linksOf(fill, three, scopeFor(inherit))).toEqual({ 'background-color': { n: 1, by: '^.page', set: 1, inherited: true } });
    // unset：可继承的属性等于 inherit，不继承的属性是这条规则把它定成了初始值
    const four = linksOf(reset, [...three, reset], scopeFor(inherit))!;
    expect(four.color).toBeUndefined();
    expect(four['background-color']).toMatchObject({ n: 1, by: '.reset' });
  });

  it('跟着变的元素完全相同的属性编成同一个号', () => {
    const links = linksOf(left, cards, scopeFor(idx))!;
    expect(Object.keys(links).sort()).toEqual(['background-color', 'color']);
    expect(links.color.set).toBe(links['background-color'].set);
    // 上边的描边色只有第一个用，另外三边前两个用：上边一个号，另外三边一个号
    const borders = sheetOf(['.b', 'border-right-color: red; border-bottom-color: red; border-left-color: red'], ['.t', 'border-top-color: red'], ['.g', 'border-top-color: green']);
    const [a, b, c] = ['b t', 'b g', 'g'].map((k) => node('li', k));
    const sides = linksOf(a, [a, b, c], scopeFor(borders))!;
    expect(sides['border-top-color']).toMatchObject({ n: 1 });
    expect(sides['border-right-color']).toMatchObject({ n: 2 });
    expect(sides['border-right-color'].set).toBe(sides['border-left-color'].set);
    expect(sides['border-right-color'].set).toBe(sides['border-bottom-color'].set);
    expect(sides['border-top-color'].set).not.toBe(sides['border-right-color'].set);
  });

  it('预览只带上这几个属性都和选中的写法相同的同伴', () => {
    expect(linkedTo(left, cards, ['background-color'], scopeFor(idx))).toEqual([left, right]);
    expect(linkedTo(middle, cards, ['background-color'], scopeFor(idx))).toEqual([middle]);
    expect(linkedTo(left, cards, ['padding-top', 'padding-bottom'], scopeFor(idx))).toEqual(cards);
    expect(linkedTo(left, cards, ['padding-top', 'background-color'], scopeFor(idx))).toEqual([left, right]);
    // 不是面板上的属性不比
    expect(linkedTo(left, cards, ['transform'], scopeFor(idx))).toEqual(cards);
  });

  it('只有一个元素时不算', () => {
    expect(linksOf(left, [left], scopeFor(idx))).toBeUndefined();
  });

  it('决定它的声明的标识里不带 | 和 ~（改动的标识用它们分段），同名规则带上序号', () => {
    const odd = sheetOf(['.a ~ .b', 'opacity: 0.5'], ['.c', 'opacity: 1', { ordinal: 2, conditions: ['@media (width >= 48rem)'] }]);
    const [x, y] = [node('p', 'b', null, { also: ['.a ~ .b'] }), node('p', 'c')];
    expect(linksOf(x, [x, y], scopeFor(odd))!.opacity.by).toBe('.a ¦ .b');
    expect(linksOf(y, [x, y], scopeFor(odd))!.opacity.by).toBe('.c {@media (width >= 48rem)}#2');
  });
});

describe('值写在 style 里的同源元素', () => {
  const idx = sheetOf(['.chip', 'padding-top: 4px; background-color: gray']);
  const chips = ['background-color: red; letter-spacing: 1px', 'background-color: red; letter-spacing: 1px', 'background-color: blue; letter-spacing: 1px'].map((style) => node('span', 'chip', null, { style }));

  it('按值分组：写着同样的值的一起变，style 没动到的属性照规则算', () => {
    const links = linksOf(chips[0], chips, scopeFor(idx))!;
    expect(links).toEqual({ 'background-color': { n: 2, by: 'style=red', set: 1 } });
    expect(linksOf(chips[2], chips, scopeFor(idx))!['background-color']).toMatchObject({ n: 1, by: 'style=blue' });
    expect(linkedTo(chips[0], chips, ['background-color'], scopeFor(idx))).toEqual([chips[0], chips[1]]);
    expect(linkedTo(chips[2], chips, ['letter-spacing', 'padding-top'], scopeFor(idx))).toEqual(chips);
  });

  it('有的写在 style 里、有的靠规则：不是同一种写法', () => {
    const bare = node('span', 'chip');
    const links = linksOf(bare, [...chips, bare], scopeFor(idx))!;
    expect(links['background-color']).toMatchObject({ n: 1, by: '.chip' });
    expect(links['letter-spacing']).toMatchObject({ n: 1, by: 'none' });
    expect(links['padding-top']).toBeUndefined();
  });

  it('!important 算进写法里，太长的值截短', () => {
    const loud = node('span', 'chip', null, { style: 'background-color: red !important' });
    expect(linksOf(loud, [loud, chips[0]], scopeFor(idx))!['background-color'].by).toBe('style=red !important');
    const long = node('span', 'chip', null, { style: `background-color: ${'x'.repeat(200)}` });
    const by = linksOf(long, [long, chips[0]], scopeFor(idx))!['background-color'].by;
    expect(by.length).toBeLessThan(96);
    expect(by.startsWith(`style=${'x'.repeat(58)}…`)).toBe(true);
  });
});

describe('同源元素很多时', () => {
  const idx = sheetOf(['.item', 'padding-top: 4px'], ['.box', 'row-gap: 8px']);
  const list = (n: number, parent: (i: number) => Fake | null) => Array.from({ length: n }, (_, i) => node('li', 'item', parent(i)));

  it('同一个父元素下的长列表照算', () => {
    const root = up(node('ul', 'box'));
    const items = list(2000, () => root);
    expect(linksOf(items[0], items, scopeFor(idx, true))).toEqual({});
    const odd = node('li', 'item', root, { style: 'padding-top: 9px' });
    expect(linksOf(odd, [...items, odd], scopeFor(idx, true))).toEqual({ 'padding-top': { n: 1, by: 'style=9px', set: 1 } });
  });

  it('多到算不起就不算，照旧全部一起变：各有各的父元素时，算到一半额度花完', () => {
    const items = list(40000, () => up(node('div', 'box')));
    expect(linksOf(items[0], items, scopeFor(idx, true))).toBeUndefined();
    // 预览和核对照着快照定下的分组做，不限
    expect(linksOf(items[0], items, scopeFor(idx))).toEqual({});
  });

  it('光是同伴自己就超了的一份都不花，额度留给后面小一些的批', () => {
    const root = up(node('ul', 'box'));
    const many = list(60000, () => root);
    const few = [node('li', 'item', root), node('li', 'item', root, { style: 'padding-top: 9px' })];
    const scope = scopeFor(idx, true);
    const before = scope.budget;
    expect(linksOf(many[0], many, scope)).toBeUndefined();
    expect(scope.budget).toBe(before);
    expect(linksOf(few[0], few, scope)).toMatchObject({ 'padding-top': { n: 1 } });
  });
});

describe('交给 Agent 之前记下的同伴下标', () => {
  it('连着的写成区间，读回来还是原来那些', () => {
    expect(ranges([0, 2, 3, 4, 5, 9])).toBe('0,2-5,9');
    expect(ranges([7])).toBe('7');
    expect(ranges([])).toBe('');
    expect(ranges(Array.from({ length: 2000 }, (_, i) => i))).toBe('0-1999');
    for (const list of [[0, 2, 3, 4, 5, 9], [7], [], [1, 2], [0, 1, 3, 4, 6]]) expect([...indexesIn(ranges(list))]).toEqual(list);
  });
});

describe('往规则里加声明时，规则命中的元素里哪些跟着变', () => {
  /** 普通 CSS：三张卡片里中间那张是深色的，标题的颜色各自从卡片继承 */
  const idx = sheetOf(
    ['.page', 'color: #111'],
    ['.card', 'padding-top: 8px'],
    ['.dark', 'color: #fff'],
    ['.title', 'font-size: 18px'],
    ['.ghost', 'opacity: 0.6'],
    ['.btn', 'padding-top: 4px'],
    ['.btn.ghost', 'letter-spacing: 2px'],
  );
  const page = node('main', 'page');
  const cards = ['card', 'card dark', 'card'].map((c) => node('section', c, up(page)));
  const titles = cards.map((c) => node('h3', 'title', up(c)));
  const buttons = ['btn', 'btn ghost'].map((c) => node('button', c, up(page)));
  const rule = (selector: string) => idx.rules.find((r) => r.selector === selector)!;

  it('没写过的属性：值是从不同的外层继承来的，只改同一组', () => {
    expect(ruleLinksOf(titles[0], titles, rule('.title'), scopeFor(idx))).toEqual({ color: { n: 2, by: '^.page', set: 1, inherited: true } });
    expect(ruleLinksOf(titles[1], titles, rule('.title'), scopeFor(idx))).toEqual({ color: { n: 1, by: '^.dark', set: 1, inherited: true } });
  });

  it('规则里已经写着的属性不看：要加声明的是元素自己没写的属性', () => {
    const big = node('h3', 'title', up(cards[0]), { style: 'font-size: 30px' });
    const pair = [titles[0], big];
    // 字号两个元素写法不同（一个靠 .title，一个写在 style 里），但 .title 里本来就有字号，不是往里加
    expect(linksOf(titles[0], pair, scopeFor(idx))).toHaveProperty('font-size');
    expect(ruleLinksOf(titles[0], pair, rule('.title'), scopeFor(idx))).toBeUndefined();
  });

  it('写法不同、但加上去的声明盖不住它的不算；盖得住的才算', () => {
    const links = ruleLinksOf(buttons[0], buttons, rule('.btn'), scopeFor(idx))!;
    // 幽灵按钮的字距写在更具体的 .btn.ghost 里，往 .btn 里加字距它也不会变
    expect(links).not.toHaveProperty('letter-spacing');
    // 它的不透明度写在前面的 .ghost 里，往 .btn 里加会把它盖掉
    expect(links.opacity).toMatchObject({ n: 1, by: 'none' });
  });

  it('命中的元素写法都相同时不用分', () => {
    const same = [titles[0], titles[2]];
    expect(ruleLinksOf(same[0], same, rule('.title'), scopeFor(idx))).toBeUndefined();
  });
});
