import * as vscode from 'vscode';
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { getLocale, localeFrom, type PanelToExt, type PropValue, type SelectionView } from '@css-tuner/protocol';
import type { Controller } from './controller';
import { summarizeCheck } from './selfcheck';

/**
 * 开发宿主里的端到端自测：扩展目录下有 selftest.json 时按步骤执行并把结果写到 out，
 * 用来在真实 Cursor 里验证注入、通道、选中、交给 Agent 后的核对和还原，不依赖人工点击。
 */
export interface Step {
  do: string;
  [k: string]: unknown;
}

interface Config {
  out: string;
  closeWindow?: boolean;
  steps: Step[];
}

export type StepRunner = (c: Controller, step: Step) => Promise<unknown>;

const runners = new Map<string, StepRunner>();

export function defineStep(name: string, run: StepRunner) {
  runners.set(name, run);
}

export function summarize(sel: SelectionView | null, props: string[] = []) {
  if (!sel) return null;
  const { el } = sel;
  const winners: Record<string, string> = {};
  for (const p of props) {
    const w = el.winners[p];
    winners[p] = w
      ? [el.computed[p], w.origin, w.rule?.utility ?? w.rule?.selector ?? '', w.value].filter(Boolean).join(' | ')
      : 'n/a';
  }
  const targets: Record<string, string> = {};
  for (const p of props) {
    const t = sel.targets[p];
    if (t) targets[p] = `${t.kind} ${t.label} affects=${t.affects}${t.declared ? ' declared' : ''}${t.reason ? ` (${t.reason})` : ''}`;
  }
  return {
    label: el.label,
    source: el.source ? `${el.source.path}:${el.source.line}:${el.source.column}` : null,
    file: sel.file,
    sameSource: el.sameSource,
    sourceIndex: el.sourceIndex,
    scopeAll: sel.scopeAll ?? null,
    breadcrumb: el.breadcrumb.map((b) => b.label).join(' > '),
    tree: [...el.breadcrumb, ...el.children].map((b) => `${b.label}${b.text ? ` “${b.text}”` : ''}${b.component ? ` <${b.component}>` : ''} kids=${b.kids ?? '?'}`),
    vars: (el.vars ?? []).map((v) => `${v.name}=${v.value} [${v.kind}] ← ${v.props.join(',')}`),
    winners,
    targets,
    pending: sel.pending,
  };
}

/** 改工作区级设置（不碰用户设置）；value 为 null 时删掉这一项 */
defineStep('config', async (c, s) => {
  await vscode.workspace.getConfiguration('cssTuner').update(String(s.key), s.value === null ? undefined : s.value, vscode.ConfigurationTarget.Workspace);
  await new Promise((r) => setTimeout(r, 150));
  return { key: s.key, value: vscode.workspace.getConfiguration('cssTuner').get(String(s.key)) ?? null, ...summarize(c.state.selection, (s.props as string[]) ?? []) };
});

defineStep('hover', async (c, s) => {
  const el = c.state.selection?.el;
  const crumb = s.clear ? null : (s.child !== undefined ? el?.children[Number(s.child)] : el?.breadcrumb[Number(s.crumb ?? 0)]) ?? null;
  await c.handle({ t: 'hover', uid: crumb?.uid ?? null });
  return { uid: crumb?.uid ?? null, label: crumb?.label ?? null };
});

