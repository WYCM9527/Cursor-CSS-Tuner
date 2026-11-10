import { toPx, type CssVar, type MeasureStep, type PageInfo, type Scales, type ScaleStep } from '@css-tuner/protocol';

const WEIGHTS: Array<[string, string]> = [
  ['thin', '100'],
  ['extralight', '200'],
  ['light', '300'],
  ['normal', '400'],
  ['medium', '500'],
  ['semibold', '600'],
  ['bold', '700'],
  ['extrabold', '800'],
  ['black', '900'],
];

export function emptyScales(rem: number, mode: Scales['mode'] = 'css'): Scales {
  return {
    mode,
    rem,
    spacing: [],
    size: [],
    radius: [],
    fontFamily: [],
    fontSize: [],
    fontWeight: WEIGHTS.map(([label, value]) => ({ label, value, token: null })),
    lineHeight: [],
    letterSpacing: [],
    shadow: [{ label: 'none', value: 'none', token: null }],
    colors: [],
    opacity: [],
    zIndex: [],
    borderWidth: [],
  };
}

type Bucket = Exclude<keyof Scales, 'mode' | 'rem' | 'gradientIn'>;

/** 按变量名猜用途；猜不出的长度归到间距 */
function bucketOf(v: CssVar): Bucket | null {
  const n = v.name.toLowerCase();
  if (v.kind === 'color') return 'colors';
  // 字体栈：名字像字体，值不以数字开头（排除 font 简写）
  if (v.kind === 'other' && /font|family|typeface|^--ff-/.test(n) && !/size|weight|style|stretch|feature|variation|smooth/.test(n) && !/^\d/.test(v.value.trim())) return 'fontFamily';
  if (/shadow|elevation/.test(n)) return 'shadow';
  if (v.kind === 'number') {
    if (/weight|fw/.test(n)) return 'fontWeight';
    if (/opacity|alpha/.test(n)) return 'opacity';
    if (/leading|line-height|lh/.test(n)) return 'lineHeight';
    return null;
  }
  if (v.kind !== 'length') return null;
  if (/radius|round|corner/.test(n)) return 'radius';
  if (/border|stroke|outline/.test(n)) return 'borderWidth';
  if (/leading|line-height|lh/.test(n)) return 'lineHeight';
  if (/tracking|letter/.test(n)) return 'letterSpacing';
  if (/font-size|text-|fs-|^--font-|type-|step-/.test(n)) return 'fontSize';
  if (/width|container|breakpoint|screen|max-|min-|^--w-|^--h-/.test(n)) return 'size';
  return 'spacing';
}

/** 普通 CSS 项目：刻度来自 :root 上的自定义属性，选了刻度的值写成 var(--x) */
export function cssScales(page: PageInfo, rem: number): Scales {
  const s = emptyScales(rem, 'css');
  for (const v of page.rootVars) {
    const b = bucketOf(v);
    if (!b) continue;
    const step: ScaleStep = { label: v.name, value: `var(${v.name})`, token: v.name };
    if (v.kind === 'length') {
      const px = toPx(v.value, rem, rem);
      if (px === null) continue;
      step.px = px;
    } else if (v.kind === 'number') {
      step.px = parseFloat(v.value);
    } else if (v.kind === 'color' || b === 'fontFamily') {
      step.value = v.value;
    }
    if (b === 'shadow') step.value = `var(${v.name})`;
    (s[b] as ScaleStep[]).push(step);
  }
  s.size = [...s.spacing, ...s.size];
  return s;
}

/** 标尺上的刻度名来自间距刻度：同一个 px 有几个名字时用第一个 */
export function measureSteps(scales: Scales): MeasureStep[] {
  const seen = new Set<number>();
  const steps: MeasureStep[] = [];
  for (const s of scales.spacing) {
    if (s.px == null || s.px <= 0) continue;
    const k = Math.round(s.px * 100);
    if (seen.has(k)) continue;
    seen.add(k);
    steps.push({ px: s.px, label: s.label });
  }
  return steps;
}
