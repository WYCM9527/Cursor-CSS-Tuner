import { parseColor, sameColor } from './color';
import { sameFontFamily } from './fonts';
import { sameBackgroundImage } from './gradient';
import { propMeta } from './props';
import { splitTopLevel } from './selectors';
import { toPx } from './values';

const COLOR_IN_LAYER = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[\da-f]{3,8}\b|\btransparent\b/i;

/** 阴影去掉全透明的层（画不出东西）：Tailwind 会在 --tw-shadow 前面拼 ring 之类的 0 0 #0000 占位层 */
function visibleShadows(v: string): string {
  const layers = splitTopLevel(v, ',')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => {
      if (!l || l === 'none') return false;
      const color = COLOR_IN_LAYER.exec(l)?.[0];
      return !color || parseColor(color)?.a !== 0;
    });
  return layers.join(', ') || 'none';
}

/** 按背景层数重复的列表：计算值的项数跟着背景图的层数走，padding-box 和 padding-box, padding-box 是同一个写法 */
const LAYER_LISTS = new Set(['background-clip', 'background-origin']);

function sameLayerList(a: string, b: string): boolean {
  const la = splitTopLevel(a, ',').map((s) => s.trim());
  const lb = splitTopLevel(b, ',').map((s) => s.trim());
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) if (la[i % la.length] !== lb[i % lb.length]) return false;
  return true;
}

/** 两个计算值是否视为相同：颜色按感知距离、长度允许 ±0.5px、纯数字允许 0.01 误差，渐变按画出来的样子，字体看首选的字体 */
export function sameValue(prop: string, a: string, b: string): boolean {
  if (a === b) return true;
  if (prop === 'font-family') return sameFontFamily(a, b);
  if (prop === 'box-shadow' || prop === 'text-shadow') return visibleShadows(a) === visibleShadows(b);
  if (prop === 'background-image') return sameBackgroundImage(a, b);
  if (LAYER_LISTS.has(prop)) return sameLayerList(a, b);
  const kind = propMeta(prop)?.kind;
  if (kind === 'color' || (parseColor(a) && parseColor(b))) return sameColor(a, b);
  const pa = toPx(a);
  const pb = toPx(b);
  if (pa != null && pb != null) return Math.abs(pa - pb) <= 0.5;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(na) === a.trim() && String(nb) === b.trim()) return Math.abs(na - nb) < 0.01;
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}
