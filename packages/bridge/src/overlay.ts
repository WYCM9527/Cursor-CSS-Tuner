import { dropSlot, slotLine } from './drop';
import { OWN_ATTR, labelOf } from './util';

// 只用灰阶，而且要在任意颜色的页面上都看得见：线都是黑白两层，拖动时的影子用半透明中灰
const STYLE = `
:host { all: initial; }
.box { position: fixed; pointer-events: none; box-sizing: border-box; }
.sel-outline { outline: 1.5px solid #fff; box-shadow: 0 0 0 2.5px #111; }
.hov-outline { outline: 1px dashed #fff; box-shadow: 0 0 0 1px #111; }
.peer { outline: 1px dotted #fff; box-shadow: 0 0 0 1px rgba(17, 17, 17, 0.55); }
.tag { position: fixed; pointer-events: none; font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; color: #f5f5f5;
  background: #111; padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 70vw; overflow: hidden;
  text-overflow: ellipsis; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 2px 8px rgba(0, 0, 0, 0.3); }
.tag .dim { opacity: 0.6; margin-left: 6px; }
.grip { position: fixed; pointer-events: auto; box-sizing: border-box; width: 16px; height: 20px; border-radius: 4px; background: #111; color: #f5f5f5;
  display: flex; align-items: center; justify-content: center; cursor: grab; touch-action: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 2px 8px rgba(0, 0, 0, 0.3); }
.grip:hover { background: #2a2a2a; }
.grip.dragging { cursor: grabbing; background: #2a2a2a; }
.line { position: fixed; pointer-events: none; background: #111; box-shadow: 0 0 0 1px #fff; border-radius: 1px; }
.ghost { position: fixed; pointer-events: none; outline: 1.5px dashed #fff; box-shadow: 0 0 0 2.5px rgba(17, 17, 17, 0.6); background: rgba(128, 128, 128, 0.12); }
.mline, .mcap { position: fixed; pointer-events: none; background: #111; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9); }
.mguide { position: fixed; pointer-events: none; background: repeating-linear-gradient(to bottom, #111 0 3px, #fff 3px 6px); }
.mguide.h { background: repeating-linear-gradient(to right, #111 0 3px, #fff 3px 6px); }
.mlabel { position: fixed; pointer-events: none; transform: translate(-50%, -50%); font: 10.5px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #f5f5f5; background: #111; padding: 1px 5px; border-radius: 3px; white-space: nowrap; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.22), 0 1px 4px rgba(0, 0, 0, 0.3); }
.hidden { display: none; }
`;

/** 标尺这一帧要画的：每段距离一条量线（带两头的短横和数字），量线碰不到目标时补的虚线 */
export interface MeasureDraw {
  spans: Array<{ axis: 'x' | 'y'; from: number; to: number; at: number; label: string }>;
  guides: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

type MeasurePart = 'mline' | 'mcap' | 'mlabel' | 'mguide';

/** 拖动换序要用的：页面上现在看到的顺序排好的各项外框、选中元素那项的下标，和放下时的回调 */
export interface DragModel {
  axis: 'x' | 'y';
  boxes: () => { boxes: DOMRect[]; index: number } | null;
  drop: (to: number) => void;
}

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let hoverBox: HTMLDivElement | null = null;
let selBox: HTMLDivElement | null = null;
let tag: HTMLDivElement | null = null;
let peerBox: HTMLDivElement | null = null;
let grip: HTMLDivElement | null = null;
let line: HTMLDivElement | null = null;
let ghost: HTMLDivElement | null = null;
let measureBox: HTMLDivElement | null = null;
let parts: Record<MeasurePart, HTMLDivElement[]> = { mline: [], mcap: [], mlabel: [], mguide: [] };
let measureFn: (() => MeasureDraw | null) | null = null;

let hoverEl: Element | null = null;
/** 悬停来自面板上的那一行，不是页面上的指针 */
let hoverFromPanel = false;
/** 刚在页面上点选的元素：指针移开之前不画它 */
let muted: Element | null = null;
let selEl: Element | null = null;
let selNote = '';
let peers: Element[] = [];
let model: DragModel | null = null;
let gripOff = false;
let drag: { pointer: number; x0: number; y0: number; rect: DOMRect; index: number; slot: number } | null = null;
let raf = 0;
let fallback = 0;

function div(cls: string, parent: Node): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
}

