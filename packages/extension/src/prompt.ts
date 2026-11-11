import { groupLabel, PROP_GROUPS, t } from '@css-tuner/protocol';
import type { ProjectResolver } from './project';
import type { ChangeRecord, RecordLink } from './records';

export interface HandoffContext {
  pageUrl: string;
  project: Pick<ProjectResolver, 'label'>;
  /** Tailwind 项目：令牌写成「Tailwind 令牌 N」 */
  tailwind: boolean;
}

function where(rec: ChangeRecord, project: HandoffContext['project']): string {
  const src = rec.element.source;
  const file = src?.file ?? (rec.view.file || null);
  const parts: string[] = [];
  if (file && src) parts.push(`${project.label(file)}:${src.line}:${src.column}`);
  else if (src) parts.push(`${src.path}:${src.line}:${src.column}`);
  if (src?.component) parts.push(t('handoff.component', { name: src.component }));
  if (!src && rec.element.path) parts.push(t('handoff.pagePath', { path: rec.element.path }));
  return parts.join(t('common.comma'));
}

/** 要改的代码就在元素那一行（元素自己的 className 之类），位置已经写在元素后面 */
function atElement(rec: ChangeRecord): boolean {
  const src = rec.element.source;
  const { file, line } = rec.view;
  return !!src && !!file && line === src.line && (!src.file || src.file === file);
}

function valueText(value: string, token: string | null, tailwind: boolean): string {
  if (!token || token === value) return value;
  return t(tailwind ? 'handoff.twToken' : 'handoff.token', { value, token });
}

/** 面板上的 padding-x 这类组名不是 CSS，换成逻辑属性 */
const LOGICAL: Record<string, string> = { 'padding-x': 'padding-inline', 'padding-y': 'padding-block', 'margin-x': 'margin-inline', 'margin-y': 'margin-block' };

function propsText(props: string[]): string {
  const group = groupLabel(props);
  return LOGICAL[group] ?? (group in PROP_GROUPS ? group : props.join(' / '));
}

function ruleText(rec: ChangeRecord): string | null {
  if (rec.preview.kind !== 'rule') return null;
  const r = rec.preview.rule;
  const cond = r.conditions.filter((c) => !c.startsWith('@layer')).join(' ');
  return `${cond ? `${cond} ` : ''}${r.fullSelector}`;
}

/** 应用：照预览改进源码；还原：把之前应用的改回原样 */
export type PromptMode = 'apply' | 'revert';

/** 这一条要做的改动；back 是改回原样，箭头反过来 */
function changeLines(rec: ChangeRecord, tw: boolean, back: boolean): string[] {
  const arrow = (from: string, to: string) => (back ? { from: to, to: from } : { from, to });
  switch (rec.kind) {
    case 'text': {
      const lines = [t('handoff.text', arrow(JSON.stringify(rec.from), JSON.stringify(rec.to)))];
      if (rec.detail?.origin) lines.push(t('handoff.text.origin', { origin: rec.detail.origin }));
      return lines;
    }
    case 'reorder': {
      const lines = [t('handoff.reorder', arrow(rec.from, rec.to))];
      const order = back ? rec.detail?.was : rec.detail?.order;
      if (order?.length) lines.push(t('handoff.reorder.order', { order: order.join(t('common.listSep')) }));
      return lines;
    }
    case 'prop': {
      const lines = [t('handoff.prop', { component: rec.detail?.component ?? '?', name: rec.props[0] ?? rec.propLabel, ...arrow(rec.from, rec.to) })];
      if (rec.detail?.site && rec.view.kind === 'agent') lines.push(t('handoff.prop.site', { site: rec.detail.site }));
      return lines;
    }
    default: {
      if (rec.removal) return [t(back ? 'handoff.remove.revert' : 'handoff.remove', { props: rec.propLabel, from: rec.from })];
      const lines = [t('handoff.change', { props: propsText(rec.props), ...arrow(rec.from, valueText(rec.value, rec.token, tw)) })];
      if (rec.detail?.font && !back) lines.push(t('handoff.localFont', { font: rec.detail.font }));
      return lines;
    }
  }
}

