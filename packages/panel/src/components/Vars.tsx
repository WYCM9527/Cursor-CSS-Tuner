import { formatNumber, parseCssNumber, t, type ScaleStep, type SelectionView, type UsedVar } from '@css-tuner/protocol';
import { currentValue, isPending } from '../lib/format';
import type { Ctx } from '../lib/scale';
import { ColorField } from './ColorField';
import { Corner, Section, TextField } from './controls';
import { NumberField } from './NumberField';
import type { Edit } from './types';

interface Props {
  sel: SelectionView;
  ctx: Ctx;
  colors: ScaleStep[] | null;
  open: boolean;
  onToggle: (id: string) => void;
  edit: (props: string[], e: Edit) => void;
  reset: (props: string[]) => void;
}

/** 元素用到的 CSS 变量：改的是定义处，页面上用到它的地方一起变 */
export function Vars({ sel, ctx, colors, open, onToggle, edit, reset }: Props) {
  const vars = sel.el.vars ?? [];
  if (!vars.length) return null;
  return (
    <Section id="vars" title={t('vars.title')} open={open} onToggle={onToggle} aside={<span className="sec-note">{t('vars.note')}</span>}>
      {vars.map((v) => (
        <div className="row var-row" key={v.name}>
          <span className="row-label" title={t('vars.usedIn', { name: v.name, props: v.props.join(t('common.listSep')) })}>
            {v.name}
          </span>
          <div className="row-fields">
            <VarField v={v} sel={sel} ctx={ctx} colors={colors} edit={(e) => edit([v.name], e)} reset={() => reset([v.name])} />
          </div>
        </div>
      ))}
    </Section>
  );
}

function VarField(props: { v: UsedVar; sel: SelectionView; ctx: Ctx; colors: ScaleStep[] | null; edit: (e: Edit) => void; reset: () => void }) {
  const { v, sel, ctx, colors, edit } = props;
  const value = currentValue(sel, v.name);
  const pending = isPending(sel, [v.name]);
  const target = sel.targets[v.name];
  const corner = <Corner label={v.name} pending={pending} onReset={props.reset} />;
  if (v.kind === 'color') return <ColorField title={v.name} prop={v.name} value={value} steps={colors} pending={pending} target={target} corner={corner} onEdit={edit} />;
  if (v.kind === 'length' || v.kind === 'number') {
    const unitless = v.kind === 'number';
    const rem = /rem$/.test(v.value.trim());
    const n = parseCssNumber(v.value);
    return (
      <NumberField
        label={<b className="glyph">{unitless ? '#' : '↔'}</b>}
        title={v.name}
        prop={v.name}
        values={[value]}
        steps={null}
        ctx={ctx}
        pending={pending}
        target={target}
        unit={unitless ? '' : 'px'}
        stepSize={unitless && n && !Number.isInteger(n.num) ? 0.05 : 1}
        corner={corner}
        onEdit={(e) => edit(rem ? { ...e, value: pxToRem(e.value, ctx.rootPx) } : e)}
      />
    );
  }
  return <TextField title={v.name} value={value} pending={pending} target={target} corner={corner} onCommit={(s) => edit({ props: [], value: s, token: null, phase: 'commit' })} />;
}

/** 变量原来用 rem 写的，拖出来的 px 换回 rem，保持源码里的单位 */
function pxToRem(value: string, rootPx: number): string {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  return m ? `${formatNumber(parseFloat(m[1]) / rootPx, 4)}rem` : value;
}
