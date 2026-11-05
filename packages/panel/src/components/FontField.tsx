import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { primaryFamily, quoteFamily, sameFontStack, t, type FontsView, type ScaleStep, type Target } from '@css-tuner/protocol';
import { Chevron, targetHint } from './controls';
import type { Edit } from './types';

const GENERICS = ['sans-serif', 'serif', 'monospace', 'system-ui'];
/** 面板里没有的字体（页面加载的网页字体）退回界面字体，不然浏览器会用默认的衬线体 */
const UI_FONT = 'var(--font)';

interface Item {
  key: string;
  label: string;
  /** 右边的小字：主题字体的首选字体 */
  detail?: string;
  value: string;
  token: string | null;
  /** 显示这一项用的字体：本机字体用它自己的字形 */
  face?: string;
}

interface Group {
  id: string;
  title: string;
  hint?: string;
  items: Item[];
}

const named = (prefix: string, name: string): Item => {
  const value = quoteFamily(name);
  return { key: `${prefix}:${name}`, label: name, value, token: null, face: `${value}, ${UI_FONT}` };
};

/** 主题（或 CSS 变量）、页面加载的、本机装的（页面加载了的不重复列）、通用字体族；按搜索词筛 */
function groupsOf(steps: ScaleStep[], vars: boolean, fonts: FontsView | null, query: string): Group[] {
  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((s) => s.toLowerCase().includes(q));
  const page = fonts?.page ?? [];
  const onPage = new Set(page.map((n) => n.toLowerCase()));
  const groups: Group[] = [
    {
      id: 'theme',
      title: t(vars ? 'insp.font.vars' : 'insp.font.theme'),
      items: steps
        .filter((s) => match(s.label, primaryFamily(s.value)))
        .map((s) => ({ key: `t:${s.label}`, label: s.label, detail: primaryFamily(s.value), value: s.value, token: s.token ?? null, face: `${s.value}, ${UI_FONT}` })),
    },
    { id: 'page', title: t('insp.font.page'), hint: t('insp.font.page.hint'), items: page.filter((n) => match(n)).map((n) => named('p', n)) },
    {
      id: 'local',
      title: t('insp.font.local'),
      hint: t('insp.font.local.hint'),
      items: (fonts?.local ?? []).filter((n) => !onPage.has(n.toLowerCase()) && match(n)).map((n) => named('l', n)),
    },
    { id: 'generic', title: t('insp.font.generic'), hint: t('insp.font.generic.hint'), items: GENERICS.filter((n) => match(n)).map((n) => ({ key: `g:${n}`, label: n, value: n, token: null, face: n })) },
  ];
  return groups.filter((g) => g.items.length);
}

