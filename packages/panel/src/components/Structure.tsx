import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t, type Crumb, type OrderView, type PanelToExt, type SelectionView } from '@css-tuner/protocol';
import { boundary, nameOf } from '../lib/names';
import { Section } from './controls';

type Send = (m: PanelToExt) => void;

const MAX_UP = 4;
const MAX_KIDS = 12;
const MAX_SIBS = 12;
/** 按下后移动超过这么多像素才算拖动，否则是点选 */
const DRAG_PX = 4;

interface Row {
  c: Crumb;
  depth: number;
  /** 组件边界：渲染它的组件和上一层不同 */
  comp: string | null;
  on: boolean;
}

interface Drag {
  pointer: number;
  from: number;
  y0: number;
  active: boolean;
  slot: number;
}

/**
 * 图层：祖先链 + 选中元素和它的兄弟 + 子元素，每行是通俗的叫法加文字开头；组件边界处标出组件名，点选切换、悬停在页面上描边。
 * 选中元素有可换序的兄弟时，兄弟行可以上下拖动换位置
 */
export function Structure(props: { sel: SelectionView; send: Send; open: boolean; onToggle: (id: string) => void; onlyComponents: boolean; setOnlyComponents: (on: boolean) => void }) {
  const { sel, send, onlyComponents } = props;
  const [allUp, setAllUp] = useState(false);
  const [allKids, setAllKids] = useState(false);
  const [allSibs, setAllSibs] = useState(false);
  const chain = sel.el.breadcrumb;
  const self = chain[chain.length - 1];
  const order = sel.order;

  let rows: Row[] = chain.map((c, i) => ({ c, depth: i, comp: boundary(c, chain[i - 1]), on: i === chain.length - 1 }));
  if (onlyComponents) rows = rows.filter((r) => r.on || r.comp);
  const hiddenUp = allUp ? 0 : Math.max(0, rows.length - 1 - MAX_UP);
  rows = rows.slice(hiddenUp);
  const base = rows[0]?.depth ?? 0;
  const selfRow = rows[rows.length - 1];

  let kids = sel.el.children.map((c) => ({ c, comp: boundary(c, self) }));
  if (onlyComponents) kids = kids.filter((k) => k.comp);
  const hiddenKids = allKids ? 0 : Math.max(0, kids.length - MAX_KIDS);
  const shownKids = hiddenKids ? kids.slice(0, MAX_KIDS) : kids;
  const selfDepth = (selfRow?.depth ?? 0) - base;

  const sibs = order ? siblingWindow(order, allSibs) : null;
  const drag = useSiblingDrag(order, send);

  const row = (c: Crumb, depth: number, comp: string | null, on: boolean) => (
    <li key={c.uid}>
      <button
        className={`tree-row${on ? ' on' : ''}`}
        style={{ paddingLeft: 6 + depth * 11 }}
        title={comp ? t('tree.component', { label: c.label, name: comp }) : c.label}
        onClick={() => !on && send({ t: 'select', uid: c.uid })}
        onPointerEnter={() => send({ t: 'hover', uid: c.uid })}
        onPointerLeave={() => send({ t: 'hover', uid: null })}
      >
        <span className="tree-twisty">{c.kids ? (on ? '▾' : '▸') : ''}</span>
        <TreeLabel label={c.label} text={c.text} />
        {comp && <span className="tree-comp">&lt;{comp}&gt;</span>}
        {!on && !!c.kids && <small className="tree-kids">{c.kids}</small>}
      </button>
    </li>
  );

  const kidRows = (
    <>
      {shownKids.map((k) => row(k.c, selfDepth + 1, k.comp, false))}
      {hiddenKids > 0 && (
        <li key="more-kids">
          <button className="tree-more" style={{ paddingLeft: 6 + (selfDepth + 1) * 11 }} onClick={() => setAllKids(true)}>
            {t('tree.moreKids', { n: hiddenKids })}
          </button>
        </li>
      )}
    </>
  );

  const sibRow = (k: number) => {
    const it = order!.items[k];
    const on = k === order!.index;
    const comp = selfRow && on ? selfRow.comp : (it.component ?? null);
    const line = drag.line(k);
    return (
      <li key={`sib-${it.uid}`} ref={(n) => drag.track(k, n)} className={line ? `drop-${line}` : undefined}>
        <button
          className={`tree-row is-sib${on ? ' on' : ''}${drag.from === k ? ' is-dragging' : ''}`}
          style={{ paddingLeft: 6 + selfDepth * 11 }}
          title={`${comp ? t('tree.component', { label: it.label, name: comp }) : it.label}\n${t('tree.drag')}`}
          onClick={() => !drag.consumeClick() && !on && send({ t: 'select', uid: it.uid })}
          onPointerDown={(e) => drag.down(e, k)}
          onPointerMove={drag.move}
          onPointerUp={drag.up}
          onPointerCancel={drag.cancel}
          onLostPointerCapture={drag.cancel}
          onPointerEnter={() => send({ t: 'hover', uid: it.uid })}
          onPointerLeave={() => send({ t: 'hover', uid: null })}
        >
          <span className="tree-twisty">{on && sel.el.children.length ? '▾' : ''}</span>
          <TreeLabel label={it.label} text={it.text} />
          {comp && <span className="tree-comp">&lt;{comp}&gt;</span>}
          <svg className="tree-grip" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
            {[1, 5, 9].flatMap((y) => [1, 5].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1" fill="currentColor" />))}
          </svg>
        </button>
      </li>
    );
  };

  return (
    <Section
      id="tree"
      title={t('tree.title')}
      open={props.open}
      onToggle={props.onToggle}
      aside={
        <button className={`chip-toggle${onlyComponents ? ' on' : ''}`} aria-pressed={onlyComponents} title={t('tree.onlyComponents.title')} onClick={() => props.setOnlyComponents(!onlyComponents)}>
          {t('tree.onlyComponents')}
        </button>
      }
    >
      <ul className={`tree${order?.pending ? ' is-pending' : ''}`} onPointerLeave={() => send({ t: 'hover', uid: null })}>
        {hiddenUp > 0 && (
          <li>
            <button className="tree-more" onClick={() => setAllUp(true)}>
              {t('tree.moreUp', { n: hiddenUp })}
            </button>
          </li>
        )}
        {(sibs ? rows.slice(0, -1) : rows).map((r) => row(r.c, r.depth - base, r.comp, r.on))}
        {sibs ? (
          <>
            {sibs.ks.map((k) => (
              <SibAndKids key={order!.items[k].uid} row={sibRow(k)} kids={k === order!.index ? kidRows : null} />
            ))}
            {sibs.hidden > 0 && (
              <li>
                <button className="tree-more" style={{ paddingLeft: 6 + selfDepth * 11 }} onClick={() => setAllSibs(true)}>
                  {t('tree.moreKids', { n: sibs.hidden })}
                </button>
              </li>
            )}
          </>
        ) : (
          kidRows
        )}
      </ul>
    </Section>
  );
}

/** 一行的名字：通俗的叫法加文字开头（没有文字时是 #id 和类名） */
function TreeLabel({ label, text }: { label: string; text?: string }) {
  const name = nameOf(label, text);
  return (
    <span className="tree-label">
      <span className="tree-role">{name.role}</span>
      {name.detail && <span className={name.quoted ? 'tree-text' : 'tree-code'}>{name.detail}</span>}
    </span>
  );
}

function SibAndKids(props: { row: ReactNode; kids: ReactNode }) {
  return (
    <>
      {props.row}
      {props.kids}
    </>
  );
}

/** 兄弟太多时只显示选中元素前后一段 */
function siblingWindow(order: OrderView, all: boolean): { ks: number[]; hidden: number } {
  const n = order.items.length;
  if (all || n <= MAX_SIBS) return { ks: [...Array(n).keys()], hidden: 0 };
  const lo = Math.max(0, Math.min(n - MAX_SIBS, order.index - Math.floor(MAX_SIBS / 2)));
  return { ks: [...Array(MAX_SIBS).keys()].map((k) => lo + k), hidden: n - MAX_SIBS };
}

/** 兄弟行的拖动：按下后移动超过几像素进入拖动，按行的中线算插入位置，松开时提交；Esc 取消 */
function useSiblingDrag(order: OrderView | undefined, send: Send) {
  const ref = useRef<Drag | null>(null);
  const rowsRef = useRef(new Map<number, HTMLLIElement>());
  const clickRef = useRef(false);
  const [state, setState] = useState<{ from: number; slot: number } | null>(null);

  const reset = () => {
    ref.current = null;
    setState(null);
  };

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      clickRef.current = true;
      reset();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state]);

  const slotAt = (y: number): number => {
    const shown = [...rowsRef.current.entries()].sort((a, b) => a[0] - b[0]);
    for (const [k, li] of shown) {
      const r = li.getBoundingClientRect();
      if (y < r.top + r.height / 2) return k;
    }
    return shown.length ? shown[shown.length - 1][0] + 1 : 0;
  };

  return {
    from: state?.from ?? -1,
    track(k: number, li: HTMLLIElement | null) {
      if (li) rowsRef.current.set(k, li);
      else rowsRef.current.delete(k);
    },
    /** 插入线画在哪一行的上沿（before）或最后一行的下沿（after） */
    line(k: number): 'before' | 'after' | null {
      if (!state || state.slot === state.from || state.slot === state.from + 1) return null;
      if (state.slot === k) return 'before';
      const last = Math.max(...rowsRef.current.keys());
      return state.slot === k + 1 && k === last ? 'after' : null;
    },
    consumeClick() {
      const hit = clickRef.current;
      clickRef.current = false;
      return hit;
    },
    down(e: ReactPointerEvent<HTMLButtonElement>, k: number) {
      if (e.button !== 0 || !order) return;
      ref.current = { pointer: e.pointerId, from: k, y0: e.clientY, active: false, slot: k };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 脚本合成的指针事件捕获不了，后续事件仍发在这一行上
      }
    },
    move(e: ReactPointerEvent<HTMLButtonElement>) {
      const d = ref.current;
      if (!d || d.pointer !== e.pointerId) return;
      if (!d.active && Math.abs(e.clientY - d.y0) < DRAG_PX) return;
      d.active = true;
      const slot = slotAt(e.clientY);
      if (slot !== d.slot || !state) {
        d.slot = slot;
        setState({ from: d.from, slot });
      }
    },
    up(e: ReactPointerEvent<HTMLButtonElement>) {
      const d = ref.current;
      if (!d || d.pointer !== e.pointerId) return;
      reset();
      if (!d.active || !order) return;
      clickRef.current = true;
      const to = d.slot > d.from ? d.slot - 1 : d.slot;
      if (to !== d.from) send({ t: 'reorder', uid: order.items[d.from].uid, to, phase: 'commit' });
    },
    cancel() {
      if (ref.current?.active) clickRef.current = true;
      reset();
    },
  };
}
