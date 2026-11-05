import { t, type Locale } from './i18n';

/* ---------- 页面侧快照 ---------- */

export interface SourceLoc {
  /** 生成代码所在模块 URL（去掉 ?t= 等查询串） */
  url: string;
  /** 原始源码在开发服务器上的路径，如 /src/App.tsx、/@fs/abs/path.tsx；sourcemap 给出 file:// 源时是本地绝对路径 */
  path: string;
  /** 本地绝对路径：开发态 JSX 转换写进代码的 fileName，或 sourcemap 里的 file:// 源（拿不到时为 null） */
  file: string | null;
  line: number;
  column: number;
  component: string | null;
  /** 元素由库组件渲染，沿 owner 链回退到了业务代码的调用处 */
  viaOwner: boolean;
}

/** 渲染这个元素的组件在哪里被调用：className 经组件参数传进来时，类名写在调用处 */
export interface CallerLoc {
  source: SourceLoc;
  /** 被调用的组件 */
  component: string | null;
  /** 同源元素里，调用链到这一层也相同的元素数（改这一处会影响几个元素） */
  same: number;
}

export interface SheetRef {
  index: number;
  /** 样式表的源文件：Vite 的 data-vite-dev-id，或外链 CSS 的 sourcemap 里唯一的本地源（Turbopack） */
  devId: string | null;
  href: string | null;
}

export interface SheetInfo extends SheetRef {
  inline: boolean;
  tailwind: boolean;
  ruleCount: number;
}

export interface RuleRef {
  sheet: SheetRef;
  /** 规则在样式表 cssRules 树里的下标路径，用于 CSSOM 预览 */
  path: number[];
  /** 规则自身的 selectorText（嵌套规则是相对写法） */
  selector: string;
  /** 展开嵌套后的完整选择器 */
  fullSelector: string;
  /** 外层 at-rule，从外到内，如 "@media (width >= 48rem)"、"@layer utilities" */
  conditions: string[];
  layer: string | null;
  /** 同一样式表里、完整选择器和条件都相同的规则中，这是第几条（0 起），用于在源码里区分重复出现的选择器 */
  ordinal: number;
  /** 文档里命中该选择器的元素数（去掉 :hover 等动态伪类后计数） */
  matchCount: number;
  /** Tailwind：规则是元素上某个类名生成的工具类时，给出未转义的类名 */
  utility: string | null;
}

export type WinnerOrigin = 'inline' | 'rule' | 'inherited' | 'initial';

export interface DeclWinner {
  value: string;
  important: boolean;
  origin: WinnerOrigin;
  rule: RuleRef | null;
  inheritedFrom: Crumb | null;
  /** 值实际来自哪个声明：属性本身、逻辑别名（padding-inline-start）或简写（padding） */
  via: string | null;
}

export interface Crumb {
  uid: string;
  label: string;
  /** 渲染出它的 React 组件（开发态 fiber 的 owner） */
  component?: string | null;
  /** 子元素个数 */
  kids?: number;
  /** 文字开头（没有文字时是 alt、aria-label 这类说明），面板上靠它认出是哪个元素 */
  text?: string;
}

export interface ElementSnapshot {
  uid: string;
  tag: string;
  id: string | null;
  classes: string[];
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  /** 从 body 下第一层到当前元素（含） */
  breadcrumb: Crumb[];
  children: Crumb[];
  source: SourceLoc | null;
  /** 同一 JSX 调用位置创建的元素数 */
  sameSource: number;
  /** 在同源元素里按文档顺序排第几（0 起），刷新后据此找回同一个元素 */
  sourceIndex: number;
  /** 从近到远，最多 3 层 */
  callers: CallerLoc[];
  /** 同源元素里带着这个类名的个数（改变体字符串时据此估算影响范围） */
  classCounts: Record<string, number>;
  /** 含 vars 里各变量：计算值和定义它的声明，键是变量名 */
  computed: Record<string, string>;
  winners: Record<string, DeclWinner>;
  vars: UsedVar[];
  /** 命中的作者样式规则，按层叠优先级从低到高 */
  rules: RuleRef[];
  inline: Record<string, string>;
  fontSizePx: number;
  rootFontSizePx: number;
  /** 元素后面露出来的底色（往上第一个不透明的背景色）：没有填充色时预览渐变描边用它垫底 */
  backdrop?: string;
  /** 元素自己的文字；页面脚本没分析时缺省 */
  text?: TextInfo;
  /** 同一个父元素下可以互换位置的兄弟 */
  order?: OrderInfo;
  /** 渲染这个元素的项目组件和它收到的 props（只有 React） */
  props?: PropsInfo;
  /** 元素连同子元素里看得见的图片和视频有几条（限时数，more 表示没数完） */
  assets?: { count: number; more: boolean };
}