// WebSocket 先连上、hello 后到时，openPage 会在页面信息到达前返回
defineStep('open', async (c, s) => {
  const ok = await c.openPage(String(s.url));
  // 同一个窗口里换到别的项目时，state.page 还是上一个页面的；服务端渲染的页面要等激活完页面脚本才报页面信息
  const origin = /^https?:/.test(String(s.url)) ? new URL(String(s.url)).origin : null;
  const arrived = () => !!c.state.page && (!origin || new URL(c.state.page.url).origin === origin);
  const deadline = Date.now() + 8000;
  while (ok && !arrived() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { ok, connection: c.state.connection, mode: c.session?.mode, page: c.state.page, notice: c.state.notice };
});

// 热更新会重建当前选中，所以要等到选中的确实是这次选的元素
defineStep('select', async (c, s) => {
  const snap = await c.session!.call('select', { selector: String(s.selector), index: typeof s.index === 'number' ? s.index : 0 });
  const uid = snap?.uid ?? null;
  const deadline = Date.now() + 6000;
  let sel = c.state.selection;
  while (uid && sel?.el.uid !== uid && Date.now() < deadline) sel = await c.nextSelection(deadline - Date.now());
  return summarize(sel, (s.props as string[]) ?? []);
});

defineStep('reload', async (c, s) => {
  const next = c.nextSelection(10000, true);
  await c.browser.reload(c.session!.browserId);
  const sel = await next;
  return { connection: c.state.connection, restored: summarize(sel, (s.props as string[]) ?? []) };
});

/** 页面上现在画了什么：悬停框、选中框、标签、把手、同源元素的框、量线上的数字，以及指针是不是十字 */
const overlayDrawn = (c: Controller) =>
  c.browser.exec<Record<string, unknown>>(
    c.session!.browserId,
    `new Promise((done) => setTimeout(() => {
      const root = document.querySelector('css-tuner-overlay')?.shadowRoot;
      const shown = (s) => [...(root?.querySelectorAll(s) ?? [])].filter((d) => !d.classList.contains('hidden'));
      done({
        hover: shown('.hov-outline').length,
        sel: shown('.sel-outline').length,
        tags: shown('.tag').map((d) => d.textContent),
        grip: shown('.grip').length,
        peers: shown('.peer').length,
        labels: shown('.mlabel').map((d) => d.textContent),
        crosshair: [...document.querySelectorAll('style[data-css-tuner]')].some((s) => s.textContent.includes('crosshair')),
      });
    }, 200))`,
  );

/**
 * 自由选择：on 开关；hover 对 selector 的第 index 个元素合成一次指针移动，click 在它上面合成按下、松开、点击（等选中换过来），
 * leave 合成指针离开页面，key 在页面上按一个键。返回页面上画了什么
 */
defineStep('pick', async (c, s) => {
  const id = c.session!.browserId;
  if (s.on !== undefined) await c.setPick(!!s.on);
  const fire = (selector: unknown, types: string[]) =>
    c.browser.exec<boolean>(
      id,
      `(() => {
        const el = document.querySelectorAll(${JSON.stringify(String(selector))})[${Number(s.index) || 0}];
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const init = { bubbles: true, composed: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
        for (const t of ${JSON.stringify(types)}) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, init) : new MouseEvent(t, init));
        return true;
      })()`,
    );
  const out: Record<string, unknown> = {};
  if (s.hover) out.found = await fire(s.hover, ['pointermove']);
  if (s.click) {
    const before = c.state.selection?.el.uid;
    out.found = await fire(s.click, ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    for (let i = 0; i < 30 && c.state.selection?.el.uid === before; i++) await new Promise((r) => setTimeout(r, 100));
    out.selected = c.state.selection?.el.label ?? null;
  }
  if (s.leave) await c.browser.exec(id, `document.documentElement.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: null }))`);
  if (s.key) await c.browser.exec(id, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(String(s.key))}, bubbles: true, cancelable: true }))`);
  return { ...out, drawn: await overlayDrawn(c), pickOn: c.state.pickOn, measureOn: c.state.measureOn };
});

defineStep('badToken', async (c) => {
  const port = c.server.port;
  const session = c.session!.id;
  const attempt = (token: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}&session=${session}`);
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
      ws.on('error', (e) => resolve(`error ${e.message}`));
    });
  return { wrongToken: await attempt('bad'), wrongSession: await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${c.server.token}&session=nope`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on('error', (e) => resolve(`error ${e.message}`));
  }) };
});

defineStep('exec', async (c, s) => c.browser.exec(c.session!.browserId, String(s.script)));

/**
 * 标尺：on 开关标尺；hover 对这个选择器的元素合成一次指针移动（alt 为真时带着 Alt），读出画出来的数字；
 * click 再在它上面点一下（等选中换过来）；key 在页面上按一个键（Escape 退出标尺，Alt 抬起 Alt）
 */
defineStep('measure', async (c, s) => {
  const id = c.session!.browserId;
  if (s.on !== undefined) await c.setMeasure(!!s.on);
  const fire = (type: 'pointermove' | 'click') =>
    c.browser.exec<boolean>(
      id,
      `(() => {
        const el = document.querySelector(${JSON.stringify(String(s.hover))});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const init = { bubbles: true, composed: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, altKey: ${!!s.alt} };
        el.dispatchEvent(${type === 'click' ? "new MouseEvent('click', init)" : "new PointerEvent('pointermove', init)"});
        return true;
      })()`,
    );
  const drawn = () =>
    c.browser.exec<{ labels: string[]; guides: number }>(
      id,
      `new Promise((done) => setTimeout(() => {
        const root = document.querySelector('css-tuner-overlay')?.shadowRoot;
        const labels = [...(root?.querySelectorAll('.mlabel:not(.hidden)') ?? [])].map((l) => l.textContent);
        done({ labels, guides: root?.querySelectorAll('.mguide:not(.hidden)').length ?? 0 });
      }, 200))`,
    );
  const out: Record<string, unknown> = {};
  if (s.hover) {
    out.found = await fire('pointermove');
    Object.assign(out, await drawn());
  }
  if (s.click) {
    const before = c.state.selection?.el.uid;
    await fire('click');
    for (let i = 0; i < 30 && c.state.selection?.el.uid === before; i++) await new Promise((r) => setTimeout(r, 100));
    out.selected = c.state.selection?.el.label ?? null;
  }
  if (s.key) {
    await c.browser.exec(id, `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(s.key === 'Alt' ? 'keyup' : 'keydown')}, { key: ${JSON.stringify(String(s.key))}, bubbles: true, cancelable: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    Object.assign(out, { after: await drawn() });
  }
  out.measureOn = c.state.measureOn;
  out.pickOn = c.state.pickOn;
  return out;
});

/** 展开「图片和视频」取完整清单（open: false 收起） */
defineStep('assets', async (c, s) => {
  await c.handle({ t: 'assetsOpen', open: s.open !== false });
  if (s.open !== false) await c.loadAssets();
  const v = c.state.selection?.assets;
  return {
    count: v?.count ?? null,
    more: v?.more ?? null,
    items: (v?.items ?? []).map((a) => ({
      kind: a.kind,
      name: a.name,
      url: a.url,
      shown: a.shown === a.url ? '=' : a.shown,
      size: a.width ? `${a.width}x${a.height}` : null,
      bytes: a.bytes,
      count: a.count,
      streaming: a.streaming ?? false,
      file: a.file,
      thumb: a.thumb ? a.thumb.slice(0, 22) : null,
    })),
  };
});

