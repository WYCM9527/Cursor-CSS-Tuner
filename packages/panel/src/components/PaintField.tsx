import { useEffect, useRef, useState, type ReactNode } from 'react';
import { angleDir, colorAt, effectiveInterp, formatGradient, gradientAngle, parseColor, stopPositions, t, type Gradient, type GradientStop, type ScaleStep, type Target } from '@css-tuner/protocol';
import { varName } from '../lib/format';
import { kindOf, pinInterp, type Paint, type PaintKind } from '../lib/paint';
import { ColorEditor, hexOf, matchStep, resolveColor } from './ColorField';
import { agentHint } from './controls';
import type { Edit } from './types';

export interface PaintFieldProps {
  title: string;
  paint: Paint;
  steps: ScaleStep[] | null;
  pending: boolean;
  target?: Target;
  /** 纯色时源码里写的变量名 */
  declared?: string | null;
  corner?: ReactNode;
  /** 字段下面的一句说明 */
  note?: string | null;
  /** 不是 Tailwind 项目：点页面变量的色块时颜色点写成 var(--x) */
  cssVars?: boolean;
  onSolid: (e: Edit) => void;
  onGradient: (g: Gradient, phase: 'live' | 'commit') => void;
  onKind: (kind: PaintKind) => void;
}

const KINDS: PaintKind[] = ['solid', 'linear', 'radial'];

/** 颜色点的颜色换成面板里画得出来的（页面变量换成刻度里记下的值） */
const shownGradient = (g: Gradient, steps: ScaleStep[] | null): Gradient => ({ ...g, stops: g.stops.map((s) => ({ ...s, color: resolveColor(s.color, steps) })) });

