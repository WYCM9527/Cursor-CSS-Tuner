import { useMemo } from 'react';
import {
  backgroundLayers,
  BORDER,
  BORDER_STYLE,
  BORDER_WIDTH,
  formatGradient,
  groupLabel,
  isGradient,
  MARGIN,
  PADDING,
  parseColor,
  parseGradient,
  primaryFamily,
  RADIUS,
  sameBackgroundImage,
  sameColor,
  sameFontStack,
  solidColorOf,
  STROKE_CLIP,
  STROKE_ORIGIN,
  strokeLayers,
  t,
  type EditRequest,
  type Gradient,
  type PanelState,
  type PanelToExt,
  type PropValue,
  type ScaleStep,
  type SelectionView,
  type Target,
} from '@css-tuner/protocol';
import { currentValue, declaredVar, isPending } from '../lib/format';
import { editableGradient, fillLayer, firstVisible, isOpaque, newGradient, opaqueGradient, type Paint, type PaintKind } from '../lib/paint';
import { ctxOf, scaleKeyOf, valuePx, type Ctx } from '../lib/scale';
import { Assets } from './Assets';
import { ColorField } from './ColorField';
import { Content } from './Content';
import { AddRemove, Corner, IconToggle, Row, Section, Segmented, SelectField, SliderField } from './controls';
import { FontField } from './FontField';
import { Icon } from './icons';
import { NumberField } from './NumberField';
import { PaintField } from './PaintField';
import { Props as PropsSection } from './Props';
import type { Edit } from './types';
import { Vars } from './Vars';

export interface UiPrefs {
  closed: string[];
  split: string[];
  /** 存下这份偏好时的默认值版本：默认值变了，旧偏好补一次（1：改动清单默认收起；2：「图片和视频」默认收起） */
  v?: number;
}

interface Props {
  state: PanelState;
  sel: SelectionView;
  prefs: UiPrefs;
  setPrefs: (p: UiPrefs) => void;
  edit: (props: string[], e: Edit) => void;
  editText: (segment: number, value: string, phase: 'live' | 'commit') => void;
  editProp: (name: string, value: PropValue, phase: 'live' | 'commit') => void;
  send: (m: PanelToExt) => void;
}

const [PT, PR, PB, PL] = PADDING;
const [MT, MR, MB, ML] = MARGIN;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];
const SIDE_ICONS = [<Icon.top key="t" />, <Icon.right key="r" />, <Icon.bottom key="b" />, <Icon.left key="l" />];
const DEFAULT_SHADOW = '0 1px 3px rgba(0, 0, 0, 0.12)';

