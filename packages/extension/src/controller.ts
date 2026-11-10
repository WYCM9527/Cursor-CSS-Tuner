import * as vscode from 'vscode';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  aliasesOf,
  getLocale,
  groupLabel,
  isGradient,
  localeFrom,
  overColor,
  parseColor,
  PROP_NAMES,
  sameValue,
  setLocale,
  solidLayer,
  STROKE_CLIP,
  STROKE_ORIGIN,
  t,
  toHex,
  type BridgeEvent,
  type EditRequest,
  type ElementSnapshot,
  type ExtToPanel,
  type Locale,
  type Notice,
  type OrderUnit,
  type OrderView,
  type PageInfo,
  type PanelState,
  type PanelToExt,
  type PreviewTarget,
  type PropInfo,
  type PropsView,
  type PropValue,
  type PropView,
  type RuleRef,
  type Scope,
  type SelectionView,
  type Target,
  type TextView,
} from '@css-tuner/protocol';
import { previewCompanions, tailwindScales, type RecipeInfo, type TwDesign } from '@css-tuner/engine';
import { Applier, SnapshotStore } from './applier';
import { AssetService } from './assets';
import { FontService } from './fonts';
import { BrowserAdapter } from './browser';
import { literalCompletions } from './completions';
import { History, pendingSet } from './history';
import { Journal, type ChangeRecord } from './journal';
import { MessageFiles } from './messages';
import {
  oneLine,
  plan,
  planOrder,
  planProp,
  planText,
  planVar,
  propKey,
  scopeAll,
  sourceKeyOf,
  tailwindEntry,
  textKey,
  type OrderContext,
  type OrderPlan,
  type Plan,
  type PropContext,
  type PropPlan,
  type TextContext,
  type TextPlan,
  type WriteSpec,
} from './planner';
import { ProjectResolver } from './project';
import { buildPrompt, type PromptMode } from './prompt';
import { recordElement, samePage } from './records';
import { cssScales, measureSteps } from './scales';
import { commandCheck, liveCheck, type CheckItem } from './selfcheck';
import { BridgeServer } from './server';
import { PageSession } from './session';
import { ClassSiteReader, CssRuleLocator } from './sites';
import { StaticServer } from './static';
import { TailwindService } from './tailwind';

const BROWSER_KEY = 'cssTuner.browserId';

/** 界面语言：设置里选了中文或英文就用选的，auto 跟随编辑器的显示语言 */
export function configuredLocale(): Locale {
  const v = vscode.workspace.getConfiguration('cssTuner').get<string>('language', 'auto');
  return v === 'zh-CN' || v === 'en' ? v : localeFrom(vscode.env.language);
}

/**
 * 静态站点的根目录：从 HTML 所在目录往上找，取工作区内最高一层带 index.html 的目录，
 * 让 /css/a.css 这种根相对路径能解析；都没有就用 HTML 所在目录
 */
function siteRoot(htmlFile: string): string {
  const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(htmlFile))?.uri.fsPath ?? null;
  let dir = dirname(htmlFile);
  let best = dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'index.html'))) best = dir;
    if (!ws || dir === ws) break;
    const up = dirname(dir);
    if (up === dir || !up.startsWith(ws)) break;
    dir = up;
  }
  return best;
}

/** 同一处代码的标识：Tailwind 是 JSX 调用位置，CSS 是那条规则，找不到位置的是元素 */
export function targetKey(p: Plan, el: ElementSnapshot): string {
  const w = p.write;
  if (w.kind === 'tailwind') return `tw|${w.file}|${w.line}|${w.column}`;
  if (w.kind === 'css') return `css|${w.file}|${w.fullSelector}|${w.conditions.join('|')}|${w.ordinal}`;
  if (w.kind === 'theme') return `theme|${w.file}|${w.name}`;
  if (p.preview.kind === 'rule') return `agent|rule|${p.preview.rule.sheet.index}|${p.preview.rule.fullSelector}|${p.preview.rule.conditions.join('|')}|${p.preview.rule.ordinal}`;
  return `agent|${sourceKeyOf(el) ?? el.uid}`;
}

/** 提示词里的一项兄弟：标签加文字开头，几项标签一样时也分得清 */
const unitText = (u: OrderUnit) => (u.text ? `${u.label} ${JSON.stringify(u.text)}` : u.label);

/** 纯 HTML 元素的选择器（刷新后按路径找回元素）；扩展自己的节点都加在末尾，不影响前面的序号 */
function htmlSelector(path: number[]): string {
  return `:root${path.map((i) => ` > :nth-child(${i + 1})`).join('')}`;
}

/**
 * 删属性的预览：改规则的直接去掉规则里的这些声明（连同逻辑别名），页面自然回落；
 * 改元素的（类名还在，规则还生效）把内联样式设成量好的回落值
 */
function removalDecls(preview: PreviewTarget, values: Record<string, string>): Record<string, string> {
  if (preview.kind === 'rule') return Object.fromEntries(Object.keys(values).flatMap((p) => aliasesOf(p).map((n) => [n, ''])));
  return values;
}
export class Controller implements vscode.Disposable {
  readonly browser = new BrowserAdapter();
  readonly server = new BridgeServer();
  readonly project = new ProjectResolver();
  readonly staticServer = new StaticServer();
  readonly classSites = new ClassSiteReader();
  readonly cssRules = new CssRuleLocator();
  readonly messages = new MessageFiles();
  readonly tailwind: TailwindService;
  readonly journal: Journal;
  readonly applier: Applier;
  readonly assets: AssetService;
  readonly fonts: FontService;
  session: PageSession | null = null;
  page: PageInfo | null = null;
  state: PanelState;

