import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hsvToRgb, parseColor, rgbToHsv, sameColor, t, toHex, type Hsva, type ScaleStep, type Target } from '@css-tuner/protocol';
import { varName } from '../lib/format';
import { agentHint } from './controls';
import type { Edit } from './types';

export interface ColorFieldProps {
  title: string;
  prop: string;
  value: string;
  steps: ScaleStep[] | null;
  pending: boolean;
  target?: Target;
  declared?: string | null;
  /** 右上角的重置 / 删除按钮 */
  corner?: ReactNode;
  onEdit: (e: Edit) => void;
}

export function matchStep(steps: ScaleStep[] | null, value: string): ScaleStep | null {
  if (!steps) return null;
  return steps.find((s) => sameColor(s.value, value)) ?? null;
}

export function hexOf(value: string): string {
  const c = parseColor(value);
  if (c && c.a === 0) return t('color.transparent');
  return c ? toHex(c) : value;
}

/** 页面变量在面板里没有定义：var(--x) 要换成刻度里记下的实际颜色才能画色块 */
export function resolveColor(value: string, steps: ScaleStep[] | null): string {
  const name = varName(value);
  if (!name || !steps) return value;
  const s = steps.find((x) => x.token === name || x.label === name || x.value === value);
  return s && parseColor(s.value) ? s.value : value;
}

export function ColorField(p: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const shown = resolveColor(p.value, p.steps);
  const step = matchStep(p.steps, shown);
  const label = varName(p.value) ?? p.declared ?? step?.label ?? hexOf(shown);
  return (
    <div className={`cf${p.pending ? ' is-pending' : ''}`}>
      <button className="cf-row" onClick={() => setOpen((v) => !v)} title={tip(p)} aria-expanded={open}>
        <span className="swatch" style={{ ['--c' as string]: shown }} />
        <span className="cf-label">{label}</span>
        {label !== hexOf(shown) && parseColor(shown) && <span className="cf-hex">{hexOf(shown)}</span>}
      </button>
      {p.corner}
      {open && <ColorPicker value={shown} steps={p.steps} onEdit={p.onEdit} onClose={() => setOpen(false)} />}
    </div>
  );
}

function tip(p: ColorFieldProps): string {
  const lines = [p.title];
  if (p.target) {
    const affects = p.target.affects > 1 ? t('common.paren', { text: t('field.affects', { n: p.target.affects }) }) : '';
    lines.push(`${t('field.writeTo', { label: p.target.label })}${affects}`);
    const why = agentHint(p.target);
    if (why) lines.push(why);
  }
  return lines.join('\n');
}

interface PickerProps {
  value: string;
  steps: ScaleStep[] | null;
  onEdit: (e: Edit) => void;
  onClose: () => void;
}

/** 颜色弹出层：拖动时的预览按帧合并，点外面收起时提交，Esc 撤回到打开时的颜色 */
function ColorPicker({ value, steps, onEdit, onClose }: PickerProps) {
  const initial = useRef(value);
  const committed = useRef(value);
  const live = useRef<string | null>(null);
  const raf = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  const send = (v: string, token: string | null, phase: 'live' | 'commit') => {
    if (phase === 'commit') {
      committed.current = v;
      live.current = null;
      onEdit({ props: [], value: v, token, phase });
      return;
    }
    live.current = v;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (live.current) onEdit({ props: [], value: live.current, token: null, phase: 'live' });
    });
  };

  const close = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    if (live.current && live.current !== committed.current) send(live.current, null, 'commit');
    onClose();
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node) && !(e.target as Element).closest?.('.cf-row')) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (live.current || committed.current !== initial.current) send(initial.current, null, 'commit');
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });

  return (
    <div className="picker" ref={root}>
      <ColorEditor value={value} steps={steps} onPick={send} onHover={(v) => onEdit({ props: [], value: v, token: null, phase: 'live' })} />
    </div>
  );
}

export interface ColorEditorProps {
  value: string;
  steps: ScaleStep[] | null;
  /** 拖动是 live；松手、回车、吸管、点色块是 commit（色块带上刻度令牌） */
  onPick: (value: string, token: string | null, phase: 'live' | 'commit') => void;
  /** 悬停色块时临时预览一下；移开时用 onPick 的 live 换回来 */
  onHover: (value: string) => void;
}