export function Inspector({ state, sel, prefs, setPrefs, edit, editText, editProp, send }: Props) {
  const ctx = useMemo<Ctx>(() => ctxOf(sel.el), [sel.el]);
  const scales = state.scales;
  const steps = (prop: string): ScaleStep[] | null => {
    const k = scaleKeyOf(prop);
    return k && scales ? (scales[k] as ScaleStep[]) : null;
  };
  const open = (id: string) => !prefs.closed.includes(id);
  const toggle = (id: string) => setPrefs({ ...prefs, closed: open(id) ? [...prefs.closed, id] : prefs.closed.filter((x) => x !== id) });
  /** 加上属性时展开折叠着的分区，不然加了看不到 */
  const reveal = (id: string, add: () => void) => () => {
    if (!open(id)) toggle(id);
    add();
  };
  const split = (id: string) => prefs.split.includes(id);
  const toggleSplit = (id: string) => setPrefs({ ...prefs, split: split(id) ? prefs.split.filter((x) => x !== id) : [...prefs.split, id] });

  const commit = (props: string[], value: string, token: string | null = null) => edit(props, { props: [], value, token, phase: 'commit' });
  const remove = (props: string[]) => edit(props, { props: [], value: '', token: null, phase: 'commit', remove: true });
  const removed = (props: readonly string[]) => props.filter((p) => sel.removed.includes(p));
  /** 还能删的：值来自源码里的声明，而且还没删 */
  const removable = (props: readonly string[]) => props.some((p) => sel.targets[p]?.declared && !sel.removed.includes(p));
  const corner = (props: string[]) => (
    <Corner label={groupLabel(props)} pending={isPending(sel, props)} onReset={() => send({ t: 'resetProps', props })} onRemove={removable(props) ? () => remove(props) : null} />
  );

  const num = (props: string[], label: React.ReactNode, title: string, extra: Partial<React.ComponentProps<typeof NumberField>> = {}) => (
    <NumberField
      key={props.join(',')}
      label={label}
      title={title}
      prop={props[0]}
      values={props.map((p) => currentValue(sel, p))}
      steps={steps(props[0])}
      ctx={ctx}
      snap={state.snap}
      pending={isPending(sel, props)}
      target={sel.targets[props[0]]}
      declared={props.length === 1 && !(props[0] in sel.pending) ? declaredVar(sel.el, props[0]) : null}
      corner={corner(props)}
      onEdit={(e) => edit(props, e)}
      {...extra}
    />
  );

  const kw = (prop: string) => ({
    value: currentValue(sel, prop),
    pending: isPending(sel, [prop]),
    target: sel.targets[prop],
    corner: corner([prop]),
    onPick: (v: string) => commit([prop], v),
  });

  const req = (props: string[], value: string, token: string | null = null): EditRequest => ({ props, value, token, phase: 'commit' });
  const many = (edits: EditRequest[]) => send({ t: 'editMany', edits });
  /** 去掉一个属性：源码里写的删掉，不然改成空值（写在 background 简写里的背景图删不干净，也改成空值） */
  const clear = (prop: string, empty: string): EditRequest =>
    removable([prop]) && (prop === 'background-color' || sel.el.winners[prop]?.via !== 'background') ? { ...req([prop], ''), remove: true } : req([prop], empty);

  const sides = strokeSides(sel, ctx);
  const tailwind = scales?.mode === 'tailwind';
  const styleProps = strokeProps('style', sides, tailwind);
  const colorProps = strokeProps('color', sides, tailwind);
  const gradientIn = scales?.gradientIn ?? '';

  // 填充和描边的渐变：背景图是一层渐变就是渐变填充；渐变描边用两层背景叠出来
  // （上层是填充、只铺到内边距，下层是描边渐变、铺到边框，边框颜色透明）。
  // 没有不透明的填充时两层背景会把元素里面也盖住，这种描边交给 Agent，扩展只拿两层背景预览
  const bgColor = currentValue(sel, 'background-color');
  const image = currentValue(sel, 'background-image');
  const layers = strokeLayers(image, currentValue(sel, 'background-clip'));
  const agentStroke = isGradient(sel.pending[colorProps[0]] ?? '') ? sel.pending[colorProps[0]] : null;
  const layered = !agentStroke && layers && colorProps.every((p) => parseColor(currentValue(sel, p))?.a === 0) ? layers : null;
  const fillImage = layered ? layered.fill : agentStroke && layers && sameBackgroundImage(layers.stroke, agentStroke) ? 'none' : image;
  const fillLayers = backgroundLayers(fillImage).length;
  const fillGradient = editableGradient(fillImage);
  const fillSolid = layered ? solidColorOf(layered.fill) : null;
  const fillPaint: Paint = fillSolid
    ? { kind: 'solid', color: fillSolid }
    : fillGradient
      ? { kind: 'gradient', gradient: fillGradient }
      : fillLayers
        ? { kind: 'complex', image: fillImage }
        : { kind: 'solid', color: bgColor };
  const strokeImage = agentStroke ?? layered?.stroke ?? null;
  const strokeGradient = strokeImage ? parseGradient(strokeImage) : null;
  const strokePaint: Paint = strokeGradient
    ? { kind: 'gradient', gradient: strokeGradient }
    : strokeImage
      ? { kind: 'complex', image: strokeImage }
      : { kind: 'solid', color: currentValue(sel, colorProps[0]) };
  const strokeIsGradient = !!strokeImage;
  /** 能垫在描边渐变上面的填充层：得不透明，不然描边的渐变会从元素里面透出来 */
  const opaqueFill = (): string | null => {
    if (layered) return layered.fill;
    if (fillGradient) return opaqueGradient(fillGradient) ? backgroundLayers(fillImage)[0] : null;
    if (fillLayers) return null;
    return isOpaque(bgColor) ? fillLayer(bgColor) : null;
  };
  const layeredEdits = (fill: string, stroke: string): EditRequest[] => [
    req(['background-image'], `${fill}, ${stroke}`),
    req(['background-clip'], STROKE_CLIP),
    req(['background-origin'], STROKE_ORIGIN),
    req(colorProps, 'transparent'),
  ];
  /** 拆掉两层背景：背景图只留填充（纯色的填充层回到背景色），裁剪和铺设范围回到默认 */
  const unlayerEdits = (fill: string): EditRequest[] => {
    const solid = solidColorOf(fill);
    return [
      req(['background-image'], solid ? 'none' : fill),
      ...(solid && !sameColor(solid, bgColor) ? [req(['background-color'], solid)] : []),
      req(['background-clip'], 'border-box'),
      req(['background-origin'], 'padding-box'),
    ];
  };

  // 填充：背景色看得见或者有背景图才算有；加上是白色，减掉是删声明（不是写在源码里的就改成透明）
  const hasFill = visible(bgColor) || fillLayers > 0;
  const addFill = () => {
    const white = scales?.colors.find((s) => s.label === 'white');
    const color = white?.value ?? '#ffffff';
    const token = white ? (white.token ?? white.label) : null;
    // 渐变描边之前没有填充只能交给 Agent，有了填充就能用两层背景写（填充和描边一起改，不走撤销删除）
    if (agentStroke) return many([req(['background-color'], color, token), ...layeredEdits(fillLayer(color), agentStroke)]);
    if (removed(['background-color']).length) return send({ t: 'resetProps', props: ['background-color'] });
    commit(['background-color'], color, token);
  };
  const removeFill = () => {
    if (layered) {
      return many([clear('background-color', 'transparent'), clear('background-image', 'none'), req(['background-clip'], 'border-box'), req(['background-origin'], 'padding-box'), req(colorProps, layered.stroke)]);
    }
    if (fillLayers) return many([...(visible(bgColor) ? [clear('background-color', 'transparent')] : []), clear('background-image', 'none')]);
    return removable(['background-color']) ? remove(['background-color']) : commit(['background-color'], 'transparent');
  };
  const onFillSolid = (e: Edit) => {
    if (!layered) return edit(['background-color'], e);
    // 两层背景时看得见的是上层，背景色一起改，拆掉两层背景后还是这个颜色
    const top = `${fillLayer(e.value)}, ${layered.stroke}`;
    if (e.phase === 'live') {
      edit(['background-image'], { ...e, value: top, token: null });
      return edit(['background-color'], e);
    }
    many([req(['background-image'], top), req(['background-color'], e.value, e.token)]);
  };
  const onFillGradient = (g: Gradient, phase: 'live' | 'commit') => {
    const v = formatGradient(g);
    edit(['background-image'], { props: [], value: layered ? `${v}, ${layered.stroke}` : v, token: null, phase });
  };
  const onFillKind = (k: PaintKind) => {
    const g = fillPaint.kind === 'gradient' ? fillPaint.gradient : null;
    if (k === 'solid') {
      const color = visible(bgColor) ? bgColor : g ? firstVisible(g) : '#ffffff';
      if (layered) return many([req(['background-image'], `${fillLayer(color)}, ${layered.stroke}`), ...(sameColor(color, bgColor) ? [] : [req(['background-color'], color)])]);
      return many([clear('background-image', 'none'), ...(visible(bgColor) ? [] : [req(['background-color'], color)])]);
    }
    if (g) return onFillGradient({ ...g, type: k, dir: k === 'linear' ? 'to right' : '' }, 'commit');
    // 纯色换成渐变：从这个颜色过渡到透明，背景色去掉（不然会从渐变透明的地方露出来）
    const from = fillPaint.kind === 'solid' && visible(fillPaint.color) ? fillPaint.color : '#ffffff';
    const next = formatGradient(newGradient(k, from, gradientIn, !!layered));
    if (layered) return many([req(['background-image'], `${next}, ${layered.stroke}`)]);
    many([req(['background-image'], next), ...(visible(bgColor) ? [clear('background-color', 'transparent')] : [])]);
  };

  // 描边：看得见的边（粗细大于 0、样式不是 none）；加上是 1px 实线，减掉是删掉四边的声明
  const addStroke = () => {
    if (removed(BORDER).length) return send({ t: 'resetProps', props: removed(BORDER) });
    // 样式是 none 时算出来的粗细总是 0（会当成没改），所以先改样式
    const edits: EditRequest[] = [];
    if (BORDER_STYLE.some((p) => /^(none|hidden)$/.test(currentValue(sel, p)))) edits.push({ props: BORDER_STYLE, value: 'solid', token: null, phase: 'commit' });
    edits.push({ props: BORDER_WIDTH, value: '1px', token: null, phase: 'commit' });
    send({ t: 'editMany', edits });
  };
  const removeStroke = () => {
    const border = removable(BORDER) ? [{ ...req(BORDER, ''), remove: true }] : [req(BORDER_WIDTH, '0px')];
    if (layered) return many([...unlayerEdits(layered.fill), ...border]);
    if (agentStroke) send({ t: 'resetProps', props: colorProps });
    many(border);
  };
  const onStrokeGradient = (g: Gradient, phase: 'live' | 'commit') => {
    const v = formatGradient(g);
    if (layered) return edit(['background-image'], { props: [], value: `${layered.fill}, ${v}`, token: null, phase });
    edit(colorProps, { props: [], value: v, token: null, phase });
  };
  const onStrokeKind = (k: PaintKind) => {
    const g = strokePaint.kind === 'gradient' ? strokePaint.gradient : null;
    if (k === 'solid') {
      const color = g ? firstVisible(g) : '#000000';
      if (layered) return many([...unlayerEdits(layered.fill), req(colorProps, color)]);
      return commit(colorProps, color);
    }
    if (g) return onStrokeGradient({ ...g, type: k, dir: k === 'linear' ? 'to right' : '' }, 'commit');
    const current = currentValue(sel, colorProps[0]);
    const next = formatGradient(newGradient(k, visible(current) ? current : '#000000', gradientIn));
    const fill = opaqueFill();
    if (fill) return many(layeredEdits(fill, next));
    commit(colorProps, next);
  };
  /** 两层背景时填充和描边是一起写的，重置也一起 */
  const paintProps = ['background-color', 'background-image', 'background-clip', 'background-origin', ...colorProps];
  const fillProps = layered ? paintProps : fillLayers ? ['background-color', 'background-image'] : ['background-color'];
  const strokeColorProps = layered ? paintProps : colorProps;
  const strokeTarget: Target | undefined = agentStroke
    ? { ...(sel.targets[colorProps[0]] ?? { label: '', affects: 1 }), kind: 'agent', reason: t('ext.plan.strokeGradient') }
    : layered
      ? sel.targets['background-image']
      : sel.targets[colorProps[0]];

  // 投影：加上是刻度里的 sm（没有就取第一档），减掉是删声明（不是写在源码里的就改成 none）
  const shadow = currentValue(sel, 'box-shadow');
  const hasShadow = !!shadow && shadow !== 'none';
  const addShadow = () => {
    if (removed(['box-shadow']).length) return send({ t: 'resetProps', props: ['box-shadow'] });
    const shadows = (scales?.shadow ?? []).filter((s) => s.value && s.value !== 'none');
    const s = shadows.find((x) => x.label === 'sm') ?? shadows[0];
    commit(['box-shadow'], s?.value ?? DEFAULT_SHADOW, s?.token ?? null);
  };
  const removeShadow = () => (removable(['box-shadow']) ? remove(['box-shadow']) : commit(['box-shadow'], 'none'));

  const display = currentValue(sel, 'display');
  const isFlex = /flex/.test(display);
  const isGrid = /grid/.test(display);
  const vertical = isFlex && /column/.test(currentValue(sel, 'flex-direction'));
  const wraps = currentValue(sel, 'flex-wrap').startsWith('wrap');
  const position = currentValue(sel, 'position');

  return (
    <div className="inspector">
      <Content sel={sel} open={open('content')} onToggle={toggle} editText={editText} resetText={(segment) => send({ t: 'resetText', segment })} />
      <PropsSection sel={sel} ctx={ctx} open={open('props')} onToggle={toggle} editProp={editProp} send={send} />

      <Section id="layout" title={t('insp.layout')} open={open('layout')} onToggle={toggle}>
        <Row label={t('insp.display')}>
          <Segmented
            {...kw('display')}
            value={isFlex ? 'flex' : isGrid ? 'grid' : display}
            options={[
              { value: 'block', label: t('insp.display.block'), title: t('insp.display.block.title') },
              { value: 'flex', label: t('insp.display.flex'), title: t('insp.display.flex.title') },
              { value: 'grid', label: t('insp.display.grid'), title: t('insp.display.grid.title') },
              { value: 'inline-block', label: t('insp.display.inline'), title: t('insp.display.inline.title') },
              { value: 'none', label: t('insp.display.none'), title: t('insp.display.none.title') },
            ]}
          />
        </Row>
        {isFlex && (
          <Row label={t('insp.direction')}>
            <Segmented
              {...kw('flex-direction')}
              options={[
                { value: 'row', label: <b className="glyph">→</b>, title: t('insp.dir.row') },
                { value: 'column', label: <b className="glyph">↓</b>, title: t('insp.dir.column') },
                { value: 'row-reverse', label: <b className="glyph">←</b>, title: t('insp.dir.rowReverse') },
                { value: 'column-reverse', label: <b className="glyph">↑</b>, title: t('insp.dir.columnReverse') },
              ]}
            />
            <IconToggle on={wraps} title={wraps ? t('insp.wrap.on') : t('insp.wrap.off')} onClick={() => edit(['flex-wrap'], { props: [], value: wraps ? 'nowrap' : 'wrap', token: null, phase: 'commit' })}>
              <Icon.wrap />
            </IconToggle>
          </Row>
        )}
        {isGrid && (
          <Row label={t('insp.columns')}>
            <NumberField
              label={<b className="glyph">#</b>}
              title={t('insp.columns.title')}
              prop="grid-template-columns"
              values={[trackCount(currentValue(sel, 'grid-template-columns'))]}
              steps={null}
              ctx={ctx}
              snap={state.snap}
              pending={isPending(sel, ['grid-template-columns'])}
              target={sel.targets['grid-template-columns']}
              unit=""
              min={1}
              max={24}
              corner={corner(['grid-template-columns'])}
              onEdit={(e) => edit(['grid-template-columns'], { ...e, value: /^\d+$/.test(e.value) ? `repeat(${e.value}, minmax(0, 1fr))` : e.value })}
            />
          </Row>
        )}
        {(isFlex || isGrid) && (
          <>
            <Row label={t('insp.justify')}>
              <Segmented
                {...kw('justify-content')}
                value={justifyOf(currentValue(sel, 'justify-content'))}
                className={vertical ? 'rot' : undefined}
                options={[
                  { value: 'flex-start', label: <Icon.jStart />, title: t('insp.at.start') },
                  { value: 'center', label: <Icon.jCenter />, title: t('insp.at.center') },
                  { value: 'flex-end', label: <Icon.jEnd />, title: t('insp.at.end') },
                  { value: 'space-between', label: <Icon.jBetween />, title: t('insp.at.between') },
                  { value: 'space-around', label: <Icon.jAround />, title: t('insp.at.around') },
                  { value: 'space-evenly', label: <Icon.jEvenly />, title: t('insp.at.evenly') },
                ]}
              />
            </Row>
            <Row label={t('insp.align')}>
              <Segmented
                {...kw('align-items')}
                value={alignItemsOf(currentValue(sel, 'align-items'))}
                className={vertical ? 'rot-ccw' : undefined}
                options={[
                  { value: 'flex-start', label: <Icon.aStart />, title: t('insp.at.start') },
                  { value: 'center', label: <Icon.aCenter />, title: t('insp.at.center') },
                  { value: 'flex-end', label: <Icon.aEnd />, title: t('insp.at.end') },
                  { value: 'stretch', label: <Icon.aStretch />, title: t('insp.at.stretch') },
                  { value: 'baseline', label: <Icon.aBaseline />, title: t('insp.at.baseline') },
                ]}
              />
            </Row>
            <Row label={t('insp.gap')}>
              {split('gap') ? (
                <>
                  {num(['row-gap'], <b className="glyph">{t('insp.gap.rowGlyph')}</b>, t('insp.gap.row'))}
                  {num(['column-gap'], <b className="glyph">{t('insp.gap.columnGlyph')}</b>, t('insp.gap.column'))}
                </>
              ) : (
                num(['row-gap', 'column-gap'], <Icon.padX />, t('insp.gap.both'))
              )}
              <IconToggle on={split('gap')} title={t('insp.gap.split')} onClick={() => toggleSplit('gap')}>
                <Icon.sides />
              </IconToggle>
            </Row>
          </>
        )}
      </Section>

      <Section id="spacing" title={t('insp.spacing')} open={open('spacing')} onToggle={toggle}>
        <BoxRow
          label={t('insp.padding')}
          id="padding"
          split={split('padding')}
          onSplit={toggleSplit}
          pair={[num([PL, PR], <Icon.padX />, t('insp.padding.x')), num([PT, PB], <Icon.padY />, t('insp.padding.y'))]}
          sides={[
            num([PT], <Icon.top />, t('insp.padding.top')),
            num([PR], <Icon.right />, t('insp.padding.right')),
            num([PB], <Icon.bottom />, t('insp.padding.bottom')),
            num([PL], <Icon.left />, t('insp.padding.left')),
          ]}
        />
        <BoxRow
          label={t('insp.margin')}
          id="margin"
          split={split('margin')}
          onSplit={toggleSplit}
          pair={[num([ML, MR], <Icon.padX />, t('insp.margin.x')), num([MT, MB], <Icon.padY />, t('insp.margin.y'))]}
          sides={[
            num([MT], <Icon.top />, t('insp.margin.top')),
            num([MR], <Icon.right />, t('insp.margin.right')),
            num([MB], <Icon.bottom />, t('insp.margin.bottom')),
            num([ML], <Icon.left />, t('insp.margin.left')),
          ]}
        />
      </Section>

      <Section id="size" title={t('insp.size')} open={open('size')} onToggle={toggle} aside={<MoreToggle on={split('size-more')} onClick={() => toggleSplit('size-more')} />}>
        <Row label={t('insp.size.wh')}>
          {num(['width'], <Icon.w />, t('insp.width'))}
          {num(['height'], <Icon.h />, t('insp.height'))}
        </Row>
        {split('size-more') && (
          <>
            <Row label={t('insp.size.min')}>
              {num(['min-width'], <Icon.w />, t('insp.minWidth'))}
              {num(['min-height'], <Icon.h />, t('insp.minHeight'))}
            </Row>
            <Row label={t('insp.size.max')}>
              {num(['max-width'], <Icon.w />, t('insp.maxWidth'))}
              {num(['max-height'], <Icon.h />, t('insp.maxHeight'))}
            </Row>
          </>
        )}
      </Section>

      <Section id="position" title={t('insp.position')} open={open('position')} onToggle={toggle}>
        <Row label={t('insp.pos.mode')}>
          <Segmented
            {...kw('position')}
            options={[
              { value: 'static', label: t('insp.pos.static'), title: t('insp.pos.static.title') },
              { value: 'relative', label: t('insp.pos.relative'), title: t('insp.pos.relative.title') },
              { value: 'absolute', label: t('insp.pos.absolute'), title: t('insp.pos.absolute.title') },
              { value: 'fixed', label: t('insp.pos.fixed'), title: t('insp.pos.fixed.title') },
              { value: 'sticky', label: t('insp.pos.sticky'), title: t('insp.pos.sticky.title') },
            ]}
          />
        </Row>
        {position !== 'static' && (
          <Row label={t('insp.offset')}>
            <div className="quad">
              {num(['top'], <Icon.top />, t('insp.offset.top'))}
              {num(['right'], <Icon.right />, t('insp.offset.right'))}
              {num(['bottom'], <Icon.bottom />, t('insp.offset.bottom'))}
              {num(['left'], <Icon.left />, t('insp.offset.left'))}
            </div>
          </Row>
        )}
        <Row label={t('insp.zIndex')}>{num(['z-index'], <Icon.layers />, t('insp.zIndex.title'), { unit: '' })}</Row>
      </Section>

      <Section id="typography" title={t('insp.typography')} open={open('typography')} onToggle={toggle}>
        <Row label={t('insp.font')}>
          <FontField
            title={t('insp.font')}
            value={currentValue(sel, 'font-family')}
            display={fontLabel(sel, scales?.fontFamily)}
            steps={scales?.fontFamily ?? []}
            vars={!tailwind}
            fonts={state.fonts}
            pending={isPending(sel, ['font-family'])}
            target={sel.targets['font-family']}
            corner={corner(['font-family'])}
            onOpen={() => send({ t: 'fontsOpen' })}
            onEdit={(e) => edit(['font-family'], e)}
          />
        </Row>
        <Row label={t('insp.sizeWeight')}>
          {num(['font-size'], <b className="glyph">T</b>, t('insp.fontSize'), { min: 0 })}
          <SelectField
            title={t('insp.fontWeight')}
            value={currentValue(sel, 'font-weight')}
            display={weightLabel(currentValue(sel, 'font-weight'), scales?.fontWeight)}
            steps={scales?.fontWeight ?? []}
            pending={isPending(sel, ['font-weight'])}
            target={sel.targets['font-weight']}
            describe={(s) => s.value}
            corner={corner(['font-weight'])}
            onEdit={(e) => edit(['font-weight'], e)}
          />
        </Row>
        <Row label={t('insp.lineLetter')}>
          {num(['line-height'], <b className="glyph">↕</b>, t('insp.lineHeight'), { min: 0 })}
          {num(['letter-spacing'], <b className="glyph">↔</b>, t('insp.letterSpacing'), { stepSize: 0.1 })}
        </Row>
        <Row label={t('insp.align')}>
          <Segmented
            value={alignOf(currentValue(sel, 'text-align'))}
            pending={isPending(sel, ['text-align'])}
            target={sel.targets['text-align']}
            corner={corner(['text-align'])}
            options={[
              { value: 'left', label: <Icon.alignLeft />, title: t('insp.ta.left') },
              { value: 'center', label: <Icon.alignCenter />, title: t('insp.ta.center') },
              { value: 'right', label: <Icon.alignRight />, title: t('insp.ta.right') },
              { value: 'justify', label: <Icon.alignJustify />, title: t('insp.ta.justify') },
            ]}
            onPick={(v) => commit(['text-align'], v)}
          />
        </Row>
        <Row label={t('insp.color')}>
          <ColorField
            title={t('insp.textColor')}
            prop="color"
            value={currentValue(sel, 'color')}
            steps={scales?.colors ?? null}
            pending={isPending(sel, ['color'])}
            target={sel.targets['color']}
            declared={'color' in sel.pending ? null : declaredVar(sel.el, 'color')}
            corner={corner(['color'])}
            onEdit={(e) => edit(['color'], e)}
          />
        </Row>
      </Section>

      <Section
        id="fill"
        title={t('insp.fill')}
        open={open('fill')}
        onToggle={toggle}
        empty={!hasFill}
        aside={<AddRemove present={hasFill} name={t('insp.fill')} onAdd={reveal('fill', addFill)} onRemove={removeFill} />}
      >
        <Row label={t('insp.background')}>
          <PaintField
            title={t('insp.bgColor')}
            paint={fillPaint}
            steps={scales?.colors ?? null}
            pending={isPending(sel, fillProps)}
            target={fillProps.length > 1 ? (sel.targets['background-image'] ?? sel.targets['background-color']) : sel.targets['background-color']}
            declared={fillProps.length > 1 || 'background-color' in sel.pending ? null : declaredVar(sel.el, 'background-color')}
            corner={
              fillProps.length > 1 ? (
                <Corner label={groupLabel(fillProps)} pending={isPending(sel, fillProps)} onReset={() => send({ t: 'resetProps', props: fillProps })} onRemove={removable(['background-color', 'background-image']) ? removeFill : null} />
              ) : (
                corner(fillProps)
              )
            }
            cssVars={!tailwind}
            onSolid={onFillSolid}
            onGradient={onFillGradient}
            onKind={onFillKind}
          />
        </Row>
      </Section>

      <Section
        id="stroke"
        title={t('insp.stroke')}
        open={open('stroke')}
        onToggle={toggle}
        empty={!sides.length}
        aside={<AddRemove present={sides.length > 0} name={t('insp.stroke')} onAdd={reveal('stroke', addStroke)} onRemove={removeStroke} />}
      >
        <Row label={t('insp.stroke.width')}>
          {split('stroke') ? (
            <div className="quad">
              {BORDER_WIDTH.map((p, i) => num([p], SIDE_ICONS[i], t((['insp.stroke.top', 'insp.stroke.right', 'insp.stroke.bottom', 'insp.stroke.left'] as const)[i]), { min: 0 }))}
            </div>
          ) : (
            num(BORDER_WIDTH, <Icon.stroke />, t('insp.stroke.width'), { min: 0 })
          )}
          <IconToggle on={split('stroke')} title={t('insp.stroke.split')} onClick={() => toggleSplit('stroke')}>
            <Icon.sides />
          </IconToggle>
        </Row>
        <Row label={t('insp.stroke.style')}>
          {strokeIsGradient ? (
            <div className="row-note">{t('insp.stroke.gradientSolidOnly')}</div>
          ) : (
            <Segmented
              value={currentValue(sel, styleProps[0])}
              pending={isPending(sel, styleProps)}
              target={sel.targets[styleProps[0]]}
              corner={corner(styleProps)}
              options={[
                { value: 'solid', label: <Icon.solid />, title: t('insp.stroke.solid') },
                { value: 'dashed', label: <Icon.dashed />, title: t('insp.stroke.dashed') },
                { value: 'dotted', label: <Icon.dotted />, title: t('insp.stroke.dotted') },
              ]}
              onPick={(v) => commit(styleProps, v)}
            />
          )}
        </Row>
        <Row label={t('insp.stroke.color')}>
          <PaintField
            title={t('insp.stroke.color')}
            paint={strokePaint}
            steps={scales?.colors ?? null}
            pending={isPending(sel, strokeColorProps)}
            target={strokeTarget}
            declared={strokeIsGradient || colorProps[0] in sel.pending ? null : declaredVar(sel.el, colorProps[0])}
            corner={
              strokeIsGradient ? (
                <Corner label={groupLabel(strokeColorProps)} pending={isPending(sel, strokeColorProps)} onReset={() => send({ t: 'resetProps', props: strokeColorProps })} onRemove={null} />
              ) : (
                corner(colorProps)
              )
            }
            note={agentStroke ? t('insp.stroke.gradientNoFill') : null}
            cssVars={!tailwind}
            onSolid={(e) => edit(colorProps, e)}
            onGradient={onStrokeGradient}
            onKind={onStrokeKind}
          />
        </Row>
      </Section>

      <Section id="radius" title={t('insp.radius')} open={open('radius')} onToggle={toggle}>
        <Row label={t('insp.radius')}>
          {split('radius') ? (
            <div className="quad">
              {RADIUS.map((p, i) =>
                num([p], <b className="glyph">{['↖', '↗', '↘', '↙'][i]}</b>, t((['insp.radius.tl', 'insp.radius.tr', 'insp.radius.br', 'insp.radius.bl'] as const)[i]), { min: 0 }),
              )}
            </div>
          ) : (
            num(RADIUS, <Icon.radius />, t('insp.radius'), { min: 0 })
          )}
          <IconToggle on={split('radius')} title={t('insp.radius.split')} onClick={() => toggleSplit('radius')}>
            <Icon.corners />
          </IconToggle>
        </Row>
      </Section>

      <Section
        id="shadow"
        title={t('insp.shadow')}
        open={open('shadow')}
        onToggle={toggle}
        empty={!hasShadow}
        aside={<AddRemove present={hasShadow} name={t('insp.shadow')} onAdd={reveal('shadow', addShadow)} onRemove={removeShadow} />}
      >
        <Row label={t('insp.shadow')}>
          <SelectField
            title={t('insp.shadow')}
            value={shadow}
            display={shadowLabel(sel, scales?.shadow)}
            steps={scales?.shadow ?? []}
            pending={isPending(sel, ['box-shadow'])}
            target={sel.targets['box-shadow']}
            describe={() => ''}
            corner={corner(['box-shadow'])}
            onEdit={(e) => edit(['box-shadow'], e)}
          />
        </Row>
      </Section>

      <Section id="effects" title={t('insp.effects')} open={open('effects')} onToggle={toggle}>
        <Row label={t('insp.opacity')}>
          <SliderField
            title={t('insp.opacity')}
            value={Math.round(parseFloat(currentValue(sel, 'opacity') || '1') * 100)}
            min={0}
            max={100}
            step={1}
            pending={isPending(sel, ['opacity'])}
            format={(n) => `${n}%`}
            corner={corner(['opacity'])}
            onEdit={(n, phase) => edit(['opacity'], { props: [], value: String(n / 100), token: opacityToken(n, scales?.opacity), phase })}
          />
        </Row>
      </Section>

      <Vars sel={sel} ctx={ctx} snap={state.snap} colors={scales?.colors ?? null} open={open('vars')} onToggle={toggle} edit={edit} reset={(props) => send({ t: 'resetProps', props })} />
      <Assets sel={sel} open={open('assets')} onToggle={toggle} send={send} />
    </div>
  );
}

function BoxRow(props: { label: string; id: string; split: boolean; onSplit: (id: string) => void; pair: React.ReactNode[]; sides: React.ReactNode[] }) {
  return (
    <Row label={props.label}>
      {props.split ? <div className="quad">{props.sides}</div> : props.pair}
      <IconToggle on={props.split} title={t('insp.sides.split')} onClick={() => props.onSplit(props.id)}>
        <Icon.sides />
      </IconToggle>
    </Row>
  );
}

function MoreToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className="link-btn" onClick={onClick}>
      {on ? t('insp.size.less') : t('insp.size.more')}
    </button>
  );
}

