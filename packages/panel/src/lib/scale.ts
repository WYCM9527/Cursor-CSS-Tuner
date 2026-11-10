import { parseCssNumber, toPx, type ElementSnapshot, type Scales, type ScaleStep } from '@css-tuner/protocol';

export type ScaleKey = Exclude<keyof Scales, 'mode' | 'rem' | 'gradientIn'>;

/** 属性 → 主题里对应的刻度 */
export function scaleKeyOf(prop: string): ScaleKey | null {
  if (/^(padding|margin)/.test(prop) || prop === 'row-gap' || prop === 'column-gap' || ['top', 'right', 'bottom', 'left'].includes(prop)) return 'spacing';
  if (/^(min-|max-)?(width|height)$/.test(prop)) return 'size';
  if (prop === 'font-size') return 'fontSize';
  if (prop === 'font-weight') return 'fontWeight';
  if (prop === 'line-height') return 'lineHeight';
  if (prop === 'letter-spacing') return 'letterSpacing';
  if (/radius$/.test(prop)) return 'radius';
  if (prop === 'box-shadow') return 'shadow';
  if (prop === 'opacity') return 'opacity';
  if (/^border-(top|right|bottom|left)-width$/.test(prop)) return 'borderWidth';
  if (prop === 'color' || prop === 'background-color' || /^border-(top|right|bottom|left)-color$/.test(prop)) return 'colors';
  if (prop === 'z-index') return 'zIndex';
  return null;
}

export interface Ctx {
  fontPx: number;
  rootPx: number;
}

export function ctxOf(el: ElementSnapshot | null | undefined): Ctx {
  return { fontPx: el?.fontSizePx ?? 16, rootPx: el?.rootFontSizePx ?? 16 };
}

/** 刻度值换算成 px（行高的无单位倍数、em 按元素字号换算），换算不了返回 null */
export function stepPx(step: ScaleStep, ctx: Ctx, prop?: string): number | null {
  if (typeof step.px === 'number') return step.px;
  return valuePx(step.value, ctx, prop);
}

export function valuePx(value: string, ctx: Ctx, prop?: string): number | null {
  const v = value.trim();
  if (v === 'normal') return prop === 'letter-spacing' ? 0 : prop === 'line-height' ? ctx.fontPx * 1.2 : null;
  const n = parseCssNumber(v);
  if (!n) return null;
  if (n.unit === '') return prop === 'line-height' ? n.num * ctx.fontPx : n.num;
  if (n.unit === '%') return prop === 'line-height' || prop === 'font-size' ? (n.num / 100) * ctx.fontPx : null;
  return toPx(v, ctx.rootPx, ctx.fontPx);
}

export interface Snap {
  step: ScaleStep;
  index: number;
  px: number;
  exact: boolean;
}

/** 找离 px 最近的刻度；exact 表示正好落在刻度上（±0.5px） */
export function nearest(steps: ScaleStep[], px: number, ctx: Ctx, prop?: string): Snap | null {
  let best: Snap | null = null;
  steps.forEach((step, index) => {
    const p = stepPx(step, ctx, prop);
    if (p === null) return;
    if (!best || Math.abs(p - px) < Math.abs(best.px - px)) best = { step, index, px: p, exact: Math.abs(p - px) <= 0.5 };
  });
  return best;
}
