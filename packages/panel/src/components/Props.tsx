import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type PanelToExt, type PropValue, type PropView, type ScaleStep, type SelectionView } from '@css-tuner/protocol';
import type { Ctx } from '../lib/scale';
import { Corner, Section, Segmented, SelectField, targetHint } from './controls';
import { NumberField } from './NumberField';

type EditProp = (name: string, value: PropValue, phase: 'live' | 'commit') => void;
type OnEdit = (value: PropValue, phase: 'live' | 'commit') => void;

const shown = (v: PropValue) => (v === null ? t('insp.props.unset') : String(v));

/** 渲染选中元素的组件收到的属性：可选值用分段或下拉，布尔是 true / false，数字可以拖，文字回车提交；对象、函数这类只读 */
export function Props(props: { sel: SelectionView; ctx: Ctx; open: boolean; onToggle: (id: string) => void; editProp: EditProp; send: (m: PanelToExt) => void }) {
  const view = props.sel.props;
  if (!view) return null;
  const src = view.source;
  const tag = `<${view.component}>`;
  const aside = src ? (
    <button className="link-btn pp-site" onClick={() => props.send({ t: 'openSource', file: src.file, line: src.line, column: src.column })} title={t('insp.props.site', { label: src.label })}>
      {tag}
    </button>
  ) : (
    <span className="pp-site">{tag}</span>
  );
  return (
    <Section id="props" title={t('insp.props')} open={props.open} onToggle={props.onToggle} aside={aside}>
      {view.server && <p className="sec-note">{t('insp.props.server')}</p>}
      {!view.server && !view.live && (
        <div className="pp-reload">
          <span>{t('insp.props.reload')}</span>
          <button className="mini" onClick={() => props.send({ t: 'reload' })}>
            {t('insp.props.reloadButton')}
          </button>
        </div>
      )}
      {view.items.map((x) => (
        <PropRow
          key={`${props.sel.el.uid}:${x.name}`}
          view={x}
          ctx={props.ctx}
          onEdit={(v, phase) => props.editProp(x.name, v, phase)}
          onReset={() => props.send({ t: 'resetProp', name: x.name })}
        />
      ))}
      {!view.items.length && <p className="sec-note">{t('insp.props.empty')}</p>}
    </Section>
  );
}

function PropRow({ view, ctx, onEdit, onReset }: { view: PropView; ctx: Ctx; onEdit: OnEdit; onReset: () => void }) {
  const hint = [view.name, view.missing ? t('insp.props.missing') : null, view.warn ?? null].filter(Boolean).join('\n');
  const corner = <Corner label={view.name} pending={view.pending} onReset={onReset} />;
  return (
    <div className={`row pp-row${view.missing ? ' is-missing' : ''}`}>
      <span className="row-label" title={hint}>
        {view.name}
        {view.warn && <i className="pp-warn" />}
      </span>
      <div className="row-fields">{control(view, ctx, onEdit, corner)}</div>
    </div>
  );
}

function control(view: PropView, ctx: Ctx, onEdit: OnEdit, corner: ReactNode): ReactNode {
  const { value, pending, target } = view;
  const opts = view.options ?? [];
  if (opts.length) {
    const key = JSON.stringify(value);
    if (opts.length <= 4 && opts.every((o) => String(o).length <= 8)) {
      return (
        <Segmented
          value={key}
          pending={pending}
          target={target}
          corner={corner}
          options={opts.map((o) => ({ value: JSON.stringify(o), label: String(o), title: String(o) }))}
          onPick={(v) => onEdit(JSON.parse(v) as PropValue, 'commit')}
        />
      );
    }
    const steps: ScaleStep[] = opts.map((o) => ({ label: String(o), value: JSON.stringify(o) }));
    return (
      <SelectField
        title={view.name}
        value={key}
        display={shown(value)}
        steps={steps}
        pending={pending}
        target={target}
        describe={() => ''}
        corner={corner}
        onEdit={(e) => onEdit(JSON.parse(e.value) as PropValue, e.phase)}
      />
    );
  }
  if (view.type === 'boolean') {
    return (
      <Segmented
        value={String(value)}
        pending={pending}
        target={target}
        corner={corner}
        options={['true', 'false'].map((v) => ({ value: v, label: v, title: v }))}
        onPick={(v) => onEdit(v === 'true', 'commit')}
      />
    );
  }
  if (view.type === 'number' && typeof value === 'number') {
    return (
      <NumberField
        label={<b className="glyph">#</b>}
        title={view.name}
        prop={view.name}
        values={[String(value)]}
        steps={null}
        ctx={ctx}
        snap={false}
        pending={pending}
        target={target}
        unit=""
        stepSize={Number.isInteger(value) ? 1 : 0.1}
        corner={corner}
        onEdit={(e) => {
          const n = Number(e.value);
          if (Number.isFinite(n)) onEdit(n, e.phase);
        }}
      />
    );
  }
  if (view.type === 'string' && typeof value === 'string') return <PropText view={view} onEdit={onEdit} corner={corner} />;
  return (
    <span className="pp-readonly" title={t('insp.props.readonly')}>
      {view.summary ?? shown(value)}
    </span>
  );
}

/** 输入时实时预览；回车或失焦提交，Esc 恢复开始编辑时的值 */
function PropText({ view, onEdit, corner }: { view: PropView; onEdit: OnEdit; corner: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const start = useRef<PropValue>('');
  const live = useRef(false);
  const cancelled = useRef(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const end = () => {
    clearTimeout(timer.current);
    if (text !== null) {
      if (!cancelled.current && text !== start.current) onEdit(text, 'commit');
      else if (live.current) onEdit(start.current, 'commit');
    }
    cancelled.current = false;
    live.current = false;
    setText(null);
  };

  return (
    <div className={`nf tf${view.pending ? ' is-pending' : ''}`} title={targetHint(view.target)}>
      <input
        className="nf-input"
        value={text ?? String(view.value ?? '')}
        spellCheck={false}
        aria-label={view.name}
        onFocus={() => {
          start.current = view.value;
        }}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            live.current = true;
            onEdit(v, 'live');
          }, 150);
        }}
        onBlur={end}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {corner}
    </div>
  );
}
