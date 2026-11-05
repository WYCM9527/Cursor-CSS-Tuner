import { execFile } from 'node:child_process';
import { isGenericFamily, primaryFamily, type PanelState } from '@css-tuner/protocol';
import type { PageSession } from './session';

/** macOS：AppKit 的字体管理器列出装了的字体族（osascript 跑 JXA，系统自带） */
const MAC_SCRIPT = 'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))';
/** Windows：.NET 的 InstalledFontCollection；输出换成 UTF-8，中文字体名才不乱码 */
const WIN_SCRIPT =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';
/** 读过超过这么久，打开菜单时在后台重读一次（刚装的字体） */
const STALE_MS = 60_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** 去掉空的和系统隐藏的（. 开头），不分大小写去重，按名字排序 */
export function tidyFamilies(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const n = raw.trim();
    if (!n || n.startsWith('.')) continue;
    const k = n.toLowerCase();
    if (!seen.has(k)) seen.set(k, n);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** 这台电脑装的字体族名：macOS 问 AppKit，Windows 问 .NET，其余用 fontconfig 的 fc-list */
export async function readLocalFonts(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === 'darwin') return tidyFamilies(JSON.parse(await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT])) as string[]);
  if (platform === 'win32') return tidyFamilies((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT])).split(/\r?\n/));
  return tidyFamilies((await run('fc-list', ['--format', '%{family[0]}\\n'])).split('\n'));
}

export interface FontHost {
  readonly session: PageSession | null;
  readonly state: PanelState;
  push(): void;
  log(msg: string): void;
}

/** 字体菜单的候选：页面加载的字体每次打开菜单都重新取，本机字体读一次后先用读到的，旧了在后台重读 */
export class FontService {
  private reading: Promise<void> | null = null;
  private readAt = 0;

  constructor(
    private readonly host: FontHost,
    private readonly read: () => Promise<string[]> = readLocalFonts,
  ) {}

  async open(): Promise<void> {
    const view = (this.host.state.fonts ??= { page: [], local: null });
    if (!this.reading && Date.now() - this.readAt > STALE_MS) this.reading = this.readLocal();
    const session = this.host.session;
    if (session) {
      try {
        view.page = await session.call('fonts', {});
      } catch (e) {
        this.host.log(`读页面字体失败：${(e as Error).message}`);
      }
    }
    this.host.push();
  }

  private async readLocal(): Promise<void> {
    const view = this.host.state.fonts!;
    try {
      view.local = await this.read();
      view.failed = undefined;
    } catch (e) {
      this.host.log(`读本机字体失败：${(e as Error).message}`);
      if (!view.local) {
        view.local = [];
        view.failed = true;
      }
    } finally {
      this.readAt = Date.now();
      this.reading = null;
      this.host.push();
    }
  }

  /** 首选的字体只装在这台电脑上、页面没有加载它时返回字体名（给 Agent 的说明） */
  localOnly(value: string): string | null {
    const fonts = this.host.state.fonts;
    const name = primaryFamily(value);
    if (!fonts?.local || !name || isGenericFamily(name)) return null;
    const k = name.toLowerCase();
    if (fonts.page.some((f) => f.toLowerCase() === k)) return null;
    return fonts.local.find((f) => f.toLowerCase() === k) ?? null;
  }
}
