import { formatNumber, type MeasureStep } from '@css-tuner/protocol';
import { setMeasureDraw, type MeasureDraw } from './overlay';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 一段距离：axis 为 x 时是 y = at 上从 x = from 到 x = to 的横线，为 y 时是 x = at 上的竖线 */
export interface Span {
  axis: 'x' | 'y';
  from: number;
  to: number;
  at: number;
}

/** 量线碰不到目标元素时补的虚线：从量线的端点引到目标的边上 */
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const MIN = 0.5;

/**
 * 选中元素 a 和悬停元素 b 之间的距离：两者分开时量中间的空隙（横竖各一段），
 * 套在里面或交叠时量对应的四条边（上对上、下对下、左对左、右对右）
 */
export function measure(a: Box, b: Box): { spans: Span[]; guides: Guide[] } {
  const spans: Span[] = [];
  const guides: Guide[] = [];
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const midX = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
  const midY = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
  if (ox > 0 && oy > 0) {
    const edge = (axis: Span['axis'], p: number, q: number, at: number) => {
      if (Math.abs(p - q) >= MIN) spans.push({ axis, from: Math.min(p, q), to: Math.max(p, q), at });
    };
    edge('y', a.top, b.top, midX);
    edge('y', a.bottom, b.bottom, midX);
    edge('x', a.left, b.left, midY);
    edge('x', a.right, b.right, midY);
    return { spans, guides };
  }
  // 另一个方向上没有重叠时，量线画在选中元素的中线上，再补一条虚线引到目标
  if (ox <= 0) {
    const toRight = a.right <= b.left;
    const from = toRight ? a.right : b.right;
    const to = toRight ? b.left : a.left;
    if (to - from >= MIN) {
      const at = oy > 0 ? midY : (a.top + a.bottom) / 2;
      spans.push({ axis: 'x', from, to, at });
      const x = toRight ? b.left : b.right;
      if (oy <= 0) guides.push({ x1: x, y1: at, x2: x, y2: at < b.top ? b.top : b.bottom });
    }
  }
  if (oy <= 0) {
    const below = a.bottom <= b.top;
    const from = below ? a.bottom : b.bottom;
    const to = below ? b.top : a.top;
    if (to - from >= MIN) {
      const at = ox > 0 ? midX : (a.left + a.right) / 2;
      spans.push({ axis: 'y', from, to, at });
      const y = below ? b.top : b.bottom;
      if (ox <= 0) guides.push({ x1: at, y1: y, x2: at < b.left ? b.left : b.right, y2: y });
    }
  }
  return { spans, guides };
}

/** 距离正好是某一档间距时带上它的名字：`16 · 4` */
export function spanLabel(px: number, steps: MeasureStep[]): string {
  const n = formatNumber(px, 1);
  const step = steps.find((s) => Math.abs(s.px - px) < 0.05);
  return step ? `${n} · ${step.label}` : n;
}

/** 量的起点：选中元素 */
let anchor: () => Element | null = () => null;
let target: Element | null = null;
let steps: MeasureStep[] = [];

function draw(): MeasureDraw | null {
  const a = anchor();
  const b = target;
  if (!a || !b || a === b || !b.isConnected) return null;
  const m = measure(a.getBoundingClientRect(), b.getBoundingClientRect());
  return { spans: m.spans.map((s) => ({ ...s, label: spanLabel(s.to - s.from, steps) })), guides: m.guides };
}

export function initMeasure(a: () => Element | null) {
  anchor = a;
}

export function disposeMeasure() {
  measureTo(null);
  anchor = () => null;
}

/** 量 el 和选中元素之间的距离（元素滚动、动画时跟着走），null 收起量线 */
export function measureTo(el: Element | null) {
  target = el;
  setMeasureDraw(el ? draw : null);
}

export function setMeasureSteps(s: MeasureStep[]) {
  steps = s;
}