const assetNamed = (c: Controller, name: unknown) => c.assets.all().find((a) => a.name === name) ?? null;

/** 另存为，不弹保存对话框：清单里叫 name 的那条存成 dir/as */
defineStep('saveAsset', async (c, s) => {
  const item = assetNamed(c, s.name);
  if (!item) return { error: `清单里没有 ${String(s.name)}` };
  try {
    const out = await c.assets.saveTo(item, join(String(s.dir), String(s.as ?? item.name)));
    const data = readFileSync(out);
    return { out, bytes: data.length, head: data.subarray(0, 12).toString(String(s.text) === 'true' ? 'utf8' : 'hex') };
  } catch (e) {
    return { error: (e as Error).message };
  }
});

/** 全部下载，不弹选文件夹的对话框 */
defineStep('saveAllAssets', async (c, s) => {
  const r = await c.assets.saveAllTo(String(s.dir));
  return { ...r, files: readdirSync(String(s.dir)).sort() };
});

/** SVG 的两种代码：copy 是「复制 SVG 代码」给的（不真的写剪贴板），否则是存成文件的 */
defineStep('assetText', async (c, s) => {
  const item = assetNamed(c, s.name);
  if (!item) return { error: `清单里没有 ${String(s.name)}` };
  if (s.as === 'copy') return (await c.session!.call('assetData', { id: item.id, as: 'copy' })).text ?? null;
  return (await c.assets.bytes(item)).data.toString('utf8');
});

/** 直接发一条调试协议命令；mainFrame 为真时自动带上主框架 id */
defineStep('cdp', async (c, s) => {
  const id = c.session!.browserId;
  const params = { ...((s.params as object) ?? {}) } as Record<string, unknown>;
  if (s.mainFrame) params.frameId = (await c.browser.cdp<{ frameTree: { frame: { id: string } } }>(id, 'Page.getFrameTree')).frameTree.frame.id;
  try {
    return await c.browser.cdp(id, String(s.method), params);
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
});

/** 读选中元素和同源元素的计算值 */
async function readComputed(c: Controller, props: string[]) {
  return c.browser.exec<Record<string, string> | null>(
    c.session!.browserId,
    `window.__CSS_TUNER__.call('snapshot', {}).then((s) => s && Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, s.computed[p]])))`,
  );
}

defineStep('edit', async (c, s) => {
  const props = s.props as string[];
  await c.edit({ props, value: String(s.value ?? ''), token: (s.token as string) ?? null, phase: (s.phase as 'live' | 'commit') ?? 'commit', ...(s.remove ? { remove: true } : {}) });
  const computed = await readComputed(c, (s.read as string[]) ?? props);
  const peers =
    typeof s.peers === 'string'
      ? await c.browser.exec(c.session!.browserId, `[...document.querySelectorAll(${JSON.stringify(s.peers)})].map(e => getComputedStyle(e).getPropertyValue(${JSON.stringify(s.peersProp ?? props[0])}))`)
      : undefined;
  return {
    pending: c.state.selection?.pending,
    ...(c.state.selection?.removed.length ? { removed: c.state.selection.removed } : {}),
    computed,
    peers,
    changes: c.state.changes.map((ch) => `${ch.status} ${ch.propLabel} ${ch.from}→${ch.to} @${ch.target.kind}:${ch.target.label} affects=${ch.target.affects}`),
    notice: c.state.notice?.text ?? null,
  };
});

/** 按面板消息原样发给扩展（上一步 / 下一步、重置、一次改几组），返回之后的历史、改动清单和页面上的计算值 */
defineStep('send', async (c, s) => {
  await c.handle(s.msg as PanelToExt);
  const sel = c.state.selection;
  return {
    history: c.state.history,
    pending: sel?.pending,
    removed: sel?.removed,
    computed: s.read ? await readComputed(c, s.read as string[]) : undefined,
    changes: changeLines(c),
    notice: c.state.notice?.text ?? null,
  };
});

/** 模拟拖动：连续发 live 编辑，测每次从发出到预览生效的往返耗时 */
defineStep('dragLatency', async (c, s) => {
  const props = s.props as string[];
  const n = Number(s.count) || 60;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await c.edit({ props, value: `${Number(s.from) + i}px`, token: null, phase: 'live' });
    times.push(performance.now() - t0);
  }
  await c.edit({ props, value: String(s.final), token: null, phase: 'commit' });
  times.sort((a, b) => a - b);
  const pct = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] * 100) / 100;
  return { count: n, p50: pct(0.5), p95: pct(0.95), max: pct(1), changes: c.state.changes.length };
});

const textLines = (sel: SelectionView | null) =>
  (sel?.texts ?? []).map((x) => `${x.segment} ${x.origin} ${x.target.kind}:${x.target.label}${x.target.reason ? ` (${x.target.reason})` : ''} “${x.value}”${x.pending ? ' pending' : ''}`);

/** 页面上一组元素的文字（看同源实例有没有一起预览） */
const pageTexts = (c: Controller, selector: unknown) =>
  typeof selector === 'string'
    ? c.browser.exec<string[]>(c.session!.browserId, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)
    : Promise.resolve(undefined);

