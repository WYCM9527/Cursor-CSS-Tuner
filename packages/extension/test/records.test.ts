import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, type ElementSnapshot, type RuleRef } from '@css-tuner/protocol';
import type { Plan, PlanLink } from '../src/planner';
import { buildPrompt } from '../src/prompt';
import { linkedView, recordElement, recordView, samePage, siteOfKey, upgradeRecord, type ChangeRecord, type RecordLink, type StoredRecord } from '../src/records';

const project = { label: (f: string) => f.replace('/repo/', '') };

function rec(over: Partial<ChangeRecord>): ChangeRecord {
  return {
    id: 'a1',
    kind: 'style',
    key: 'k',
    status: 'pending',
    createdAt: 1,
    pageUrl: 'http://localhost:5173/',
    element: { label: 'h1.title', source: { url: '', path: '/src/App.tsx', file: '/repo/src/App.tsx', line: 12, column: 7, component: 'App', viaOwner: false }, sourceIndex: 0, sameSource: 1 },
    props: ['padding-top'],
    propLabel: 'padding-top',
    from: '16px',
    to: '24px',
    value: '24px',
    token: null,
    original: {},
    view: { kind: 'agent', label: 'Agent', affects: 1, reason: 'why' },
    preview: { kind: 'inline', uid: 'u1', sourceKey: null },
    previewId: 'p1',
    write: { kind: 'agent', reason: 'why' },
    ...over,
  };
}

describe('改动记录', () => {
  it('0.2.0 及以前存下的记录没有 kind，读出来按样式改动处理', () => {
    const { kind: _, ...old } = rec({});
    const stored: StoredRecord = old;
    expect(upgradeRecord(stored).kind).toBe('style');
    expect(upgradeRecord({ ...old, kind: 'text' }).kind).toBe('text');
  });

  it('0.10.0 以前扩展自己写回的记录：状态换成交给 Agent 的那一套，写回前的文件留着对比', () => {
    const patch = { file: '/repo/src/App.tsx', hashBefore: 'h0' };
    expect(upgradeRecord({ ...rec({}), status: 'unverified', patch })).toMatchObject({ status: 'applied', snapshot: { file: '/repo/src/App.tsx', hash: 'h0' } });
    expect(upgradeRecord({ ...rec({}), status: 'conflict', patch }).status).toBe('applied');
    expect(upgradeRecord({ ...rec({}), status: 'failed' }).status).toBe('pending');
    const up = upgradeRecord({ ...rec({}), status: 'applied', patch });
    expect(up.status).toBe('applied');
    expect('patch' in up).toBe(false);
  });

  it('改动清单的视图带上类型；换序在等 Agent 时也还是模拟的', () => {
    expect(recordView(rec({ kind: 'reorder', from: '2', to: '1' }))).toMatchObject({ id: 'a1', kind: 'reorder', from: '2', to: '1', target: { kind: 'agent' }, simulated: true });
    expect(recordView(rec({ kind: 'reorder', status: 'handoff' })).simulated).toBe(true);
    expect(recordView(rec({ kind: 'reorder', status: 'applied' })).simulated).toBeUndefined();
    expect(recordView(rec({})).remove).toBeUndefined();
    expect(recordView(rec({ removal: { values: { 'padding-top': '0px' } } })).remove).toBe(true);
  });

  it('记进改动的元素带上页面层级和元素自己的文字开头', () => {
    const crumbs = [
      { uid: 'u0', label: 'header', text: 'Logo' },
      { uid: 'u1', label: 'a.nav', text: 'Code' },
    ];
    const el = { label: 'a.nav', source: null, sourceIndex: 0, sameSource: 1, breadcrumb: crumbs } as unknown as ElementSnapshot;
    expect(recordElement(el)).toEqual({ label: 'a.nav', source: null, sourceIndex: 0, sameSource: 1, path: 'header > a.nav', text: 'Code' });
    expect(recordElement({ ...el, breadcrumb: [crumbs[0], { uid: 'u1', label: 'a.nav' }] })).not.toHaveProperty('text');
  });

  it('同一个页面：查询参数和普通锚点不算，hash 路由算', () => {
    const home = 'http://127.0.0.1:5178/';
    expect(samePage(home, 'http://127.0.0.1:5178/?x=1#faq')).toBe(true);
    expect(samePage(home, 'http://127.0.0.1:5178/#/')).toBe(true);
    expect(samePage(home, 'http://127.0.0.1:5178/#/effects')).toBe(false);
    expect(samePage('http://127.0.0.1:5178/#/effects/', 'http://127.0.0.1:5178/#/effects?tag=a')).toBe(true);
    expect(samePage('http://127.0.0.1:5178/#!/a', 'http://127.0.0.1:5178/#/a')).toBe(true);
    expect(samePage(home, 'http://127.0.0.1:5178/zh')).toBe(false);
  });

  it('从改动的标识里取出代码位置：去掉属性和这一组的记号，选择器和路径里的 ~ 留着', () => {
    const site = 'tw|/repo/src/Plan.tsx|9|5';
    expect(siteOfKey(`${site}|background-color`)).toBe(site);
    expect(siteOfKey(`${site}~.bg-white|background-color`)).toBe(site);
    expect(siteOfKey(`${site}~@2|background-color`)).toBe(site);
    expect(siteOfKey(`${site}~^.page {@media (width >= 48rem)}#2@1|color`)).toBe(site);
    const sibling = 'css|/repo/src/app.css|.a ~ .b||0';
    expect(siteOfKey(`${sibling}|opacity`)).toBe(sibling);
    expect(siteOfKey(`${sibling}~none|opacity`)).toBe(sibling);
    const home = 'tw|/Users/me/~work/src/Plan.tsx|9|5';
    expect(siteOfKey(`${home}|color`)).toBe(home);
    expect(siteOfKey(`${home}~.text-white|color`)).toBe(home);
    expect(siteOfKey('agent|/src/Plan.tsx:9:5~style=red|background-color')).toBe('agent|/src/Plan.tsx:9:5');
    expect(siteOfKey('agent|u1|background-color')).toBe('agent|u1');
  });
});

