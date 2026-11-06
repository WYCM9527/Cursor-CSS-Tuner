import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatNumber, t, type ScaleStep, type Target } from '@css-tuner/protocol';
import { nearest, ordered, valuePx, walk, type Ctx } from '../lib/scale';
import { agentHint } from './controls';
import type { Edit } from './types';

export interface NumberFieldProps {
  label: ReactNode;
  title: string;
  prop: string;
  values: string[];
  steps: ScaleStep[] | null;
  ctx: Ctx;
  snap: boolean;
  pending: boolean;
  target?: Target;
  /** 源码里声明的变量名，显示在令牌位 */
  declared?: string | null;
  /** 精确模式下拖动 / 方向键的步长 */
  stepSize?: number;
  min?: number;
  max?: number;
  unit?: 'px' | '';
  /** 右上角的重置 / 删除按钮 */
  corner?: ReactNode;
  onEdit: (e: Edit) => void;
}

export const PX_PER_STEP = 6;
const PX_PER_UNIT = 2;

function fmt(n: number, stepSize: number): string {
  return formatNumber(n, stepSize < 0.1 ? 3 : stepSize < 1 ? 2 : 1);
}

/** 输入框里敲的值 → CSS 值和令牌：纯数字按 px（无单位属性按数字），也认刻度名、带单位的长度和关键字 */
function parseTyped(text: string, steps: ScaleStep[] | null, unit: 'px' | ''): { value: string; token: string | null } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return { value: unit === 'px' ? `${parseFloat(t)}px` : String(parseFloat(t)), token: null };
  const step = steps?.find((s) => s.label === t || s.token === t);
  if (step) return { value: step.value, token: step.token ?? null };
  if (/^--[\w-]+$/.test(t)) return { value: `var(${t})`, token: t };
  if (/^-?(\d+\.?\d*|\.\d+)(px|rem|em|%|vw|vh|svh|dvh|ch|ex|pt)$/i.test(t)) return { value: t.toLowerCase(), token: null };
  if (/^(auto|normal|none|fit-content|min-content|max-content|inherit|initial|unset)$/.test(t)) return { value: t, token: null };
  if (/^(calc|var|clamp|min|max)\(.+\)$/.test(t)) return { value: t, token: null };
  return null;
}

