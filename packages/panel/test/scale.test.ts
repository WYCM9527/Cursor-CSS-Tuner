import { describe, expect, it } from 'vitest';
import type { ScaleStep } from '@css-tuner/protocol';
import { displayNumber, displayValue, shortFile, varName } from '../src/lib/format';
import { nearest, scaleKeyOf, valuePx, type Ctx } from '../src/lib/scale';

const ctx: Ctx = { fontPx: 20, rootPx: 16 };
const spacing: ScaleStep[] = [
  { label: '0', value: '0px', token: '0' },
  { label: '1', value: '0.25rem', token: '1' },
  { label: '2', value: '0.5rem', token: '2' },
  { label: '4', value: '1rem', token: '4' },
  { label: '6', value: '1.5rem', token: '6' },
];

describe('刻度', () => {
  it('属性对应到主题里的刻度', () => {
    expect(scaleKeyOf('padding-left')).toBe('spacing');
    expect(scaleKeyOf('column-gap')).toBe('spacing');
    expect(scaleKeyOf('top')).toBe('spacing');
    expect(scaleKeyOf('max-width')).toBe('size');
    expect(scaleKeyOf('border-top-left-radius')).toBe('radius');
    expect(scaleKeyOf('line-height')).toBe('lineHeight');
    expect(scaleKeyOf('background-color')).toBe('colors');
    expect(scaleKeyOf('display')).toBeNull();
  });

  it('换算成 px：rem 按根字号、em 和无单位行高按元素字号', () => {
    expect(valuePx('1.5rem', ctx)).toBe(24);
    expect(valuePx('2em', ctx)).toBe(40);
    expect(valuePx('1.5', ctx, 'line-height')).toBe(30);
    expect(valuePx('150%', ctx, 'line-height')).toBe(30);
    expect(valuePx('normal', ctx, 'letter-spacing')).toBe(0);
    expect(valuePx('normal', ctx, 'line-height')).toBe(24);
    expect(valuePx('50%', ctx, 'width')).toBeNull();
    expect(valuePx('auto', ctx)).toBeNull();
  });

  it('找最近的刻度，±0.5px 内算正好落在刻度上', () => {
    expect(nearest(spacing, 15.8, ctx)).toMatchObject({ index: 3, px: 16, exact: true });
    expect(nearest(spacing, 13, ctx)).toMatchObject({ index: 3, px: 16, exact: false });
    expect(nearest(spacing, 3, ctx)).toMatchObject({ index: 1, px: 4 });
    expect(nearest([], 3, ctx)).toBeNull();
  });
});

describe('显示', () => {
  it('数值统一显示成 px，小数位按大小取', () => {
    expect(displayNumber('1.5rem', ctx)).toBe('24');
    expect(displayNumber('13.5px', ctx)).toBe('13.5');
    expect(displayNumber('2.25px', ctx)).toBe('2.25');
    expect(displayNumber('auto', ctx)).toBe('auto');
  });

  it('清单里颜色用十六进制、变量只显示名字', () => {
    expect(displayValue('rgb(59, 91, 219)')).toBe('#3b5bdb');
    expect(displayValue('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(displayValue('var(--color-brand, #000)')).toBe('--color-brand');
    expect(displayValue('12px')).toBe('12px');
    expect(varName('var( --x )')).toBe('--x');
    expect(varName('calc(var(--x) * 2)')).toBeNull();
    expect(shortFile('/Users/me/p/src/components/Card.tsx')).toBe('components/Card.tsx');
    expect(shortFile(null)).toBe('');
  });
});