function alignOf(v: string): string {
  if (v === 'start' || v === '-webkit-left') return 'left';
  if (v === 'end' || v === '-webkit-right') return 'right';
  if (v === '-webkit-center') return 'center';
  return v;
}

function justifyOf(v: string): string {
  if (v === 'start' || v === 'left' || v === 'normal') return 'flex-start';
  if (v === 'end' || v === 'right') return 'flex-end';
  return v;
}

function alignItemsOf(v: string): string {
  if (v === 'start' || v === 'self-start') return 'flex-start';
  if (v === 'end' || v === 'self-end') return 'flex-end';
  if (v === 'normal') return 'stretch';
  return v;
}

/** 网格列数：`repeat(3, …)` 或计算值里的轨道个数（去掉 [线名]） */
function trackCount(v: string): string {
  const m = /^repeat\(\s*(\d+)/.exec(v.trim());
  if (m) return m[1];
  if (!v || v === 'none') return v;
  const tracks = v.replace(/\[[^\]]*\]/g, ' ').trim();
  if (!tracks || /repeat\(|minmax\(|subgrid|masonry/.test(tracks)) return v;
  return String(tracks.split(/\s+/).length);
}

/** 颜色看得见：不是空值、不是全透明（变量这类认不出的当作看得见） */
function visible(color: string): boolean {
  return !!color && (parseColor(color)?.a ?? 1) > 0;
}

/** 看得见描边的那几边：粗细大于 0、样式不是 none / hidden */
function strokeSides(sel: SelectionView, ctx: Ctx): Side[] {
  return SIDES.filter((s) => {
    const style = currentValue(sel, `border-${s}-style`);
    return (valuePx(currentValue(sel, `border-${s}-width`), ctx, `border-${s}-width`) ?? 0) > 0 && style !== 'none' && style !== 'hidden';
  });
}

/**
 * 改描边样式 / 颜色时动哪几边：看得见的是四边、一对边（上下 / 左右）或单独一边就只改它们，其余情况四边一起改；
 * Tailwind 的样式类只有四边一起的
 */
function strokeProps(part: 'style' | 'color', sides: Side[], tailwind: boolean): string[] {
  const key = sides.join();
  const exact = sides.length === 1 || sides.length === 4 || key === 'top,bottom' || key === 'right,left';
  return (exact && !(part === 'style' && tailwind) ? sides : SIDES).map((s) => `border-${s}-${part}`);
}

/** 字体字段上的名字：主题里的字体显示令牌名，源码写的是变量时显示变量名，其余显示首选的字体 */
function fontLabel(sel: SelectionView, steps: ScaleStep[] | undefined): string {
  const value = currentValue(sel, 'font-family');
  const step = steps?.find((s) => sameFontStack(s.value, value));
  if (step) return step.label;
  if (!('font-family' in sel.pending)) {
    // Tailwind 4 的 font-sans 生成的是 var(--font-sans)，next/font 这类变量算出来的字体栈对不上主题的值，按类名认
    const utility = sel.el.winners['font-family']?.rule?.utility?.replace(/^.*:/, '');
    const token = utility?.startsWith('font-') ? steps?.find((s) => s.token === utility.slice(5)) : undefined;
    if (token) return token.label;
    const v = declaredVar(sel.el, 'font-family');
    if (v) return v;
  }
  return primaryFamily(value) || value;
}

function weightLabel(value: string, steps: ScaleStep[] | undefined): string {
  return steps?.find((x) => x.value === value)?.label ?? value;
}

function opacityToken(n: number, steps: ScaleStep[] | undefined): string | null {
  const s = steps?.find((x) => Math.abs(parseFloat(x.value) * 100 - n) < 0.5);
  return s?.token ?? null;
}

function shadowLabel(sel: SelectionView, steps: ScaleStep[] | undefined): string {
  const pending = sel.pending['box-shadow'];
  if (pending) return steps?.find((s) => s.value === pending)?.label ?? t('insp.custom');
  const w = sel.el.winners['box-shadow'];
  if (w?.rule?.utility) return w.rule.utility.replace(/^.*:/, '');
  const v = declaredVar(sel.el, 'box-shadow');
  if (v) return v;
  const computed = sel.el.computed['box-shadow'];
  if (!computed || computed === 'none') return t('insp.none');
  return steps?.find((s) => s.value === computed)?.label ?? t('insp.custom');
}
