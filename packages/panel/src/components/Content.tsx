import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t, type SelectionView, type TextView } from '@css-tuner/protocol';
import { Corner, Section, targetHint } from './controls';

type EditText = (segment: number, value: string, phase: 'live' | 'commit') => void;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** 元素自己的文字，每段一个输入框；页面上双击文字也能直接改 */
export function Content(props: { sel: SelectionView; open: boolean; onToggle: (id: string) => void; editText: EditText; resetText: (segment: number) => void }) {
  const texts = props.sel.texts ?? [];
  if (!texts.length) return null;
  return (
    <Section id="content" title={t('insp.content')} open={props.open} onToggle={props.onToggle}>
      {texts.map((x) => (
        <TextRow key={`${props.sel.el.uid}:${x.segment}`} view={x} onEdit={(value, phase) => props.editText(x.segment, value, phase)} onReset={() => props.resetText(x.segment)} />
      ))}
    </Section>
  );
}

/** 输入时实时预览；回车或失焦提交，Esc 恢复开始编辑时的文字 */
function TextRow({ view, onEdit, onReset }: { view: TextView; onEdit: (value: string, phase: 'live' | 'commit') => void; onReset: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const start = useRef('');
  const live = useRef(false);
  const cancelled = useRef(false);
  const timer = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const shown = text ?? view.value;

  useLayoutEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.height = '0px';
    a.style.height = `${a.scrollHeight}px`;
  }, [shown]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const end = () => {
    clearTimeout(timer.current);
    if (text !== null) {
      const v = oneLine(text);
      if (!cancelled.current && v && v !== start.current) onEdit(v, 'commit');
      else if (live.current) onEdit(start.current, 'commit');
    }
    cancelled.current = false;
    live.current = false;
    setText(null);
  };

  const { origin } = view;
  const dynamic = origin === 'dynamic';
  const corner = <Corner label={t('panel.change.text')} pending={view.pending} onReset={onReset} />;
  return (
    <div className={`tx${view.pending ? ' is-pending' : ''}`}>
      {!dynamic && (
        <div className="tx-head" title={targetHint(view.target)}>
          <span className="tx-where">{t(`insp.text.origin.${origin}`)}</span>
          <span className="tx-target">{view.target.label}</span>
          {corner}
        </div>
      )}
      <textarea
        ref={area}
        className="tx-input"
        rows={1}
        value={shown}
        spellCheck={false}
        aria-label={t('insp.content')}
        title={dynamic ? targetHint(view.target) : undefined}
        onFocus={() => {
          start.current = view.value;
        }}
        onChange={(e) => {
          const v = e.target.value.replace(/[\r\n]+/g, ' ');
          setText(v);
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            live.current = true;
            onEdit(oneLine(v) || start.current, 'live');
          }, 150);
        }}
        onBlur={end}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {dynamic && corner}
    </div>
  );
}