/* ---------- 图片和视频 ---------- */

/** 图片（img / picture）、CSS 背景图（含伪元素上的）、内联 SVG、视频文件、视频封面 */
export type AssetKind = 'image' | 'background' | 'svg' | 'video' | 'poster';

/** 页面脚本收集到的一条资源：同一个地址出现几次都合并成一条 */
export interface AssetItem {
  /** 这份清单里的编号，取内容时用 */
  id: string;
  kind: AssetKind;
  /** 要下载的地址：响应式图片里最大的那张、还原过的原图；内联 SVG 为 null */
  url: string | null;
  /** 页面上正在显示的地址 */
  shown: string | null;
  /** 建议的文件名；没有扩展名时扩展按 Content-Type 补 */
  name: string;
  /** 要下载的那份的像素尺寸，SVG 是页面上显示的尺寸；不知道时为 null */
  width: number | null;
  height: number | null;
  /** 文件大小（字节），拿不到时为 null */
  bytes: number | null;
  /** 页面上出现了几次 */
  count: number;
  /** 第一次出现处的元素 */
  uid: string;
  /** 缩略图：页面里画好的 data: 地址，或者图片地址；没有时为 null */
  thumb: string | null;
  /** 分段播放（MediaSource、HLS、DASH）的视频：没有完整的文件可以下载 */
  streaming?: boolean;
}

export interface AssetList {
  items: AssetItem[];
  /** 合并后的条数 */
  count: number;
  /** 时间用完没数完：count 是下限，items 不全 */
  more: boolean;
}

/** 面板上的一条资源 */
export interface AssetView extends AssetItem {
  /** 资源就是项目里的文件（public/ 里的图片等），可以「在项目里找到」 */
  file: string | null;
}

/** 选中元素的「图片和视频」分区：数量总是有，展开后才取清单 */
export interface AssetsView {
  count: number;
  more: boolean;
  /** 没展开、或者正在取时为 null */
  items: AssetView[] | null;
}

/** 元素的一段直接子文本 */
export interface TextSegment {
  /** 文本节点原样（含首尾空白）；正在预览时是预览前的值 */
  value: string;
  /** React：文本在元素 JSX children 里的下标（和运行时 children 数组一致）；不是元素自己的 JSX 直接写的为 null */
  child: number | null;
  /**
   * 沿组件调用链找到的、值和这段文字相等的 prop：depth 对应 callers 的层级（1 起），
   * 0 表示元素由库组件渲染、prop 写在元素自己的源码位置上；name 是 children 时 child 是它在 children 数组里的下标
   */
  props: Array<{ depth: number; name: string; child?: number }>;
}

export interface TextInfo {
  /** 直接子文本节点里非空白的那些，按文档顺序 */
  segments: TextSegment[];
  /** 纯 HTML 页面：元素从 <html> 起逐层的子元素下标 */
  htmlPath: number[] | null;
  /** <html lang>，挑多语言文件时用 */
  lang: string | null;
}