describe('只带上一部分同伴的改动记成什么样', () => {
  const view = { kind: 'tailwind' as const, label: 'src/Plan.tsx:9 className', file: '/repo/src/Plan.tsx', line: 9, column: 5, affects: 2 };
  const inline = { kind: 'inline' as const, uid: 'u1', sourceKey: '/src/Plan.tsx:9:5' };
  const write = { kind: 'tailwind' as const, file: '/repo/src/Plan.tsx', line: 9, column: 5, utility: 'bg-white', entry: null };
  const link: PlanLink = { key: '.bg-white', group: '1', total: 3, inherited: false, byValue: true };
  /** 3 个同源元素里估计有 2 个跟着变 */
  const byValue: Plan = { view, preview: { ...inline, linked: ['background-color'] }, write, link };

  it('影响几个按预览实际作用到的算；比这处代码渲染出的少时记下总数', () => {
    expect(linkedView(byValue, 2)).toEqual({ view, link: { total: 3 } });
    expect(linkedView(byValue, 1)).toEqual({ view: { ...view, affects: 1 }, link: { total: 3 } });
  });

  it('实际全都带上了（规划时估少了）：就是普通的改动，不用交代只改哪几个', () => {
    const all = linkedView(byValue, 3);
    expect(all).toEqual({ view: { ...view, affects: 3 } });
    expect(all).not.toHaveProperty('link');
    // 页面上的同源元素比选中时多了
    const more = linkedView(byValue, 5);
    expect(more).toEqual({ view: { ...view, affects: 5 } });
    expect(more).not.toHaveProperty('link');
  });

  it('是哪一部分一起记下：继承来的、类名用到哪一段的、规则命中的', () => {
    expect(linkedView({ ...byValue, link: { ...link, inherited: true } }, 2).link).toEqual({ total: 3, inherited: true });
    const segs = [['bg-white', 'ring-2'], ['bg-white', 'border']];
    const branch: Plan = { ...byValue, preview: { ...inline, segs, seg: 1 }, link: { key: '@2', group: '@1.2/1', total: 3, inherited: false, byValue: false, segment: 'bg-white border' } };
    expect(linkedView(branch, 2)).toEqual({ view, link: { total: 3, segment: 'bg-white border', byValue: false } });
    const both: Plan = { ...branch, preview: { ...inline, linked: ['background-color'], segs, seg: 1 }, link: { ...branch.link!, key: '.bg-white@2', byValue: true } };
    expect(linkedView(both, 1).link).toEqual({ total: 3, segment: 'bg-white border', byValue: true });
    const among: Plan = { ...byValue, preview: { kind: 'inline', uid: 'u1', sourceKey: null, among: '.title', linked: ['color'] }, link: { ...link, inherited: true, rule: true } };
    expect(linkedView(among, 2).link).toEqual({ total: 3, inherited: true, rule: true });
  });

  it('全部同伴一起变的改动原样记', () => {
    const { link: _, ...whole } = { ...byValue, preview: inline };
    expect(linkedView(whole, 1)).toEqual({ view });
    expect(linkedView(whole, 1).view).toBe(view);
    // 预览没挂上（元素不在页面上了）
    expect(linkedView(byValue, 0)).toEqual({ view });
    // 预览不按写法也不按类名分（直接改规则）
    expect(linkedView({ ...byValue, preview: inline }, 1)).toEqual({ view });
    expect(linkedView({ ...byValue, preview: { kind: 'rule', rule: {} as RuleRef, uid: 'u1' } }, 1)).toEqual({ view });
  });
});