  private bundle: string | null = null;
  private post: ((msg: ExtToPanel) => void) | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];
  private sessionSubs: vscode.Disposable[] = [];
  private helloCount = 0;
  private lastSelection: { path: string; line: number; column: number; index: number } | null = null;
  private selectionWaiters: Array<(s: SelectionView | null) => void> = [];
  private plans = new Map<string, Plan>();
  /** 选中元素每段文字的规划，键是段序号 */
  private textPlans = new Map<number, TextPlan>();
  /** 选中元素所在兄弟组的换序规划，没有可换序的兄弟时为 null */
  private orderPlan: OrderPlan | null = null;
  /** 还没提交的实时换序预览：重建选中状态时按它显示，和页面上看到的一致 */
  private liveOrder: { key: string; order: number[] } | null = null;
  /** 选中元素所属组件每个属性的规划，键是属性名 */
  private propPlans = new Map<string, PropPlan>();
  /** 调用处没写、由 cva 默认变体决定的属性显示的默认值（改回它就等于没改） */
  private propDefaults = new Map<string, PropValue>();
  /** TS 在调用处字符串里给出的字面量补全：键是文件、mtime 和位置；null 是问过但没有，at 是上次问的时间 */
  private propOptions = new Map<string, { options: string[] | null; at: number; busy?: boolean }>();
  /** 当前页面 Tailwind 入口的设计系统，不是 Tailwind 页面时为 null */
  private design: TwDesign | null = null;
  private editChain: Promise<unknown> = Promise.resolve();
  /** 上一步 / 下一步（只管未应用的改动） */
  readonly history = new History();
  /** 正在做一步（编辑提交、重置、撤销）：中途改动清单的变化不算外部改动 */
  private stepping = 0;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly log: (msg: string) => void,
  ) {
    const cfg = vscode.workspace.getConfiguration('cssTuner');
    this.tailwind = new TailwindService(log);
    this.journal = new Journal(ctx.workspaceState);
    this.applier = new Applier(this, new SnapshotStore(ctx));
    this.assets = new AssetService(this, ctx.globalState);
    this.fonts = new FontService(this);
    this.state = {
      connection: 'idle',
      page: null,
      pickOn: false,
      measureOn: false,
      scope: cfg.get<Scope>('tailwind.scope', 'instance'),
      selection: null,
      scales: null,
      changes: this.journal.views(),
      notice: null,
      defaultUrl: cfg.get<string>('defaultUrl', 'http://localhost:5173/'),
      busy: false,
      locale: getLocale(),
      history: { undo: null, redo: null },
      fonts: null,
    };
    this.disposables.push(
      this.journal,
      this.applier,
      this.journal.onChange(() => {
        this.state.changes = this.journal.views();
        // 应用、核对、清理这些不经过历史的变化：对不上的几步作废
        if (!this.stepping) this.syncHistory();
        this.applier.track();
        this.push();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.project.invalidate()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('cssTuner')) return;
        const c = vscode.workspace.getConfiguration('cssTuner');
        this.state.defaultUrl = c.get<string>('defaultUrl', this.state.defaultUrl);
        if (e.affectsConfiguration('cssTuner.tailwind.scope')) this.state.scope = c.get<Scope>('tailwind.scope', this.state.scope);
        if (e.affectsConfiguration('cssTuner.language')) {
          setLocale(configuredLocale());
          this.state.locale = getLocale();
          this.state.history = this.history.labels();
        }
        // 范围、rem 基准变了：选中元素的代码位置和刻度按新设置重新判断（已记下的改动不变）
        if (this.state.selection) this.state.selection = this.buildSelection(this.state.selection.el);
        this.push();
      }),
    );
    // 上次关掉时还有在等 Agent 的改动：接着盯
    this.applier.track();
  }

  get remBase(): number {
    return vscode.workspace.getConfiguration('cssTuner').get<number>('remBase', 16);
  }

  /* ---------- 面板 ---------- */

  attachPanel(post: (msg: ExtToPanel) => void): vscode.Disposable {
    this.post = post;
    this.flush();
    return new vscode.Disposable(() => {
      if (this.post === post) this.post = null;
    });
  }

  push() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => this.flush(), 16);
  }

  private flush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.post?.({ t: 'state', state: this.state });
  }

  notify(level: Notice['level'], text: string) {
    this.state.notice = { level, text };
    this.push();
    if (level === 'error') this.log(t('ext.log.error', { text }));
  }

  /** 面板最近一次报告就绪的时间（自测用） */
  panelReadyAt = 0;
  readonly panelErrors: string[] = [];

  async handle(msg: PanelToExt): Promise<void> {
    try {
      switch (msg.t) {
        case 'ready':
          this.panelReadyAt = Date.now();
          this.flush();
          return;
        case 'error':
          this.panelErrors.push(msg.message);
          this.log(t('ext.log.panelError', { message: msg.message }));
          return;
        case 'openPage':
          await this.openPage(msg.url);
          return;
        case 'measure':
          await this.setMeasure(msg.on);
          return;
        case 'pick':
          await this.setPick(msg.on);
          return;
        case 'select':
          await this.session?.call('select', { uid: msg.uid });
          return;
        case 'hover':
          await this.session?.call('hover', { uid: msg.uid });
          return;
        case 'edit':
          await this.edit(msg.edit);
          return;
        case 'resetProps':
          await this.resetProps(msg.props);
          return;
        case 'discard':
          await this.discard(msg.id);
          return;
        case 'clearDone':
          this.journal.clearDone();
          await this.sweepSnapshots();
          return;
        case 'setScope':
          this.state.scope = msg.scope;
          if (this.state.selection) this.state.selection = this.buildSelection(this.state.selection.el);
          this.push();
          return;
        case 'setLocale': {
          this.applyLocale(msg.locale);
          // 工作区里写过语言的话用户设置会被盖住，切换就改工作区的
          const cfg = vscode.workspace.getConfiguration('cssTuner');
          const target = cfg.inspect('language')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          await cfg.update('language', msg.locale, target);
          return;
        }
        case 'openSource':
          await this.openSource(msg.file, msg.line, msg.column);
          return;
        case 'dismissNotice':
          this.state.notice = null;
          this.push();
          return;
        default:
          await this.handleMore(msg);
      }
    } catch (e) {
      this.notify('error', (e as Error).message);
    }
  }

  private async handleMore(msg: PanelToExt): Promise<void> {
    switch (msg.t) {
      case 'apply':
        await this.applier.apply(msg.ids);
        return;
      case 'revert':
        await this.applier.revert(msg.id);
        return;
      case 'diff':
        await this.applier.diff(msg.id);
        return;
      case 'editText':
        await this.editText(msg.segment, msg.value, msg.phase);
        return;
      case 'reorder':
        await this.reorder(msg.uid, msg.to, msg.phase);
        return;
      case 'editProp':
        await this.editProp(msg.name, msg.value, msg.phase);
        return;
      case 'editMany':
        await this.editMany(msg.edits);
        return;
      case 'undo':
        await this.undo();
        return;
      case 'redo':
        await this.redo();
        return;
      case 'resetText':
        await this.resetText(msg.segment);
        return;
      case 'resetProp':
        await this.resetProp(msg.name);
        return;
      case 'reload':
        if (this.session) await this.browser.reload(this.session.browserId);
        return;
      case 'assetsOpen':
      case 'saveAsset':
      case 'saveAllAssets':
      case 'copySvg':
      case 'revealAsset':
        await this.assetAction(msg);
        return;
      case 'fontsOpen':
        await this.fonts.open();
        return;
    }
  }

  /* ---------- 交给 Agent ---------- */

  /** 交给 Agent 的提示词：recs 按改的先后排 */
  handoffPrompt(recs: ChangeRecord[], mode: PromptMode): string {
    const tailwind = !!this.page && !!tailwindEntry(this.page, this.project);
    return buildPrompt(recs, { pageUrl: this.page?.url ?? recs[0].pageUrl, project: this.project, tailwind }, mode);
  }

  /* ---------- 静态页 ---------- */

  /** 用内置静态服务打开本地 HTML 或文件夹（没有开发服务器的项目） */
  async serveStatic(target?: vscode.Uri): Promise<boolean> {
    let uri = target;
    if (!uri) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file' && /\.html?$/i.test(active.fsPath)) uri = active;
    }
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        filters: { HTML: ['html', 'htm'] },
        openLabel: t('ext.static.openLabel'),
      });
      uri = picked?.[0];
    }
    if (!uri) return false;
    const path = uri.fsPath;
    const isDir = (() => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })();
    const root = isDir ? path : siteRoot(path);
    const origin = await this.staticServer.serve(root);
    this.project.register(origin, root);
    const url = isDir ? `${origin}/` : this.staticServer.urlFor(root, path) ?? `${origin}/`;
    this.log(t('ext.log.static', { root, origin }));
    return this.openPage(url);
  }

  /** 本地文件在当前页面源下的地址（静态页的 CSS 文件改了以后重新加载 <link> 用） */
  urlForFile(file: string): string | null {
    if (!this.page) return null;
    const root = this.project.rootFor(this.page.url);
    if (!root) return null;
    const rel = relative(root, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return `${new URL(this.page.url).origin}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
  }

  /* ---------- 页面连接 ---------- */

  private bridgeBundle(): string {
    if (!this.bundle) this.bundle = readFileSync(join(this.ctx.extensionPath, 'media', 'bridge.js'), 'utf8');
    return this.bundle;
  }

  /** 自检：内部命令在不在；live 时另开一个标签页，把注入、连接、选中、预览走一遍（不影响正在调参的页面） */
  async selfCheck(live: boolean): Promise<CheckItem[]> {
    const items = await commandCheck();
    if (!live || items.some((i) => i.required && !i.ok)) return items;
    const root = join(this.ctx.extensionPath, 'media', 'selfcheck');
    return [...items, ...(await liveCheck({ browser: this.browser, server: this.server, statics: this.staticServer, bundle: this.bridgeBundle(), root, log: this.log }))];
  }

  async openPage(url?: string): Promise<boolean> {
    const target = (url || this.state.defaultUrl).trim();
    // 本地 HTML 文件或文件夹：交给内置静态服务
    if (target.startsWith('file://')) return this.serveStatic(vscode.Uri.parse(target));
    if (isAbsolute(target) && existsSync(target)) return this.serveStatic(vscode.Uri.file(target));
    if (!/^https?:\/\//.test(target)) throw new Error(t('ext.open.badUrl', { target }));
    const cap = await this.browser.check();
    if (!cap.ok) {
      this.notify('error', t('ext.open.missingCommands', { missing: cap.missing.join(', ') }));
      return false;
    }
    this.state.connection = 'opening';
    this.state.notice = null;
    this.push();
    await this.server.start();

    let browserId = this.session?.browserId ?? this.ctx.workspaceState.get<string>(BROWSER_KEY) ?? null;
    const reuse = !!browserId && (await this.browser.isOpen(browserId));
    if (!reuse || !browserId) {
      // 先开空白页、注册好桥接脚本再跳过去：页面一开始加载桥接就在
      browserId = await this.browser.open('about:blank');
      await this.ctx.workspaceState.update(BROWSER_KEY, browserId);
    }

    if (!this.session || this.session.browserId !== browserId) {
      this.disposeSession();
      this.session = new PageSession(browserId, this.browser, this.server, this.bridgeBundle(), this.log);
      this.sessionSubs.push(
        this.session.onEvent((ev) => void this.onBridgeEvent(ev)),
        this.session.onState((s) => {
          this.state.connection = s === 'idle' ? 'idle' : s;
          if (s === 'lost') this.state.pickOn = this.state.measureOn = false;
          this.push();
        }),
      );
    }

    if (!reuse || (await this.browser.url(browserId)) !== target) {
      await this.registerEarly(this.session);
      await this.browser.navigate(browserId, target);
    }
    if (reuse) await this.browser.focus(browserId);

    const href = await this.browser.waitReady(browserId);
    if (!href || href.startsWith('chrome-error://')) {
      this.notify('error', t('ext.open.unreachable', { target }));
      this.state.connection = 'lost';
      this.push();
      return false;
    }
    await this.session.inject();
    const ok = await this.session.waitConnected(10000);
    if (!ok) this.notify('error', t('ext.open.notConnected'));
    // 会话一直连着（同一个标签页换地址）时不会再发状态变化，这里补上
    this.state.connection = ok ? 'connected' : 'lost';
    this.push();
    return ok;
  }

  /**
   * 跳转前注册桥接脚本：React 初始化之前挂上 DevTools 钩子，组件属性才能在页面上预览。
   * 新开的标签页 CDP 可能还没就绪，稍等再试；一直不行也不要紧，加载完会照常注入
   */
  private async registerEarly(session: PageSession): Promise<void> {
    for (let i = 0; i < 12; i++) {
      try {
        await session.register();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  private disposeSession() {
    for (const d of this.sessionSubs) d.dispose();
    this.sessionSubs = [];
    this.session?.dispose();
    this.session = null;
    this.helloCount = 0;
  }

  async setPick(on: boolean) {
    if (!this.session?.connected) {
      if (on) this.notify('warn', t('ext.pick.noPage'));
      return;
    }
    await this.session.call('setPick', { on });
    this.state.pickOn = on;
    if (on) this.state.measureOn = false;
    this.push();
    if (on) await this.browser.focus(this.session.browserId);
  }

  /** 标尺：和选取元素互斥，页面上 Esc 退出 */
  async setMeasure(on: boolean) {
    if (!this.session?.connected) {
      if (on) this.notify('warn', t('ext.pick.noPage'));
      return;
    }
    await this.session.call('setMeasure', { on });
    this.state.measureOn = on;
    if (on) this.state.pickOn = false;
    this.push();
    if (on) await this.browser.focus(this.session.browserId);
  }

  /** 自测用：最近收到的桥接事件 */
  readonly trace: string[] = [];

  protected async onBridgeEvent(ev: BridgeEvent) {
    const t0 = Date.now();
    this.trace.push(`${t0 % 100000} ${ev.t}${'page' in ev && ev.page ? ` sheets=${ev.page.sheets.length}` : ''}${ev.t === 'select' ? ` el=${ev.el?.label ?? null}` : ''}`);
    if (this.trace.length > 200) this.trace.splice(0, 100);
    switch (ev.t) {
      case 'hello': {
        this.helloCount++;
        // 新文档：旧的选中元素已经不在了；换了页面就不再按源码位置找回
        const prev = this.page?.url;
        if (this.lastSelection && (!prev || !this.samePage(prev, ev.page.url))) this.lastSelection = null;
        this.state.selection = null;
        this.assets.forget();
        await this.setPage(ev.page);
        this.state.pickOn = false;
        this.state.measureOn = false;
        this.push();
        await this.onHello(this.helloCount > 1);
        return;
      }
      case 'page':
        await this.setPage(ev.page);
        return;
      case 'pick':
        this.state.pickOn = ev.on;
        this.push();
        return;
      case 'measure':
        this.state.measureOn = ev.on;
        this.push();
        return;
      case 'select':
        await this.onSelect(ev.el);
        return;
      case 'editText':
        // 页面上双击改的是选中元素（双击前页面会先改选文字所在的元素）
        if (this.state.selection?.el.uid !== ev.uid) await this.refreshSelection();
        if (this.state.selection?.el.uid === ev.uid) await this.editText(ev.segment, ev.value, ev.phase);
        return;
      case 'reorder':
        // 页面上拖的是选中元素的把手
        if (this.state.selection?.el.uid === ev.uid) await this.reorder(ev.uid, ev.to, 'commit');
        return;
      case 'log':
        return;
    }
  }

  private async setPage(page: PageInfo) {
    this.page = page;
    this.project.learnFromSheets(page.url, page.sheets.map((s) => s.devId).filter((d): d is string => !!d));
    this.state.page = { url: page.url, title: page.title };
    const { design, scales } = await this.loadScales(page);
    // 等设计系统的时候又来了新的页面信息（热更新连着换样式表、换了页面）：以后来的那次为准
    if (this.page !== page) return;
    this.design = design;
    this.state.scales = scales;
    // 样式表变了（懒加载的 CSS、热更新），代码位置要按新的样式表和设计系统重新判断
    if (this.state.selection) this.state.selection = this.buildSelection(this.state.selection.el);
    this.push();
    void this.session?.call('measureSteps', { steps: measureSteps(scales) }).catch(() => undefined);
    // 换了页面、样式表热更新过：在等 Agent 的改动可能已经生效了
    this.applier.soon();
  }

  /** 设计系统还没加载好（或加载失败）时按项目里装的版本号 */
  private tailwindMajor(): number | null {
    if (this.design) return this.design.major;
    const entry = this.page ? tailwindEntry(this.page, this.project) : null;
    const version = entry ? this.tailwind.versionFor(entry) : null;
    return version ? Number(version.split('.')[0]) || null : null;
  }

  /** 刻度：Tailwind 项目从项目自己的设计系统读，普通 CSS 用页面上的 CSS 变量 */
  protected async loadScales(page: PageInfo) {
    const entry = tailwindEntry(page, this.project);
    const design = entry ? await this.tailwind.designFor(entry, this.remBase) : null;
    return { design, scales: design ? tailwindScales(design, this.remBase) : cssScales(page, this.remBase) };
  }

  /** 页面（重新）连上：刷新后按源码位置找回之前选中的元素，并把未应用、等 Agent 改的改动重新挂上预览 */
  protected async onHello(reconnect: boolean) {
    await this.restorePreviews();
    this.applier.soon();
    if (reconnect && this.lastSelection && this.session) {
      const { path, line, column, index } = this.lastSelection;
      await this.session.call('select', { source: { path, line, column, index }, waitMs: 4000 }, 8000).catch(() => null);
    }
  }

  samePage(a: string, b: string): boolean {
    return samePage(a, b);
  }

  /** 先挂旧的：同一处交给 Agent 之后又改了的，后改的那条要盖在上面 */
  private async restorePreviews() {
    for (const rec of [...this.journal.previewing()].reverse()) await this.showPreview(rec);
  }

  /** 把一条改动的预览挂到页面上：元素按源码位置找回来（换序按选中时的那一项，纯 HTML 按路径） */
  async showPreview(rec: ChangeRecord) {
    const session = this.session;
    if (!session || !this.page || !this.samePage(rec.pageUrl, this.page.url)) return;
    const src = rec.element.source;
    // 换序记的是挪动的那一项，按选中时的元素（anchor）找回这一组
    const anchor = rec.preview.kind === 'order' ? rec.preview.anchor : undefined;
    const htmlPath = rec.preview.kind === 'text' || rec.preview.kind === 'order' ? rec.preview.htmlPath : undefined;
    const query = anchor
      ? { source: anchor }
      : src && rec.preview.kind !== 'order'
        ? { source: { path: src.path, line: src.line, column: src.column, index: rec.element.sourceIndex } }
        : htmlPath
          ? { selector: htmlSelector(htmlPath) }
          : null;
    const uid = query ? await session.call('resolve', { ...query, waitMs: 3000 }, 6000).catch(() => null) : null;
    // 规则预览改的是样式表，元素找不回来也照样生效；其余都要作用在元素上
    if (!uid && rec.preview.kind !== 'rule') return;
    const target = { ...rec.preview, uid: uid ?? rec.preview.uid } as PreviewTarget;
    this.journal.update(rec.id, { preview: target });
    await session
      .call('preview', { id: rec.previewId, target, ...(await this.previewValue(rec)) })
      .catch((e) => this.log(t('ext.log.restorePreviewFailed', { error: (e as Error).message })));
  }

  /** 一条改动的预览值：样式是声明（含 Tailwind 令牌顺带的属性），删属性见 removalDecls，文字和 props 是新值，换序的位置在目标里 */
  private async previewValue(rec: ChangeRecord): Promise<{ decls?: Record<string, string>; text?: string; prop?: PropValue }> {
    switch (rec.kind) {
      case 'text':
        return { text: rec.value };
      case 'prop':
        return { prop: JSON.parse(rec.value) as PropValue };
      case 'reorder':
        return {};
      default:
        if (rec.removal) return { decls: removalDecls(rec.preview, rec.removal.values) };
        if (rec.decls) return { decls: rec.decls };
        return { decls: { ...(await this.companions(rec.write, rec.props, rec.token)), ...Object.fromEntries(rec.props.map((p) => [p, rec.value])) } };
    }
  }

  protected async onSelect(el: ElementSnapshot | null) {
    if (!el) {
      this.state.selection = null;
      this.push();
      this.resolveSelectionWaiters();
      return;
    }
    if (el.source) this.lastSelection = { path: el.source.path, line: el.source.line, column: el.source.column, index: el.sourceIndex };
    this.state.selection = this.buildSelection(el);
    this.push();
    this.resolveSelectionWaiters();
    this.scheduleAssets();
  }

  protected buildSelection(el: ElementSnapshot): SelectionView {
    const pageUrl = this.page?.url ?? '';
    const file = el.source ? this.project.fileFor(pageUrl, el.source.path, el.source.file) : null;
    this.plans.clear();
    const targets: Record<string, Target> = {};
    let all: number | null = null;
    if (this.page) {
      const ctx = {
        page: this.page,
        project: this.project,
        scope: this.state.scope,
        classSite: (f: string, line: number, column: number) => this.classSites.site(f, line, column),
        classLiterals: (f: string) => this.classSites.literals(f),
        ruleSource: (entry: string, ref: RuleRef) => this.cssRules.sourceOf(entry, ref),
        isUtility: (candidate: string) => !!this.design?.valid(candidate),
        tailwindMajor: this.tailwindMajor(),
      };
      for (const prop of PROP_NAMES) {
        const p = plan(el, prop, ctx);
        this.plans.set(prop, p);
        targets[prop] = p.view;
      }
      for (const v of el.vars ?? []) {
        const p = planVar(el, v.name, ctx);
        this.plans.set(v.name, p);
        targets[v.name] = p.view;
      }
      all = scopeAll(el, ctx, targets);
    }
    return {
      el,
      file,
      targets,
      ...this.pendingFor(el),
      texts: this.textsFor(el),
      order: this.orderFor(el),
      props: this.propsFor(el),
      assets: this.assets.view(el),
      ...(all ? { scopeAll: all } : {}),
    };
  }

  /* ---------- 图片和视频 ---------- */

  private assetTimer: NodeJS.Timeout | null = null;

  /** 「图片和视频」展开着时取选中元素的完整清单（热更新连着来的几次选中只取一回） */
  private scheduleAssets() {
    if (!this.assets.open || !this.state.selection) return;
    if (this.assetTimer) clearTimeout(this.assetTimer);
    this.assetTimer = setTimeout(() => {
      this.assetTimer = null;
      void this.loadAssets();
    }, 150);
  }

  async loadAssets(): Promise<void> {
    const uid = this.state.selection?.el.uid;
    if (!uid || !this.assets.open) return;
    try {
      await this.assets.load(uid);
    } catch (e) {
      this.log(t('ext.log.error', { text: (e as Error).message }));
      return;
    }
    const sel = this.state.selection;
    if (sel?.el.uid !== uid) return;
    sel.assets = this.assets.view(sel.el);
    this.push();
  }

  private async assetAction(msg: Extract<PanelToExt, { t: 'assetsOpen' | 'saveAsset' | 'saveAllAssets' | 'copySvg' | 'revealAsset' }>) {
    switch (msg.t) {
      case 'assetsOpen':
        this.assets.open = msg.open;
        this.scheduleAssets();
        return;
      case 'saveAsset':
        await this.assets.save(msg.id);
        return;
      case 'saveAllAssets':
        await this.assets.saveAll();
        return;
      case 'copySvg':
        await this.assets.copySvg(msg.id);
        return;
      case 'revealAsset':
        await this.assets.reveal(msg.id);
        return;
    }
  }

  private orderContext(page: PageInfo): OrderContext {
    return {
      page,
      project: this.project,
      jsxOrder: (f, sites) => this.classSites.jsxOrder(f, sites),
      arraySite: (f, line, column, count) => this.classSites.arraySite(f, line, column, count),
    };
  }

  /** 兄弟组的顺序：有未应用的换序时按换过之后的顺序 */
  private orderFor(el: ElementSnapshot): OrderView | undefined {
    const p = this.page ? planOrder(el, this.orderContext(this.page)) : null;
    this.orderPlan = p;
    if (!p || !el.order) return undefined;
    const rec = this.journal.findPending(p.key);
    const live = this.liveOrder?.key === p.key && this.liveOrder.order.length === p.units.length ? this.liveOrder.order : null;
    return this.orderView(p, live ?? this.currentOrder(p, rec), el.order.index, el.order.axis, !!rec);
  }

  private currentOrder(p: OrderPlan, rec: ChangeRecord | undefined): number[] {
    const n = p.units.length;
    const perm = rec ? (JSON.parse(rec.value) as number[]) : [];
    return perm.length === n ? perm : [...Array(n).keys()];
  }

  private orderView(p: OrderPlan, perm: number[], self: number, axis: 'x' | 'y', pending: boolean): OrderView {
    const items = perm.map((i) => {
      const u = p.units[i];
      return { uid: u.uids[0], label: u.label, component: /^[a-z]/.test(u.name) ? null : u.name || null, ...(u.text ? { text: u.text } : {}) };
    });
    return { items, index: perm.indexOf(self), axis, pending, target: p.view };
  }

  private textContext(page: PageInfo): TextContext {
    return {
      page,
      project: this.project,
      textChild: (f, line, column, index) => this.classSites.textChild(f, line, column, index),
      textAttr: (f, line, column, name) => this.classSites.textAttr(f, line, column, name),
      message: (near, ref, text, lang) => {
        const root = this.project.packageRoot(near);
        return root ? this.messages.find(root, ref, text, lang) : { reason: t('engine.message.notFound', { key: ref.key }) };
      },
    };
  }

  /** 每段文字写在哪；有未应用的改动时显示改动后的文字 */
  private textsFor(el: ElementSnapshot): TextView[] | undefined {
    this.textPlans.clear();
    const segs = el.text?.segments;
    if (!this.page || !segs?.length) return undefined;
    const ctx = this.textContext(this.page);
    return segs.map((seg, i) => {
      const p = planText(el, i, ctx);
      this.textPlans.set(i, p);
      const rec = this.journal.findPending(textKey(p, el, i));
      return { segment: i, value: rec ? rec.value : oneLine(seg.value), pending: !!rec, origin: p.origin, target: p.view };
    });
  }

  private propContext(page: PageInfo): PropContext {
    return { page, project: this.project, propSite: (f, line, column, name, tag) => this.classSites.propSite(f, line, column, name, tag) };
  }

  /** 选中元素自己的 JSX 用到的 cva / tv 配方（元素隔着别的组件时配方不是这个组件的） */
  private recipeFor(el: ElementSnapshot): RecipeInfo | null {
    if (!this.page || !el.props?.direct || !el.source) return null;
    const file = this.project.fileFor(this.page.url, el.source.path, el.source.file);
    return file ? this.classSites.recipe(file, el.source.line, el.source.column) : null;
  }

  /** 渲染选中元素的组件收到的属性；有未应用的改动时显示改动后的值，cva 变体里调用处没写的也列出来 */
  private propsFor(el: ElementSnapshot): PropsView | undefined {
    this.propPlans.clear();
    this.propDefaults.clear();
    const info = el.props;
    if (!this.page || !info) return undefined;
    const ctx = this.propContext(this.page);
    const recipe = this.recipeFor(el);
    const items: PropView[] = [];
    const add = (prop: PropInfo, missing: boolean) => {
      const p = planProp(el, prop.name, ctx);
      this.propPlans.set(prop.name, p);
      if (missing) this.propDefaults.set(prop.name, prop.value);
      const rec = this.journal.findPending(propKey(p, el, prop.name));
      const options = this.optionsFor(el, prop, p, recipe);
      items.push({
        name: prop.name,
        type: prop.type,
        value: rec ? (JSON.parse(rec.value) as PropValue) : prop.value,
        ...(prop.summary ? { summary: prop.summary } : {}),
        pending: !!rec,
        ...(options ? { options } : {}),
        ...(missing ? { missing } : {}),
        ...(p.warn ? { warn: p.warn } : {}),
        target: p.view,
      });
    };
    for (const prop of info.props) add(prop, false);
    for (const name of recipe?.passed ?? []) {
      const opts = recipe!.variants[name] ?? [];
      if (!opts.length || info.props.some((x) => x.name === name)) continue;
      const d = recipe!.defaults[name];
      const bool = opts.every((o) => o === 'true' || o === 'false');
      add(bool ? { name, type: 'boolean', value: d === 'true' } : { name, type: d === undefined ? 'undefined' : 'string', value: d ?? null }, true);
    }
    const loc = info.source;
    const file = loc ? this.project.fileFor(this.page.url, loc.path, loc.file) : null;
    return {
      component: info.component,
      source: loc && file ? { file, line: loc.line, column: loc.column, label: `${this.project.label(file)}:${loc.line}` } : null,
      server: info.server,
      live: info.live,
      items,
    };
  }

  /** 属性可选的值：cva / tv 配方的变体，或者 TS 在调用处字符串里给出的字面量补全（异步，问到了再推一次） */
  private optionsFor(el: ElementSnapshot, prop: PropInfo, p: PropPlan, recipe: RecipeInfo | null): PropValue[] | undefined {
    if (prop.type !== 'string' && prop.type !== 'undefined' && prop.type !== 'null') return undefined;
    const variant = recipe?.passed.includes(prop.name) ? recipe.variants[prop.name] : undefined;
    if (variant?.length && !variant.every((o) => o === 'true' || o === 'false')) return variant;
    const inner = p.site?.kind === 'literal' ? p.site.inner : undefined;
    if (!inner || p.write.kind !== 'jsxProp') return undefined;
    const file = p.write.file;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    const key = `${file}|${mtime}|${inner.line}|${inner.column}`;
    const hit = this.propOptions.get(key);
    if (hit?.options) return hit.options;
    if (hit && (hit.busy || Date.now() - hit.at < 15000)) return undefined;
    this.propOptions.set(key, { options: null, at: Date.now(), busy: true });
    void literalCompletions(file, inner.line, inner.column).then((options) => {
      this.propOptions.set(key, { options, at: Date.now() });
      if (this.propOptions.size > 200) this.propOptions.delete(this.propOptions.keys().next().value as string);
      const now = this.selectionOf(el);
      const item = now?.props?.items.find((x) => x.name === prop.name);
      if (!options || !item) return;
      item.options = options;
      this.push();
    });
    return undefined;
  }

  /** 改选中元素所属组件的属性：live 只预览，commit 记进改动清单；改回原来的值就撤掉这条改动 */
  editProp(name: string, value: PropValue, phase: 'live' | 'commit'): Promise<void> {
    return this.queue(() => (phase === 'commit' ? this.step(() => this.doEditProp(name, value, phase)) : this.doEditProp(name, value, phase)));
  }

  private async doEditProp(name: string, value: PropValue, phase: 'live' | 'commit') {
    const sel = this.state.selection;
    const session = this.session;
    const p = this.propPlans.get(name);
    const info = sel?.el.props;
    const item = sel?.props?.items.find((x) => x.name === name);
    if (!sel || !session || !this.page || !p || !info || !item) return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    const el = sel.el;
    const key = propKey(p, el, name);
    const existing = this.journal.findPending(key);
    const previewId = this.previewIdFor(key, existing);
    // 调用处原来的值（JSON）：取快照里的（面板上的值在实时预览时已经变了）；没写时是 "undefined"，界面上显示的是默认值
    const snap = info.props.find((x) => x.name === name);
    const base = existing?.original[name] ?? (!snap || snap.type === 'undefined' ? 'undefined' : JSON.stringify(snap.value));
    const shown: PropValue = base === 'undefined' ? (this.propDefaults.get(name) ?? null) : (JSON.parse(base) as PropValue);
    const json = JSON.stringify(value);
    const back = json === base || (base === 'undefined' && this.propDefaults.has(name) && json === JSON.stringify(shown));
    if (back) await session.call('clearPreview', { id: previewId });
    else if (info.live) await session.call('preview', { id: previewId, target: p.preview, prop: value });
    const now = this.selectionOf(el)?.props?.items.find((x) => x.name === name);
    if (now) now.value = back ? shown : value;
    if (phase === 'commit') {
      if (back) {
        if (existing) this.journal.remove(existing.id);
      } else {
        const fields = { value: json, to: json, expected: { [name]: json }, view: p.view, write: p.write };
        if (existing) this.journal.update(existing.id, fields);
        else {
          this.journal.add({
            kind: 'prop',
            key,
            pageUrl: this.page.url,
            element: recordElement(el),
            props: [name],
            propLabel: name,
            from: base === 'undefined' ? t('engine.prop.unset') : base,
            token: null,
            original: { [name]: base },
            preview: p.preview,
            previewId,
            detail: { component: info.component, ...(sel.props?.source ? { site: sel.props.source.label } : {}) },
            ...fields,
          });
        }
      }
      if (now) now.pending = !back;
    }
    this.push();
  }

  /** 选中元素上仍未应用的改动值（同一处代码、同一属性），删属性的是删掉之后的值 */
  private pendingFor(el: ElementSnapshot): Pick<SelectionView, 'pending' | 'removed'> {
    const pending: Record<string, string> = {};
    const removed = new Set<string>();
    for (const rec of [...this.journal.pending()].reverse()) {
      for (const prop of rec.props) {
        const p = this.plans.get(prop);
        if (!p || !rec.key.startsWith(targetKey(p, el) + '|')) continue;
        pending[prop] = rec.removal?.values[prop] ?? rec.value;
        if (rec.removal) removed.add(prop);
        else removed.delete(prop);
      }
    }
    return { pending, removed: [...removed] };
  }

  /** 选中元素上未应用的样式改动（和元素现在的代码位置相同） */
  private pendingOn(el: ElementSnapshot): ChangeRecord[] {
    return this.journal.pending().filter((rec) => {
      const p = rec.kind === 'style' ? this.plans.get(rec.props[0]) : undefined;
      return !!p && rec.key.startsWith(targetKey(p, el) + '|');
    });
  }

  private resolveSelectionWaiters() {
    const ws = this.selectionWaiters;
    this.selectionWaiters = [];
    for (const w of ws) w(this.state.selection);
  }

  /** 等下一次选中更新（自测用）；nonNull 时跳过中途的“取消选中” */
  nextSelection(timeoutMs = 5000, nonNull = false): Promise<SelectionView | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.state.selection), timeoutMs);
      const waiter = (s: SelectionView | null) => {
        if (nonNull && !s) {
          this.selectionWaiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(s);
      };
      this.selectionWaiters.push(waiter);
    });
  }

  /* ---------- 编辑与预览 ---------- */

  /** 编辑、重置、撤销按顺序一个个来：预览和改动清单都是异步改的 */
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const p = this.editChain.then(run);
    this.editChain = p.catch(() => undefined);
    return p;
  }

  /** 一次用户操作：前后的未应用改动有变化就记成历史里的一步；套在别的操作里时算进外面那一步 */
  private async step<T>(run: () => Promise<T>): Promise<T> {
    if (this.stepping) return run();
    const before = pendingSet(this.journal.all());
    this.stepping++;
    try {
      return await run();
    } finally {
      this.stepping--;
      this.history.record(before, pendingSet(this.journal.all()));
      this.syncHistory();
      this.push();
    }
  }

  /** 作废和现在的改动清单对不上的几步，按钮提示跟着变 */
  private syncHistory() {
    this.history.prune((key) => this.journal.findPending(key));
    this.state.history = this.history.labels();
  }

  /** 换界面语言：上一步 / 下一步的提示和选中元素的定位说明按新语言重新生成（清单里已记下的说明不变） */
  applyLocale(locale: Locale) {
    setLocale(locale);
    this.state.locale = locale;
    this.state.history = this.history.labels();
    if (this.state.selection) this.state.selection = this.buildSelection(this.state.selection.el);
    this.push();
  }

  edit(req: EditRequest): Promise<void> {
    return this.queue(() => (req.phase === 'commit' || req.remove ? this.step(() => this.doEdit(req)) : this.doEdit(req)));
  }

  /** 一次改几组属性（加描边：粗细和样式一起设），撤销时算一步 */
  editMany(edits: EditRequest[]): Promise<void> {
    return this.queue(() => this.step(async () => {
      for (const req of edits) await this.doEdit(req);
    }));
  }

  /** 按代码位置分组：同一组的属性记成一条改动 */
  private groupByTarget(el: ElementSnapshot, props: string[]): Map<string, { plan: Plan; props: string[] }> {
    const groups = new Map<string, { plan: Plan; props: string[] }>();
    for (const prop of props) {
      const p = this.plans.get(prop);
      if (!p) continue;
      const k = targetKey(p, el);
      const g = groups.get(k) ?? { plan: p, props: [] };
      g.props.push(prop);
      groups.set(k, g);
    }
    return groups;
  }

  private async doEdit(req: EditRequest) {
    const sel = this.state.selection;
    const session = this.session;
    if (!sel || !session || !this.page || !req.props.length) return;
    if (req.remove) return this.doRemove(req);
    if (isGradient(req.value) && req.props.every((p) => /^border-(top|right|bottom|left)-color$/.test(p))) return this.doStrokeGradient(req);
    const el = sel.el;
    let undeleted = false;
    for (const [tk, g] of this.groupByTarget(el, req.props)) {
      const props = [...g.props].sort();
      const key = `${tk}|${props.join(',')}`;
      const existing = this.journal.findPending(key);
      const previewId = this.previewIdFor(key, existing);
      const decls = { ...(await this.companions(g.plan.write, props, req.token ?? null)), ...Object.fromEntries(props.map((p) => [p, req.value])) };
      const res = await session.call('preview', { id: previewId, target: g.plan.preview, decls });
      const live = this.selectionOf(el);
      if (live) for (const p of props) live.pending[p] = req.value;
      if (req.phase !== 'commit') {
        // 预览回到原值（关掉下拉菜单时恢复打开前的值），这些属性上又没有未应用的改动：撤掉预览，不算改过
        const untouched = !this.pendingOn(el).some((r) => r.props.some((p) => props.includes(p)));
        if (untouched && props.every((p) => res.computed[p] !== undefined && sameValue(p, res.computed[p], el.computed[p] ?? ''))) {
          await session.call('clearPreview', { id: previewId });
          if (live) for (const p of props) delete live.pending[p];
        }
        continue;
      }

      // 这些属性上别的未应用删除（删的范围不一样）：先撤掉删除再按新值改，原值按删之前的算
      const removals = this.pendingOn(el).filter((r) => r.removal && r.key !== key && r.props.some((p) => props.includes(p)));
      const before: Record<string, string> = Object.assign({}, ...removals.map((r) => r.original));
      const was: Record<string, string> = Object.assign({}, ...removals.map((r) => r.removal?.from ?? {}), existing?.removal?.from ?? {});
      for (const r of removals) await this.dropRecord(r);
      undeleted ||= removals.length > 0;
      const original = Object.fromEntries(props.map((p) => [p, existing?.original[p] ?? before[p] ?? el.computed[p] ?? '']));
      const backToOriginal = props.every((p) => res.computed[p] !== undefined && sameValue(p, res.computed[p], original[p]));
      if (backToOriginal) {
        if (existing) this.journal.remove(existing.id);
        await session.call('clearPreview', { id: previewId });
        const now = this.selectionOf(el);
        if (now) {
          for (const p of props) delete now.pending[p];
          now.removed = now.removed.filter((p) => !props.includes(p));
        }
        continue;
      }
      const to = this.describeTo(g.plan, req);
      const from = was[props[0]] ?? this.describeFrom(el, props[0], g.plan);
      const expected = Object.fromEntries(props.filter((p) => res.computed[p] !== undefined).map((p) => [p, res.computed[p]]));
      const { view, write } = g.plan;
      const font = props.includes('font-family') && !req.token ? this.fonts.localOnly(req.value) : null;
      const detail = font ? { font } : undefined;
      if (existing) {
        const undo = existing.removal ? { from, removal: undefined } : {};
        this.journal.update(existing.id, { value: req.value, token: req.token ?? null, to, expected, view, write, decls: undefined, detail, ...undo });
      } else {
        this.journal.add({
          kind: 'style',
          key,
          pageUrl: this.page.url,
          element: recordElement(el),
          props,
          propLabel: groupLabel(props),
          from,
          to,
          value: req.value,
          token: req.token ?? null,
          original,
          expected,
          view,
          preview: g.plan.preview,
          previewId,
          write,
          ...(detail ? { detail } : {}),
        });
      }
      const now = this.selectionOf(el);
      if (now) {
        for (const p of props) now.pending[p] = req.value;
        now.removed = now.removed.filter((p) => !props.includes(p));
      }
    }
    // 撤掉的删除管着更多属性（删了整个描边再改粗细）：其余属性回到原来的值，重新读一遍
    if (undeleted) await this.refreshSelection();
    this.push();
  }

  /**
   * 没有填充色的元素把描边改成渐变：有填充色时面板用两层背景写（内层填充裁到内边距、渐变铺到边框），
   * 没有填充色这样写会把元素里面也盖住，交给 Agent 换别的写法；预览垫一层元素后面的底色，看起来和最后一样
   */
  private async doStrokeGradient(req: EditRequest) {
    const sel = this.state.selection;
    const session = this.session;
    const plan = this.plans.get(req.props[0]);
    if (!sel || !session || !this.page || !plan) return;
    const el = sel.el;
    const props = [...req.props].sort();
    const key = `${targetKey(plan, el)}|${props.join(',')}`;
    const existing = this.journal.findPending(key);
    const previewId = this.previewIdFor(key, existing);
    // 垫底的是元素里面看到的颜色：半透明的背景色叠在后面的底色上
    const backdrop = parseColor(el.backdrop) ?? { r: 1, g: 1, b: 1, a: 1 };
    const bg = parseColor(sel.pending['background-color'] ?? el.computed['background-color']);
    const decls = {
      'background-image': `${solidLayer(toHex(bg ? overColor(bg, backdrop) : backdrop))}, ${req.value}`,
      'background-clip': STROKE_CLIP,
      'background-origin': STROKE_ORIGIN,
      ...Object.fromEntries(props.map((p) => [p, 'transparent'])),
    };
    await session.call('preview', { id: previewId, target: plan.preview, decls });
    const live = this.selectionOf(el);
    if (live) for (const p of props) live.pending[p] = req.value;
    if (req.phase === 'commit') {
      const reason = t('ext.plan.strokeGradient');
      const fields = { value: req.value, token: null, to: req.value, expected: {}, view: { ...plan.view, kind: 'agent' as const, reason }, write: { kind: 'agent' as const, reason }, decls };
      if (existing) this.journal.update(existing.id, { ...fields, ...(existing.removal ? { from: this.describeFrom(el, props[0], plan), removal: undefined } : {}) });
      else {
        this.journal.add({
          kind: 'style',
          key,
          pageUrl: this.page.url,
          element: recordElement(el),
          props,
          propLabel: groupLabel(props),
          from: this.describeFrom(el, props[0], plan),
          original: Object.fromEntries(props.map((p) => [p, el.computed[p] ?? ''])),
          preview: plan.preview,
          previewId,
          ...fields,
        });
      }
      const now = this.selectionOf(el);
      if (now) now.removed = now.removed.filter((p) => !props.includes(p));
    }
    this.push();
  }

  /**
   * 删属性：去掉这些属性在元素上生效的那条声明（Tailwind 删类名，CSS 删声明），页面上预览删掉之后的样子。
   * 只删作者写的声明，继承、初始值和框架预设样式删不了
   */
  private async doRemove(req: EditRequest) {
    const sel = this.state.selection;
    const session = this.session;
    if (!sel || !session || !this.page) return;
    const el = sel.el;
    const declared = req.props.filter((p) => this.plans.get(p)?.view.declared);
    if (!declared.length) {
      this.notify('info', t('ext.remove.nothing'));
      return;
    }
    const utility = (p: string) => {
      const w = this.plans.get(p)?.write;
      return w?.kind === 'tailwind' ? w.utility : null;
    };
    const groups: Array<{ key: string; plan: Plan; props: string[]; classes?: string[] }> = [];
    for (const [tk, g] of this.groupByTarget(el, declared)) {
      const props = [...g.props].sort();
      const w = g.plan.write;
      const classes = w.kind === 'tailwind' ? [...new Set(props.map(utility).filter((u): u is string => !!u))] : undefined;
      if (w.kind === 'tailwind' && w.override) {
        this.notify('warn', t('ext.remove.override'));
        continue;
      }
      groups.push({ key: `${tk}|${props.join(',')}`, plan: g.plan, props, ...(classes ? { classes } : {}) });
    }
    const props = groups.flatMap((g) => g.props);
    if (!props.length) return;
    // 只改（或删）这几个属性里一部分的未应用改动删掉之后就没用了，原值和原来的写法按它们记下的算
    const dropped = this.pendingOn(el).filter((r) => r.props.every((p) => props.includes(p)));
    const before: Record<string, string> = Object.assign({}, ...dropped.map((r) => r.original));
    const was: Record<string, string> = Object.assign({}, ...dropped.map((r) => Object.fromEntries(r.props.map((p) => [p, r.removal?.from?.[p] ?? r.from]))));
    for (const r of dropped) await this.dropRecord(r);
    const fallback = await session.call('fallback', { uid: el.uid, props });
    if (!fallback) return;
    for (const { key, plan: g, props: gp, classes } of groups) {
      const existing = this.journal.findPending(key);
      const previewId = this.previewIdFor(key, existing);
      const values = Object.fromEntries(gp.map((p) => [p, fallback[p] ?? '']));
      const from = Object.fromEntries(gp.map((p) => [p, was[p] ?? this.describeFrom(el, p, g)]));
      const removal = { values, from, ...(classes ? { classes } : {}) };
      const { view, write } = g;
      await session.call('preview', { id: previewId, target: g.preview, decls: removalDecls(g.preview, values) });
      const fields = { value: '', token: null, to: t('panel.change.removed'), expected: values, view, write, removal };
      if (existing) this.journal.update(existing.id, fields);
      else {
        this.journal.add({
          kind: 'style',
          key,
          pageUrl: this.page.url,
          element: recordElement(el),
          props: gp,
          propLabel: groupLabel(gp),
          from: classes?.join(' ') || from[gp[0]],
          original: Object.fromEntries(gp.map((p) => [p, before[p] ?? el.computed[p] ?? ''])),
          preview: g.preview,
          previewId,
          ...fields,
        });
      }
    }
    await this.refreshSelection();
  }

  /** 编辑等预览的时候选中可能已经重建过（热更新换了样式表、刚连上还在读刻度）：改现在这份，换了元素就不改 */
  private selectionOf(el: ElementSnapshot): SelectionView | null {
    const s = this.state.selection;
    return s?.el.uid === el.uid ? s : null;
  }

  /** 改选中元素的第 segment 段文字：live 只预览，commit 记进改动清单；改回原文或清空就撤掉这条改动 */
  editText(segment: number, value: string, phase: 'live' | 'commit'): Promise<void> {
    return this.queue(() => (phase === 'commit' ? this.step(() => this.doEditText(segment, value, phase)) : this.doEditText(segment, value, phase)));
  }

  private async doEditText(segment: number, raw: string, phase: 'live' | 'commit') {
    const sel = this.state.selection;
    const session = this.session;
    const seg = sel?.el.text?.segments[segment];
    const p = this.textPlans.get(segment);
    if (!sel || !session || !this.page || !seg || !p) return;
    const el = sel.el;
    const key = textKey(p, el, segment);
    const existing = this.journal.findPending(key);
    const previewId = this.previewIdFor(key, existing);
    const original = existing?.original.text ?? seg.value;
    const value = oneLine(raw);
    const back = !value || value === oneLine(original);
    if (back) await session.call('clearPreview', { id: previewId });
    else await session.call('preview', { id: previewId, target: p.preview, text: value });
    const view = this.selectionOf(el)?.texts?.find((x) => x.segment === segment);
    if (view) view.value = back ? oneLine(original) : value;
    if (phase === 'commit') {
      if (back) {
        if (existing) this.journal.remove(existing.id);
      } else if (existing) {
        this.journal.update(existing.id, { value, to: value, expected: { text: value }, view: p.view, write: p.write });
      } else {
        this.journal.add({
          kind: 'text',
          key,
          pageUrl: this.page.url,
          element: recordElement(el),
          props: [],
          propLabel: t('panel.change.text'),
          from: oneLine(original),
          to: value,
          value,
          token: null,
          original: { text: original },
          expected: { text: value },
          view: p.view,
          preview: p.preview,
          previewId,
          write: p.write,
          ...(p.code ? { detail: { origin: p.code } } : {}),
        });
      }
      if (view) view.pending = !back;
    }
    this.push();
  }

  /**
   * 把选中元素兄弟组里 uid 所在的那项挪到第 to 个（按现在的顺序）：live 只预览，commit 记进改动清单；
   * 同一组上的换序合并成一条，挪回原来的顺序就撤掉这条改动
   */
  reorder(uid: string, to: number, phase: 'live' | 'commit'): Promise<void> {
    return this.queue(() => (phase === 'commit' ? this.step(() => this.doReorder(uid, to, phase)) : this.doReorder(uid, to, phase)));
  }

  private async doReorder(uid: string, to: number, phase: 'live' | 'commit') {
    const sel = this.state.selection;
    const session = this.session;
    const p = this.orderPlan;
    const info = sel?.el.order;
    if (!sel || !session || !this.page || !p || !info) return;
    const existing = this.journal.findPending(p.key);
    const previewId = this.previewIdFor(p.key, existing);
    // to 是相对现在显示的顺序（可能是还没提交的实时预览）
    const shown = (sel.order?.items ?? []).map((it) => p.units.findIndex((u) => u.uids[0] === it.uid));
    const current = shown.length === p.units.length && shown.every((i) => i >= 0) ? shown : this.currentOrder(p, existing);
    const unit = p.units.findIndex((u) => u.uids.includes(uid));
    if (unit < 0) return;
    const next = current.filter((i) => i !== unit);
    next.splice(Math.max(0, Math.min(next.length, Math.round(to))), 0, unit);
    const back = next.every((v, i) => v === i);
    this.liveOrder = phase === 'live' && !back ? { key: p.key, order: next } : null;
    let affects = 1;
    if (back) await session.call('clearPreview', { id: previewId });
    else affects = (await session.call('preview', { id: previewId, target: p.preview(next) })).count || 1;
    const now = this.selectionOf(sel.el);
    if (now) now.order = this.orderView(p, next, info.index, info.axis, phase === 'commit' ? !back : !!existing);
    if (phase === 'commit') {
      if (back) {
        if (existing) this.journal.remove(existing.id);
      } else {
        const u = p.units[unit];
        const fields = {
          element: {
            label: u.label,
            source: u.source,
            sourceIndex: 0,
            sameSource: 1,
            path: [...sel.el.breadcrumb.slice(0, -1).map((b) => b.label), u.label].join(' > '),
            ...(u.text ? { text: u.text } : {}),
          },
          from: String(unit + 1),
          to: String(next.indexOf(unit) + 1),
          value: JSON.stringify(next),
          expected: { order: next.map((i) => p.units[i].sig).join('\n') },
          view: affects > 1 ? { ...p.view, affects } : p.view,
          preview: p.preview(next),
          write: p.write(next),
          detail: { order: next.map((i) => unitText(p.units[i])), was: p.units.map(unitText) },
        };
        if (existing) this.journal.update(existing.id, fields);
        else {
          this.journal.add({
            kind: 'reorder',
            key: p.key,
            pageUrl: this.page.url,
            props: [],
            propLabel: t('panel.change.order'),
            token: null,
            original: { order: p.units.map((x) => x.sig).join('\n') },
            previewId,
            ...fields,
          });
        }
      }
    }
    this.push();
  }

  /** Tailwind 令牌顺带设置的属性（text-lg 的行高），预览时一起设上，看到的就是应用后的样子 */
  private async companions(write: WriteSpec, props: string[], token: string | null): Promise<Record<string, string>> {
    if (write.kind !== 'tailwind' || token === null || !write.entry) return {};
    const d = await this.tailwind.designFor(write.entry, this.remBase);
    return d ? previewCompanions(d, props, token) : {};
  }

  private describeFrom(el: ElementSnapshot, prop: string, p: Plan): string {
    const w = el.winners[prop];
    if (p.write.kind === 'tailwind') return w?.rule?.utility ?? el.computed[prop] ?? '';
    if (w?.origin === 'rule' && p.write.kind === 'css' && p.write.mode === 'edit') return w.value;
    return el.computed[prop] ?? '';
  }

  private describeTo(p: Plan, req: EditRequest): string {
    if (p.write.kind === 'tailwind' && req.token) return req.token;
    return req.value;
  }

  /** 重置：撤掉选中元素上这些属性的未应用改动 */
  resetProps(props: string[]): Promise<void> {
    return this.reset(() => {
      const el = this.state.selection?.el;
      return el ? this.pendingOn(el).filter((r) => r.props.some((p) => props.includes(p))) : [];
    });
  }

  /** 重置第 segment 段文字 */
  resetText(segment: number): Promise<void> {
    return this.reset(() => {
      const el = this.state.selection?.el;
      const p = this.textPlans.get(segment);
      return el && p ? [this.journal.findPending(textKey(p, el, segment))] : [];
    });
  }

  /** 重置组件的一个属性 */
  resetProp(name: string): Promise<void> {
    return this.reset(() => {
      const el = this.state.selection?.el;
      const p = this.propPlans.get(name);
      return el && p ? [this.journal.findPending(propKey(p, el, name))] : [];
    });
  }

  private reset(pick: () => Array<ChangeRecord | undefined>): Promise<void> {
    return this.queue(() =>
      this.step(async () => {
        const recs = pick().filter((r): r is ChangeRecord => !!r);
        if (!recs.length) return;
        for (const rec of recs) await this.dropRecord(rec);
        await this.sweepSnapshots();
        await this.refreshSelection();
      }),
    );
  }

  /** 改动清单里的「放弃」：等 Agent 还原的是不还原了，回到已应用 */
  discard(id: string): Promise<void> {
    return this.queue(() =>
      this.step(async () => {
        const rec = this.journal.get(id);
        if (!rec) return;
        if (rec.status === 'reverting') {
          this.journal.update(id, { status: 'applied', note: undefined });
          return;
        }
        await this.dropRecord(rec);
        await this.sweepSnapshots();
        if (this.state.selection) {
          for (const p of rec.props) delete this.state.selection.pending[p];
          await this.refreshSelection();
        }
      }),
    );
  }

  /**
   * 新改动的预览 id：同一处还有交给 Agent、预览还挂着的改动时另起一个，免得核对上那条时把这条的预览也撤了。
   * 同一处接着改（实时预览、再提交）要拿到同一个 id
   */
  private previewIdFor(key: string, existing: ChangeRecord | undefined): string {
    if (existing) return existing.previewId;
    const taken = new Set(this.journal.previewing().map((r) => r.previewId));
    let id = key;
    for (let n = 2; taken.has(id); n++) id = `${key}#${n}`;
    return id;
  }

  /** 撤掉一条改动：去掉页面上的预览，移出清单 */
  private async dropRecord(rec: ChangeRecord) {
    await this.session?.call('clearPreview', { id: rec.previewId }).catch(() => undefined);
    this.journal.remove(rec.id);
  }

  /** 上一步 */
  undo(): Promise<void> {
    return this.queue(() => this.replay('undo'));
  }

  /** 下一步 */
  redo(): Promise<void> {
    return this.queue(() => this.replay('redo'));
  }

  /** 把这一步动到的未应用改动放回之前（重做是之后）的样子，页面上的预览和面板跟着变 */
  private async replay(kind: 'undo' | 'redo') {
    const state = this.history.take(kind, (key) => this.journal.findPending(key));
    if (!state) return;
    this.stepping++;
    try {
      for (const [key, rec] of state) await this.restoreRecord(key, rec);
    } finally {
      this.stepping--;
      this.syncHistory();
    }
    this.liveOrder = null;
    await this.sweepSnapshots();
    await this.refreshSelection();
    this.push();
  }

  /** 把 key 这条未应用改动换成 rec 记下的样子（null 是撤掉）；同一 id 的预览会合并声明，先撤掉再重新挂 */
  private async restoreRecord(key: string, rec: ChangeRecord | null) {
    const cur = this.journal.findPending(key);
    if (cur) await this.session?.call('clearPreview', { id: cur.previewId }).catch(() => undefined);
    if (cur && (!rec || cur.id !== rec.id)) this.journal.remove(cur.id);
    if (!rec) return;
    const copy = structuredClone(rec);
    this.journal.put(copy);
    await this.showPreview(copy);
  }

  /** 重新取一次选中元素的快照（预览变化后计算值会变） */
  async refreshSelection() {
    if (!this.session?.connected) return;
    const el = await this.session.call('snapshot', {}).catch(() => null);
    if (el) {
      this.state.selection = this.buildSelection(el);
      this.push();
    }
  }

  async openSource(file: string, line: number, column: number) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(pos, pos),
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
  }

  records(): ChangeRecord[] {
    return this.journal.all();
  }

  private sweepSnapshots() {
    return this.applier.snapshots.sweep(new Set(this.journal.all().map((r) => r.id)));
  }

  dispose() {
    void this.session?.detach();
    this.disposeSession();
    this.server.dispose();
    this.staticServer.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
