import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { t } from '@css-tuner/protocol';
import type { Controller } from './controller';
import type { ChangeRecord } from './journal';
import { prefill } from './handoff';

export const SCHEME = 'css-tuner';

/** 工作区里的文件变了之后隔多久核对：热更新一般几百毫秒到一两秒，大一些的 Next 项目里服务端组件要好几秒 */
const AFTER_CHANGE = [300, 1000, 2500, 6000];
/** 页面重新连上（多半是改的文件让开发服务器整页刷新了）、样式表变了之后 */
const AFTER_HELLO = [500, 2500];
/** 没看到文件变化时也隔一会儿核对一次：Agent 改的文件可能在工作区外，或者被监听漏掉 */
const POLL_MS = 4000;
/** 构建产物和依赖的变化不算 Agent 改了代码 */
const IGNORED = /[\\/](node_modules|\.git|dist|\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.cache|coverage)[\\/]/;

const hash = (s: string) => createHash('sha1').update(s).digest('hex');

function readDisk(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const shortValues = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `${k}: ${x}`)
    .join('; ');

/** 第一次交给 Agent 前的文件内容，存在扩展的工作区存储里，是「对比」视图的左侧 */
export class SnapshotStore implements vscode.TextDocumentContentProvider {
  private readonly dir: vscode.Uri;

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(ctx.storageUri ?? ctx.globalStorageUri, 'snapshots');
  }

  private fileOf(id: string) {
    return vscode.Uri.joinPath(this.dir, `${id}.txt`);
  }

  async save(id: string, text: string) {
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(this.fileOf(id), Buffer.from(text, 'utf8'));
  }

  async load(id: string): Promise<string | null> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(this.fileOf(id))).toString('utf8');
    } catch {
      return null;
    }
  }

  /** 删掉已不在改动清单里的快照 */
  async sweep(keep: Set<string>) {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.dir);
    } catch {
      return;
    }
    for (const [name] of entries) {
      const id = name.replace(/\.txt$/, '');
      if (!keep.has(id)) await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, name)).then(undefined, () => undefined);
    }
  }

  uri(id: string, file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/before/${id}/${basename(file)}` });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, , id] = uri.path.split('/');
    return (await this.load(id)) ?? t('apply.snapshotGone');
  }
}

/**
 * 应用和还原都交给 Agent：把改动整理成提示词预填进新的 Agent 对话，由用户按回车发送。
 * 交出去的改动预览留在页面上，Agent 改了文件、页面热更新后读预览底下源码给的值来核对，对上了才撤预览
 */
export class Applier implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** 文件变化、页面变化各自排的几次核对，再来一次就重排 */
  private readonly timers = new Map<'file' | 'page', ReturnType<typeof setTimeout>[]>();
  /** 最近一次看到工作区里的文件变化 */
  private changedAt = 0;
  /** 变过、还没让页面重新加载的 CSS 文件（没有热更新的页面用） */
  private readonly css = new Set<string>();
  private running: Promise<void> | null = null;
  /** 核对途中又要核对一轮：记下这一轮要不要切到别的档 */
  private queued: boolean | null = null;

  constructor(
    private readonly c: Controller,
    readonly snapshots: SnapshotStore,
  ) {}

  /**
   * 应用：不给 ids 是全部未应用的；给了 ids 时还在等 Agent 改的再发一次（上一次没发出去、或者没改对）。
   * dry 只整理提示词、不碰 Agent 对话和剪贴板（自测用）
   */
  async apply(ids?: string[], opts: { dry?: boolean } = {}): Promise<string | null> {
    const c = this.c;
    const recs = (ids ? ids.map((id) => c.journal.get(id)) : c.journal.pending())
      .filter((r): r is ChangeRecord => !!r && (r.status === 'pending' || r.status === 'handoff'))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!recs.length) {
      c.notify('info', t('ext.apply.none'));
      return null;
    }
    const prompt = c.handoffPrompt(recs, 'apply');
    const how = opts.dry ? null : await prefill(prompt);
    const sentAt = Date.now();
    for (const rec of recs) {
      const snapshot = rec.snapshot ?? (await this.snapshot(rec));
      c.journal.update(rec.id, { status: 'handoff', sentAt, note: undefined, ...(snapshot ? { snapshot } : {}) });
    }
    c.log(t('apply.sentLog', { n: recs.length }));
    if (how) c.notify('info', t(how === 'clipboard' ? 'ext.apply.clipboard' : 'ext.apply.prefilled', { n: recs.length }));
    this.track();
    return prompt;
  }

  /** 还原：交给 Agent 把代码改回原样，页面上核对上原值后标成已还原 */
  async revert(id: string, opts: { dry?: boolean } = {}): Promise<string | null> {
    const c = this.c;
    const rec = c.journal.get(id);
    if (!rec || (rec.status !== 'applied' && rec.status !== 'reverting')) return null;
    const prompt = c.handoffPrompt([rec], 'revert');
    const how = opts.dry ? null : await prefill(prompt);
    c.journal.update(id, { status: 'reverting', sentAt: Date.now(), note: undefined });
    if (how) c.notify('info', t(how === 'clipboard' ? 'ext.revert.clipboard' : 'ext.revert.prefilled'));
    this.track();
    return prompt;
  }

  /** 对比：第一次交给 Agent 之前的文件 ↔ 现在 */
  async diff(id: string) {
    const c = this.c;
    const snap = c.journal.get(id)?.snapshot;
    if (!snap) {
      c.notify('info', t('diff.none'));
      return;
    }
    const now = readDisk(snap.file);
    if (now !== null && hash(now) === snap.hash) {
      c.notify('info', t('diff.unchanged', { file: basename(snap.file) }));
      return;
    }
    const title = t('diff.beforeNow', { file: basename(snap.file) });
    await vscode.commands.executeCommand('vscode.diff', this.snapshots.uri(id, snap.file), vscode.Uri.file(snap.file), title, { preview: true });
  }

  /** 存下改动所在文件现在的样子；改动没有落在某个文件上（找不到源码位置）时不存 */
  private async snapshot(rec: ChangeRecord): Promise<ChangeRecord['snapshot']> {
    const file = 'file' in rec.write ? rec.write.file : rec.view.file;
    const text = file ? readDisk(file) : null;
    if (!file || text === null) return undefined;
    await this.snapshots.save(rec.id, text);
    return { file, hash: hash(text) };
  }

  /** 有在等 Agent 的改动时盯着工作区里的文件变化、定时核对，都等完了就停 */
  track() {
    const waiting = this.c.journal.waiting().length > 0;
    if (waiting && !this.watcher) {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
      const on = (uri: vscode.Uri) => this.changed(uri);
      this.watcher.onDidChange(on);
      this.watcher.onDidCreate(on);
      this.watcher.onDidDelete(on);
      this.poll = setInterval(() => void this.probe(false), POLL_MS);
    } else if (!waiting && this.watcher) {
      this.stop();
    }
  }

  /** 页面重新连上、换了页面、样式表变了（热更新）：过一会儿核对（不切档：切宽度本身也会让页面变） */
  soon() {
    if (this.c.journal.waiting().length) this.schedule('page', AFTER_HELLO, false);
  }

  private changed(uri: vscode.Uri) {
    if (uri.scheme !== 'file' || IGNORED.test(uri.fsPath)) return;
    this.changedAt = Date.now();
    if (/\.css$/i.test(uri.fsPath)) this.css.add(uri.fsPath);
    this.schedule('file', AFTER_CHANGE, true);
  }

  /** 按这几个时间点核对；settle：最后一次时文件已经改完一阵了，切到别的档核对、核对不了的也给个结果 */
  private schedule(kind: 'file' | 'page', delays: number[], settle: boolean) {
    for (const timer of this.timers.get(kind) ?? []) clearTimeout(timer);
    this.timers.set(
      kind,
      delays.map((ms, i) => setTimeout(() => void this.probe(settle && i === delays.length - 1), ms)),
    );
  }

  private stop() {
    this.watcher?.dispose();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const list of this.timers.values()) for (const timer of list) clearTimeout(timer);
    this.timers.clear();
  }

  /** 核对一轮在等 Agent 的改动；settled：文件改完一阵了 */
  probe(settled: boolean): Promise<void> {
    if (this.running) {
      this.queued = (this.queued ?? false) || settled;
      return this.running;
    }
    this.running = this.pass(settled)
      .catch((e) => this.c.log(String(e)))
      .finally(() => {
        this.running = null;
        const next = this.queued;
        this.queued = null;
        if (next !== null) void this.probe(next);
      });
    return this.running;
  }

  private async pass(settled: boolean) {
    const c = this.c;
    const page = c.page;
    if (!c.session?.connected || !page) return;
    await this.reloadSheets();
    const recs = c.journal.waiting().filter((r) => c.samePage(r.pageUrl, page.url));
    if (!recs.length) return;
    let done = 0;
    for (const rec of recs) if (await this.check(rec, settled)) done++;
    if (done) {
      c.log(t('apply.matchedLog', { n: done }));
      await c.refreshSelection();
    }
    this.track();
  }

  /** 核对一条：对上了标成已应用 / 已还原；没对上、预览又掉了（元素被重建、样式表被换掉）就重新挂上 */
  private async check(rec: ChangeRecord, settled: boolean): Promise<boolean> {
    const c = this.c;
    const back = rec.status === 'reverting';
    const expected = back ? this.revertExpected(rec) : rec.expected;
    const touched = this.changedAt > (rec.sentAt ?? 0);
    const finish = (note?: string) => c.journal.update(rec.id, { status: back ? 'reverted' : 'applied', note });
    if (!expected || !Object.keys(expected).length) {
      // 页面上没有能比的值：文件改完一阵了就当作改好了，请用户自己看一眼
      if (!settled || !touched) return false;
      if (!back) await c.session?.call('clearPreview', { id: rec.previewId }).catch(() => undefined);
      finish(t('apply.unchecked'));
      return true;
    }
    const src = rec.element.source;
    const r = await c.session
      ?.call(
        'probe',
        {
          id: rec.previewId,
          target: rec.preview,
          expected,
          source: src ? { path: src.path, line: src.line, column: src.column, index: rec.element.sourceIndex } : undefined,
        },
        8000,
      )
      .catch(() => null);
    // 核对途中被放弃、重新发过
    if (!r || c.journal.get(rec.id)?.status !== rec.status) return false;
    if (r.ok) {
      finish();
      return true;
    }
    if (!back && !r.attached && (r.found || rec.preview.kind === 'rule')) {
      // 同一处后来又改了的也重新挂一遍，盖在这条上面
      const above = c.journal.previewing().filter((x) => x.key === rec.key && x.createdAt > rec.createdAt);
      for (const x of [rec, ...above.reverse()]) await c.showPreview(x);
    }
    const actual = shortValues(r.actual);
    if (settled && touched && actual) c.journal.update(rec.id, { note: t('apply.still', { actual }) });
    return false;
  }

  /**
   * 还原后要核对的原值。描边样式是 none 时粗细总算成 0：同一处改描边样式的那条还生效着，
   * 还原粗细后页面上是这个样式的默认粗细，和记下的原值对不上，这几边的粗细不核对
   */
  private revertExpected(rec: ChangeRecord): Record<string, string> {
    const target = (r: ChangeRecord) => r.key.slice(0, r.key.lastIndexOf('|'));
    const live = new Set(
      this.c.journal
        .all()
        .filter((r) => r.id !== rec.id && target(r) === target(rec) && (r.status === 'applied' || r.status === 'reverting'))
        .flatMap((r) => r.props),
    );
    return Object.fromEntries(Object.entries(rec.original).filter(([p]) => !/^border-\w+-width$/.test(p) || !live.has(p.replace(/width$/, 'style'))));
  }

  /** 没有热更新的页面（内置静态服务、普通文件服务）：让改过的 CSS 对应的 <link> 重新加载 */
  private async reloadSheets() {
    const s = this.c.session;
    if (!s?.connected || !this.css.size) return;
    const hrefs = [...this.css].map((f) => this.c.urlForFile(f)).filter((u): u is string => !!u);
    this.css.clear();
    if (hrefs.length) await s.call('reloadSheets', { hrefs }).catch(() => 0);
  }

  dispose() {
    this.stop();
  }
}