function ensure() {
  if (host && host.isConnected) return;
  if (!document.documentElement) return;
  host = document.createElement('css-tuner-overlay');
  host.setAttribute(OWN_ATTR, '');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: block;';
  root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);
  peerBox = div('peers', root);
  hoverBox = div('box hov-outline hidden', root);
  selBox = div('box sel-outline hidden', root);
  measureBox = div('measure', root);
  parts = { mline: [], mcap: [], mlabel: [], mguide: [] };
  tag = div('tag hidden', root);
  line = div('line hidden', root);
  ghost = div('ghost hidden', root);
  grip = div('grip hidden', root);
  grip.innerHTML = '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg>';
  wireGrip(grip);
  document.documentElement.appendChild(host);
}

/** 把手上的事件不往页面上传（页面在 document 上的监听不该看到它） */
function wireGrip(g: HTMLDivElement) {
  const stop = (e: Event) => e.stopPropagation();
  g.addEventListener('pointerdown', (e) => {
    stop(e);
    if (e.button !== 0 || !model || !selEl) return;
    const m = model.boxes();
    if (!m) return;
    e.preventDefault();
    try {
      g.setPointerCapture(e.pointerId);
    } catch {
      // 脚本合成的指针事件没有对应的活动指针，捕获不了，移动事件直接发到把手上
    }
    drag = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, rect: selEl.getBoundingClientRect(), index: m.index, slot: m.index };
    g.classList.add('dragging');
    moveDrag(e);
  });
  g.addEventListener('pointermove', (e) => {
    stop(e);
    moveDrag(e);
  });
  g.addEventListener('pointerup', (e) => {
    stop(e);
    endDrag(true);
  });
  g.addEventListener('pointercancel', () => endDrag(false));
  g.addEventListener('lostpointercapture', () => endDrag(false));
  for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu']) g.addEventListener(t, stop);
}

function moveDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer || !model || !line || !ghost) return;
  const m = model.boxes();
  if (!m) return;
  drag.slot = dropSlot(m.boxes, e.clientX, e.clientY, model.axis);
  const r = drag.rect;
  place(ghost, r.left + e.clientX - drag.x0, r.top + e.clientY - drag.y0, r.width, r.height);
  if (drag.slot === drag.index || drag.slot === drag.index + 1) line.classList.add('hidden');
  else {
    const l = slotLine(m.boxes, drag.slot, model.axis);
    place(line, l.x, l.y, l.w, l.h);
  }
}

function endDrag(commit: boolean) {
  if (!drag) return;
  const { slot, index, pointer } = drag;
  drag = null;
  if (grip?.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer);
  grip?.classList.remove('dragging');
  line?.classList.add('hidden');
  ghost?.classList.add('hidden');
  const to = slot > index ? slot - 1 : slot;
  if (commit && model && to !== index) model.drop(to);
  kick();
}

function place(d: HTMLElement, x: number, y: number, w: number, h: number) {
  d.style.left = `${x}px`;
  d.style.top = `${y}px`;
  d.style.width = `${Math.max(0, w)}px`;
  d.style.height = `${Math.max(0, h)}px`;
  d.classList.remove('hidden');
}

function outline(d: HTMLElement | null, el: Element | null) {
  if (!d) return;
  if (!el) {
    d.classList.add('hidden');
    return;
  }
  const r = el.getBoundingClientRect();
  place(d, r.left, r.top, r.width, r.height);
}

