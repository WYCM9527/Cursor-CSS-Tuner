import { describe, expect, it } from 'vitest';
import { fontFamilies, primaryFamily, quoteFamily, sameFontFamily, sameFontStack, sameValue } from '../src';

describe('字体栈', () => {
  it('拆成字体名：去掉引号和转义，引号里的逗号不拆', () => {
    expect(fontFamilies(`"PingFang SC", 'Helvetica Neue', Arial ,sans-serif`)).toEqual(['PingFang SC', 'Helvetica Neue', 'Arial', 'sans-serif']);
    expect(fontFamilies('"A, B", serif')).toEqual(['A, B', 'serif']);
    expect(fontFamilies('"Say \\"Hi\\"", serif')).toEqual(['Say "Hi"', 'serif']);
    expect(fontFamilies('Times   New Roman')).toEqual(['Times New Roman']);
    expect(primaryFamily('ui-sans-serif, system-ui')).toBe('ui-sans-serif');
    expect(primaryFamily('')).toBe('');
  });

  it('写进 CSS：通用字体族和单个英文标识符不加引号，其余加双引号', () => {
    expect(quoteFamily('Inter')).toBe('Inter');
    expect(quoteFamily(' Serif ')).toBe('serif');
    expect(quoteFamily('system-ui')).toBe('system-ui');
    expect(quoteFamily('PingFang SC')).toBe('"PingFang SC"');
    expect(quoteFamily('赖江湖墨暖圆书')).toBe('"赖江湖墨暖圆书"');
    expect(quoteFamily('inherit')).toBe('"inherit"');
    expect(quoteFamily('3Dumb')).toBe('"3Dumb"');
    expect(quoteFamily('Say "Hi"')).toBe('"Say \\"Hi\\""');
  });

  it('核对看首选的字体（Agent 常会补后备字体），主题令牌看整串', () => {
    expect(sameFontFamily('"PingFang SC"', '"PingFang SC", -apple-system, sans-serif')).toBe(true);
    expect(sameFontFamily('Inter, sans-serif', 'inter')).toBe(true);
    expect(sameFontFamily('Inter', 'Roboto, Inter')).toBe(false);
    expect(sameValue('font-family', '"PingFang SC"', '"PingFang SC", sans-serif')).toBe(true);
    expect(sameValue('font-family', 'Georgia, serif', '"PingFang SC"')).toBe(false);
    const theme = "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";
    expect(sameFontStack(theme, 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"')).toBe(true);
    expect(sameFontStack(theme, 'ui-sans-serif, system-ui')).toBe(false);
  });
});