/** 取色器本体：饱和度 / 明度面板、色相、透明度、十六进制、吸管和主题色块 */
export function ColorEditor({ value, steps, onPick, onHover }: ColorEditorProps) {
  const committed = useRef(value);
  const [hsva, setHsva] = useState<Hsva>(() => rgbToHsv(parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 }));
  const [hex, setHex] = useState<string | null>(null);
  const send = (v: string, token: string | null, phase: 'live' | 'commit') => {
    if (phase === 'commit') committed.current = v;
    onPick(v, token, phase);
  };

  const setFromHsva = (next: Hsva, phase: 'live' | 'commit') => {
    setHsva(next);
    send(toHex(hsvToRgb(next)), null, phase);
  };

  const area = useRef<HTMLDivElement>(null);
  const dragArea = (e: React.PointerEvent<HTMLDivElement>, phase: 'live' | 'commit') => {
    const r = area.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    setFromHsva({ ...hsva, s, v }, phase);
  };

  const groups = useMemo(() => groupSteps(steps ?? []), [steps]);
  const hoverBase = useRef<string | null>(null);
  const cur = toHex(hsvToRgb(hsva));
  const hasEyeDropper = typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper === 'function';

  return (
    <>
      <div
        className="sv"
        ref={area}
        style={{ ['--hue' as string]: `${hsva.h}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragArea(e, 'live');
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) dragArea(e, 'live');
        }}
        onPointerUp={(e) => dragArea(e, 'commit')}
      >
        <span className="sv-dot" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%` }} />
      </div>
      <input
        className="hue"
        type="range"
        min={0}
        max={360}
        value={Math.round(hsva.h)}
        onChange={(e) => setFromHsva({ ...hsva, h: +e.target.value }, 'live')}
        onPointerUp={() => send(cur, null, 'commit')}
        onKeyUp={() => send(cur, null, 'commit')}
        aria-label={t('color.hue')}
      />
      <input
        className="alpha"
        type="range"
        min={0}
        max={100}
        value={Math.round(hsva.a * 100)}
        style={{ ['--c' as string]: toHex({ ...hsvToRgb(hsva), a: 1 }) }}
        onChange={(e) => setFromHsva({ ...hsva, a: +e.target.value / 100 }, 'live')}
        onPointerUp={() => send(cur, null, 'commit')}
        onKeyUp={() => send(cur, null, 'commit')}
        aria-label={t('insp.opacity')}
      />
      <div className="picker-row">
        <input
          className="hex"
          value={hex ?? cur}
          spellCheck={false}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const c = parseColor(hex ?? '');
            setHex(null);
            if (c) {
              setHsva(rgbToHsv(c));
              send(toHex(c), null, 'commit');
            }
          }}
          onBlur={() => setHex(null)}
          aria-label={t('color.hex')}
        />
        {hasEyeDropper && (
          <button
            className="icon-btn"
            title={t('color.eyedropper')}
            onClick={async () => {
              try {
                const Ctor = (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
                const r = await new Ctor().open();
                const c = parseColor(r.sRGBHex);
                if (c) {
                  setHsva(rgbToHsv(c));
                  send(toHex(c), null, 'commit');
                }
              } catch {
                /* 用户取消 */
              }
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M10.5 2.5l3 3-1.5 1.5-3-3zM9 4l3 3-6 6H3v-3z" />
            </svg>
          </button>
        )}
      </div>
      {groups.map((g) => (
        <div key={g.name} className="swatches-group">
          <div className="swatches-title">{g.name}</div>
          <div
            className={g.grid ? 'swatches grid' : 'swatches'}
            onPointerLeave={() => {
              if (hoverBase.current !== null) {
                send(hoverBase.current, null, 'live');
                hoverBase.current = null;
              }
            }}
          >
            {g.items.map((s) => (
              <button
                key={s.label}
                className={`swatch-btn${sameColor(s.value, cur) ? ' on' : ''}`}
                style={{ ['--c' as string]: s.value }}
                title={`${s.label}  ${hexOf(s.value)}`}
                onPointerEnter={() => {
                  if (hoverBase.current === null) hoverBase.current = committed.current;
                  onHover(s.value);
                }}
                onClick={() => {
                  hoverBase.current = null;
                  const c = parseColor(s.value);
                  if (c) setHsva(rgbToHsv(c));
                  send(s.value, s.token ?? s.label, 'commit');
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

interface Group {
  name: string;
  grid: boolean;
  items: ScaleStep[];
}

/** 主题自定义色单独一组；Tailwind 调色板按色系排成网格 */
function groupSteps(steps: ScaleStep[]): Group[] {
  const custom: ScaleStep[] = [];
  const families = new Map<string, ScaleStep[]>();
  for (const s of steps) {
    const m = /^([a-z]+)-(\d{2,3})$/.exec(s.label);
    if (m) {
      const arr = families.get(m[1]) ?? [];
      arr.push(s);
      families.set(m[1], arr);
    } else custom.push(s);
  }
  const out: Group[] = [];
  if (custom.length) out.push({ name: steps.some((s) => s.label.startsWith('--')) ? t('color.pageVars') : t('color.theme'), grid: false, items: custom });
  if (families.size) out.push({ name: t('color.palette'), grid: true, items: [...families.values()].flat() });
  return out;
}