/** 元素的标签；withGrip 时左边带着拖动换序的把手 */
function drawTag(el: Element, note: string, withGrip: boolean) {
  if (!tag) return;
  const r = el.getBoundingClientRect();
  tag.textContent = '';
  const main = document.createElement('span');
  main.textContent = labelOf(el);
  const dim = document.createElement('span');
  dim.className = 'dim';
  dim.textContent = `${Math.round(r.width)}×${Math.round(r.height)}${note ? '  ' + note : ''}`;
  tag.append(main, dim);
  tag.classList.remove('hidden');
  const h = 20;
  const top = Math.min(r.top - h - 4 >= 0 ? r.top - h - 4 : r.bottom + 4, innerHeight - h - 2);
  const left = Math.max(2, Math.min(r.left, innerWidth - 260));
  if (withGrip && grip) place(grip, left, top, 16, h);
  else grip?.classList.add('hidden');
  tag.style.left = `${withGrip ? left + 20 : left}px`;
  tag.style.top = `${top}px`;
}

function drawPeers(on: boolean) {
  if (!peerBox) return;
  const need = on && selEl ? peers.filter((p) => p !== selEl && p.isConnected).slice(0, 80) : [];
  while (peerBox.childElementCount < need.length) div('box peer', peerBox);
  const kids = Array.from(peerBox.children) as HTMLElement[];
  kids.forEach((k, i) => {
    const p = need[i];
    if (!p) {
      k.classList.add('hidden');
      return;
    }
    const r = p.getBoundingClientRect();
    place(k, r.left, r.top, r.width, r.height);
  });
}

function part(kind: MeasurePart, i: number): HTMLDivElement {
  const pool = parts[kind];
  while (pool.length <= i) pool.push(div(`${kind} hidden`, measureBox!));
  return pool[i];
}

function hideParts(kind: MeasurePart, from: number) {
  for (const d of parts[kind].slice(from)) d.classList.add('hidden');
}

function drawMeasure(m: MeasureDraw | null) {
  const spans = m?.spans ?? [];
  const guides = m?.guides ?? [];
  spans.forEach((s, i) => {
    const len = s.to - s.from;
    const [l, c1, c2, label] = [part('mline', i), part('mcap', i * 2), part('mcap', i * 2 + 1), part('mlabel', i)];
    // 量线比数字短时数字挪到旁边（横线下面、竖线右边），不挡住量线和两头
    if (s.axis === 'x') {
      const fits = len >= s.label.length * 6.4 + 18;
      place(l, s.from, s.at - 0.5, len, 1);
      place(c1, s.from - 0.5, s.at - 4, 1, 8);
      place(c2, s.to - 0.5, s.at - 4, 1, 8);
      label.style.left = `${s.from + len / 2}px`;
      label.style.top = `${fits ? s.at : s.at + 7}px`;
      label.style.transform = fits ? '' : 'translate(-50%, 0)';
    } else {
      const fits = len >= 26;
      place(l, s.at - 0.5, s.from, 1, len);
      place(c1, s.at - 4, s.from - 0.5, 8, 1);
      place(c2, s.at - 4, s.to - 0.5, 8, 1);
      label.style.left = `${fits ? s.at : s.at + 7}px`;
      label.style.top = `${s.from + len / 2}px`;
      label.style.transform = fits ? '' : 'translate(0, -50%)';
    }
    label.textContent = s.label;
    label.classList.remove('hidden');
  });
  hideParts('mline', spans.length);
  hideParts('mcap', spans.length * 2);
  hideParts('mlabel', spans.length);
  guides.forEach((g, i) => {
    const d = part('mguide', i);
    const across = g.y1 === g.y2;
    d.classList.toggle('h', across);
    if (across) place(d, Math.min(g.x1, g.x2), g.y1 - 0.5, Math.abs(g.x2 - g.x1), 1);
    else place(d, g.x1 - 0.5, Math.min(g.y1, g.y2), 1, Math.abs(g.y2 - g.y1));
  });
  hideParts('mguide', guides.length);
}

/**
 * 这一帧画什么。悬停的别的元素：虚线框加标签。选中元素平时不画，悬停到它身上时画整套
 * （实线框、带代码位置的标签、把手、同源元素）；刚在页面上点选它、指针还没移开过的不算，面板上悬停它那一行算。
 * 量距离时选中元素只描边，收起标签，免得和量线、数字叠在一起
 */