/** 选中元素每段文字在代码里的位置 */
defineStep('texts', async (c) => ({ texts: textLines(c.state.selection), segments: c.state.selection?.el.text ?? null }));

/** 在面板上改选中元素的第 segment 段文字 */
defineStep('editText', async (c, s) => {
  await c.editText(Number(s.segment) || 0, String(s.value), (s.phase as 'live' | 'commit') ?? 'commit');
  return { texts: textLines(c.state.selection), page: await pageTexts(c, s.read), changes: changeLines(c) };
});

/**
 * 模拟在页面上双击文字编辑：双击 selector 的第一段文字，选中整段输入 value，再按 key（Enter 提交、Escape 取消）。
 * 选中的元素要包含它
 */
defineStep('pageEdit', async (c, s) => {
  const id = c.session!.browserId;
  const sel = JSON.stringify(String(s.selector));
  const before = c.state.changes.length;
  const target = `document.querySelectorAll(${sel})[${Number(s.index) || 0}]`;
  // 页面可能开着平滑滚动：先立即滚到位，等布局稳定了再量坐标
  await c.browser.exec(id, `${target}?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await new Promise((r) => setTimeout(r, 300));
  const hit = await c.browser.exec(
    id,
    `(() => {
      const el = ${target};
      const node = el && [...el.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
      if (!node) return null;
      const r = document.createRange();
      r.selectNodeContents(node);
      const b = r.getClientRects()[0];
      const x = b.left + Math.min(6, b.width / 2), y = b.top + b.height / 2;
      const top = document.elementFromPoint(x, y);
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      return { x: Math.round(x), y: Math.round(y), top: top === el ? 'self' : top ? top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '') : null };
    })()`,
  );
  await new Promise((r) => setTimeout(r, 400));
  const typed = await c.browser.exec(
    id,
    `(() => {
      const wrap = document.querySelector('[data-css-tuner-editing]');
      if (!wrap) return null;
      const node = [...wrap.childNodes].find((n) => n.nodeType === 3);
      const r = document.createRange();
      r.selectNodeContents(node ?? wrap);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.execCommand('insertText', false, ${JSON.stringify(String(s.value))});
      return wrap.textContent;
    })()`,
  );
  await new Promise((r) => setTimeout(r, 400));
  const live = await pageTexts(c, s.read);
  await c.browser.exec(
    id,
    `document.querySelector('[data-css-tuner-editing]')?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(String(s.key ?? 'Enter'))}, bubbles: true, cancelable: true }))`,
  );
  const deadline = Date.now() + 3000;
  while (s.key !== 'Escape' && c.state.changes.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const left = await c.browser.exec(id, `document.querySelectorAll('[data-css-tuner-editing]').length`);
  return { hit, typed, live, after: await pageTexts(c, s.read), editorsLeft: left, texts: textLines(c.state.selection), changes: changeLines(c) };
});

/** 选中元素所在兄弟组：现在的顺序、选中的是第几个、代码位置 */
const orderLine = (sel: SelectionView | null) => {
  const o = sel?.order;
  if (!o) return null;
  const target = `${o.target.kind}:${o.target.label}${o.target.affects > 1 ? ` affects=${o.target.affects}` : ''}${o.target.reason ? ` (${o.target.reason})` : ''}`;
  return { items: o.items.map((i) => `${i.label}${i.text ? ` “${i.text}”` : ''}${i.component ? ` <${i.component}>` : ''}`), index: o.index, axis: o.axis, pending: o.pending, target };
};

/** 页面上一组元素按显示出来的位置（从上到下，同一行里从左到右）排的文字，看换序预览摆得对不对 */
const visualOrder = (c: Controller, selector: unknown) =>
  typeof selector === 'string'
    ? c.browser.exec<string[]>(
        c.session!.browserId,
        `(() => {
          const xs = [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => ({ t: e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40), r: e.getBoundingClientRect() }));
          const sameRow = (a, b) => Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > Math.min(a.r.height, b.r.height) / 2;
          return xs.sort((a, b) => (sameRow(a, b) ? a.r.left - b.r.left : a.r.top - b.r.top)).map((x) => x.t);
        })()`,
      )
    : Promise.resolve(undefined);

defineStep('order', async (c, s) => ({
  order: orderLine(c.state.selection),
  page: await visualOrder(c, s.read),
  ...(s.sigs ? { sigs: c.state.selection?.el.order?.units.map((u) => `${u.label} = ${u.sig}`) } : {}),
}));

/** 在面板上把兄弟组里第 item 项（按现在的顺序，缺省是选中元素）挪到第 to 个 */
defineStep('reorder', async (c, s) => {
  const o = c.state.selection?.order;
  if (!o) return { error: 'no order group' };
  const item = o.items[s.item !== undefined ? Number(s.item) : o.index];
  await c.reorder(item.uid, Number(s.to), (s.phase as 'live' | 'commit') ?? 'commit');
  await new Promise((r) => setTimeout(r, 150));
  return { order: orderLine(c.state.selection), page: await visualOrder(c, s.read), changes: changeLines(c) };
});

/** 选中元素所属组件的属性：每项的类型、值、可选值、代码位置 */
const propsLines = (sel: SelectionView | null) => {
  const p = sel?.props;
  if (!p) return null;
  const line = (x: NonNullable<SelectionView['props']>['items'][number]) =>
    [
      `${x.name}: ${x.type} ${JSON.stringify(x.value)}`,
      x.summary ? `(${x.summary})` : '',
      x.options ? `[${x.options.join('|')}]` : '',
      x.missing ? 'missing' : '',
      x.pending ? 'pending' : '',
      x.warn ? `warn(${x.warn})` : '',
      `→ ${x.target.kind}:${x.target.label}${x.target.affects > 1 ? ` affects=${x.target.affects}` : ''}${x.target.reason ? ` (${x.target.reason})` : ''}`,
    ]
      .filter(Boolean)
      .join(' ');
  return { component: p.component, source: p.source?.label ?? null, server: p.server, live: p.live, items: p.items.map(line) };
};

/** 页面上一组元素的 class（看属性预览有没有让组件换了样式） */
const pageClasses = (c: Controller, selector: unknown) =>
  typeof selector === 'string'
    ? c.browser.exec<string[]>(c.session!.browserId, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.getAttribute('class') ?? '')`)
    : Promise.resolve(undefined);

