import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTailwindDesign, previewCompanions, tailwindScales, type TwDesign } from '../src';
import { namespaces } from '../src/tailwind/v3';

const FIX = join(__dirname, '../../../fixtures/tw3-react');

let d: TwDesign;
beforeAll(async () => {
  d = await loadTailwindDesign(join(FIX, 'src/index.css'));
});

describe('Tailwind 3 设计系统（fixtures/tw3-react）', () => {
  it('按项目装的版本加载，主题来自 tailwind.config.ts', () => {
    expect(d.major).toBe(3);
    expect(d.files.map((f) => f.split('/').pop())).toEqual(['index.css', 'tailwind.config.ts']);
    expect(d.css('p-4')).toBe('.p-4 {\n  padding: 1rem;\n}\n');
    expect(d.css('md:p-8')).toContain('@media (min-width: 768px) {\n  .md\\:p-8 {\n    padding: 2rem;\n  }\n}');
    expect(d.valid('bg-brand')).toBe(true);
    expect(d.valid('p-13')).toBe(false);
    expect(d.valid('btn-primary')).toBe(false);
    expect(d.themeValue('--spacing')).toBe('0.25rem');
    expect(d.themeValue('--color-brand')).toBe('#3b5bdb');
    expect(d.themeValue('--text-lg--line-height')).toBe('1.75rem');
  });

  it('工具类管的属性：字号的行高、阴影都按 v4 的语义', () => {
    const lg = d.info('text-lg')!;
    expect([...lg.hard]).toEqual(['font-size']);
    expect(lg.soft.has('line-height')).toBe(true);
    expect([...d.info('text-lg/7')!.hard].sort()).toEqual(['font-size', 'line-height']);
    expect([...d.info('shadow-md')!.hard]).toEqual(['box-shadow']);
    expect(d.info('!p-4')!.important).toBe(true);
  });

  it('任意值换成主题写法', () => {
    expect(d.canonical('px-[40px]')).toBe('px-10');
    expect(d.canonical('md:p-[2rem]')).toBe('md:p-8');
    expect(d.canonical('!p-[16px]')).toBe('!p-4');
    expect(d.canonical('bg-[#3B5BDB]')).toBe('bg-brand');
    expect(d.canonical('text-[#1c1c1e]')).toBe('text-ink');
    expect(d.canonical('rounded-[14px]')).toBe('rounded-card');
    expect(d.canonical('rounded-[0.25rem]')).toBe('rounded');
    expect(d.canonical('opacity-[35%]')).toBe('opacity-35');
    expect(d.canonical('font-[900]')).toBe('font-black');
    expect(d.canonical('text-[length:19px]')).toBe('text-[19px]');
    expect(d.canonical('text-[length:1rem]')).toBe('text-[1rem]');
    expect(d.canonical('px-[13px]')).toBe('px-[13px]');
  });
});

