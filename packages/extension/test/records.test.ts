import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, type ElementSnapshot, type RuleRef } from '@css-tuner/protocol';
import { buildPrompt } from '../src/prompt';
import { recordElement, recordView, samePage, upgradeRecord, type ChangeRecord, type StoredRecord } from '../src/records';

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
    const phone = rec({ ...ownClass, id: 'c3', band: { name: 'mobile', min: 0, max: 768 } });
    const p = buildPrompt([pad, phone], ctx);
    expect(p).toContain('2. Element `h1.title`');
    expect(p).toContain('   - Only when the page is narrower than 768px (phone); wider stays the same');
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