/** 选中元素所属组件的属性；TS 补全是异步的，waitOptions 指定的属性拿到可选值后再返回 */
defineStep('props', async (c, s) => {
  const want = typeof s.waitOptions === 'string' ? s.waitOptions : null;
  const deadline = Date.now() + (Number(s.timeoutMs) || 10000);
  while (want && !c.state.selection?.props?.items.find((x) => x.name === want)?.options && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return { props: propsLines(c.state.selection), page: await pageTexts(c, s.read), classes: await pageClasses(c, s.readClass) };
});

/** 直接问语言服务某处（行列从 1 起）的补全，排查属性可选值用：返回耗时和前几项的种类 */
defineStep('completions', async (_c, s) => {
  const t0 = Date.now();
  const ts = vscode.extensions.getExtension('vscode.typescript-language-features');
  const active = !!ts?.isActive;
  if (s.prepare) {
    await ts?.activate();
    await vscode.workspace.openTextDocument(vscode.Uri.file(String(s.file)));
  }
  const list = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
    'vscode.executeCompletionItemProvider',
    vscode.Uri.file(String(s.file)),
    new vscode.Position(Number(s.line) - 1, Number(s.column) - 1),
  );
  const items = (list?.items ?? []).slice(0, Number(s.count) || 12).map((x) => `${typeof x.label === 'string' ? x.label : x.label.label} kind=${x.kind === undefined ? '?' : vscode.CompletionItemKind[x.kind]}`);
  return { ms: Date.now() - t0, wasActive: active, active: !!ts?.isActive, total: list?.items.length ?? 0, items };
});

/** 在面板上改选中元素所属组件的属性 */
defineStep('editProp', async (c, s) => {
  await c.editProp(String(s.name), s.value as PropValue, (s.phase as 'live' | 'commit') ?? 'commit');
  await new Promise((r) => setTimeout(r, Number(s.settleMs) || 200));
  return { props: propsLines(c.state.selection), page: await pageTexts(c, s.read), classes: await pageClasses(c, s.readClass), changes: changeLines(c) };
});

/**
 * 模拟在页面上拖选中元素的把手：按下把手，移到 over 选中的那个元素（selector 的第 index 个）的前半或后半（side），松开。
 * 返回拖动中有没有画出插入线
 */
