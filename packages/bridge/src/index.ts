import type { BridgeEvent, BridgeMethods, BridgeReply, BridgeRequest, ElementSnapshot, SelectQuery, SourceLoc } from '@css-tuner/protocol';
import { assetData, listAssets } from './assets';
import { installHook } from './devtools';
import { beginEdit, finish as finishEdit, isEditingText, textAt } from './edit';
import { fallbackValues } from './fallback';
import { visibleBoxes } from './order';
import { mute, redraw, setDragModel, setGripHidden, setHover, setSelected } from './overlay';
import { pageFonts, pageInfo } from './page';
import { disposeMeasure, initMeasure, setMeasureSteps } from './measure';
import { disposePick, initPick, measureOn, pickOn, setMeasure, setPick } from './pick';
import { activeOrder, clearAll, clearPreview, hasOrderPreviews, preview, prune, reapplyOrders, reattachRules } from './preview';
import { snapshot } from './snapshot';
import { findBySource, sameSourceElements, sourceOf, warmSources, whenHydrated } from './source';
import { hasTextPreviews, reapplyTexts, textNodesOf } from './text';
import { elOf, isOwnNode, loadSheetSources, sleep, uidOf } from './util';
import { probe } from './verify';

export interface BootConfig {
  port: number;
  token: string;
  session: string;
}

type Handlers = { [K in keyof BridgeMethods]: (p: BridgeMethods[K]['p']) => Promise<BridgeMethods[K]['r']> | BridgeMethods[K]['r'] };

class Bridge {
  private cfg: BootConfig;
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer = 0;
  private selected: Element | null = null;
  private selectedLoc: (SourceLoc & { index: number }) | null = null;
  private refreshTimer = 0;
  private lastHref = location.href;
  private observer: MutationObserver | null = null;
  private urlTimer = 0;
  private stopped = false;
  /** 每次页面加载生成一个，exec 通道靠它发现页面刷新过 */
  readonly instance = Math.random().toString(36).slice(2);

  /**
   * readyState 变成 interactive 之后、DOMContentLoaded 之前，模块脚本（以及 Vite 注入的 <style>）还没执行；
   * 只有真正收到 DOMContentLoaded 才算页面结构就绪
   */
  private domReady = document.readyState !== 'loading';
  private helloPending = false;

