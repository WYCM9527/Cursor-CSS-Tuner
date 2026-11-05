/** 物理属性在 LTR、horizontal-tb 下对应的逻辑属性（Tailwind 4 的 px/py 生成 padding-inline/block） */
export const ALIASES: Record<string, string[]> = {
  'padding-top': ['padding-top', 'padding-block-start'],
  'padding-bottom': ['padding-bottom', 'padding-block-end'],
  'padding-left': ['padding-left', 'padding-inline-start'],
  'padding-right': ['padding-right', 'padding-inline-end'],
  'margin-top': ['margin-top', 'margin-block-start'],
  'margin-bottom': ['margin-bottom', 'margin-block-end'],
  'margin-left': ['margin-left', 'margin-inline-start'],
  'margin-right': ['margin-right', 'margin-inline-end'],
  top: ['top', 'inset-block-start'],
  bottom: ['bottom', 'inset-block-end'],
  left: ['left', 'inset-inline-start'],
  right: ['right', 'inset-inline-end'],
  width: ['width', 'inline-size'],
  height: ['height', 'block-size'],
  'min-width': ['min-width', 'min-inline-size'],
  'max-width': ['max-width', 'max-inline-size'],
  'min-height': ['min-height', 'min-block-size'],
  'max-height': ['max-height', 'max-block-size'],
  'border-top-left-radius': ['border-top-left-radius', 'border-start-start-radius'],
  'border-top-right-radius': ['border-top-right-radius', 'border-start-end-radius'],
  'border-bottom-right-radius': ['border-bottom-right-radius', 'border-end-end-radius'],
  'border-bottom-left-radius': ['border-bottom-left-radius', 'border-end-start-radius'],
};

/** 长写属性可能来自哪些简写（简写里有 var() 时 CSSOM 里长写值为空，要回头读简写） */
export const SHORTHANDS: Record<string, string[]> = {
  'padding-top': ['padding', 'padding-block'],
  'padding-block-start': ['padding-block', 'padding'],
  'padding-bottom': ['padding', 'padding-block'],
  'padding-block-end': ['padding-block', 'padding'],
  'padding-left': ['padding', 'padding-inline'],
  'padding-inline-start': ['padding-inline', 'padding'],
  'padding-right': ['padding', 'padding-inline'],
  'padding-inline-end': ['padding-inline', 'padding'],
  'margin-top': ['margin', 'margin-block'],
  'margin-block-start': ['margin-block', 'margin'],
  'margin-bottom': ['margin', 'margin-block'],
  'margin-block-end': ['margin-block', 'margin'],
  'margin-left': ['margin', 'margin-inline'],
  'margin-inline-start': ['margin-inline', 'margin'],
  'margin-right': ['margin', 'margin-inline'],
  'margin-inline-end': ['margin-inline', 'margin'],
  top: ['inset', 'inset-block'],
  bottom: ['inset', 'inset-block'],
  left: ['inset', 'inset-inline'],
  right: ['inset', 'inset-inline'],
  'inset-block-start': ['inset-block', 'inset'],
  'inset-block-end': ['inset-block', 'inset'],
  'inset-inline-start': ['inset-inline', 'inset'],
  'inset-inline-end': ['inset-inline', 'inset'],
  'border-top-left-radius': ['border-radius'],
  'border-top-right-radius': ['border-radius'],
  'border-bottom-right-radius': ['border-radius'],
  'border-bottom-left-radius': ['border-radius'],
  'border-start-start-radius': ['border-radius'],
  'border-start-end-radius': ['border-radius'],
  'border-end-end-radius': ['border-radius'],
  'border-end-start-radius': ['border-radius'],
  'row-gap': ['gap'],
  'column-gap': ['gap'],
  'font-family': ['font'],
  'font-size': ['font'],
  'font-weight': ['font'],
  'line-height': ['font'],
  'background-color': ['background'],
  'background-image': ['background'],
  'background-clip': ['background'],
  'background-origin': ['background'],
  'flex-direction': ['flex-flow'],
  'flex-wrap': ['flex-flow'],
  'justify-content': ['place-content'],
  'align-items': ['place-items'],
  'grid-template-columns': ['grid-template', 'grid'],
};

/** 描边的长写：border-top-width ↔ border-block-start-width，简写有边（border-top）、分量（border-width）和整体（border） */
const BORDER_SIDES = { top: 'block-start', right: 'inline-end', bottom: 'block-end', left: 'inline-start' } as const;
for (const [side, logical] of Object.entries(BORDER_SIDES)) {
  const axis = logical.split('-')[0];
  for (const part of ['width', 'style', 'color']) {
    const phys = `border-${side}-${part}`;
    const log = `border-${logical}-${part}`;
    ALIASES[phys] = [phys, log];
    SHORTHANDS[phys] = [`border-${side}`, `border-${part}`, 'border'];
    SHORTHANDS[log] = [`border-${logical}`, `border-${axis}-${part}`, `border-${axis}`];
  }
}

export function aliasesOf(prop: string): string[] {
  return ALIASES[prop] ?? [prop];
}

export function shorthandsOf(prop: string): string[] {
  return SHORTHANDS[prop] ?? [];
}

/**
 * 可按“上 右 下 左”展开的盒模型简写及其长写顺序。
 * 两值简写（padding-inline 等）按“起 止”展开；gap 是“行 列”。
 */
export const BOX_SHORTHANDS: Record<string, string[]> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-block': ['padding-top', 'padding-bottom'],
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  'inset-inline': ['left', 'right'],
  'inset-block': ['top', 'bottom'],
  gap: ['row-gap', 'column-gap'],
  ...Object.fromEntries(
    ['width', 'style', 'color'].flatMap((part) => [
      [`border-${part}`, ['top', 'right', 'bottom', 'left'].map((s) => `border-${s}-${part}`)],
      [`border-inline-${part}`, [`border-left-${part}`, `border-right-${part}`]],
      [`border-block-${part}`, [`border-top-${part}`, `border-bottom-${part}`]],
    ]),
  ),
};

/** 逻辑长写 → 物理长写（LTR） */
export function physicalOf(prop: string): string {
  for (const [phys, list] of Object.entries(ALIASES)) if (list.includes(prop)) return phys;
  return prop;
}
