import { describe, expect, it, vi } from 'vitest';
import type { PanelState } from '@css-tuner/protocol';
import { FontService, readLocalFonts, tidyFamilies, type FontHost } from '../src/fonts';

function host(page: string[] | Error) {
  const logs: string[] = [];
  const call = vi.fn(async () => {
    if (page instanceof Error) throw page;
    return page;
  });
  const h = { state: { fonts: null } as unknown as PanelState, session: { call }, push: vi.fn(), log: (m: string) => logs.push(m) };
  return { h, call, logs, as: h as unknown as FontHost };
}

describe('本机字体', () => {
  it('去掉空的和系统隐藏的，不分大小写去重，按名字排', () => {
    expect(tidyFamilies(['Zapfino', '', '  Arial ', '.SF NS', 'arial', 'PingFang SC', 'Avenir Next'])).toEqual(['Arial', 'Avenir Next', 'PingFang SC', 'Zapfino']);
  });

  it.runIf(process.platform === 'darwin')('macOS 上问 AppKit 读得到', async () => {
    const fonts = await readLocalFonts('darwin');
    expect(fonts.length).toBeGreaterThan(20);
    expect(fonts).toContain('Helvetica');
  });
});

describe('字体菜单的候选', () => {
  it('打开时取页面字体、读本机字体；读过的一分钟内不重读，页面字体每次都取', async () => {
    const { h, call, as } = host(['Inter']);
    const read = vi.fn(async () => ['Inter', 'PingFang SC']);
    const fonts = new FontService(as, read);
    await fonts.open();
    await vi.waitFor(() => expect(h.state.fonts?.local).toEqual(['Inter', 'PingFang SC']));
    expect(h.state.fonts?.page).toEqual(['Inter']);
    await fonts.open();
    expect(read).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('只装在本机、页面没有加载的字体才要跟 Agent 说', async () => {
    const { h, as } = host(['Inter']);
    const fonts = new FontService(as, async () => ['Inter', 'PingFang SC']);
    expect(fonts.localOnly('"PingFang SC"')).toBeNull();
    await fonts.open();
    await vi.waitFor(() => expect(h.state.fonts?.local).not.toBeNull());
    expect(fonts.localOnly('"PingFang SC", sans-serif')).toBe('PingFang SC');
    expect(fonts.localOnly('"pingfang sc"')).toBe('PingFang SC');
    expect(fonts.localOnly('Inter')).toBeNull();
    expect(fonts.localOnly('sans-serif')).toBeNull();
    expect(fonts.localOnly('"Comic Neue"')).toBeNull();
  });

  it('读不到本机字体：标上 failed、记日志，页面字体照样有', async () => {
    const { h, logs, as } = host(['Inter']);
    const fonts = new FontService(as, async () => {
      throw new Error('spawn fc-list ENOENT');
    });
    await fonts.open();
    await vi.waitFor(() => expect(h.state.fonts?.failed).toBe(true));
    expect(h.state.fonts).toEqual({ page: ['Inter'], local: [], failed: true });
    expect(logs.some((l) => l.includes('fc-list'))).toBe(true);
  });

  it('页面字体取不到时留着上次的', async () => {
    const { h, as } = host(new Error('timeout'));
    h.state.fonts = { page: ['Inter'], local: ['Arial'] };
    await new FontService(as, async () => ['Arial']).open();
    expect(h.state.fonts.page).toEqual(['Inter']);
  });
});