/**
 * 同一处代码渲染出好几个元素（或者一条规则命中好几个）、这条改动只改其中一部分（类名写在条件分支里、值是从不同的外层继承来的）。
 * 还原时不用说：照着之前改的改回去
 */
function partialOf(rec: ChangeRecord, back: boolean): RecordLink | undefined {
  return !back && rec.kind === 'style' ? rec.detail?.link : undefined;
}

/** 只改哪几个：规则命中的元素里写法相同的；同源元素里类名用到同一段字符串的、写法相同的，或者两样都要 */
function partialLine(rec: ChangeRecord, partial: RecordLink): string {
  const n = rec.view.affects;
  if (partial.rule) return t('handoff.partial.rule', { total: partial.total, n });
  // 第几个是在全部同源元素里数的：改的是外层调用处时（只管其中一部分）对不上，不写
  const index = partial.total === rec.element.sameSource ? t('handoff.partial.index', { i: rec.element.sourceIndex + 1 }) : '';
  if (!partial.segment) return t('handoff.partial', { total: partial.total, n, index });
  return t(partial.byValue ? 'handoff.partial.both' : 'handoff.partial.segment', { total: partial.total, n, index, segment: partial.segment });
}

/**
 * 改动之外要交代的：改在哪段代码、只改同一处代码渲染出的哪几个、定位时知道的线索、再发一次时上一次的结果。
 * 没有源码位置的元素，线索只是「找不到位置」，不写；渐变描边的说明是写法上的要求，总要写
 */
function contextLines(rec: ChangeRecord, back: boolean): string[] {
  const lines: string[] = [];
  const rule = rec.kind === 'style' ? ruleText(rec) : null;
  if (rule) lines.push(t('handoff.rule', { rule }));
  else if (rec.view.kind !== 'agent' && rec.view.label && !atElement(rec)) lines.push(t('handoff.target', { label: rec.view.label }));
  const partial = partialOf(rec, back);
  if (partial) {
    lines.push(partialLine(rec, partial));
    if (partial.inherited) lines.push(t('handoff.partial.inherited'));
  }
  if (rec.write.kind === 'agent' && (rec.element.source || rec.decls)) lines.push(t('handoff.why', { why: rec.write.reason }));
  if (rec.note && (rec.status === 'handoff' || rec.status === 'reverting')) lines.push(t('handoff.last', { note: rec.note }));
  return lines;
}

/**
 * 交给 Agent 的提示词：每一项是一个元素，写清在哪、原值 → 新值（还原时反过来）；
 * 同一个元素上交代的东西都一样的几条改动合成一项。怎么写由 Agent 按项目的写法决定
 */
export function buildPrompt(recs: ChangeRecord[], ctx: HandoffContext, mode: PromptMode = 'apply'): string {
  const back = mode === 'revert';
  const items = new Map<string, { head: { label: string; text: string; loc: string; same: string }; changes: string[]; context: string[] }>();
  for (const rec of recs) {
    const loc = where(rec, ctx.project);
    const head = {
      label: rec.element.label,
      // 只有页面层级时，同名的兄弟元素靠文字区分
      text: !rec.element.source && rec.element.text ? t('handoff.elementText', { text: rec.element.text }) : '',
      loc: loc ? t('common.paren', { text: loc }) : '',
      same: !partialOf(rec, back) && rec.view.affects > 1 ? t('handoff.sameSource', { n: rec.view.affects }) : '',
    };
    const context = contextLines(rec, back);
    const key = [rec.preview.uid, head.label, head.text, head.loc, head.same, ...context].join('\n');
    const item = items.get(key) ?? { head, changes: [], context };
    item.changes.push(...changeLines(rec, ctx.tailwind, back));
    items.set(key, item);
  }
  const lines = [t(back ? 'handoff.revert.intro' : 'handoff.intro', { url: ctx.pageUrl, n: items.size })];
  [...items.values()].forEach((item, i) => {
    lines.push('', t('handoff.element', { i: i + 1, ...item.head }), ...item.changes, ...item.context);
  });
  lines.push('', t('handoff.requirements'), t('handoff.req.sync'), t('handoff.req.report'));
  return lines.join('\n');
}