/** 兄弟组里的一项：父元素 JSX children 里的一个元素、组件调用或 {…} 表达式，页面上可能对应几个元素 */
export interface OrderUnit {
  /** 这一项渲染出的元素，按页面顺序（多数只有一个） */
  uids: string[];
  label: string;
  /** 第一个元素的文字开头，同 Crumb.text */
  text?: string;
  /** 这一项在 JSX 里的位置（元素自己或组件的调用处）；.map() 渲染的各项共用一个 */
  source: SourceLoc | null;
  /** 宿主元素的标签名或组件名，定位时和源码里这一项的 JSX 名字核对 */
  name: string;
  /** 页面上的样子（标签和文字开头），按新顺序排出来就是校验时期望看到的 */
  sig: string;
}

export interface OrderInfo {
  /** 同一个父元素下可以互换位置的兄弟（含自己），按页面顺序 */
  units: OrderUnit[];
  /** 自己在 units 里的下标 */
  index: number;
  /** 父元素的排列方式：flex / grid 预览时写 order，其余按位移量做 transform */
  layout: 'flex' | 'grid' | 'flow';
  axis: 'x' | 'y';
  /** 兄弟由 .map() 渲染时它们共用的 JSX 位置（path:line:column），要改的是数组顺序；写死的兄弟为 null */
  mapped: string | null;
  /** 纯 HTML 页面：元素自己从 <html> 起逐层的子元素下标 */
  htmlPath: number[] | null;
}

export type PropValue = string | number | boolean | null;

export interface PropInfo {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'object' | 'array' | 'function' | 'element';
  /** 基本类型的值；对象、函数、React 元素为 null，只读 */
  value: PropValue;
  /** 只读值的类型说明，如 "() => void" */
  summary?: string;
}

export interface PropsInfo {
  component: string;
  /** 组件的调用处（属性写在这里） */
  source: SourceLoc | null;
  props: PropInfo[];
  /** 服务端组件：页面上不能预览，应用后才看得到效果 */
  server: boolean;
  /** 页面上能预览：React 开发构建初始化前钩子就挂上了（扩展连上之前就打开的页面要刷新一次） */
  live: boolean;
  /** 页面上由同一个调用处创建的组件实例数 */
  same: number;
  /** 选中的元素就是这个组件自己的 JSX 渲染的（不隔着别的组件），元素 className 里的 cva 配方才算这个组件的变体 */
  direct: boolean;
}

export interface CssVar {
  name: string;
  value: string;
  kind: 'length' | 'color' | 'number' | 'other';
}

/** 选中元素的样式引用到的 CSS 变量（Tailwind 内部的 --tw-* 不算） */
export interface UsedVar extends CssVar {
  /** 元素上哪些属性引用了它 */
  props: string[];
}

export interface PageInfo {
  url: string;
  title: string;
  react: boolean;
  vite: boolean;
  sheets: SheetInfo[];
  rootVars: CssVar[];
}

/* ---------- 桥接脚本 <-> 扩展 ---------- */

export type BridgeEvent =
  | { t: 'hello'; session: string; page: PageInfo }
  | { t: 'page'; page: PageInfo }
  | { t: 'select'; el: ElementSnapshot | null }
  | { t: 'pick'; on: boolean }
  /** 标尺开关变了（页面上按 Esc 退出、选取元素把它顶掉） */
  | { t: 'measure'; on: boolean }
  /** 在页面上双击改文字：live 是输入过程中，commit 是回车或失焦；按 Esc 时把开始编辑时的文字作为 commit 发回来 */
  | { t: 'editText'; uid: string; segment: number; value: string; phase: 'live' | 'commit' }
  /** 在页面上拖动选中元素的把手换位置：to 是放下处在兄弟组里的位置（按页面上现在看到的顺序，0 起） */
  | { t: 'reorder'; uid: string; to: number }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

