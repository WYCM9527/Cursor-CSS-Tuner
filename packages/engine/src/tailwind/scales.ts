import { toPx, type Scales, type ScaleStep } from '@css-tuner/protocol';
import type { TwDesign } from './design';

/** Tailwind v3 以来常用的间距倍数；v4 任意倍数都合法，这里只挑常用的做吸附 */
const SPACING_STEPS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];

function num(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

function px(value: string, rem: number): number | undefined {
  const v = toPx(value, rem, rem);
  return v === null ? undefined : v;
}

/** 刻度来自项目实际加载的设计系统（含 @theme 或 tailwind.config 里自定义的令牌） */
export function tailwindScales(d: TwDesign, rem = d.rem): Scales {
  const base = d.themeValue('--spacing') ?? '0.25rem';
  const unit = /^([\d.]+)(rem|px|em)$/.exec(base.trim());
  // 基准倍数只留项目里真有的类（v3 的主题可能整个换掉），单独定义过的令牌按定义的值
  const namedSpacing = new Map(d.namespace('--spacing').filter((e): e is [string, string] => e[0] !== null));
  const spacing: ScaleStep[] = [];
  if (unit) {
    const n = parseFloat(unit[1]);
    for (const k of SPACING_STEPS) {
      const token = num(k);
      if (!namedSpacing.has(token) && d.valid(`p-${token}`)) {
        const value = k === 0 ? '0px' : `${num(n * k)}${unit[2]}`;
        spacing.push({ label: token, value, px: px(value, rem), token });
      }
      if (k === 0 && !namedSpacing.has('px') && d.valid('p-px')) spacing.push({ label: 'px', value: '1px', px: 1, token: 'px' });
    }
  }
  for (const [k, v] of namedSpacing) spacing.push({ label: k, value: v, px: px(v, rem), token: k });

  const size: ScaleStep[] = [...spacing];
  for (const [k, v] of d.namespace('--container')) {
    if (k !== null) size.push({ label: k, value: v, px: px(v, rem), token: k });
  }

  const radius: ScaleStep[] = [{ label: 'none', value: '0px', px: 0, token: 'none' }];
  for (const [k, v] of d.namespace('--radius')) {
    radius.push({ label: k ?? 'DEFAULT', value: v, px: px(v, rem), token: k ?? '' });
  }
  radius.push({ label: 'full', value: '9999px', px: 9999, token: 'full' });

  // --font 下还有 --font-weight-*、--font-sans--font-feature-settings 这类：只留 font-* 类设置字体的。
  // 主题里的字体栈常写成好几行，空白压成一个空格
  const fontFamily: ScaleStep[] = [];
  for (const [k, v] of d.namespace('--font')) {
    if (k === null || k.includes('--') || !d.info(`font-${k}`)?.values.has('font-family')) continue;
    fontFamily.push({ label: k, value: v.replace(/\s+/g, ' ').trim(), token: k });
  }

  const fontSize: ScaleStep[] = [];
  for (const [k, v] of d.namespace('--text')) {
    if (k === null || k.includes('--')) continue;
    fontSize.push({ label: k, value: v, px: px(v, rem), token: k });
  }

  const fontWeight: ScaleStep[] = d.namespace('--font-weight').flatMap(([k, v]) => (k === null ? [] : [{ label: k, value: v, token: k }]));

  const lineHeight: ScaleStep[] = [{ label: 'none', value: '1', token: 'none' }];
  const namedLeading = new Map(d.namespace('--leading').filter((e): e is [string, string] => e[0] !== null));
  for (const [k, v] of namedLeading) lineHeight.push({ label: k, value: v, token: k });
  if (unit) {
    const n = parseFloat(unit[1]);
    for (const k of [3, 4, 5, 6, 7, 8, 9, 10]) {
      if (namedLeading.has(String(k)) || !d.valid(`leading-${k}`)) continue;
      const value = `${num(n * k)}${unit[2]}`;
      lineHeight.push({ label: String(k), value, px: px(value, rem), token: String(k) });
    }
  }

  const letterSpacing: ScaleStep[] = d.namespace('--tracking').flatMap(([k, v]) => (k === null ? [] : [{ label: k, value: v, token: k }]));

  const shadow: ScaleStep[] = [{ label: 'none', value: 'none', token: 'none' }];
  for (const [k, v] of d.namespace('--shadow')) {
    shadow.push({ label: k ?? 'DEFAULT', value: v, token: k ?? '' });
  }

  const colors: ScaleStep[] = [];
  for (const [k, v] of d.namespace('--color')) {
    if (k !== null) colors.push({ label: k, value: v, token: k });
  }
  if (!colors.some((c) => c.token === 'transparent')) colors.push({ label: 'transparent', value: 'transparent', token: 'transparent' });

  const opacity: ScaleStep[] = Array.from({ length: 21 }, (_, i) => ({ label: String(i * 5), value: num(i / 20), token: String(i * 5) }));

  const zIndex: ScaleStep[] = [0, 10, 20, 30, 40, 50].map((n) => ({ label: String(n), value: String(n), px: n, token: String(n) }));

  // 粗细取设计系统实际生成的值（v3 的 tailwind.config 可能改过 borderWidth）
  const borderWidth: ScaleStep[] = [];
  for (const k of ['0', '', '2', '4', '8']) {
    const value = d.info(k ? `border-${k}` : 'border')?.values.get('border-top-width');
    if (value) borderWidth.push({ label: k || 'DEFAULT', value, px: px(value, rem), token: k });
  }

  return {
    mode: 'tailwind',
    rem,
    spacing,
    size,
    radius,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing,
    shadow,
    colors,
    opacity,
    zIndex,
    borderWidth,
    ...(d.major >= 4 ? { gradientIn: 'oklab' } : {}),
  };
}
