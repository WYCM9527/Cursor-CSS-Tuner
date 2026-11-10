import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTailwindDesign, locateClassSite, previewCompanions, tailwindScales, type TwDesign } from '../src';

const FIX = join(__dirname, '../../../fixtures/tw-react');
const APP = join(FIX, 'src/App.tsx');

let d: TwDesign;
beforeAll(async () => {
  d = await loadTailwindDesign(join(FIX, 'src/index.css'));
  // Tailwind 4 第一次规范类名要先建整张反查表，CI 上要好几秒，不能算进第一个测试的超时
  d.canonical('p-4');
}, 30_000);

describe('JSX 上的 className（fixtures/tw-react）', () => {
  const app = readFileSync(APP, 'utf8');
  const tokens = (line: number, column: number) => {
    const s = locateClassSite(app, APP, line, column);
    if ('error' in s) throw new Error(s.error);
    return s.tokens.map((t) => `${t.text}${t.editable ? '' : '!'}${t.seg.conditional ? '?' : ''}`);
  };

  it('字符串字面量、clsx 参数、模板字符串、只用了一次的常量', () => {
    expect(tokens(14, 7)).toEqual(['flex', 'items-center', 'justify-between', 'bg-brand', 'px-6', 'py-4', 'text-white']);
    expect(tokens(19, 7)).toEqual(['mt-2', 'text-sm', 'text-ink/70', 'underline?']);
    expect(tokens(23, 7)).toEqual(expect.arrayContaining(['rounded-card', 'mt-4', 'p-4']));
    expect(tokens(42, 7)).toEqual(['rounded-md', 'bg-brand', 'px-4', 'py-2', 'text-white']);
  });

  it('没有 className 的元素', () => {
    const s = locateClassSite(app, APP, 27, 7);
    expect('error' in s || s.hasClassName).toBe(false);
  });

  it('className 来自组件参数时没有写死的类名', () => {
    const s = locateClassSite('export const X = (p: { c: string }) => <div className={p.c} />;\n', '/x.tsx', 1, 40);
    expect('error' in s || s.tokens).toEqual([]);
  });
});

describe('Tailwind 设计系统', () => {
  it('任意值规范成主题写法，主题里没有的保留任意值', () => {
    expect(d.canonical('px-[40px]')).toBe('px-10');
    expect(d.canonical('px-[13px]')).toBe('px-3.25');
    expect(d.canonical('px-[13.5px]')).toBe('px-[13.5px]');
  });
});

describe('Tailwind 刻度', () => {
  it('来自项目设计系统，含 @theme 自定义令牌', () => {
    const s = tailwindScales(d);
    expect(s.mode).toBe('tailwind');
    expect(s.spacing.find((x) => x.token === '4')?.px).toBe(16);
    expect(s.spacing.find((x) => x.token === 'gutter')?.px).toBe(18);
    expect(s.radius.find((x) => x.token === 'card')?.px).toBe(14);
    expect(s.colors.find((x) => x.token === 'brand')?.value).toBe('#3b5bdb');
    expect(s.fontSize.find((x) => x.token === 'lg')?.px).toBe(18);
    expect(s.fontSize.some((x) => x.label.includes('--'))).toBe(false);
    // --font 下的 --font-weight-* 不算字体；theme.css 里分几行写的字体栈压成一行
    expect(s.fontFamily.map((x) => x.token)).toEqual(['sans', 'serif', 'mono']);
    expect(s.fontFamily.find((x) => x.token === 'mono')?.value).toMatch(/^ui-monospace, SFMono-Regular, .*, "Courier New", monospace$/);
    expect(s.size.find((x) => x.token === '3xl')?.px).toBe(768);
  });

  it('预览字号令牌时带上它的默认行高，保留 --tw-leading 让 leading-* 仍然生效', () => {
    const lh = previewCompanions(d, ['font-size'], 'lg')['line-height'];
    expect(lh).toMatch(/^var\(--tw-leading,\s*calc\(1\.75\s*\/\s*1\.125\)\)$/);
    expect(previewCompanions(d, ['font-size'], null)).toEqual({});
    expect(previewCompanions(d, ['padding-left', 'padding-right'], '4')).toEqual({});
  });
});