export function NumberField(p: NumberFieldProps) {
  const unit = p.unit ?? 'px';
  const stepSize = p.stepSize ?? 1;
  const first = p.values[0] ?? '';
  const mixed = p.values.some((v) => v !== first);
  const curPx = valuePx(first, p.ctx, p.prop);
  const seq = useMemo(() => (p.steps ? ordered(p.steps, p.ctx, p.prop) : []), [p.steps, p.ctx, p.prop]);
  const snapped = curPx !== null && p.steps ? nearest(p.steps, curPx, p.ctx, p.prop) : null;
  const token = p.declared ?? (snapped?.exact ? snapped.step.label : null);

  const [text, setText] = useState<string | null>(null);
  const [drag, setDrag] = useState<null | { px: number; label: string | null; exact: boolean }>(null);
  const dragRef = useRef<null | { x: number; px: number; moved: boolean; last: string; pointer: number; startIndexPx: number }>(null);
  const raf = useRef(0);
  const queued = useRef<Edit | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const clamp = (n: number) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n));
  const emitLive = (e: Edit) => {
    queued.current = e;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (queued.current) p.onEdit(queued.current);
      queued.current = null;
    });
  };
  const exactValue = (n: number) => (unit === 'px' ? `${fmt(n, stepSize)}px` : fmt(n, stepSize));

  const compute = (dx: number, alt: boolean, shift: boolean, startPx: number) => {
    if (p.snap && !alt && seq.length) {
      const steps = Math.trunc(dx / PX_PER_STEP);
      const s = steps === 0 ? null : walk(seq, startPx, steps);
      if (!s) return { px: startPx, value: null as string | null, token: null as string | null, label: token, exact: false };
      return { px: s.pxv, value: s.value, token: s.token ?? null, label: s.label, exact: false };
    }
    const n = clamp(startPx + Math.round(dx / PX_PER_UNIT) * stepSize * (shift ? 10 : 1));
    return { px: n, value: exactValue(n), token: null, label: null, exact: true };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = curPx ?? 0;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有活动指针 */
    }
    dragRef.current = { x: e.clientX, px: start, moved: false, last: first, pointer: e.pointerId, startIndexPx: start };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const r = compute(dx, e.altKey, e.shiftKey, d.startIndexPx);
    setDrag({ px: r.px, label: r.label, exact: r.exact });
    if (r.value && r.value !== d.last) {
      d.last = r.value;
      emitLive({ props: [], value: r.value, token: r.token, phase: 'live' });
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!d.moved) {
      inputRef.current?.focus();
      return;
    }
    const r = compute(e.clientX - d.x, e.altKey, e.shiftKey, d.startIndexPx);
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    queued.current = null;
    if (r.value) p.onEdit({ props: [], value: r.value, token: r.token, phase: 'commit' });
  };

  const commitText = () => {
    if (text === null) return;
    const parsed = parseTyped(text, p.steps, unit);
    setText(null);
    if (parsed && parsed.value !== first) p.onEdit({ props: [], value: parsed.value, token: parsed.token, phase: 'commit' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitText();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setText(null);
      inputRef.current?.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const base = curPx ?? 0;
      if (p.snap && !e.altKey && seq.length) {
        const s = walk(seq, base, dir);
        if (s) p.onEdit({ props: [], value: s.value, token: s.token ?? null, phase: 'commit' });
      } else {
        p.onEdit({ props: [], value: exactValue(clamp(base + dir * stepSize * (e.shiftKey ? 10 : 1))), token: null, phase: 'commit' });
      }
      setText(null);
    }
  };

  const shown = text ?? (mixed ? '' : curPx === null ? first : fmt(curPx, stepSize));

  return (
    <div className={`nf${p.pending ? ' is-pending' : ''}${drag ? ' is-dragging' : ''}`} title={hint(p)}>
      <span
        className="nf-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label={t('field.drag', { title: p.title })}
      >
        {p.label}
      </span>
      <input
        ref={inputRef}
        className="nf-input"
        value={drag ? fmt(drag.px, stepSize) : shown}
        placeholder={mixed ? t('field.mixed') : ''}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={onKeyDown}
        aria-label={p.title}
      />
      {(drag?.label ?? token) && !drag?.exact && <span className="nf-token">{drag?.label ?? token}</span>}
      {!drag && p.corner}
      {drag && <Ruler seq={seq} px={drag.px} exact={drag.exact} unit={unit} stepSize={stepSize} />}
    </div>
  );
}

function hint(p: NumberFieldProps): string {
  const lines = [p.title];
  if (p.target) {
    lines.push(t('field.writeTo', { label: p.target.label }));
    if (p.target.affects > 1) lines.push(t('field.affects', { n: p.target.affects }));
    const why = agentHint(p.target);
    if (why) lines.push(why);
  }
  lines.push(p.snap ? t('field.dragHint.snap') : t('field.dragHint'));
  return lines.join('\n');
}

function Ruler({ seq, px, exact, unit, stepSize }: { seq: Array<ScaleStep & { pxv: number }>; px: number; exact: boolean; unit: string; stepSize: number }) {
  if (exact || !seq.length) {
    return (
      <div className="ruler is-exact">
        <span>{t('field.exact')}</span>
        <b>
          {fmt(px, stepSize)}
          {unit}
        </b>
      </div>
    );
  }
  let i = seq.findIndex((s) => Math.abs(s.pxv - px) <= 0.5);
  if (i < 0) i = 0;
  const from = Math.max(0, Math.min(i - 3, seq.length - 7));
  const view = seq.slice(from, from + 7);
  return (
    <div className="ruler">
      {view.map((s) => (
        <span key={`${s.label}-${s.pxv}`} className={Math.abs(s.pxv - px) <= 0.5 ? 'on' : ''}>
          <i />
          {s.label}
        </span>
      ))}
    </div>
  );
}