export function PaintField(p: PaintFieldProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cf${p.pending ? ' is-pending' : ''}`}>
      <button className="cf-row" onClick={() => setOpen((v) => !v)} title={tip(p)} aria-expanded={open}>
        <PaintRow paint={p.paint} steps={p.steps} declared={p.declared ?? null} />
      </button>
      {p.corner}
      {p.note && <div className="cf-note">{p.note}</div>}
      {open && <PaintPicker {...p} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PaintRow({ paint, steps, declared }: { paint: Paint; steps: ScaleStep[] | null; declared: string | null }) {
  if (paint.kind === 'solid') {
    const shown = resolveColor(paint.color, steps);
    const label = varName(paint.color) ?? declared ?? matchStep(steps, shown)?.label ?? hexOf(shown);
    return (
      <>
        <span className="swatch" style={{ ['--c' as string]: shown }} />
        <span className="cf-label">{label}</span>
        {label !== hexOf(shown) && parseColor(shown) && <span className="cf-hex">{hexOf(shown)}</span>}
      </>
    );
  }
  if (paint.kind === 'gradient') {
    const g = paint.gradient;
    const angle = gradientAngle(g);
    return (
      <>
        <span className="swatch is-gradient" style={{ ['--g' as string]: formatGradient(shownGradient(g, steps)) }} />
        <span className="cf-label">{t(g.type === 'radial' ? 'paint.radialName' : 'paint.linearName')}</span>
        {angle !== null && <span className="cf-hex">{Math.round(angle)}°</span>}
      </>
    );
  }
  return (
    <>
      <span className="swatch is-image" />
      <span className="cf-label">{t('paint.imageName')}</span>
    </>
  );
}

function tip(p: PaintFieldProps): string {
  const lines = [p.title];
  if (p.target) {
    const affects = p.target.affects > 1 ? t('common.paren', { text: t('field.affects', { n: p.target.affects }) }) : '';
    lines.push(`${t('field.writeTo', { label: p.target.label })}${affects}`);
    const why = agentHint(p.target);
    if (why) lines.push(why);
  }
  if (p.paint.kind === 'complex') lines.push(t('paint.complex'));
  return lines.join('\n');
}

interface Send {
  live: () => void;
  commit: () => void;
}

/** 颜料弹出层：顶上切换纯色 / 线性 / 径向，下面是取色器或渐变编辑；点外面收起时提交，Esc 撤回只改过的纯色 */
function PaintPicker(p: PaintFieldProps & { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const startKind = useRef(kindOf(p.paint));
  const initialColor = useRef(p.paint.kind === 'solid' ? p.paint.color : null);
  const changed = useRef(false);
  // 拖动时的预览按帧合并；最后一下还没提交的，收起或切换类型时补上
  const last = useRef<Send | null>(null);
  const raf = useRef(0);
  const cancel = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };
  const live = (s: Send) => {
    changed.current = true;
    last.current = s;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      last.current?.live();
    });
  };
  const commit = (run: () => void) => {
    changed.current = true;
    cancel();
    last.current = null;
    run();
  };
  const flush = () => {
    cancel();
    const s = last.current;
    last.current = null;
    s?.commit();
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node) && !(e.target as Element).closest?.('.cf-row')) {
        flush();
        p.onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (startKind.current === 'solid' && p.paint.kind === 'solid' && initialColor.current !== null && changed.current) {
        cancel();
        last.current = null;
        p.onSolid({ props: [], value: initialColor.current, token: null, phase: 'commit' });
      } else flush();
      p.onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });

  const kind = kindOf(p.paint);
  const solid = (value: string, token: string | null, phase: 'live' | 'commit') => {
    if (phase === 'commit') commit(() => p.onSolid({ props: [], value, token, phase: 'commit' }));
    else live({ live: () => p.onSolid({ props: [], value, token: null, phase: 'live' }), commit: () => p.onSolid({ props: [], value, token: null, phase: 'commit' }) });
  };
  const gradient = (g: Gradient, phase: 'live' | 'commit') => {
    if (phase === 'commit') commit(() => p.onGradient(g, 'commit'));
    else live({ live: () => p.onGradient(g, 'live'), commit: () => p.onGradient(g, 'commit') });
  };

  return (
    <div className="picker" ref={root}>
      <div className="seg paint-kind" role="radiogroup" aria-label={p.title}>
        {KINDS.map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? 'on' : ''}
            title={t(`paint.${k}.title`)}
            onClick={() => {
              if (k === kind) return;
              flush();
              changed.current = true;
              p.onKind(k);
            }}
          >
            {t(`paint.${k}`)}
          </button>
        ))}
      </div>
      {p.paint.kind === 'solid' && (
        <ColorEditor key="solid" value={resolveColor(p.paint.color, p.steps)} steps={p.steps} onPick={solid} onHover={(v) => p.onSolid({ props: [], value: v, token: null, phase: 'live' })} />
      )}
      {p.paint.kind === 'gradient' && <GradientEditor gradient={p.paint.gradient} steps={p.steps} cssVars={!!p.cssVars} onChange={gradient} onPreview={(g) => p.onGradient(g, 'live')} />}
      {p.paint.kind === 'complex' && <div className="paint-note">{t('paint.complex')}</div>}
    </div>
  );
}

/** 每个颜色点都写上位置：没写的按 CSS 的规则补齐，拖动、加点时才有准确的起点 */
function explicit(g: Gradient): Gradient {
  const ps = stopPositions(g.stops);
  return { ...g, stops: g.stops.map((s, i) => ({ ...s, pos: Math.round(ps[i] * 100) / 100 })) };
}

interface GradientEditorProps {
  gradient: Gradient;
  steps: ScaleStep[] | null;
  cssVars: boolean;
  onChange: (g: Gradient, phase: 'live' | 'commit') => void;
  /** 悬停色块的临时预览，不算改动 */
  onPreview: (g: Gradient) => void;
}

/** 渐变编辑：渐变条上点一下加颜色点、拖动改位置；选中的颜色点改颜色和位置，线性渐变还能改角度 */
function GradientEditor({ gradient, steps, cssVars, onChange, onPreview }: GradientEditorProps) {
  const [g, setG] = useState(() => explicit(gradient));
  const [sel, setSel] = useState(0);
  // 拖动时事件很密，处理函数读这份最新的，不等重新渲染
  const cur = useRef(g);
  const drag = useRef<{ stop: GradientStop; moved: boolean } | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  // 外面的渐变变了（撤销、换元素、扩展回传）且没在拖动时跟上
  const text = formatGradient(gradient);
  useEffect(() => {
    if (drag.current) return;
    const next = explicit(gradient);
    if (formatGradient(next) === formatGradient(cur.current)) return;
    cur.current = next;
    setG(next);
    setSel((i) => Math.min(i, next.stops.length - 1));
  }, [text]);

  const emit = (next: Gradient, phase: 'live' | 'commit') => {
    const pinned = pinInterp(cur.current, next);
    cur.current = pinned;
    setG(pinned);
    onChange(pinned, phase);
  };
  /** 颜色点按位置排好，选中跟着 focus 那个点走 */
  const ordered = (stops: GradientStop[], focus: GradientStop | null): Gradient => {
    const out = [...stops].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    if (focus) setSel(out.indexOf(focus));
    return { ...cur.current, stops: out };
  };
  const posAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  const moveStop = (stop: GradientStop, pos: number, phase: 'live' | 'commit') => {
    const moved = { ...stop, pos };
    emit(ordered(cur.current.stops.map((s) => (s === stop ? moved : s)), moved), phase);
    return moved;
  };
  const removeStop = (i: number) => {
    if (cur.current.stops.length <= 2) return;
    const stops = cur.current.stops.filter((_, j) => j !== i);
    setSel(Math.min(i, stops.length - 1));
    emit({ ...cur.current, stops }, 'commit');
  };

  const shown = shownGradient(g, steps);
  const barCss = formatGradient({ type: 'linear', repeating: false, dir: 'to right', interp: effectiveInterp(shown), stops: shown.stops });
  const stop = g.stops[sel] ?? g.stops[0];
  const angle = gradientAngle(g);

  const setColor = (value: string, token: string | null, phase: 'live' | 'commit') => {
    const color = cssVars && token?.startsWith('--') ? `var(${token})` : value;
    emit({ ...cur.current, stops: cur.current.stops.map((s, j) => (j === sel ? { ...s, color } : s)) }, phase);
  };

  return (
    <>
      {angle !== null && (
        <div className="grad-row">
          <NumInput label={t('grad.angle')} title={t('grad.angle.title')} unit="°" value={Math.round(angle)} onCommit={(n) => emit({ ...cur.current, dir: angleDir(n) }, 'commit')} />
          <button className="icon-btn" title={t('grad.rotate')} aria-label={t('grad.rotate')} onClick={() => emit({ ...cur.current, dir: angleDir((gradientAngle(cur.current) ?? 180) + 90) }, 'commit')}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.5 6.5A5 5 0 1 0 13 9.5" />
              <path d="M13 3v3.5H9.5" />
            </svg>
          </button>
        </div>
      )}
      <div
        className="gbar"
        ref={bar}
        style={{ ['--g' as string]: barCss }}
        title={t('grad.bar.title')}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const i = Number((e.target as HTMLElement).dataset.stop);
          if (Number.isInteger(i) && cur.current.stops[i]) {
            setSel(i);
            drag.current = { stop: cur.current.stops[i], moved: false };
            return;
          }
          // 点在空白处：在这里加一个颜色点，颜色取渐变在这个位置的颜色，按住还能接着拖
          const pos = posAt(e.clientX);
          const color = colorAt(shownGradient(cur.current, steps), pos) ?? cur.current.stops[0].color;
          const added = { color, pos };
          emit(ordered([...cur.current.stops, added], added), 'commit');
          drag.current = { stop: added, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const pos = posAt(e.clientX);
          if (pos === d.stop.pos) return;
          drag.current = { stop: moveStop(d.stop, pos, 'live'), moved: true };
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) emit(cur.current, 'commit');
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) emit(cur.current, 'commit');
        }}
      >
        {g.stops.map((s, i) => (
          <button
            key={i}
            data-stop={i}
            className={`gstop${i === sel ? ' on' : ''}`}
            style={{ left: `${s.pos ?? 0}%`, ['--c' as string]: resolveColor(s.color, steps) }}
            title={t('grad.stop.title', { n: i + 1, color: hexOf(resolveColor(s.color, steps)), pos: `${s.pos ?? 0}%` })}
            aria-pressed={i === sel}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') removeStop(i);
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
                moveStop(cur.current.stops[i], Math.min(100, Math.max(0, (cur.current.stops[i].pos ?? 0) + d)), 'commit');
              }
            }}
          />
        ))}
      </div>
      <div className="grad-row">
        <NumInput label={t('grad.stop.pos')} title={t('grad.stop.pos.title')} unit="%" value={stop.pos ?? 0} min={0} max={100} onCommit={(n) => moveStop(cur.current.stops[sel], n, 'commit')} />
        <button className="icon-btn" title={t('grad.stop.remove')} aria-label={t('grad.stop.remove')} disabled={g.stops.length <= 2} onClick={() => removeStop(sel)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M3.5 8h9" />
          </svg>
        </button>
      </div>
      <ColorEditor
        key={`${sel}:${g.stops.length}`}
        value={resolveColor(stop.color, steps)}
        steps={steps}
        onPick={(v, token, phase) => {
          // 移开色块换回原来的颜色：只预览，不算改动
          if (phase === 'live' && v === resolveColor(cur.current.stops[sel]?.color ?? '', steps)) onPreview(cur.current);
          else setColor(v, token, phase);
        }}
        onHover={(v) => onPreview({ ...cur.current, stops: cur.current.stops.map((s, j) => (j === sel ? { ...s, color: v } : s)) })}
      />
    </>
  );
}

/** 小数字框：回车或移开时提交 */
function NumInput(p: { label: string; title: string; unit: string; value: number; min?: number; max?: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    if (draft === null) return;
    setDraft(null);
    const n = parseFloat(draft);
    if (Number.isNaN(n)) return;
    const v = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n));
    if (v !== p.value) p.onCommit(v);
  };
  return (
    <label className="grad-num" title={p.title}>
      <span>{p.label}</span>
      <input
        value={draft ?? String(Math.round(p.value * 100) / 100)}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done();
          if (e.key === 'Escape') setDraft(null);
        }}
        onBlur={done}
      />
      <span>{p.unit}</span>
    </label>
  );
}