export function shown<E>(s: { sel: E | null; hover: E | null; muted: E | null; fromPanel: boolean; measuring: boolean }): {
  hover: E | null;
  sel: 'full' | 'outline' | null;
} {
  const fresh = (el: E) => s.fromPanel || el !== s.muted;
  const hover = s.hover && s.hover !== s.sel && fresh(s.hover) ? s.hover : null;
  if (!s.sel) return { hover, sel: null };
  if (s.measuring) return { hover, sel: 'outline' };
  return { hover, sel: s.hover === s.sel && fresh(s.sel) ? 'full' : null };
}

/** 标签、把手连到选中元素边上的一块，四周放宽 pad：从元素移去拖把手的路上都在里面 */
export function holdZone(tag: Rect, grip: Rect, el: Rect, pad = 4): Rect {
  return {
    left: Math.min(tag.left, grip.left, el.right) - pad,
    right: Math.max(tag.right, grip.right, el.left) + pad,
    top: Math.min(tag.top, grip.top, el.bottom) - pad,
    bottom: Math.max(tag.bottom, grip.bottom, el.top) + pad,
  };
}

function frame() {
  raf = 0;
  ensure();
  if (!root) return;
  const m = measureFn?.() ?? null;
  const sel = selEl && selEl.isConnected ? selEl : null;
  const show = shown({ sel, hover: hoverEl && hoverEl.isConnected ? hoverEl : null, muted, fromPanel: hoverFromPanel, measuring: !!m });
  outline(hoverBox, show.hover);
  outline(selBox, show.sel ? sel : null);
  drawMeasure(m);
  if (sel && show.sel === 'full') drawTag(sel, selNote, !!model && !gripOff);
  else if (show.hover && !m) drawTag(show.hover, '', false);
  else {
    tag?.classList.add('hidden');
    grip?.classList.add('hidden');
  }
  drawPeers(show.sel === 'full');
  if (show.hover || show.sel || m) raf = requestAnimationFrame(frame);
}

// 页面不出帧（窗口被遮住、后台截图）时 rAF 不触发，用定时器补画一帧
function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
  if (!fallback) {
    fallback = window.setTimeout(() => {
      fallback = 0;
      if (!raf) return;
      cancelAnimationFrame(raf);
      frame();
    }, 100);
  }
}

/** 悬停的元素：页面上指针下的，fromPanel 时是面板上悬停的那一行 */
export function setHover(el: Element | null, fromPanel = false) {
  if (el !== muted) muted = null;
  hoverEl = el;
  hoverFromPanel = fromPanel;
  kick();
}

/** 刚在页面上点选了 el：指针移开之前不画它 */
export function mute(el: Element) {
  muted = el;
  kick();
}

/** 指针在把手、标签上，或者在它们和选中元素之间（把手露着时） */
export function holds(x: number, y: number): boolean {
  if (!selEl || !tag || !grip || grip.classList.contains('hidden')) return false;
  const z = holdZone(tag.getBoundingClientRect(), grip.getBoundingClientRect(), selEl.getBoundingClientRect());
  return x >= z.left && x <= z.right && y >= z.top && y <= z.bottom;
}

export function dragging(): boolean {
  return !!drag;
}

/** 正在拖把手时取消拖动，返回有没有在拖 */
export function cancelDrag(): boolean {
  if (!drag) return false;
  endDrag(false);
  return true;
}

export function setSelected(el: Element | null, note = '', same: Element[] = []) {
  if (el !== selEl) setDragModel(null);
  selEl = el;
  selNote = note;
  peers = same;
  kick();
}

/** 选中元素有可以换序的兄弟时给出拖动模型，null 收起把手 */
export function setDragModel(m: DragModel | null) {
  model = m;
  if (!m) endDrag(false);
  kick();
}

export function setGripHidden(off: boolean) {
  gripOff = off;
  if (off) endDrag(false);
  kick();
}

export function redraw() {
  kick();
}

/** 标尺：每帧按 fn 给出的量线画（元素滚动、动画时跟着走），null 收起 */
export function setMeasureDraw(fn: (() => MeasureDraw | null) | null) {
  measureFn = fn;
  kick();
}

export function isOverlay(node: EventTarget | null): boolean {
  return !!host && node === host;
}