export type PreviewTarget =
  /**
   * depth：要改的代码在第几层调用处，预览只作用于调用链到这一层也相同的同源元素；
   * withClass：要改的代码是变体字符串，预览只作用于带着这个类名的同源元素
   */
  | { kind: 'inline'; uid: string; sourceKey: string | null; depth?: number; withClass?: string }
  | { kind: 'rule'; rule: RuleRef; uid: string }
  /** 元素第 segment 段直接子文本；sourceKey、depth 的含义同 inline，同源实例一起改；纯 HTML 页面带 htmlPath，核对时重新取页面 HTML */
  | { kind: 'text'; uid: string; sourceKey: string | null; segment: number; depth?: number; htmlPath?: number[] }
  /**
   * 兄弟组换序：新顺序第 k 个位置放原来的第 order[k] 项。不动真实 DOM，flex / grid 父元素写 order，其余按位移量做 transform。
   * uid 是组里的一个元素，mapped 同 OrderInfo；anchor 是这个元素的源码位置（刷新、热更新后按它找回这一组）；
   * 纯 HTML 页面带 htmlPath（元素自己的），核对时重新取页面 HTML
   */
  | { kind: 'order'; uid: string; order: number[]; mapped: string | null; anchor?: { path: string; line: number; column: number; index: number }; htmlPath?: number[] }
  /**
   * 用 React 开发构建的 overrideProps 改渲染这个元素的组件的一个 prop，同一个调用处创建的实例一起改；
   * anchor 是元素的源码位置（组件被重新挂载、元素换了以后按它找回）
   */
  | { kind: 'props'; uid: string; name: string; anchor?: { path: string; line: number; column: number; index: number } };

export interface SelectQuery {
  uid?: string;
  selector?: string;
  index?: number;
  source?: { path: string; line: number; column: number; index?: number };
  /** 元素暂时不在（页面刚加载、React 还没提交）时最多等多久 */
  waitMs?: number;
}

/** 标尺上的间距刻度：距离正好是某一档时数字后面带上它的名字（Tailwind 是刻度数，CSS 项目是变量名） */
export interface MeasureStep {
  px: number;
  label: string;
}

export interface BridgeMethods {
  ping: { p: Record<string, never>; r: 'pong' };
  pageInfo: { p: Record<string, never>; r: PageInfo };
  setPick: { p: { on: boolean }; r: boolean };
  /** 标尺：开着时量悬停元素和选中元素之间的距离，点击改选中、Esc 退出；和选取元素互斥 */
  setMeasure: { p: { on: boolean }; r: boolean };
  /** 标尺和 Alt 临时测量用的间距刻度 */
  measureSteps: { p: { steps: MeasureStep[] }; r: boolean };
  select: { p: SelectQuery; r: ElementSnapshot | null };
  /** 只定位元素、不改变选中，返回 uid（刷新后重新挂预览用） */
  resolve: { p: SelectQuery; r: string | null };
  snapshot: { p: Record<string, never>; r: ElementSnapshot | null };
  /** 样式目标用 decls，text 目标用 text，props 目标用 prop；order 目标的位置在目标里 */
  preview: {
    p: { id: string; target: PreviewTarget; decls?: Record<string, string>; text?: string; prop?: PropValue };
    r: { computed: Record<string, string>; count: number };
  };
  clearPreview: { p: { id: string }; r: boolean };
  clearAllPreviews: { p: Record<string, never>; r: number };
  /** 去掉这些属性在元素上生效的那条作者声明之后的计算值（删属性的预览值），元素不在时为 null */
  fallback: { p: { uid: string; props: string[] }; r: Record<string, string> | null };
  /** 面板结构树上悬停的元素，在页面上描边；null 取消 */
  hover: { p: { uid: string | null }; r: boolean };
  /** 交给 Agent 后核对一次：源码现在在页面上给出的值对不对得上（读预览底下的，不等待），对上了才撤掉预览 */
  probe: {
    /**
     * expected 的键随目标类型：样式是 CSS 属性名，text 是 "text"，order 是 "order"（兄弟的 sig 按期望的顺序排，一行一项），props 是属性名（值为 JSON）。
     * source：热更新后元素可能被重建，按源码位置重新找回（不能用当前选中的元素）
     */
    p: { id: string; target: PreviewTarget; expected: Record<string, string>; source?: { path: string; line: number; column: number; index: number } };
    /** attached：预览还作用在页面上；found：页面上找得到这个元素 */
    r: { ok: boolean; actual: Record<string, string>; attached: boolean; found: boolean };
  };
  reloadSheets: { p: { hrefs?: string[] }; r: number };
  /** 选中元素连同子元素里看得见的图片、背景图、SVG 和视频（限时） */
  assets: { p: Record<string, never>; r: AssetList };
  /** 页面用 @font-face 加载的字体名（next/font 这类带哈希的内部名字不算） */
  fonts: { p: Record<string, never>; r: string[] };
  /** 清单里一条资源的内容：SVG 是代码（file 换成页面上实际的颜色，copy 保留 currentColor），blob: 地址是 base64 字节 */
  assetData: {
    p: { id: string; as: 'file' | 'copy' };
    r: { text?: string; base64?: string; mime?: string; error?: 'gone' | 'streaming' | 'too-large' | 'unsupported' };
  };
}