/** 输入的字体名：带逗号或引号的当作写好的字体栈 */
function typedValue(text: string): string {
  return /[,"']/.test(text) ? text : quoteFamily(text);
}

/** 把一项滚到看得见，只滚列表自己（scrollIntoView 会连面板一起滚）；最上面要让开吸顶的分组标题 */
function reveal(list: HTMLElement | null, selector: string, center: boolean): boolean {
  const el = list?.querySelector<HTMLElement>(selector);
  if (!list || !el) return false;
  const box = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const head = list.querySelector<HTMLElement>('.font-group')?.offsetHeight ?? 0;
  if (center) list.scrollTop += r.top - box.top - (box.height - r.height) / 2;
  else if (r.top < box.top + head) list.scrollTop -= box.top + head - r.top;
  else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
  return true;
}

/**
 * 字体：搜索框加分组列表，本机字体用自己的字形显示；悬停或方向键选到即预览，点选或回车提交，
 * 搜不到时可以直接用输入的字体名；Esc 或点外面恢复打开前的值
 */
export function FontField(props: {
  title: string;
  value: string;
  display: string;
  steps: ScaleStep[];
  /** 普通 CSS 项目：主题字体是 CSS 变量 */
  vars: boolean;
  fonts: FontsView | null;
  pending: boolean;
  target?: Target;
  corner?: ReactNode;
  onOpen: () => void;
  onEdit: (e: Edit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const base = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** 方向键换的才滚到看得见：悬停换的也滚的话，列表会在指针底下一路滚下去 */
  const byKey = useRef(false);

  const groups = useMemo(() => (open ? groupsOf(props.steps, props.vars, props.fonts, query) : []), [open, props.steps, props.vars, props.fonts, query]);
  const q = query.trim();
  const exact = groups.some((g) => g.items.some((i) => i.label.toLowerCase() === q.toLowerCase()));
  const typed: Item | null = q && !exact ? { key: 'typed', label: t('insp.font.use', { name: q }), value: typedValue(q), token: null } : null;
  const items = [...(typed ? [typed] : []), ...groups.flatMap((g) => g.items)];
  // 有搜索词时默认停在第一个搜到的字体上，回车就用它；一个都没搜到才轮到输入的名字
  const current = active >= 0 ? active : q ? (typed && items.length > 1 ? 1 : 0) : -1;
  const loading = open && !props.fonts?.local;

  const preview = (item: Item) => {
    if (base.current === null) base.current = props.value;
    props.onEdit({ props: [], value: item.value, token: null, phase: 'live' });
  };
  const pick = (item: Item) => {
    base.current = null;
    setOpen(false);
    props.onEdit({ props: [], value: item.value, token: item.token, phase: 'commit' });
  };
  const close = (revert: boolean) => {
    if (revert && base.current !== null) props.onEdit({ props: [], value: base.current, token: null, phase: 'live' });
    base.current = null;
    setOpen(false);
  };
  const show = () => {
    setQuery('');
    setActive(-1);
    setOpen(true);
    props.onOpen();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });

  // 打开时把当前用的那一项滚到中间；第一次打开时本机字体还没读回来，当前的本机字体要等列表到了再滚，用户已经在挑就不动
  const revealed = useRef(false);
  useEffect(() => {
    if (!open) revealed.current = false;
    else if (!revealed.current && active < 0 && !q) revealed.current = reveal(list.current, '.on', true);
  }, [open, groups]);

  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    reveal(list.current, '.is-active', false);
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
      byKey.current = true;
      setActive(next);
      preview(items[next]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[current];
      if (item) pick(item);
    }
  };

  const agent = props.target?.kind === 'agent';
  let index = typed ? 1 : 0;
  const row = (item: Item, i: number) => (
    <button
      key={item.key}
      role="option"
      aria-selected={sameFontStack(item.value, props.value)}
      className={`${sameFontStack(item.value, props.value) ? 'on' : ''}${i === current ? ' is-active' : ''}`}
      title={item.value}
      onPointerEnter={() => {
        setActive(i);
        preview(item);
      }}
      onClick={() => pick(item)}
    >
      <span style={item.face ? { fontFamily: item.face } : undefined}>{item.label}</span>
      {item.detail && <small>{item.detail}</small>}
    </button>
  );
  return (
    <div className={`sel font-sel${props.pending ? ' is-pending' : ''}`} ref={box}>
      <button className="sel-btn" onClick={() => (open ? close(true) : show())} title={[props.title, props.value, targetHint(props.target)].filter(Boolean).join('\n')} aria-expanded={open}>
        <span className="sel-value" style={{ fontFamily: `${props.value}, ${UI_FONT}` }}>
          {props.display}
        </span>
        {agent && <span className="nf-agent" title={props.target?.reason ?? t('field.agent')} />}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="sel-menu font-menu">
          <input
            className="font-search"
            value={query}
            placeholder={t('insp.font.search')}
            spellCheck={false}
            autoFocus
            aria-label={t('insp.font.search')}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="font-list" role="listbox" ref={list}>
            {typed && <div className="font-typed">{row(typed, 0)}</div>}
            {groups.map((g) => (
              <Fragment key={g.id}>
                <div className="font-group" title={g.hint}>
                  {g.title}
                </div>
                {g.items.map((item) => row(item, index++))}
              </Fragment>
            ))}
            {loading && <div className="font-note">{t('insp.font.loading')}</div>}
            {props.fonts?.failed && <div className="font-note">{t('insp.font.failed')}</div>}
          </div>
        </div>
      )}
      {props.corner}
    </div>
  );
}
