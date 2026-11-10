import { createRoot } from 'react-dom/client';
import { getLocale, localeFrom, setLocale, t, type MsgKey, type PanelState } from '@css-tuner/protocol';
import { App } from './App';
import { PX_PER_UNIT } from './components/NumberField';
import type { Host } from './host';
import './styles.css';

/**
 * 商店页素材：把自测导出的面板状态按帧排成网格渲染，可以模拟按住数值字段拖动。
 * 整页截一张图，再按 window.__shots 里每帧的位置裁开，和页面截图逐帧合成。
 * 用法：/shots.html?lang=en&spec=/shots.json（状态文件和 spec 放在 public/ 下）
 */
interface FrameSpec {
  state: string;
  /** 按住标题为 field 的数值字段向右拖，值加 by 个步长 */
  drag?: { field: MsgKey; by: number };
  /** 要报告位置的元素：CSS 选择器，或数值字段的标题；拖动时报告拖到的位置 */
  point?: string | { field: MsgKey };
}

interface Spec {
  width: number;
  height: number;
  columns: number;
  prefs?: unknown;
  frames: FrameSpec[];
}

interface Shot {
  x: number;
  y: number;
  point: { x: number; y: number } | null;
  value: string | null;
}

declare global {
  interface Window {
    __shots?: Shot[];
  }
}

const params = new URLSearchParams(location.search);
setLocale(localeFrom(params.get('lang')));
document.documentElement.lang = getLocale();

function staticHost(state: PanelState, prefs: unknown): Host {
  return {
    send() {},
    subscribe(cb) {
      cb(state);
      return () => {};
    },
    load: <T,>(key: string, fallback: T) => (key === 'prefs' && prefs ? (prefs as T) : fallback),
    save() {},
  };
}

const fieldHandle = (box: HTMLElement, field: MsgKey) =>
  box.querySelector<HTMLElement>(`[aria-label="${CSS.escape(t('field.drag', { title: t(field) }))}"]`);

const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

const settle = () => new Promise((r) => setTimeout(r, 300));

async function main() {
  const spec = (await (await fetch(params.get('spec') ?? '/shots.json')).json()) as Spec;
  const states = await Promise.all(spec.frames.map((f) => fetch(f.state).then((r) => r.json() as Promise<PanelState>)));
  const grid = document.getElementById('root')!;
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${spec.columns},${spec.width}px);grid-auto-rows:${spec.height}px;height:auto`;
  const boxes = spec.frames.map((_, i) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:relative;overflow:hidden';
    grid.append(box);
    createRoot(box).render(<App host={staticHost({ ...states[i], locale: getLocale() }, spec.prefs)} />);
    return box;
  });
  await settle();

  const drags = new Map<number, { x: number; y: number }>();
  spec.frames.forEach((f, i) => {
    if (!f.drag) return;
    const handle = fieldHandle(boxes[i], f.drag.field);
    if (!handle) throw new Error(`frame ${i}: no field ${f.drag.field}`);
    const from = center(handle);
    const to = { x: from.x + PX_PER_UNIT * f.drag.by, y: from.y };
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: from.x, clientY: from.y }));
    // 先越过 3px 的起拖距离，拖一个步长也能动
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: from.x + 3 * Math.sign(f.drag.by), clientY: from.y }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: to.x, clientY: to.y }));
    drags.set(i, to);
  });
  await settle();

  window.__shots = spec.frames.map((f, i) => {
    const box = boxes[i].getBoundingClientRect();
    const target = typeof f.point === 'string' ? boxes[i].querySelector(f.point) : f.point ? fieldHandle(boxes[i], f.point.field) : null;
    const at = drags.get(i) ?? (target ? center(target) : null);
    const input = f.drag ? fieldHandle(boxes[i], f.drag.field)?.parentElement?.querySelector('input') : null;
    return {
      x: box.left + scrollX,
      y: box.top + scrollY,
      point: at ? { x: Math.round(at.x - box.left), y: Math.round(at.y - box.top) } : null,
      value: input?.value ?? null,
    };
  });
  document.body.dataset.ready = '1';
}

void main();