describe('交给 Agent 的提示词', () => {
  afterEach(() => setLocale('en'));
  const ctx = { pageUrl: 'http://localhost:5173/', project, tailwind: true };
  /** 要改的就是元素自己的 className */
  const ownClass = {
    view: { kind: 'tailwind' as const, label: 'src/App.tsx:12 className', file: '/repo/src/App.tsx', line: 12, column: 7, affects: 1 },
    write: { kind: 'tailwind' as const, file: '/repo/src/App.tsx', line: 12, column: 7, utility: 'pt-4', entry: null },
  };
  const unmapped = (uid: string): Partial<ChangeRecord> => ({
    element: { label: 'a.nav', source: null, sourceIndex: 0, sameSource: 1, path: 'body > header > nav > a.nav', text: 'Code' },
    preview: { kind: 'inline', uid, sourceKey: null },
  });
  const maxWidth = { props: ['max-width'], propLabel: 'max-width', from: '100%', to: '11px', value: '11px' };

  it('开头写页面，每项一个元素，项之间空一行，最后两条要求', () => {
    const p = buildPrompt(
      [
        rec({ ...ownClass, token: '6', value: '1.5rem', to: '6' }),
        rec({ ...ownClass, id: 'b2', props: ['color'], propLabel: 'color', from: '#111827', to: '#912626', value: '#912626' }),
        rec({ ...unmapped('u2'), ...maxWidth, id: 'c3' }),
      ],
      ctx,
    );
    expect(p).toBe(
      [
        'On http://localhost:5173/, change the following 2 items:',
        '',
        '1. Element `h1.title` (src/App.tsx:12:7, component App)',
        '   - padding-top: 16px → 1.5rem (Tailwind token 6)',
        '   - color: #111827 → #912626',
        '',
        '2. Element `a.nav` "Code" (page position body > header > nav > a.nav)',
        '   - max-width: 100% → 11px',
        '',
        'Requirements:',
        '- Consider whether other places affected by this should change too; if unsure, ask me first.',
        '- When done, list what you changed.',
      ].join('\n'),
    );
  });

  it('跟随界面语言', () => {
    setLocale('zh-CN');
    expect(buildPrompt([rec({ ...unmapped('u2'), ...maxWidth })], ctx)).toBe(
      [
        '修改页面「http://localhost:5173/」中的下列 1 处内容：',
        '',
        '1. 元素 `a.nav`「Code」（页面位置 body > header > nav > a.nav）',
        '   - max-width：100% → 11px',
        '',
        '要求：',
        '- 斟酌是否需要同步修改受影响的其他地方，拿不准就先问我；',
        '- 改完后列出修改的地方。',
      ].join('\n'),
    );
  });

  it('元素的文字只在没有源码位置时写，用来区分同名元素', () => {
    expect(buildPrompt([rec({ element: { ...rec({}).element, text: 'Hello' } })], ctx)).toContain('1. Element `h1.title` (src/App.tsx:12:7, component App)');
    const tabs = buildPrompt([rec({ ...unmapped('u2'), ...maxWidth }), rec({ ...unmapped('u3'), ...maxWidth, id: 'b2', element: { ...unmapped('u3').element!, text: 'Issues' } })], ctx);
    expect(tabs).toContain('1. Element `a.nav` "Code" (page position');
    expect(tabs).toContain('2. Element `a.nav` "Issues" (page position');
  });

  it('同一个元素上交代的东西都一样，才合成一项', () => {
    const pad = rec(ownClass);
    const color = rec({ ...ownClass, id: 'b2', props: ['color'], propLabel: 'color', from: '#111', to: '#222', value: '#222' });
    expect(buildPrompt([pad, color], ctx)).toContain('the following 1 item:');
    const another = rec({ ...ownClass, id: 'd4', preview: { kind: 'inline', uid: 'u9', sourceKey: null } });
    expect(buildPrompt([pad, another], ctx)).toContain('the following 2 items:');
  });

  it('几个属性一起改时写成 CSS 简写；令牌按项目类型写', () => {
    expect(buildPrompt([rec({ props: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] })], ctx)).toContain('   - padding: 16px → 24px');
    expect(buildPrompt([rec({ props: ['padding-right', 'padding-left'] })], ctx)).toContain('   - padding-inline: 16px → 24px');
    expect(buildPrompt([rec({ props: ['color', 'background-color'] })], ctx)).toContain('   - color / background-color: 16px → 24px');
    expect(buildPrompt([rec({ token: '--space-6', value: '1.5rem' })], { ...ctx, tailwind: false })).toContain('   - padding-top: 16px → 1.5rem (--space-6)');
  });

  it('代码位置和元素位置不同时才写；没有源码位置的元素不写定位线索，渐变描边的说明总要写', () => {
    expect(buildPrompt([rec(ownClass)], ctx)).not.toContain('In the code');
    const callSite = { kind: 'source' as const, label: 'src/App.tsx:20 <Card> className', file: '/repo/src/App.tsx', line: 20, affects: 1 };
    expect(buildPrompt([rec({ ...ownClass, view: callSite })], ctx)).toContain('   - In the code: src/App.tsx:20 <Card> className');
    expect(buildPrompt([rec({})], ctx)).toContain('\n   - why\n');
    expect(buildPrompt([rec(unmapped('u2'))], ctx)).not.toContain('why');
    expect(buildPrompt([rec({ ...unmapped('u2'), decls: { 'background-clip': 'padding-box, border-box' } })], ctx)).toContain('\n   - why\n');
    expect(buildPrompt([rec({})], ctx)).not.toMatch(/written back|write-back/i);
  });

  it('文字用 JSON 字符串给出原文和新文字，附上来源', () => {
    const p = buildPrompt([rec({ kind: 'text', props: [], from: 'Line 1\nLine 2', to: 'Say "hi"', value: 'Say "hi"', detail: { origin: 'messages/en.json hero.title' } })], ctx);
    expect(p).toContain('   - Text: "Line 1\\nLine 2" → "Say \\"hi\\""');
    expect(p).toContain('   - Text source: messages/en.json hero.title');
  });

  it('换序写出位置和改完的顺序；还原时反过来', () => {
    const reorder = { kind: 'reorder' as const, props: [], from: '3', to: '1', value: '0', detail: { order: ['Team', 'Starter', 'Pro'], was: ['Starter', 'Pro', 'Team'] } };
    const p = buildPrompt([rec(reorder)], ctx);
    expect(p).toContain('   - Position among its siblings: 3 → 1');
    expect(p).toContain('   - Order afterwards: Team, Starter, Pro');
    const back = buildPrompt([rec({ ...reorder, status: 'applied' })], ctx, 'revert');
    expect(back).toContain('   - Position among its siblings: 1 → 3');
    expect(back).toContain('   - Order afterwards: Starter, Pro, Team');
  });

  it('一处代码影响页面上几处时写明，按要改的这处代码算，不按元素本身算', () => {
    const shared = { kind: 'tailwind' as const, label: 'src/Card.tsx:5 className', affects: 2 };
    expect(buildPrompt([rec({ view: shared })], ctx)).toContain('changing this code affects 2 places on the page');
    const callSite = rec({ kind: 'prop', props: ['size'], element: { ...rec({}).element, sameSource: 3 }, view: { kind: 'source', label: 'src/Buttons.tsx:10 <Button> size', affects: 1 } });
    expect(buildPrompt([callSite], ctx)).not.toContain('places on the page');
  });

  describe('只改同一处代码渲染出的一部分元素', () => {
    /** Plan.tsx 第 9 行渲染出 3 个卡片，选中的是第 2 个，改动只改其中 n 个 */
    const some = (link: RecordLink, n = 2, over: Partial<ChangeRecord> = {}): ChangeRecord =>
      rec({
        element: { label: 'div.rounded-2xl', source: { url: '', path: '/src/Plan.tsx', file: '/repo/src/Plan.tsx', line: 9, column: 5, component: 'Plan', viaOwner: false }, sourceIndex: 1, sameSource: 3 },
        view: { kind: 'tailwind', label: 'src/Plan.tsx:9 className', file: '/repo/src/Plan.tsx', line: 9, column: 5, affects: n },
        write: { kind: 'tailwind', file: '/repo/src/Plan.tsx', line: 9, column: 5, utility: 'bg-white', entry: null },
        preview: { kind: 'inline', uid: 'u1', sourceKey: '/src/Plan.tsx:9:5', linked: ['background-color'] },
        props: ['background-color'],
        propLabel: 'background-color',
        from: '#ffffff',
        to: '#fef2f2',
        value: '#fef2f2',
        detail: { link },
        ...over,
      });
    const head = '1. Element `div.rounded-2xl` (src/Plan.tsx:9:5, component Plan)';
    const change = '   - background-color: #ffffff → #fef2f2';
    const renders = '   - This code renders 3 elements on the page. Apply the above to only';
    const second = ' (the selected element is number 2 in page order)';
    const rest = '. Leave the rest unchanged, and add a condition in the code if nothing there tells them apart';

    it('写法相同的：说清一共几个、改几个、怎么认，不再写「影响几处」', () => {
      const p = buildPrompt([some({ total: 3 })], ctx);
      expect(p).toContain(`${head}\n${change}\n${renders} 2 of them: the ones whose current value is the original value shown above${second}${rest}\n\nRequirements:`);
      expect(p).not.toContain('places on the page');
      expect(buildPrompt([some({ total: 3 }, 1)], ctx)).toContain(`${renders} 1 of them: the one whose current value is the original value shown above${second}${rest}\n`);
    });

    it('类名用到同一段字符串的；还要写法相同时两样都写', () => {
      const segment = buildPrompt([some({ total: 3, segment: 'bg-white border', byValue: false })], ctx);
      expect(segment).toContain(`${renders} 2 of them: the ones whose classes come from the \`bg-white border\` string${second}. The same class is also written in another branch; leave it alone there\n`);
      const both = buildPrompt([some({ total: 3, segment: 'bg-white border', byValue: true }, 1)], ctx);
      expect(both).toContain(`${renders} 1 of them: the one whose classes come from the \`bg-white border\` string and whose current value is the original value shown above${second}${rest}\n`);
    });

    it('原值是继承来的要说明：元素自己没写，照着原值在代码里找不到', () => {
      const p = buildPrompt([some({ total: 3, inherited: true })], ctx);
      expect(p).toContain(`${second}${rest}\n   - The original value above is inherited from an outer element; the element doesn't set it itself\n`);
      expect(buildPrompt([some({ total: 3 })], ctx)).not.toContain('inherited from');
    });

    it('第几个是在全部同源元素里数的：改的是外层调用处（只管其中一部分）时不写', () => {
      const caller = some({ total: 2 }, 1, { view: { kind: 'source', label: 'src/App.tsx:20 <Plan> className', file: '/repo/src/App.tsx', line: 20, affects: 1 } });
      const p = buildPrompt([caller], ctx);
      expect(p).toContain('   - In the code: src/App.tsx:20 <Plan> className\n   - This code renders 2 elements on the page. Apply the above to only 1 of them: the one whose current value is the original value shown above. Leave the rest');
      expect(p).not.toContain('in page order');
    });

    it('往 CSS 规则里加声明：说的是规则命中的元素，让 Agent 另写更具体的规则', () => {
      const onRule: Partial<ChangeRecord> = {
        view: { kind: 'css', label: 'src/app.css .title', file: '/repo/src/app.css', affects: 2 },
        write: { kind: 'css', file: '/repo/src/app.css', selector: '.title', fullSelector: '.title', conditions: [], ordinal: 0, mode: 'add', via: null },
        preview: { kind: 'inline', uid: 'u1', sourceKey: null, among: '.title', linked: ['color'] },
      };
      const p = buildPrompt([some({ total: 3, inherited: true, rule: true }, 2, onRule)], { ...ctx, tailwind: false });
      expect(p).toContain(
        [
          '   - In the code: src/app.css .title',
          '   - This rule matches 3 elements on the page. Apply the above to only 2 of them: the ones whose current value is the original value shown above. Leave the rest unchanged; if needed, write a more specific rule for the ones that change',
          "   - The original value above is inherited from an outer element; the element doesn't set it itself",
          '',
        ].join('\n'),
      );
      expect(p).not.toContain('in page order');
      const one = buildPrompt([some({ total: 3, rule: true }, 1, { ...onRule, view: { ...onRule.view!, affects: 1 } })], { ...ctx, tailwind: false });
      expect(one).toContain('only 1 of them: the one whose current value is the original value shown above. Leave the rest unchanged; if needed, write a more specific rule for the one that changes\n');
    });

    it('还原时不用说：照着之前改的改回去', () => {
      const back = buildPrompt([some({ total: 3, inherited: true }, 2, { status: 'applied' })], ctx, 'revert');
      expect(back).toContain(`${head}, and changing this code affects 2 places on the page\n   - background-color: #fef2f2 → #ffffff\n\nRequirements:`);
      expect(back).not.toContain('This code renders');
      expect(back).not.toContain('inherited from');
    });

    it('两条改动只改的那一部分不一样时分成两项', () => {
      const color = { props: ['color'], propLabel: 'color', id: 'b2' };
      expect(buildPrompt([some({ total: 3 }), some({ total: 3 }, 2, color)], ctx)).toContain('the following 1 item:');
      expect(buildPrompt([some({ total: 3 }), some({ total: 3 }, 1, color)], ctx)).toContain('the following 2 items:');
      expect(buildPrompt([some({ total: 3 }), some({ total: 3, inherited: true }, 2, color)], ctx)).toContain('the following 2 items:');
    });

    it('跟随界面语言', () => {
      setLocale('zh-CN');
      const zh = (link: RecordLink, n = 2, over: Partial<ChangeRecord> = {}) => buildPrompt([some(link, n, over)], ctx);
      expect(zh({ total: 3, inherited: true })).toContain(
        '   - 这处代码在页面上渲染出 3 个元素，上面的改动只改其中 2 个：现在的值和上面写的原值相同的（选中的是按页面顺序的第 2 个）。其余的保持不变；代码里没有条件能区分它们时，加上条件\n   - 上面的原值是从外层元素继承来的，元素自己没有写\n',
      );
      expect(zh({ total: 3, segment: 'bg-white border', byValue: false })).toContain('上面的改动只改其中 2 个：类名里用到 `bg-white border` 这一段的（选中的是按页面顺序的第 2 个）。同一个类在别的分支里也写着，那里的不动\n');
      expect(zh({ total: 3, rule: true })).toContain('   - 这条规则在页面上命中 3 个元素，上面的改动只改其中 2 个：现在的值和上面写的原值相同的。其余的保持不变；需要的话给要改的这几个另写一条更具体的规则\n');
    });
  });

  it('删属性写成删掉；还原时加回来', () => {
    const removal = { propLabel: 'border', props: ['border-top-width', 'border-top-style'], from: 'border border-brand', to: 'removed', value: '', removal: { values: { 'border-top-width': '0px' }, classes: ['border', 'border-brand'] } };
    const p = buildPrompt([rec(removal)], ctx);
    expect(p).toContain('   - Remove border (now border border-brand)');
    expect(p).not.toContain('border-top-width');
    expect(buildPrompt([rec({ ...removal, status: 'applied' })], ctx, 'revert')).toContain('   - Add border back: border border-brand');
  });

  it('再发一次时附上上一次改完页面上是什么样', () => {
    const p = buildPrompt([rec({ status: 'handoff', note: 'The code changed, but the page now shows padding-top: 20px' })], ctx);
    expect(p).toContain('   - After the last attempt: The code changed, but the page now shows padding-top: 20px');
    expect(buildPrompt([rec({ note: 'old' })], ctx)).not.toContain('After the last attempt');
  });

  it('换成只装在本机、页面没加载的字体时写明；还原时不写', () => {
    const font = { ...ownClass, props: ['font-family'], propLabel: 'font-family', from: 'ui-sans-serif, system-ui', to: '"PingFang SC"', value: '"PingFang SC"', detail: { font: 'PingFang SC' } };
    const p = buildPrompt([rec(font)], ctx);
    expect(p).toContain('   - font-family: ui-sans-serif, system-ui → "PingFang SC"\n   - PingFang SC is installed on this computer; the page doesn\'t load it\n');
    expect(buildPrompt([rec({ ...font, status: 'applied' })], ctx, 'revert')).not.toContain('installed');
    setLocale('zh-CN');
    expect(buildPrompt([rec(font)], ctx)).toContain('   - PingFang SC 是本机装的字体，页面没有加载它');
  });

  it('props 写出组件和属性名；交给 Agent 时附上调用处', () => {
    const p = buildPrompt([rec({ kind: 'prop', props: ['variant'], propLabel: 'variant', from: '"primary"', to: '"ghost"', value: '"ghost"', detail: { component: 'Button', site: 'src/App.tsx:18' } })], ctx);
    expect(p).toContain('   - Prop variant of <Button>: "primary" → "ghost"');
    expect(p).toContain('   - Call site: src/App.tsx:18');
    expect(p).not.toContain('Tailwind');
  });

  it('还原：箭头反过来，要求不变', () => {
    const rule: RuleRef = {
      sheet: { index: 0, devId: null, href: null },
      path: [0],
      selector: '.card',
      fullSelector: '.card',
      conditions: ['@media (width >= 48rem)', '@layer base'],
      layer: 'base',
      ordinal: 0,
      matchCount: 2,
      utility: null,
    };
    const p = buildPrompt(
      [
        rec({ status: 'applied', preview: { kind: 'rule', rule, uid: 'u1' } }),
        rec({ id: 'b2', kind: 'text', status: 'applied', props: [], from: 'Old', to: 'New', value: 'New' }),
      ],
      { ...ctx, tailwind: false },
      'revert',
    );
    expect(p).toContain('On http://localhost:5173/, change the following 2 items back:');
    expect(p).toContain('   - padding-top: 24px → 16px');
    expect(p).toContain('   - Active rule: `@media (width >= 48rem) .card`');
    expect(p).toContain('   - Text: "New" → "Old"');
    expect(p).toContain('- Consider whether other places affected by this should change too');
  });
});
