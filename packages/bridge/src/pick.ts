import { measureTo } from './measure';
import { cancelDrag, dragging, holds, isOverlay, setHover } from './overlay';
import { OWN_ATTR, isOwnNode } from './util';

interface Hooks {
  /** 选中元素：没有它时按住 Alt 也不量 */
  anchor: () => Element | null;
  /** 在页面上点中了元素 */
  pick: (el: Element) => void;
  /** 自由选择里双击了页面：改双击处的文字 */
  edit: (x: number, y: number) => void;
  /** 页面上按 Esc 关掉了标尺 */
  measureOff: () => void;
}

let hooks: Hooks | null = null;
/** 自由选择：悬停描边、点击改选中，一直开到再关掉 */
let picking = false;
/** 标尺：量悬停元素和选中元素之间的距离 */
let measuring = false;
/** 自由选择或标尺开着：页面上的点击、按下和右键都拦住 */
let engaged = false;
/** 两样都没开时按住 Alt 悬停量距离：只看不拦 */
let altOnly = false;
/** 指针下的页面元素 */
let aimed: Element | null = null;
let cursorStyle: HTMLStyleElement | null = null;

function own(e: Event): boolean {
  return e.target instanceof Node && isOwnNode(e.target);
}

/** 事件落在的页面元素（跳过 CSS Tuner 自己的节点） */
function targetOf(e: Event): Element | null {
  for (const n of e.composedPath()) {
    if (n instanceof Element && !isOwnNode(n)) return n;
  }
  return null;
}

/** html 和 body 不描边 */
function hoverable(el: Element | null): Element | null {
  return el === document.documentElement || el === document.body ? null : el;
}

function block(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function aim(el: Element | null, altKey: boolean) {
  aimed = el;
  setHover(el);
  measureTo(measuring || altKey ? el : null);
}

function move(e: PointerEvent) {
  if (!engaged) {
    if (!e.altKey || !hooks?.anchor()) {
      if (altOnly) stopAlt();
      return;
    }
    altOnly = true;
  }
  // 拖着把手，或者从选中元素移去拖把手的路上：还算在选中元素上
  if (dragging() || holds(e.clientX, e.clientY)) return;
  aim(hoverable(targetOf(e)), e.altKey);
}

function stopAlt() {
  altOnly = false;
  aim(null, false);
}

/** 抬起 Alt：只看不拦时连悬停框一起收，开着自由选择时只收量线 */
function altUp() {
  if (altOnly) stopAlt();
  else if (!measuring) measureTo(null);
}

function keyUp(e: KeyboardEvent) {
  if (e.key === 'Alt' || !e.altKey) altUp();
}

/** 指针离开页面：移出窗口，或者移到浮在页面上的面板里（覆盖层上的把手不算） */
function out(e: PointerEvent) {
  if (dragging() || !(engaged || altOnly)) return;
  const to = e.relatedTarget;
  if (to && !(to instanceof Element && to.shadowRoot && isOwnNode(to) && !isOverlay(to))) return;
  if (altOnly) stopAlt();
  else aim(null, false);
}

function click(e: MouseEvent) {
  if (own(e)) return;
  block(e);
  // 点在把手旁边的标签上，也算点了选中元素
  const el = holds(e.clientX, e.clientY) ? hooks?.anchor() : targetOf(e);
  if (!el || el === document.documentElement) return;
  aim(hoverable(el), e.altKey);
  hooks?.pick(el);
}

function dblclick(e: MouseEvent) {
  if (own(e)) return;
  block(e);
  if (picking && !measuring) hooks?.edit(e.clientX, e.clientY);
}

/** Esc 收掉正在拖的把手或开着的标尺；自由选择不靠 Esc 退出，这个键也不交给页面 */
function key(e: KeyboardEvent) {
  if (e.key !== 'Escape' || own(e)) return;
  block(e);
  if (cancelDrag() || !measuring) return;
  setMeasure(false);
  hooks?.measureOff();
}

/** 落在 CSS Tuner 自己节点上的（把手、改文字的框、面板）照常交给它们 */
function guard(e: Event) {
  if (!own(e)) block(e);
}

const passthrough = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'auxclick'] as const;

function engage() {
  const v = picking || measuring;
  if (v === engaged) return;
  engaged = v;
  if (v) {
    altOnly = false;
    window.addEventListener('click', click, true);
    window.addEventListener('dblclick', dblclick, true);
    window.addEventListener('keydown', key, true);
    for (const t of passthrough) window.addEventListener(t, guard, true);
    cursorStyle = document.createElement('style');
    cursorStyle.setAttribute(OWN_ATTR, '');
    cursorStyle.textContent = `html, html *:not([${OWN_ATTR}]) { cursor: crosshair !important; }`;
    (document.head || document.documentElement).appendChild(cursorStyle);
  } else {
    window.removeEventListener('click', click, true);
    window.removeEventListener('dblclick', dblclick, true);
    window.removeEventListener('keydown', key, true);
    for (const t of passthrough) window.removeEventListener(t, guard, true);
    cursorStyle?.remove();
    cursorStyle = null;
    aim(null, false);
  }
}

export function initPick(h: Hooks) {
  hooks = h;
  window.addEventListener('pointermove', move, { capture: true, passive: true });
  window.addEventListener('pointerout', out, { capture: true, passive: true });
  window.addEventListener('keyup', keyUp, true);
  window.addEventListener('blur', altUp);
}

export function disposePick() {
  setPick(false);
  setMeasure(false);
  if (altOnly) stopAlt();
  window.removeEventListener('pointermove', move, true);
  window.removeEventListener('pointerout', out, true);
  window.removeEventListener('keyup', keyUp, true);
  window.removeEventListener('blur', altUp);
  hooks = null;
}

export function setPick(v: boolean) {
  picking = v;
  engage();
}

export function pickOn(): boolean {
  return picking;
}

/** 标尺：和自由选择一样拦住页面，点击改选中 */
export function setMeasure(v: boolean) {
  measuring = v;
  engage();
  measureTo(v ? aimed : null);
}

export function measureOn(): boolean {
  return measuring;
}