defineStep('pageDrag', async (c, s) => {
  const id = c.session!.browserId;
  const before = JSON.stringify(c.state.changes.map((ch) => [ch.id, ch.to]));
  const over = `document.querySelectorAll(${JSON.stringify(String(s.over))})[${Number(s.index) || 0}]`;
  // 把手只在自由选择里、悬停到选中元素上时露出来
  const picking = c.state.pickOn;
  if (!picking) await c.setPick(true);
  await c.handle({ t: 'hover', uid: c.state.selection?.el.uid ?? null });
  // 窗口在后台时页面的定时器被节流，覆盖层可能还没画出把手
  const shown = `!!document.querySelector('css-tuner-overlay')?.shadowRoot?.querySelector('.grip:not(.hidden)')`;
  for (let i = 0; i < 30 && !(await c.browser.exec<boolean>(id, shown)); i++) await new Promise((r) => setTimeout(r, 100));
  const drag = await c.browser.exec(
    id,
    `(() => {
      const root = document.querySelector('css-tuner-overlay')?.shadowRoot;
      const grip = root?.querySelector('.grip');
      const el = ${over};
      if (!grip || grip.classList.contains('hidden') || !el) return { grip: !!grip && !grip.classList.contains('hidden'), over: !!el };
      const g = grip.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const axis = ${JSON.stringify(s.axis ?? 'y')};
      const after = ${JSON.stringify(s.side ?? 'after')} === 'after';
      const x = axis === 'x' ? r.left + r.width * (after ? 0.8 : 0.2) : r.left + r.width / 2;
      const y = axis === 'y' ? r.top + r.height * (after ? 0.8 : 0.2) : r.top + r.height / 2;
      const ev = (type, cx, cy) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true }));
      ev('pointerdown', g.left + g.width / 2, g.top + g.height / 2);
      ev('pointermove', (g.left + x) / 2, (g.top + y) / 2);
      ev('pointermove', x, y);
      const line = !root.querySelector('.line').classList.contains('hidden');
      const ghost = !root.querySelector('.ghost').classList.contains('hidden');
      ev('pointerup', x, y);
      return { grip: true, line, ghost, at: [Math.round(x), Math.round(y)] };
    })()`,
  );
  const deadline = Date.now() + 3000;
  while (JSON.stringify(c.state.changes.map((ch) => [ch.id, ch.to])) === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  await c.handle({ t: 'hover', uid: null });
  if (!picking) await c.setPick(false);
  return { drag, order: orderLine(c.state.selection), page: await visualOrder(c, s.read), changes: changeLines(c) };
});

defineStep('discard', async (c, s) => {
  const ch = c.state.changes[Number(s.index) || 0];
  if (!ch) return 'no change';
  await c.discard(ch.id);
  return { left: c.state.changes.length, pending: c.state.selection?.pending, computed: await readComputed(c, (s.read as string[]) ?? ch.props) };
});

/** 拒绝所有 WebSocket 后刷新页面，验证自动退回 executeJavaScript 通道，再恢复 */
/** keep: true 时停在 exec 模式，让后面的步骤在这个模式下跑；之后用 end: true 恢复 WebSocket */
defineStep('execFallback', async (c, s) => {
  const session = c.session!;
  if (s.end) {
    c.server.refuseAll = false;
    const back = c.nextSelection(15000, true);
    await c.browser.reload(session.browserId);
    await back;
    return { modeAfter: session.mode, connection: c.state.connection };
  }
  c.server.refuseAll = true;
  const sel = c.nextSelection(15000, true);
  await c.browser.reload(session.browserId);
  const restored = await sel;
  const mode = session.mode;
  const t0 = Date.now();
  const snap = await session.call('snapshot', {});
  const rtt = Date.now() - t0;
  if (s.keep) return { modeWhileRefused: mode, restored: summarize(restored, (s.props as string[]) ?? []), snapshotOk: !!snap, execRttMs: rtt };
  c.server.refuseAll = false;
  const back = c.nextSelection(15000, true);
  await c.browser.reload(session.browserId);
  await back;
  return { modeWhileRefused: mode, restored: summarize(restored, (s.props as string[]) ?? []), snapshotOk: !!snap, execRttMs: rtt, modeAfter: session.mode, connection: c.state.connection };
});

defineStep('trace', async (c) => c.trace.splice(0));

const changeLines = (c: Controller) => c.state.changes.map((ch) => `${ch.status} ${ch.propLabel} ${ch.from}→${ch.to}${ch.note ? ` (${ch.note})` : ''}`);

/** 自测前备份要改的源码，结束时比对：还原必须字节级一致；不一致就按备份恢复并报告 */
const backups = new Map<string, string>();
defineStep('backup', async (_c, s) => {
  for (const f of s.files as string[]) backups.set(f, readFileSync(f, 'utf8'));
  return [...backups.keys()].map((f) => f.split('/').slice(-3).join('/'));
});

defineStep('compareFiles', async (_c, s) => {
  const out: Record<string, string> = {};
  for (const [f, text] of backups) {
    const now = readFileSync(f, 'utf8');
    const name = f.split('/').slice(-3).join('/');
    if (now === text) out[name] = 'identical';
    else {
      out[name] = s.restore ? 'DIFFERENT (restored from backup)' : 'different';
      if (s.restore) writeFileSync(f, text);
    }
  }
  return out;
});

/**
 * 应用（交给 Agent）：只整理提示词、改状态开始核对，不打开对话、不碰剪贴板。
 * ids 用改动清单里的序号（0 是最新的），不给就是全部未应用的
 */
defineStep('apply', async (c, s) => {
  const ids = Array.isArray(s.indexes) ? (s.indexes as number[]).map((i) => c.state.changes[i]?.id).filter(Boolean) : undefined;
  const prompt = await c.applier.apply(ids, { dry: true });
  const read = s.read as { props: string[] } | undefined;
  return { prompt: prompt?.split('\n') ?? null, changes: changeLines(c), computed: read ? await readComputed(c, read.props) : undefined };
});

/** 还原（交给 Agent）：同 apply，只整理提示词 */
defineStep('revert', async (c, s) => {
  const ch = c.state.changes[Number(s.index) || 0];
  if (!ch) return 'no change';
  const prompt = await c.applier.revert(ch.id, { dry: true });
  return { prompt: prompt?.split('\n') ?? null, changes: changeLines(c) };
});

/** 等交给 Agent 的改动核对完（都不在等了，或者到了时限），返回用了多久、清单和页面上的值 */
defineStep('settle', async (c, s) => {
  const t0 = Date.now();
  const ms = Number(s.timeoutMs) || 15000;
  while (c.journal.waiting().length && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  const read = s.read as { props: string[] } | undefined;
  return { ms: Date.now() - t0, waiting: c.journal.waiting().length, changes: changeLines(c), computed: read ? await readComputed(c, read.props) : undefined };
});

/** 打开对比视图，返回当前标签页的左右两侧 */
defineStep('diff', async (c, s) => {
  const ch = c.state.changes[Number(s.index) || 0];
  if (!ch) return 'no change';
  await c.applier.diff(ch.id);
  await new Promise((r) => setTimeout(r, 300));
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return { opened: false, notice: c.state.notice };
  const left = (await vscode.workspace.openTextDocument(input.original)).getText();
  const right = (await vscode.workspace.openTextDocument(input.modified)).getText();
  const diffLines = right.split('\n').filter((l, i) => l !== left.split('\n')[i]);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return { opened: true, left: input.original.scheme, right: input.modified.scheme, changedLines: diffLines.map((l) => l.trim()) };
});

defineStep('fileLine', async (_c, s) => readFileSync(String(s.file), 'utf8').split('\n')[Number(s.line) - 1]);

/** 模拟桌面宽度（开发宿主里浏览器标签页很窄，会落到移动端样式） */
defineStep('viewport', async (c, s) => {
  const id = c.session!.browserId;
  if (s.clear) await c.browser.cdp(id, 'Emulation.clearDeviceMetricsOverride');
  else await c.browser.cdp(id, 'Emulation.setDeviceMetricsOverride', { width: Number(s.width) || 1280, height: Number(s.height) || 800, deviceScaleFactor: Number(s.scale) || 1, mobile: false });
  await new Promise((r) => setTimeout(r, 300));
  return c.browser.exec(id, 'innerWidth + "x" + innerHeight');
});

/** 打印第一处包含 find 的行起的 count 行 */
defineStep('fileRange', async (_c, s) => {
  const lines = readFileSync(String(s.file), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.includes(String(s.find)));
  return at < 0 ? null : lines.slice(at, at + (Number(s.count) || 10));
});

/** 热更新时间线：Vite 发出更新的时刻（?t=）、浏览器取模块的起止，相对最近一次写盘 */
let lastWrite = 0;
defineStep('hmrTimeline', async (c) => {
  const entries = await c.browser.exec<Array<{ name: string; start: number; end: number }>>(
    c.session!.browserId,
    `(() => { const out = performance.getEntriesByType('resource').filter(e => /[?&]t=\\d+/.test(e.name)).map(e => ({ name: e.name.replace(location.origin, ''), start: Math.round(performance.timeOrigin + e.startTime), end: Math.round(performance.timeOrigin + e.responseEnd) })); performance.clearResourceTimings(); return out; })()`,
  );
  return (entries ?? [])
    .filter((e) => e.start >= lastWrite)
    .map((e) => {
      const t = Number(/[?&]t=(\d+)/.exec(e.name)?.[1]);
      return `${e.name.split('?')[0]} vite=+${t - lastWrite} fetch=+${e.start - lastWrite}..+${e.end - lastWrite}`;
    });
});

/** 改一下源码（模拟 Agent 照提示词改代码）：find 找不到时返回 false */
defineStep('touchFile', async (_c, s) => {
  const f = String(s.file);
  const text = readFileSync(f, 'utf8');
  if (!text.includes(String(s.find))) return false;
  lastWrite = Date.now();
  writeFileSync(f, text.replace(String(s.find), String(s.replace)));
  await new Promise((r) => setTimeout(r, Number(s.settleMs) || 600));
  return true;
});

const composerIds = async () => ((await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds').then(undefined, () => [])) as string[]) ?? [];

/** 只用一段无害的文字测预填：新建对话的 id，事后到 Cursor 状态库核对“填了但没发送” */
defineStep('prefillProbe', async (_c, s) => {
  const before = await composerIds();
  const text = String(s.text);
  let error: string | null = null;
  try {
    if (s.via === 'chat') await vscode.commands.executeCommand('workbench.action.chat.open', { query: text, isPartialQuery: true });
    else await vscode.commands.executeCommand('composer.createNew', { partialState: { text } });
  } catch (e) {
    error = String(e);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const after = await composerIds();
  return { error, newIds: after.filter((id) => !before.includes(id)) };
});

/** 只生成提示词，不改状态：应用是全部未应用的，还原是清单里第 index 条 */
defineStep('prompt', async (c, s) => {
  if (s.mode === 'revert') {
    const rec = c.journal.get(c.state.changes[Number(s.index) || 0]?.id ?? '');
    return rec ? c.handoffPrompt([rec], 'revert').split('\n') : null;
  }
  const recs = [...c.journal.pending()].reverse();
  return recs.length ? c.handoffPrompt(recs, 'apply').split('\n') : null;
});

defineStep('serveStatic', async (c, s) => {
  const ok = await c.serveStatic(vscode.Uri.file(String(s.file)));
  return { ok, page: c.state.page, root: c.state.page ? c.project.rootFor(c.state.page.url) : null, connection: c.state.connection };
});

/** 把面板状态导出成 JSON，供浏览器里的面板开发页用真实数据排查排版 */
defineStep('dumpState', async (c, s) => {
  writeFileSync(String(s.path), JSON.stringify(c.state, null, 1));
  return { bytes: JSON.stringify(c.state).length };
});

/** 截取页面（含覆盖层）存成 PNG。开发宿主窗口被完全挡住时浏览器不出新帧，截图会一直等，所以要限时 */
defineStep('screenshot', async (c, s) => {
  const ms = Number(s.timeoutMs) || 5000;
  const shot = await Promise.race([
    c.browser.cdp<{ data: string }>(c.session!.browserId, 'Page.captureScreenshot', { format: 'png' }),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
  if (!shot) return { timeout: ms };
  writeFileSync(String(s.path), Buffer.from(shot.data, 'base64'));
  return { path: s.path };
});

/** 切换界面语言（不写进用户设置）：之后生成的提示、改动说明和提示词都用这个语言 */
defineStep('locale', async (c, s) => {
  c.applyLocale(localeFrom(String(s.locale)));
  return getLocale();
});

/** 打开侧栏面板，等 webview 里的 React 应用发回 ready */
defineStep('panel', async (c) => {
  const t0 = Date.now();
  c.panelReadyAt = 0;
  await vscode.commands.executeCommand('cssTuner.panel.focus');
  while (!c.panelReadyAt && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
  return { ready: !!c.panelReadyAt, ms: c.panelReadyAt ? c.panelReadyAt - t0 : null, errors: c.panelErrors.slice() };
});

defineStep('debugPlan', async (c, s) => {
  const prop = String(s.prop);
  const live = await c.session!.call('pageInfo', {});
  return {
    controllerSheets: c.page?.sheets,
    liveSheets: live.sheets,
    winner: c.state.selection?.el.winners[prop],
    target: c.state.selection?.targets[prop],
  };
});

/** 切换改动范围（只改这个 / 全部），返回重新规划后的代码位置 */
defineStep('scope', async (c, s) => {
  await c.handle({ t: 'setScope', scope: s.scope === 'source' ? 'source' : 'instance' });
  return { scope: c.state.scope, ...summarize(c.state.selection, (s.props as string[]) ?? []) };
});

/** 打开字体菜单（面板发 fontsOpen），等本机字体读完：返回页面字体、本机字体的个数和开头几个、has 里的字体装没装、主题字体 */
defineStep('fonts', async (c, s) => {
  const t0 = Date.now();
  await c.handle({ t: 'fontsOpen' });
  const deadline = t0 + (Number(s.timeoutMs) || 15000);
  while (!c.state.fonts?.local && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const f = c.state.fonts;
  return {
    ms: Date.now() - t0,
    page: f?.page ?? null,
    local: f?.local?.length ?? null,
    failed: !!f?.failed,
    sample: f?.local?.slice(0, 5) ?? null,
    has: Object.fromEntries(((s.has as string[]) ?? []).map((n) => [n, !!f?.local?.includes(n)])),
    theme: c.state.scales?.fontFamily.map((x) => `${x.label}${x.token !== undefined ? `(${x.token})` : ''}=${x.value}`) ?? null,
  };
});

/** 执行编辑器命令，比如录屏前关掉侧栏，让浏览器标签页比模拟的视口大 */
defineStep('command', async (_c, s) => {
  await vscode.commands.executeCommand(String(s.id), ...((s.args as unknown[]) ?? []));
  await new Promise((r) => setTimeout(r, 300));
  return true;
});

defineStep('wait', async (_c, s) => {
  await new Promise((r) => setTimeout(r, Number(s.ms) || 500));
  return true;
});

defineStep('state', async (c) => ({
  workspace: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  root: c.state.page ? c.project.rootFor(c.state.page.url) : null,
  connection: c.state.connection,
  page: c.state.page,
  scope: c.state.scope,
  notice: c.state.notice,
  changes: c.state.changes.map((ch) => `${ch.status} ${ch.propLabel} ${ch.from}→${ch.to} @${ch.target.label}${ch.note ? ` (${ch.note})` : ''}`),
}));

/** 扩展目录里有 selftest.json 时按它跑一遍端到端自测；返回是否跑了 */
export async function maybeRunSelfTest(ctx: vscode.ExtensionContext, c: Controller): Promise<boolean> {
  if (ctx.extensionMode === vscode.ExtensionMode.Production) return false;
  const file = join(ctx.extensionPath, 'selftest.json');
  if (!existsSync(file)) return false;
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as Config;
  const results: unknown[] = [];
  const write = (done = false) => writeFileSync(cfg.out, JSON.stringify({ at: new Date().toISOString(), done, results }, null, 2));
  write();
  c.journal.clear();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = folder ? join(folder, '.vscode', 'settings.json') : null;
  const hadSettings = !!settings && existsSync(settings);
  for (const step of cfg.steps) {
    const t0 = Date.now();
    let result: unknown;
    try {
      const run = runners.get(step.do);
      if (!run) throw new Error(`未知步骤 ${step.do}`);
      result = await run(c, step);
    } catch (e) {
      result = { error: String((e as Error)?.stack ?? e) };
    }
    results.push({ do: step.do, label: step.label ?? null, ms: Date.now() - t0, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    write();
  }
  if (settings && !hadSettings) removeIfEmpty(settings);
  write(true);
  if (cfg.closeWindow) await vscode.commands.executeCommand('workbench.action.closeWindow');
  return true;
}

/** config 步骤新建的 .vscode/settings.json 恢复成空对象后，删掉文件和空目录 */
function removeIfEmpty(file: string) {
  try {
    if (!existsSync(file) || readFileSync(file, 'utf8').replace(/\s/g, '') !== '{}') return;
    rmSync(file);
    const dir = dirname(file);
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // 清理失败不影响自测结果
  }
}

defineStep('selfCheck', async (c, s) => {
  const items = await c.selfCheck(s.live !== false);
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  return { ...summarizeCheck(items), items, tabsAfter: tabs };
});
