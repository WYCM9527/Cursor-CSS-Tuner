import { describe, expect, it } from 'vitest';
import type { PageInfo } from '@css-tuner/protocol';
import { cssScales, emptyScales, measureSteps } from '../src/scales';

describe('标尺上的刻度名', () => {
  it('来自间距刻度：同一个 px 只留第一个名字，0 和没有 px 的不要', () => {
    const s = emptyScales(16, 'tailwind');
    s.spacing = [
      { label: '0', value: '0px', px: 0 },
      { label: 'px', value: '1px', px: 1 },
      { label: '4', value: '1rem', px: 16 },
      { label: 'md', value: '1rem', px: 16 },
      { label: 'auto', value: 'auto' },
    ];
    expect(measureSteps(s)).toEqual([
      { px: 1, label: 'px' },
      { px: 16, label: '4' },
    ]);
  });
});

describe('普通 CSS 项目的刻度', () => {
  it('像字体的变量归到字体，值是整串字体栈；font 简写、字体样式、字号、字重和阴影不算', () => {
    const page: PageInfo = {
      url: 'http://localhost:5174/',
      title: '',
      react: false,
      vite: false,
      sheets: [],
      rootVars: [
        { name: '--font-body', value: 'system-ui, sans-serif', kind: 'other' },
        { name: '--ff-display', value: '"Playfair Display", serif', kind: 'other' },
        { name: '--font', value: '16px/1.5 Inter, sans-serif', kind: 'other' },
        { name: '--font-style-quote', value: 'italic', kind: 'other' },
        { name: '--font-weight-bold', value: '700', kind: 'number' },
        { name: '--font-lg', value: '20px', kind: 'length' },
        { name: '--shadow-md', value: '0 1px 2px rgb(0 0 0 / 0.1)', kind: 'other' },
      ],
    };
    const s = cssScales(page, 16);
    expect(s.fontFamily).toEqual([
      { label: '--font-body', value: 'system-ui, sans-serif', token: '--font-body' },
      { label: '--ff-display', value: '"Playfair Display", serif', token: '--ff-display' },
    ]);
    expect(s.fontSize.map((x) => x.token)).toEqual(['--font-lg']);
    expect(s.fontWeight.map((x) => x.token)).toContain('--font-weight-bold');
    expect(s.shadow.map((x) => x.token)).toContain('--shadow-md');
  });
});
