import { useCallback, useEffect, useState } from 'react';
import { getLocale, setLocale, t, type PanelState, type PanelToExt, type PropValue } from '@css-tuner/protocol';
import type { Host } from './host';
import { ChangeList, ElementHeader, NoticeBar, Toolbar } from './components/Chrome';
import { Inspector, type UiPrefs } from './components/Inspector';
import { Structure } from './components/Structure';
import type { Edit } from './components/types';

function loadPrefs(host: Host): UiPrefs {
  const p = host.load<UiPrefs>('prefs', { closed: ['position', 'changes', 'assets'], split: [], v: 2 });
  const v = p.v ?? 0;
  if (v >= 2) return p;
  const add = [...(v < 1 ? ['changes'] : []), 'assets'];
  return { ...p, closed: [...new Set([...p.closed, ...add])], v: 2 };
}

export function App({ host }: { host: Host }) {
  const [state, setState] = useState<PanelState | null>(null);
  const [prefs, setPrefsState] = useState<UiPrefs>(() => loadPrefs(host));

  useEffect(() => {
    const off = host.subscribe((s) => {
      if (s.locale) {
        if (s.locale !== getLocale()) setLocale(s.locale);
        document.documentElement.lang = s.locale;
      }
      setState(s);
    });
    host.send({ t: 'ready' });
    return off;
  }, [host]);

  const send = useCallback((m: PanelToExt) => host.send(m), [host]);
  const setPrefs = useCallback(
    (p: UiPrefs) => {
      setPrefsState(p);
      host.save('prefs', p);
    },
    [host],
  );
  const edit = useCallback((props: string[], e: Edit) => host.send({ t: 'edit', edit: { ...e, props } }), [host]);
  const editText = useCallback((segment: number, value: string, phase: 'live' | 'commit') => host.send({ t: 'editText', segment, value, phase }), [host]);
  const editProp = useCallback((name: string, value: PropValue, phase: 'live' | 'commit') => host.send({ t: 'editProp', name, value, phase }), [host]);

  // ⌘Z / ⇧⌘Z（Windows、Linux 上 Ctrl+Z / Ctrl+Shift+Z、Ctrl+Y）：输入框里留给输入框自己撤销
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.shiftKey);
      if (!redo && !(k === 'z' && !e.shiftKey)) return;
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      host.send({ t: redo ? 'redo' : 'undo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [host]);

  if (!state) return <div className="boot">{t('panel.boot')}</div>;
  const sel = state.selection;
  const connected = state.connection === 'connected';
  const toggleClosed = (id: string) => setPrefs({ ...prefs, closed: prefs.closed.includes(id) ? prefs.closed.filter((x) => x !== id) : [...prefs.closed, id] });

  return (
    <div className="app">
      <Toolbar state={state} send={send} />
      <ChangeList state={state} send={send} open={!prefs.closed.includes('changes')} onToggle={() => toggleClosed('changes')} />
      <NoticeBar state={state} send={send} />
      <main className="main">
        {!connected && state.connection !== 'opening' && (
          <div className="empty">
            <p>{t('panel.empty.open')}</p>
            <p className="muted">{t('panel.empty.support')}</p>
          </div>
        )}
        {state.connection === 'opening' && <div className="empty muted">{t('panel.opening')}</div>}
        {connected && !sel && (
          <div className="empty">
            <p>{t('panel.empty.pick')}</p>
            <p className="muted">{t('panel.empty.stop')}</p>
          </div>
        )}
        {connected && sel && (
          <>
            <ElementHeader state={state} sel={sel} send={send} />
            <Structure
              sel={sel}
              send={send}
              open={!prefs.closed.includes('tree')}
              onToggle={toggleClosed}
              onlyComponents={prefs.split.includes('tree-components')}
              setOnlyComponents={(on) => setPrefs({ ...prefs, split: on ? [...prefs.split, 'tree-components'] : prefs.split.filter((x) => x !== 'tree-components') })}
            />
            <Inspector state={state} sel={sel} prefs={prefs} setPrefs={setPrefs} edit={edit} editText={editText} editProp={editProp} send={send} />
          </>
        )}
      </main>
    </div>
  );
}