  constructor(cfg: BootConfig) {
    this.cfg = cfg;
    if (!this.domReady) {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          this.domReady = true;
          if (this.helloPending) this.sendHello();
        },
        { once: true },
      );
    }
    this.watch();
    this.connect();
    window.addEventListener('dblclick', this.onDblClick, true);
    const anchor = () => (this.selected?.isConnected ? this.selected : null);
    initMeasure(anchor);
    initPick({
      anchor,
      pick: (el) => {
        finishEdit(true);
        mute(el);
        if (el !== this.selected) void this.select(el);
      },
      edit: (x, y) => void this.editAt(x, y),
      measureOff: () => {
        this.syncGrip();
        this.send({ t: 'measure', on: false });
      },
    });
    this.syncGrip();
    this.urlTimer = window.setInterval(() => {
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        this.sendPage();
      }
    }, 500);
  }

  /** 扩展卸载或换会话时调用：断开连接、撤掉预览和高亮，页面恢复原样 */
  shutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.refreshTimer);
    clearInterval(this.urlTimer);
    clearTimeout(this.textTimer);
    this.observer?.disconnect();
    window.removeEventListener('dblclick', this.onDblClick, true);
    finishEdit(false);
    disposePick();
    disposeMeasure();
    clearAll();
    setSelected(null);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    delete (window as unknown as { __CSS_TUNER__?: Bridge }).__CSS_TUNER__;
  }

  configure(cfg: BootConfig) {
    const changed = cfg.port !== this.cfg.port || cfg.token !== this.cfg.token;
    this.cfg = cfg;
    if (changed) {
      this.retry = 0;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      this.connect();
    }
  }

  private connect() {
    clearTimeout(this.timer);
    const { port, token, session } = this.cfg;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${encodeURIComponent(token)}&session=${encodeURIComponent(session)}`);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.domReady) this.sendHello();
      else this.helloPending = true;
    };
    ws.onmessage = (ev) => {
      let msg: BridgeRequest;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'req') void this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.schedule();
      }
    };
    ws.onerror = () => {
      /* onclose 会跟着触发 */
    };
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const delay = Math.min(3000, 300 * 2 ** this.retry++);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  private queue: BridgeEvent[] = [];

  private send(ev: BridgeEvent | BridgeReply) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(ev));
      return;
    }
    if (ev.t !== 'res') {
      this.queue.push(ev);
      if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
    }
  }

  /** WebSocket 被页面 CSP 拦截时，扩展改用 executeJavaScript 调这两个方法 */
  async call(m: string, p: unknown): Promise<unknown> {
    const fn = this.handlers[m as keyof Handlers] as ((p: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`unknown method ${m}`);
    return fn(p ?? {});
  }

  private drainedAt = 0;

  drain(): BridgeEvent[] {
    this.drainedAt = Date.now();
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** WebSocket 连着，或者扩展正在用 executeJavaScript 轮询（每 200ms 取一次事件） */
  connected(): boolean {
    return (!!this.ws && this.ws.readyState === WebSocket.OPEN) || Date.now() - this.drainedAt < 2000;
  }

  private sendHello() {
    this.helloPending = false;
    void whenHydrated()
      .then(() => loadSheetSources())
      .then(() => {
        this.send({ t: 'hello', session: this.cfg.session, page: pageInfo() });
        warmSources(0);
      });
  }

  /** 激活之前服务端渲染的样式表还会被换掉，等激活完再报 */
  private sendPage() {
    void whenHydrated()
      .then(() => loadSheetSources())
      .then(() => this.send({ t: 'page', page: pageInfo() }));
  }

  private textTimer = 0;
  private orderTimer = 0;

  private watch() {
    this.observer = new MutationObserver((records) => {
      let css = false;
      let lost = false;
      let added = false;
      let nodes = false;
      for (const r of records) {
        const t = r.target;
        if (isOwnNode(t)) continue;
        const styleEl = t instanceof HTMLStyleElement ? t : t.parentNode instanceof HTMLStyleElement ? t.parentNode : null;
        if (styleEl || Array.from(r.addedNodes).some((n) => n instanceof HTMLStyleElement || n instanceof HTMLLinkElement)) css = true;
        if (this.selected && !this.selected.isConnected) lost = true;
        if (r.type === 'attributes' && r.target === this.selected) css = true;
        if (r.type === 'childList' && r.addedNodes.length) added = true;
        if (r.type === 'childList') nodes = true;
      }
      if (css || lost) this.scheduleRefresh(css);
      if (added && this.connected()) warmSources();
      if (nodes && hasTextPreviews()) {
        clearTimeout(this.textTimer);
        this.textTimer = window.setTimeout(reapplyTexts, 30);
      }
      if (nodes && hasOrderPreviews()) {
        clearTimeout(this.orderTimer);
        this.orderTimer = window.setTimeout(() => void reapplyOrders().then(redraw), 30);
      }
    });
    // 观察 document 而不是 documentElement：启动时 <html> 可能还没建出来
    this.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  }

  private scheduleRefresh(cssChanged: boolean) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      prune();
      if (cssChanged) {
        reattachRules();
        this.sendPage();
      }
      if (this.selected && !this.selected.isConnected) {
        const again = await this.refind();
        if (again) this.selected = again;
      }
      if (this.selected) await this.emitSelection();
    }, 120);
  }

  private async refind(): Promise<Element | null> {
    const loc = this.selectedLoc;
    if (!loc) return null;
    return findBySource(loc.path, loc.line, loc.column, loc.index);
  }

  private async emitSelection(): Promise<ElementSnapshot | null> {
    const el = this.selected;
    if (!el || !el.isConnected) {
      setSelected(null);
      this.send({ t: 'select', el: null });
      return null;
    }
    const snap = await snapshot(el);
    const same = snap.source ? await sameSourceElements(el) : [el];
    const note = snap.source ? `${snap.source.path.split('/').pop()}:${snap.source.line}` : '';
    setSelected(el, note, same);
    this.setDrag(el, snap);
    if (snap.source) this.selectedLoc = { ...snap.source, index: Math.max(0, same.indexOf(el)) };
    this.send({ t: 'select', el: snap });
    return snap;
  }

  /** 选中元素有可以换序的兄弟时，覆盖层上显示把手；放下时把位置（按页面上看到的顺序）发给扩展 */
  private setDrag(el: Element, snap: ElementSnapshot) {
    const info = snap.order;
    if (!info) {
      setDragModel(null);
      return;
    }
    const units = info.units.map((u) => u.uids);
    setDragModel({
      axis: info.axis,
      boxes: () => {
        const p = el.parentElement;
        if (!p || !el.isConnected) return null;
        const order = activeOrder(p) ?? units.map((_, i) => i);
        if (order.length !== units.length) return null;
        const boxes = visibleBoxes(units, order);
        return boxes.every(Boolean) ? { boxes: boxes as DOMRect[], index: order.indexOf(info.index) } : null;
      },
      drop: (to) => this.send({ t: 'reorder', uid: uidOf(el), to }),
    });
  }

  private async select(el: Element | null): Promise<ElementSnapshot | null> {
    this.selected = el;
    this.selectedLoc = null;
    if (el) {
      const s = await sourceOf(el);
      if (s) this.selectedLoc = { ...s, index: 0 };
    }
    return this.emitSelection();
  }

  /** 选中元素里面 (x, y) 处的文字就地编辑；文字不在选中元素自己身上时先改选文字所在的元素。那里没有能改的文字返回 false */
  private editAt(x: number, y: number): boolean {
    if (isEditingText() || !this.selected || !this.connected()) return false;
    const hit = textAt(x, y, this.selected);
    const el = hit?.node.parentElement;
    if (!hit || !el || isOwnNode(el) || el.isContentEditable || el.closest('input, textarea, select')) return false;
    const segment = textNodesOf(el).indexOf(hit.node);
    if (segment < 0) return false;
    void (async () => {
      if (el !== this.selected) await this.select(el);
      const uid = uidOf(el);
      beginEdit(hit.node, hit.offset, (value, phase) => this.send({ t: 'editText', uid, segment, value, phase }));
    })();
    return true;
  }

  /** 自由选择里的双击由 pick.ts 拦下来转给 editAt */
  private onDblClick = (e: MouseEvent) => {
    if (pickOn() || measureOn() || !this.editAt(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  /** 把手只在自由选择里露出来；标尺开着时点击留给改选中 */
  private syncGrip() {
    setGripHidden(!pickOn() || measureOn());
  }

  private handlers: Handlers = {
    ping: () => 'pong',
    pageInfo: async () => {
      await whenHydrated();
      await loadSheetSources();
      return pageInfo();
    },
    setPick: ({ on }) => {
      setPick(on);
      this.syncGrip();
      this.send({ t: 'pick', on: pickOn() });
      return pickOn();
    },
    setMeasure: ({ on }) => {
      setMeasure(on);
      this.syncGrip();
      this.send({ t: 'measure', on: measureOn() });
      return measureOn();
    },
    measureSteps: ({ steps }) => {
      setMeasureSteps(steps);
      return true;
    },
    select: async (q: SelectQuery) => this.select(await find(q)),
    resolve: async (q: SelectQuery) => {
      const el = await find(q);
      return el ? uidOf(el) : null;
    },
    snapshot: async () => (this.selected && this.selected.isConnected ? snapshot(this.selected) : null),
    preview: async ({ id, target, decls = {}, text, prop }) => {
      const count = await preview(id, target, decls, text, prop);
      const el = elOf(target.uid);
      const computed: Record<string, string> = {};
      if (el) {
        const cs = getComputedStyle(el);
        for (const p of Object.keys(decls)) computed[p] = cs.getPropertyValue(p).trim();
      }
      redraw();
      return { computed, count };
    },
    clearPreview: ({ id }) => {
      const had = clearPreview(id);
      redraw();
      return had;
    },
    clearAllPreviews: () => clearAll(),
    fallback: ({ uid, props }) => {
      const el = elOf(uid);
      return el ? fallbackValues(el, props) : null;
    },
    hover: ({ uid }) => {
      const el = uid ? elOf(uid) : null;
      setHover(el, true);
      return !!el;
    },
    probe: ({ id, target, expected, source }) =>
      probe(id, target, expected, () => (source ? findBySource(source.path, source.line, source.column, source.index) : this.refind())),
    reloadSheets: ({ hrefs }) => reloadSheets(hrefs),
    assets: async () => (this.selected && this.selected.isConnected ? listAssets(this.selected) : { items: [], count: 0, more: false }),
    assetData: ({ id, as }) => assetData(id, as),
    fonts: () => pageFonts(),
  };

  private async handle(req: BridgeRequest) {
    const fn = this.handlers[req.m] as ((p: unknown) => unknown) | undefined;
    if (!fn) {
      this.send({ t: 'res', id: req.id, ok: false, error: `unknown method ${req.m}` });
      return;
    }
    try {
      const data = await fn(req.p ?? {});
      this.send({ t: 'res', id: req.id, ok: true, data });
    } catch (e) {
      this.send({ t: 'res', id: req.id, ok: false, error: String((e as Error)?.stack || e) });
    }
  }
}

async function findOnce(q: SelectQuery): Promise<Element | null> {
  if (q.uid) return elOf(q.uid);
  if (q.selector) return document.querySelectorAll(q.selector)[q.index ?? 0] ?? null;
  if (q.source) return findBySource(q.source.path, q.source.line, q.source.column, q.source.index ?? 0);
  return null;
}

async function find(q: SelectQuery): Promise<Element | null> {
  const deadline = Date.now() + Math.min(q.waitMs ?? 0, 10000);
  for (;;) {
    const el = await findOnce(q);
    if (el || Date.now() >= deadline) return el;
    await sleep(120);
  }
}

/** 样式表自身及其 @import 链上所有文件的 URL（去掉查询串） */
function sheetUrls(sheet: CSSStyleSheet | null, out = new Set<string>(), depth = 0): Set<string> {
  if (!sheet || depth > 8) return out;
  if (sheet.href) out.add(sheet.href.split('?')[0]);
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return out;
  }
  for (const r of Array.from(rules)) {
    if (r instanceof CSSImportRule) sheetUrls(r.styleSheet, out, depth + 1);
    else if (!(r instanceof CSSLayerStatementRule)) break;
  }
  return out;
}

function reloadSheets(hrefs?: string[]): number {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'));
  const wanted = hrefs?.map((h) => new URL(h, location.href).href.split('?')[0]);
  let n = 0;
  for (const link of links) {
    const base = link.href.split('?')[0];
    if (wanted) {
      const urls = sheetUrls(link.sheet);
      urls.add(base);
      if (!wanted.some((h) => urls.has(h))) continue;
    }
    const next = link.cloneNode() as HTMLLinkElement;
    next.href = `${base}?css-tuner=${Date.now()}`;
    next.addEventListener('load', () => link.remove(), { once: true });
    next.addEventListener('error', () => next.remove(), { once: true });
    link.after(next);
    n++;
  }
  return n;
}

export function boot(cfg: BootConfig) {
  if (window.top !== window) return;
  installHook();
  const w = window as unknown as { __CSS_TUNER__?: Bridge };
  if (w.__CSS_TUNER__) {
    w.__CSS_TUNER__.configure(cfg);
    return;
  }
  w.__CSS_TUNER__ = new Bridge(cfg);
}