export type BridgeMethod = keyof BridgeMethods;

export interface BridgeRequest {
  t: 'req';
  id: number;
  m: BridgeMethod;
  p: unknown;
}

export interface BridgeReply {
  t: 'res';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/* ---------- 面板 <-> 扩展 ---------- */

export type Scope = 'instance' | 'source';

export interface EditRequest {
  props: string[];
  value: string;
  /** 吸附到的刻度：Tailwind 主题键（如 "5"、"lg"、"tri-void"）或 CSS 变量名（如 "--space-2"） */
  token?: string | null;
  phase: 'live' | 'commit';
  /** 删掉这些属性的声明（Tailwind 删类名、CSS 删声明），value 不用 */
  remove?: boolean;
}

/** source：写进 JSX、HTML 或多语言文件（文字、换序、props） */
export type TargetKind = 'tailwind' | 'css' | 'source' | 'agent';

export interface Target {
  kind: TargetKind;
  /** 人读的位置，如 "src/App.tsx:12 className" 或 "styles.css .card" */
  label: string;
  file?: string;
  line?: number;
  column?: number;
  affects: number;
  reason?: string;
  /** 属性的值来自一条作者写的声明或类名（可以删掉）；继承、初始值和框架预设样式不算 */
  declared?: boolean;
}

export interface SelectionView {
  el: ElementSnapshot;
  file: string | null;
  targets: Record<string, Target>;
  pending: Record<string, string>;
  /** 有未应用的删除的属性（pending 里是删掉之后的值） */
  removed: string[];
  /** 元素的每段文字和它在代码里的位置 */
  texts?: TextView[];
  /** 选中元素所在的兄弟组（少于两项时缺省） */
  order?: OrderView;
  /** 渲染选中元素的项目组件收到的 props（不是 React 页面、或者没有 props 时缺省） */
  props?: PropsView;
  /** 元素连同子元素里看得见的图片和视频 */
  assets?: AssetsView;
  /** 「只改这个」和「全部」会写到不同地方时才有：选「全部」会改到页面上几个元素 */
  scopeAll?: number;
}

export interface PropView {
  name: string;
  type: PropInfo['type'];
  /** 有未应用的改动时是改动后的值；调用处没写、由 cva 默认变体决定时是默认值 */
  value: PropValue;
  summary?: string;
  pending: boolean;
  /** 可选的值：cva 变体、TS 字面量联合类型 */
  options?: PropValue[];
  /** 调用处没写这个属性，改了会加上 */
  missing?: boolean;
  /** 改的时候要注意的地方，如调用处有 {...spread} */
  warn?: string;
  target: Target;
}

export interface PropsView {
  component: string;
  /** 组件的调用处 */
  source: { file: string; line: number; column: number; label: string } | null;
  server: boolean;
  live: boolean;
  items: PropView[];
}

export interface OrderView {
  /** 兄弟按现在的顺序（有未应用的换序时是换过之后的） */
  items: Array<{ uid: string; label: string; component?: string | null; text?: string }>;
  /** 选中元素在 items 里的位置 */
  index: number;
  axis: 'x' | 'y';
  pending: boolean;
  target: Target;
}

export type TextOrigin = 'jsx' | 'prop' | 'message' | 'html' | 'dynamic';

export interface TextView {
  segment: number;
  /** 去掉首尾空白的文字：有未应用的改动时是改动后的值 */
  value: string;
  pending: boolean;
  /** 文字写在哪：JSX 字面量、调用处的属性、多语言文件、HTML 文件，或动态内容（交给 Agent） */
  origin: TextOrigin;
  target: Target;
}

export interface ScaleStep {
  label: string;
  value: string;
  px?: number;
  token?: string | null;
}

export interface Scales {
  mode: 'tailwind' | 'css';
  rem: number;
  spacing: ScaleStep[];
  size: ScaleStep[];
  radius: ScaleStep[];
  /** 字体：Tailwind 是主题里的 --font-*，普通 CSS 项目是 :root 上像字体的变量；值是整串字体栈 */
  fontFamily: ScaleStep[];
  fontSize: ScaleStep[];
  fontWeight: ScaleStep[];
  lineHeight: ScaleStep[];
  letterSpacing: ScaleStep[];
  shadow: ScaleStep[];
  colors: ScaleStep[];
  opacity: ScaleStep[];
  zIndex: ScaleStep[];
  borderWidth: ScaleStep[];
  /** 新建渐变的插值色彩空间：Tailwind 4 的渐变工具类都带 in oklab，预览照着写才和应用后一样 */
  gradientIn?: string;
  /** 断点（按宽度从小到大）：Tailwind 是主题里的 screens，普通 CSS 项目用 md 768、lg 1024 */
  breakpoints: Breakpoint[];
}

export interface Breakpoint {
  name: string;
  px: number;
}

/** 视口：实际宽度，或按手机、平板（md 起）、桌面（lg 起）的宽度显示页面 */
export type ViewportPreset = 'actual' | 'mobile' | 'tablet' | 'desktop';

export type ViewportBand = Exclude<ViewportPreset, 'actual'>;

export interface ViewportView {
  preset: ViewportPreset;
  /** 每一档模拟的宽度；prefix 是这一档在 Tailwind 里的断点前缀（手机是不带前缀的基础样式，普通 CSS 项目都为 null） */
  bands: Record<ViewportBand, { width: number; prefix: string | null }>;
}

/** 未应用 → 交给 Agent 等它改（handoff）→ 页面上核对上了（applied）→ 交给 Agent 还原（reverting）→ 核对上原样（reverted） */
export type ChangeStatus = 'pending' | 'handoff' | 'applied' | 'reverting' | 'reverted';

/** 改动类型：样式、文字、同一父元素内换序、组件 props */
export type ChangeKind = 'style' | 'text' | 'reorder' | 'prop';

export interface ChangeView {
  id: string;
  kind: ChangeKind;
  status: ChangeStatus;
  element: string;
  props: string[];
  propLabel: string;
  /** 样式是属性值，文字是原文，换序是位置（1 起），props 是 JSON */
  from: string;
  to: string;
  target: Target;
  /** 核对的情况：页面上现在是什么、为什么核对不了 */
  note?: string;
  /** 页面上的预览是模拟出来的（换序用 order / transform 摆出来，真实 DOM 没动） */
  simulated?: boolean;
  /** 删掉属性的声明（to 是删掉之后的值） */
  remove?: boolean;
  pageUrl: string;
  createdAt: number;
}

/** 清单和上一步提示里改动叫什么：文字、换序按当前界面语言叫，样式和 props 用属性名 */
export function changeName(c: { kind: ChangeKind; propLabel: string }): string {
  return c.kind === 'text' ? t('panel.change.text') : c.kind === 'reorder' ? t('panel.change.order') : c.propLabel;
}

export type Connection = 'idle' | 'opening' | 'connected' | 'lost';

export interface Notice {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface PanelState {
  connection: Connection;
  page: { url: string; title: string } | null;
  pickOn: boolean;
  /** 标尺开着 */
  measureOn: boolean;
  viewport: ViewportView;
  scope: Scope;
  selection: SelectionView | null;
  scales: Scales | null;
  changes: ChangeView[];
  notice: Notice | null;
  defaultUrl: string;
  busy: boolean;
  /** 数值吸附到刻度（按住 Alt 临时关闭） */
  snap: boolean;
  /** 界面语言：默认跟随编辑器的显示语言，面板上切换过就用切换的 */
  locale: Locale;
  /** 上一步 / 下一步会撤销、重做的操作说明，没有可撤销、重做的为 null */
  history: { undo: string | null; redo: string | null };
  /** 字体菜单里的候选，第一次打开字体菜单之前为 null */
  fonts: FontsView | null;
}

/** 页面用 @font-face 加载的字体；这台电脑装的字体（还在读时为 null，读不到时是空的、failed 为真） */
export interface FontsView {
  page: string[];
  local: string[] | null;
  failed?: boolean;
}

export type PanelToExt =
  | { t: 'ready' }
  | { t: 'openPage'; url: string }
  | { t: 'pick'; on: boolean }
  | { t: 'measure'; on: boolean }
  | { t: 'setViewport'; preset: ViewportPreset }
  | { t: 'select'; uid: string }
  | { t: 'hover'; uid: string | null }
  | { t: 'edit'; edit: EditRequest }
  /** 一次改几组属性（加描边要同时设粗细和样式），撤销时算一步 */
  | { t: 'editMany'; edits: EditRequest[] }
  /** 撤销 / 重做未应用的改动 */
  | { t: 'undo' }
  | { t: 'redo' }
  /** 改选中元素第 segment 段文字 */
  | { t: 'editText'; segment: number; value: string; phase: 'live' | 'commit' }
  /** 把选中元素兄弟组里 uid 所在的那项挪到第 to 个（按现在的顺序，0 起）：live 只预览（结构树拖动中），commit 记进改动清单 */
  | { t: 'reorder'; uid: string; to: number; phase: 'live' | 'commit' }
  /** 改渲染选中元素的组件的一个 prop */
  | { t: 'editProp'; name: string; value: PropValue; phase: 'live' | 'commit' }
  /** 刷新页面（让钩子赶在 React 之前挂上，才能预览 props） */
  | { t: 'reload' }
  /** 重置：放弃选中元素上这些属性 / 这段文字 / 这个 prop / 换序的未应用改动 */
  | { t: 'resetProps'; props: string[] }
  | { t: 'resetText'; segment: number }
  | { t: 'resetProp'; name: string }
  | { t: 'resetOrder' }
  /** 应用：整理成提示词预填进新的 Agent 对话。不给 ids 是全部未应用的；给了 ids 时，还在等 Agent 改的那几条再发一次 */
  | { t: 'apply'; ids?: string[] }
  /** 还原：交给 Agent 改回原样（还在等它还原的再发一次） */
  | { t: 'revert'; id: string }
  /** 放弃：未应用、等 Agent 改的撤掉预览移出清单；等 Agent 还原的不还原了，回到已应用 */
  | { t: 'discard'; id: string }
  | { t: 'openSource'; file: string; line: number; column: number }
  /** 对比：交给 Agent 之前的文件 ↔ 现在 */
  | { t: 'diff'; id: string }
  | { t: 'setScope'; scope: Scope }
  | { t: 'setSnap'; on: boolean }
  | { t: 'setLocale'; locale: Locale }
  | { t: 'clearDone' }
  | { t: 'dismissNotice' }
  /** 「图片和视频」分区展开 / 收起：展开时才取完整清单 */
  | { t: 'assetsOpen'; open: boolean }
  /** 另存为（每次弹保存对话框） */
  | { t: 'saveAsset'; id: string }
  /** 全部存进一个文件夹 */
  | { t: 'saveAllAssets' }
  | { t: 'copySvg'; id: string }
  | { t: 'revealAsset'; id: string }
  /** 打开字体菜单：取页面加载的字体，本机字体读过一次就用读到的 */
  | { t: 'fontsOpen' }
  /** 面板里的未捕获异常，写进扩展的输出面板 */
  | { t: 'error'; message: string };

export type ExtToPanel = { t: 'state'; state: PanelState };