describe('Tailwind 3 刻度', () => {
  it('来自 tailwind.config，含 extend 里的令牌，不重复', () => {
    const s = tailwindScales(d);
    expect(s.spacing.find((x) => x.token === '4')?.px).toBe(16);
    expect(s.spacing.find((x) => x.token === 'gutter')?.px).toBe(18);
    expect(s.spacing.filter((x) => x.token === '4')).toHaveLength(1);
    expect(s.spacing.slice(0, 3).map((x) => x.token)).toEqual(['0', 'px', '0.5']);
    expect(s.radius.find((x) => x.token === 'card')?.px).toBe(14);
    expect(s.radius.find((x) => x.label === 'DEFAULT')?.token).toBe('');
    expect(s.colors.find((x) => x.token === 'brand')?.value).toBe('#3b5bdb');
    expect(s.colors.find((x) => x.token === 'red-500')?.value).toBe('#ef4444');
    expect(s.fontSize.find((x) => x.token === 'lg')?.px).toBe(18);
    expect(s.fontSize.some((x) => x.label.includes('--'))).toBe(false);
    expect(s.size.find((x) => x.token === '3xl')?.px).toBe(768);
    expect(s.lineHeight.filter((x) => x.token === '6')).toHaveLength(1);
    expect(s.lineHeight.find((x) => x.token === 'tight')?.value).toBe('1.25');
    expect(s.shadow.find((x) => x.label === 'DEFAULT')?.token).toBe('');
    expect(s.breakpoints.map((b) => `${b.name}=${b.px}`)).toEqual(['sm=640', 'md=768', 'lg=1024', 'xl=1280', '2xl=1536']);
    expect(s.fontFamily.map((x) => x.token)).toEqual(['sans', 'serif', 'mono']);
    expect(s.fontFamily[0].value).toMatch(/^ui-sans-serif, system-ui, sans-serif, /);
  });

  it('字体：数组用逗号连起来，带 fontFeatureSettings 这类选项的只取字体', () => {
    const { spaces } = namespaces({
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: [['"Playfair Display"', 'serif'], { fontFeatureSettings: '"ss01"' }],
        body: ['"Source Sans 3", sans-serif', { fontVariationSettings: '"opsz" 32' }],
        mono: 'Menlo, monospace',
      },
    } as never);
    expect([...spaces.get('--font')!]).toEqual([
      ['sans', 'Inter, sans-serif'],
      ['display', '"Playfair Display", serif'],
      ['body', '"Source Sans 3", sans-serif'],
      ['mono', 'Menlo, monospace'],
    ]);
  });

  it('断点来自 screens：字符串和 { min } 算，只有上限的、raw、数组不算', () => {
    const { spaces } = namespaces({
      screens: { sm: '640px', tablet: { min: '700px', max: '900px' }, narrow: { max: '500px' }, print: { raw: 'print' }, multi: ['1400px'] },
    } as never);
    expect([...spaces.get('--breakpoint')!]).toEqual([
      ['sm', '640px'],
      ['tablet', '700px'],
    ]);
  });

  it('预览字号令牌时带上它的默认行高', () => {
    expect(previewCompanions(d, ['font-size'], 'lg')).toEqual({ 'line-height': 'var(--tw-leading, 1.75rem)' });
    expect(previewCompanions(d, ['padding-left', 'padding-right'], '4')).toEqual({});
  });
});

describe('Tailwind 3 配置的查找和重新读取', () => {
  const dir = join(FIX, '.tmp-config-test');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('@config 指定的配置；改过之后重新加载能读到新值', async () => {
    mkdirSync(join(dir, 'css'), { recursive: true });
    mkdirSync(join(dir, 'cfg'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ "private": true }\n');
    writeFileSync(join(dir, 'css/app.css'), '@config "../cfg/tw.cjs";\n@tailwind utilities;\n');
    const write = (hex: string) =>
      writeFileSync(join(dir, 'cfg/tw.cjs'), `const shared = require('./shared.cjs');\nmodule.exports = { content: [], theme: { extend: { colors: { brand: '${hex}', ...shared } } } };\n`);
    writeFileSync(join(dir, 'cfg/shared.cjs'), "module.exports = { accent: '#ff0000' };\n");
    write('#111111');
    const a = await loadTailwindDesign(join(dir, 'css/app.css'));
    expect(a.css('bg-brand')).toContain('rgb(17 17 17');
    expect(a.css('bg-accent')).toContain('rgb(255 0 0');
    expect(a.files.map((f) => f.split('/').pop())).toEqual(['app.css', 'tw.cjs', 'shared.cjs']);
    write('#222222');
    writeFileSync(join(dir, 'cfg/shared.cjs'), "module.exports = { accent: '#00ff00' };\n");
    const b = await loadTailwindDesign(join(dir, 'css/app.css'));
    expect(b.css('bg-brand')).toContain('rgb(34 34 34');
    expect(b.css('bg-accent')).toContain('rgb(0 255 0');
  });

  it('没有配置文件时用默认主题', async () => {
    mkdirSync(join(dir, 'bare'), { recursive: true });
    writeFileSync(join(dir, 'bare/package.json'), '{ "private": true }\n');
    writeFileSync(join(dir, 'bare/index.css'), '@tailwind utilities;\n');
    const c = await loadTailwindDesign(join(dir, 'bare/index.css'));
    expect(c.major).toBe(3);
    expect(c.files.map((f) => f.split('/').pop())).toEqual(['index.css']);
    expect(c.valid('bg-red-500')).toBe(true);
    expect(c.valid('bg-brand')).toBe(false);
  });
});
