import type { ChangeKind, ChangeStatus, ChangeView, ElementSnapshot, PreviewTarget, SourceLoc, Target } from '@css-tuner/protocol';
import type { RecordBand } from './band';
import type { WriteSpec } from './planner';

export interface ChangeRecord {
  id: string;
  kind: ChangeKind;
  key: string;
  status: ChangeStatus;
  createdAt: number;
  pageUrl: string;
  /** path：页面上的层级（面包屑），text：元素的文字开头；没有源码位置时让 Agent 能找到、认出元素 */
  element: { label: string; source: SourceLoc | null; sourceIndex: number; sameSource: number; path?: string; text?: string };
  /** 样式是 CSS 属性，props 是属性名，文字和换序为空 */
  props: string[];
  propLabel: string;
  /** 样式是属性值，文字是原文，换序是位置（1 起），props 是 JSON */
  from: string;
  to: string;
  value: string;
  token: string | null;
  /** 改动前的值（还原后核对用），键的含义同 probe 的 expected */
  original: Record<string, string>;
  /** 预览时页面上的值，Agent 改完源码后应得到同样的结果（应用后核对用） */
  expected?: Record<string, string>;
  view: Target;
  preview: PreviewTarget;
  previewId: string;
  /** 改动对应的源码位置和写法（给 Agent 的提示词里说明在哪改） */
  write: WriteSpec;
  note?: string;
  /** 第一次交给 Agent 时这个文件的样子（「对比」的左边）；hash 用来看文件后来改过没有 */
  snapshot?: { file: string; hash: string };
  /** 最近一次交给 Agent（应用或还原）的时间 */
  sentAt?: number;
  /** 交给 Agent 时用的附加说明：换序后兄弟的新顺序和原来的顺序、props 所属组件和它的调用处、文字来源、只装在本机的字体 */
  detail?: { order?: string[]; was?: string[]; component?: string; site?: string; origin?: string; font?: string };
  /**
   * 删属性：每个属性删掉之后页面上的值（面板显示、应用后核对）、删之前的写法（撤掉删除再改时当原值显示；
   * 删除预览开着时元素快照里已经读不到），Tailwind 还有要去掉的类（各属性当前生效的类名）
   */
  removal?: { values: Record<string, string>; from?: Record<string, string>; classes?: string[] };
  /** 预览用的声明和 props → value 不一样时（没有填充色的渐变描边用两层背景预览） */
  decls?: Record<string, string>;
  /** 视口选了一档时改的：只管这一档，页面宽度在这一档里才预览，应用后切到这一档核对 */
  band?: RecordBand;
}

/**
 * 存下来的记录：0.2.0 及以前的没有 kind，都是样式改动；0.10.0 以前是扩展自己写回的，
 * 多几种状态，写回前的文件记在 patch 里
 */
export type StoredRecord = Omit<ChangeRecord, 'kind' | 'status'> & {
  kind?: ChangeKind;
  status: ChangeStatus | 'unverified' | 'failed' | 'conflict';
  patch?: { file: string; hashBefore: string };
};

const OLD_STATUS: Record<string, ChangeStatus> = { unverified: 'applied', conflict: 'applied', failed: 'pending' };

export function upgradeRecord(r: StoredRecord): ChangeRecord {
  const { patch, ...rest } = r;
  return {
    ...rest,
    kind: r.kind ?? 'style',
    status: OLD_STATUS[r.status] ?? (r.status as ChangeStatus),
    ...(patch && !r.snapshot ? { snapshot: { file: patch.file, hash: patch.hashBefore } } : {}),
  };
}

export function recordElement(el: ElementSnapshot): ChangeRecord['element'] {
  const text = el.breadcrumb.at(-1)?.text;
  return { label: el.label, source: el.source, sourceIndex: el.sourceIndex, sameSource: el.sameSource, path: el.breadcrumb.map((b) => b.label).join(' > '), ...(text ? { text } : {}) };
}

export function recordView(r: ChangeRecord): ChangeView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    element: r.element.label,
    props: r.props,
    propLabel: r.propLabel,
    from: r.from,
    to: r.to,
    target: r.view,
    note: r.note,
    ...(r.kind === 'reorder' && (r.status === 'pending' || r.status === 'handoff') ? { simulated: true } : {}),
    ...(r.removal ? { remove: true } : {}),
    pageUrl: r.pageUrl,
    createdAt: r.createdAt,
  };
}

/** hash 路由（`#/effects`、`#!/a`）是页面的一部分；普通锚点（`#faq`）和没有 hash 都算根路由 */
const hashRoute = (u: URL) => /^#!?(\/[^?]*)/.exec(u.hash)?.[1].replace(/(.)\/$/, '$1') ?? '/';

/** 两个地址是不是同一个页面：查询参数和普通锚点不算 */
export function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && hashRoute(ua) === hashRoute(ub);
  } catch {
    return a === b;
  }
}