import { changeName, getLocale, groupLabel, sameValue, setLocale, t, type AssetView, type ChangeView, type ElementSnapshot, type OrderView, type PanelState, type PanelToExt, type PropsView, type Scales, type ScaleStep, type Target } from '@css-tuner/protocol';
import type { Host } from './host';

/** 浏览器里调试面板用的假宿主：行为尽量贴近扩展，便于不开 Cursor 也能看交互 */

const rem = (n: number) => `${+(n / 16).toFixed(4)}rem`;

function spacing(): ScaleStep[] {
  const keys = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];
  const out: ScaleStep[] = keys.map((k) => ({ label: String(k), value: k === 0 ? '0px' : rem(k * 4), px: k * 4, token: String(k) }));
  out.splice(1, 0, { label: 'px', value: '1px', px: 1, token: 'px' });
  out.push({ label: 'gutter', value: '18px', px: 18, token: 'gutter' });
  return out;
}

const PALETTE: Record<string, string[]> = {
  slate: ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cad5e2', '#90a1b9', '#62748e', '#45556c', '#314158', '#1d293d', '#0f172b', '#020618'],
  blue: ['#eff6ff', '#dbeafe', '#bedbff', '#8ec5ff', '#51a2ff', '#2b7fff', '#155dfc', '#1447e6', '#193cb8', '#1c398e', '#162456'],
  rose: ['#fff1f2', '#ffe4e6', '#ffccd3', '#ffa1ad', '#ff637e', '#ff2056', '#ec003f', '#c70036', '#a50036', '#8b0836', '#4d0218'],
  amber: ['#fffbeb', '#fef3c6', '#fee685', '#ffd230', '#ffb900', '#fe9a00', '#e17100', '#bb4d00', '#973c00', '#7b3306', '#461901'],
};
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const SANS = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
/** 假宿主里「本机装的字体」：常见的 macOS 字体，浏览器里打开时能看到真实字形 */
const LOCAL_FONTS = [
  'American Typewriter', 'Arial', 'Avenir Next', 'Baskerville', 'Didot', 'Futura', 'Georgia', 'Gill Sans', 'Helvetica Neue', 'Hiragino Sans GB',
  'Inter', 'Kaiti SC', 'Menlo', 'Optima', 'PingFang SC', 'PingFang TC', 'Rockwell', 'Songti SC', 'Times New Roman', 'Verdana', 'Zapfino',
];

export function mockScales(): Scales {
  const sp = spacing();
  return {
    mode: 'tailwind',
    rem: 16,
    spacing: sp,
    size: [...sp, ...['3xs:256', 'xs:320', 'sm:384', 'md:448', 'lg:512', 'xl:576', '2xl:672', '3xl:768'].map((s) => {
      const [k, v] = s.split(':');
      return { label: k, value: rem(+v), px: +v, token: k };
    })],
    radius: [['xs', 2], ['sm', 4], ['md', 6], ['lg', 8], ['xl', 12], ['2xl', 16], ['3xl', 24], ['card', 14], ['full', 9999]].map(([k, v]) => ({ label: String(k), value: `${v}px`, px: +v, token: String(k) })),
    fontFamily: [
      ['sans', SANS],
      ['serif', 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif'],
      ['mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'],
      ['display', '"Playfair Display", ui-serif, serif'],
    ].map(([k, v]) => ({ label: k, value: v, token: k })),
    fontSize: [['xs', 12], ['sm', 14], ['base', 16], ['lg', 18], ['xl', 20], ['2xl', 24], ['3xl', 30], ['4xl', 36], ['5xl', 48], ['6xl', 60]].map(([k, v]) => ({ label: String(k), value: rem(+v), px: +v, token: String(k) })),
    fontWeight: [['thin', 100], ['extralight', 200], ['light', 300], ['normal', 400], ['medium', 500], ['semibold', 600], ['bold', 700], ['extrabold', 800], ['black', 900]].map(([k, v]) => ({ label: String(k), value: String(v), token: String(k) })),
    lineHeight: [['none', '1'], ['tight', '1.25'], ['snug', '1.375'], ['normal', '1.5'], ['relaxed', '1.625'], ['loose', '2'], ...[3, 4, 5, 6, 7, 8, 9, 10].map((n) => [String(n), rem(n * 4)])].map(([k, v]) => ({ label: k, value: v, token: k })),
    letterSpacing: [['tighter', '-0.05em'], ['tight', '-0.025em'], ['normal', '0em'], ['wide', '0.025em'], ['wider', '0.05em'], ['widest', '0.1em']].map(([k, v]) => ({ label: k, value: v, token: k })),
    shadow: [
      ['none', 'none'],
      ['2xs', '0 1px rgb(0 0 0 / 0.05)'],
      ['xs', '0 1px 2px 0 rgb(0 0 0 / 0.05)'],
      ['sm', '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)'],
      ['md', '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)'],
      ['lg', '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)'],
      ['xl', '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)'],
      ['2xl', '0 25px 50px -12px rgb(0 0 0 / 0.25)'],
    ].map(([k, v]) => ({ label: k, value: v, token: k })),
    colors: [
      { label: 'brand', value: '#3b5bdb', token: 'brand' },
      { label: 'ink', value: '#1f2328', token: 'ink' },
      { label: 'paper', value: '#f6f8fa', token: 'paper' },
      { label: 'white', value: '#ffffff', token: 'white' },
      { label: 'black', value: '#000000', token: 'black' },
      ...Object.entries(PALETTE).flatMap(([fam, list]) => list.map((v, i) => ({ label: `${fam}-${SHADES[i]}`, value: v, token: `${fam}-${SHADES[i]}` }))),
    ],
    opacity: Array.from({ length: 21 }, (_, i) => ({ label: String(i * 5), value: String(i / 20), token: String(i * 5) })),
    zIndex: [0, 10, 20, 30, 40, 50].map((n) => ({ label: String(n), value: String(n), px: n, token: String(n) })),
    borderWidth: [['0', 0], ['DEFAULT', 1], ['2', 2], ['4', 4], ['8', 8]].map(([k, v]) => ({ label: String(k), value: `${v}px`, px: +v, token: k === 'DEFAULT' ? '' : String(k) })),
  };
}

/** 删属性后页面上回落到的值（假宿主里按 Tailwind 预设样式估一个） */
function fallbackOf(prop: string): string {
  if (/^border-.*-width$/.test(prop)) return '0px';
  if (/^border-.*-style$/.test(prop)) return 'solid';
  if (/^border-.*-color$/.test(prop)) return 'rgb(229, 231, 235)';
  return (
    ({ 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'background-clip': 'border-box', 'background-origin': 'padding-box', 'box-shadow': 'none', color: 'rgb(31, 35, 40)' } as Record<string, string>)[prop] ??
    'initial'
  );
}

/** 假宿主里算一步（能撤销）的消息和这一步的说明（用的时候才按当前界面语言拼） */
function stepLabel(m: PanelToExt, state: PanelState): (() => string) | null {
  switch (m.t) {
    case 'edit': {
      const { props, remove, phase } = m.edit;
      if (remove) return () => t('history.removed', { label: groupLabel(props) });
      return phase === 'commit' ? () => groupLabel(props) : null;
    }
    case 'editMany':
      return m.edits.length ? () => groupLabel(m.edits[0].props) : null;
    case 'editText':
      return m.phase === 'commit' ? () => t('panel.change.text') : null;
    case 'reorder':
      return m.phase === 'commit' ? () => t('panel.change.order') : null;
    case 'editProp':
      return m.phase === 'commit' ? () => m.name : null;
    case 'resetProps':
      return () => t('history.dropped', { label: groupLabel(m.props) });
    case 'resetText':
      return () => t('history.dropped', { label: t('panel.change.text') });
    case 'resetProp':
      return () => t('history.dropped', { label: m.name });
    case 'discard': {
      const c = state.changes.find((x) => x.id === m.id);
      if (c?.status !== 'pending') return null;
      const { kind, propLabel } = c;
      return () => t('history.dropped', { label: changeName({ kind, propLabel }) });
    }
    default:
      return null;
  }
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const NO_BORDER = Object.fromEntries(SIDES.flatMap((s) => [[`border-${s}-width`, '0px'], [`border-${s}-style`, 'solid'], [`border-${s}-color`, 'rgb(229, 231, 235)']]));

function el(over: Partial<ElementSnapshot>): ElementSnapshot {
  const computed: Record<string, string> = {
    display: 'flex',
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'justify-content': 'space-between',
    'align-items': 'center',
    'grid-template-columns': 'none',
    position: 'relative',
    top: 'auto',
    right: 'auto',
    bottom: 'auto',
    left: 'auto',
    'z-index': 'auto',
    'padding-top': '16px',
    'padding-right': '24px',
    'padding-bottom': '16px',
    'padding-left': '24px',
    'margin-top': '0px',
    'margin-right': '0px',
    'margin-bottom': '0px',
    'margin-left': '0px',
    'row-gap': 'normal',
    'column-gap': 'normal',
    width: '720px',
    height: '64px',
    'min-width': 'auto',
    'max-width': 'none',
    'min-height': 'auto',
    'max-height': 'none',
    'font-family': SANS,
    'font-size': '16px',
    'font-weight': '400',
    'line-height': '24px',
    'letter-spacing': 'normal',
    'text-align': 'start',
    color: 'rgb(255, 255, 255)',
    'background-color': 'rgb(59, 91, 219)',
    'background-image': 'none',
    'background-clip': 'border-box',
    'background-origin': 'padding-box',
    'border-top-left-radius': '0px',
    'border-top-right-radius': '0px',
    'border-bottom-right-radius': '0px',
    'border-bottom-left-radius': '0px',
    ...NO_BORDER,
    'box-shadow': 'none',
    opacity: '1',
    '--spacing': '0.25rem',
    '--color-brand': '#3b5bdb',
    '--color-white': '#fff',
    '--font-sans': 'ui-sans-serif, system-ui, sans-serif',
  };
  const util = (u: string, value: string) => ({
    value,
    important: false,
    origin: 'rule' as const,
    via: null,
    inheritedFrom: null,
    rule: { sheet: { index: 1, devId: '/src/index.css', href: null }, path: [0], selector: `.${u}`, fullSelector: `.${u}`, conditions: ['@layer utilities'], layer: 'utilities', ordinal: 0, matchCount: 1, utility: u },
  });
  return {
    uid: 'e1',
    tag: 'header',
    id: null,
    classes: ['flex', 'items-center', 'justify-between', 'bg-brand', 'px-6', 'py-4', 'text-white'],
    label: 'header.flex.items-center…',
    rect: { x: 24, y: 24, w: 720, h: 64 },
    breadcrumb: [
      { uid: 'e0', label: 'div#root', component: null, kids: 2 },
      { uid: 'e9', label: 'main.mx-auto.max-w-3xl…', component: 'App', kids: 6 },
      { uid: 'e1', label: 'header.flex.items-center…', component: 'App', kids: 2 },
    ],
    children: [
      { uid: 'e2', label: 'h1.text-2xl.font-bold…', component: 'App', kids: 0, text: 'css-tuner fixture' },
      { uid: 'e3', label: 'span.rounded-full.bg-white/10…', component: 'Badge', kids: 0, text: 'Beta' },
    ],
    source: { url: 'http://localhost:5173/src/App.tsx', path: '/src/App.tsx', file: '/proj/src/App.tsx', line: 14, column: 7, component: 'App', viaOwner: false },
    sameSource: 1,
    sourceIndex: 0,
    callers: [],
    classCounts: {},
    computed,
    winners: {
      'padding-left': util('px-6', 'calc(var(--spacing) * 6)'),
      'padding-right': util('px-6', 'calc(var(--spacing) * 6)'),
      'padding-top': util('py-4', 'calc(var(--spacing) * 4)'),
      'padding-bottom': util('py-4', 'calc(var(--spacing) * 4)'),
      'background-color': util('bg-brand', 'var(--color-brand)'),
      color: util('text-white', 'var(--color-white)'),
    },
    vars: [
      { name: '--spacing', value: '0.25rem', kind: 'length', props: ['padding-left', 'padding-right', 'padding-top', 'padding-bottom'] },
      { name: '--color-brand', value: '#3b5bdb', kind: 'color', props: ['background-color'] },
      { name: '--color-white', value: '#fff', kind: 'color', props: ['color'] },
      { name: '--font-sans', value: 'ui-sans-serif, system-ui, sans-serif', kind: 'other', props: ['font-family'] },
    ],
    rules: [],
    inline: {},
    fontSizePx: 16,
    rootFontSizePx: 16,
    ...over,
  };
}

const TITLE = el({
  uid: 'e2',
  tag: 'h1',
  classes: ['text-2xl', 'font-bold', 'tracking-tight'],
  label: 'h1.text-2xl.font-bold…',
  breadcrumb: [
    { uid: 'e0', label: 'div#root', component: null, kids: 2 },
    { uid: 'e9', label: 'main.mx-auto.max-w-3xl…', component: 'App', kids: 6 },
    { uid: 'e1', label: 'header.flex.items-center…', component: 'App', kids: 2 },
    { uid: 'e2', label: 'h1.text-2xl.font-bold…', component: 'App', kids: 0, text: 'css-tuner fixture' },
  ],
  children: [],
  source: { url: 'http://localhost:5173/src/App.tsx', path: '/src/App.tsx', file: '/proj/src/App.tsx', line: 15, column: 9, component: 'App', viaOwner: false },
  fontSizePx: 24,
  text: { segments: [{ value: 'css-tuner fixture', child: 0, props: [] }], htmlPath: null, lang: 'zh-CN' },
});
TITLE.computed = { ...TITLE.computed, display: 'block', 'font-size': '24px', 'font-weight': '700', 'line-height': '32px', 'letter-spacing': '-0.6px', 'background-color': 'rgba(0, 0, 0, 0)', 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px', width: '220px', height: '32px' };

/** 页面上用了 3 次的 Badge 组件里的 span：「只改这个」和「全部」写到不同地方 */
const BADGE = el({
  uid: 'e3',
  tag: 'span',
  classes: ['rounded-full', 'bg-white/10', 'px-2', 'text-xs'],
  label: 'span.rounded-full.bg-white/10…',
  breadcrumb: [...TITLE.breadcrumb.slice(0, 3), { uid: 'e3', label: 'span.rounded-full.bg-white/10…', component: 'Badge', kids: 0, text: 'Beta' }],
  children: [],
  source: { url: 'http://localhost:5173/src/Badge.tsx', path: '/src/Badge.tsx', file: '/proj/src/Badge.tsx', line: 4, column: 10, component: 'Badge', viaOwner: false },
  sameSource: 3,
  fontSizePx: 12,
  text: { segments: [{ value: 'Beta', child: 0, props: [] }], htmlPath: null, lang: 'zh-CN' },
});

const thumb = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;

/** 「图片和视频」的假清单：缩略图用内联 SVG 画 */
const ASSETS: AssetView[] = [
  {
    id: 'a1',
    kind: 'image',
    url: 'http://localhost:5173/hero-1280.png',
    shown: 'http://localhost:5173/hero-640.png',
    name: 'hero-1280.png',
    width: 1280,
    height: 720,
    bytes: 63705,
    count: 2,
    uid: 'e1',
    file: '/proj/public/hero-1280.png',
    thumb: thumb('<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#9db4ff"/><stop offset="1" stop-color="#ffd8a8"/></linearGradient></defs><rect y="14" width="64" height="36" fill="url(#g)"/><path d="M0 50l18-16 12 10 14-14 20 20z" fill="#3b5bdb"/>'),
  },
  {
    id: 'a2',
    kind: 'background',
    url: 'http://localhost:5173/pattern.png',
    shown: 'http://localhost:5173/pattern.png',
    name: 'pattern.png',
    width: 32,
    height: 32,
    bytes: 115,
    count: 1,
    uid: 'e1',
    file: '/proj/public/pattern.png',
    thumb: thumb('<rect width="64" height="64" fill="#e8ecff"/><path d="M0 0h32v32H0zM32 32h32v32H32z" fill="#bac8ff"/>'),
  },
  {
    id: 'a3',
    kind: 'svg',
    url: null,
    shown: null,
    name: 'logo.svg',
    width: 24,
    height: 24,
    bytes: 296,
    count: 1,
    uid: 'e2',
    file: null,
    thumb: thumb('<path d="M32 4l8 19h20L44 35l6 21-18-12-18 12 6-21L4 23h20z" fill="#3b5bdb"/>'),
  },
  {
    id: 'a4',
    kind: 'video',
    url: 'http://localhost:5173/intro.mp4',
    shown: 'http://localhost:5173/intro.mp4',
    name: 'intro.mp4',
    width: 1920,
    height: 1080,
    bytes: 4404019,
    count: 1,
    uid: 'e1',
    file: '/proj/public/intro.mp4',
    thumb: thumb('<rect y="14" width="64" height="36" fill="#1f2937"/><path d="M27 24v16l13-8z" fill="#fff"/>'),
  },
  {
    id: 'a5',
    kind: 'poster',
    url: 'https://cdn.example.com/intro-poster.jpg',
    shown: 'https://cdn.example.com/intro-poster.jpg',
    name: 'intro-poster.jpg',
    width: 1920,
    height: 1080,
    bytes: 186368,
    count: 1,
    uid: 'e1',
    file: null,
    thumb: thumb('<rect y="14" width="64" height="36" fill="#334155"/><circle cx="44" cy="26" r="5" fill="#fcc419"/><path d="M0 50l22-18 16 12 8-6 18 12z" fill="#64748b"/>'),
  },
  { id: 'a6', kind: 'video', url: 'blob:http://localhost:5173/7c1f', shown: 'blob:http://localhost:5173/7c1f', name: 'video', width: null, height: null, bytes: null, count: 1, uid: 'e1', file: null, thumb: null, streaming: true },
];

export function createMockHost(): Host {
  const els: Record<string, ElementSnapshot> = { e1: el({ assets: { count: ASSETS.length, more: false } }), e2: TITLE, e3: BADGE };
  let assetsOpen = false;
  const state: PanelState = {
    connection: 'connected',
    page: { url: 'http://localhost:5173/', title: 'fixture · tw-react' },
    pickOn: false,
    measureOn: false,
    scope: 'instance',
    selection: null,
    scales: mockScales(),
    changes: [],
    notice: null,
    defaultUrl: 'http://localhost:5173/',
    busy: false,
    snap: true,
    locale: getLocale(),
    history: { undo: null, redo: null },
    fonts: null,
  };
  const pendingByEl: Record<string, Record<string, string>> = {};
  const removedByEl: Record<string, string[]> = {};
  const textByEl: Record<string, Record<number, string>> = {};
  const app = (line: number, parent: string): Target => ({ kind: 'source', label: `src/App.tsx:${line} ${parent}`, file: '/proj/src/App.tsx', line, column: 5, affects: 1 });
  const orders: Record<string, OrderView & { start: string[] }> = {
    e1: {
      items: [
        { uid: 'e1', label: 'header.flex.items-center…' },
        { uid: 'e5', label: 'section.grid.gap-4…' },
        { uid: 'e6', label: 'ul.space-y-2 ×3' },
        { uid: 'e7', label: 'footer.text-sm', component: 'Footer', text: '© 2026 css-tuner' },
      ],
      index: 0,
      axis: 'y',
      pending: false,
      target: app(12, '<main>'),
      start: ['e1', 'e5', 'e6', 'e7'],
    },
    e2: {
      items: [
        { uid: 'e2', label: 'h1.text-2xl.font-bold…', text: 'css-tuner fixture' },
        { uid: 'e3', label: 'span.rounded-full.bg-white/10…', component: 'Badge', text: 'Beta' },
      ],
      index: 0,
      axis: 'x',
      pending: false,
      target: app(14, '<header>'),
      start: ['e2', 'e3'],
    },
  };
  const hero = (name: string): Target => ({ kind: 'source', label: `src/App.tsx:12 <Hero> ${name}`, file: '/proj/src/App.tsx', line: 12, column: 7, affects: 1 });
  const propViews: Record<string, PropsView> = {
    e1: {
      component: 'Hero',
      source: { file: '/proj/src/App.tsx', line: 12, column: 7, label: 'src/App.tsx:12' },
      server: false,
      live: true,
      items: [
        { name: 'title', type: 'string', value: '可视化调样式', pending: false, target: hero('title') },
        { name: 'variant', type: 'string', value: 'primary', options: ['primary', 'outline', 'ghost'], pending: false, target: hero('variant') },
        { name: 'size', type: 'undefined', value: 'md', options: ['sm', 'md', 'lg', 'xl'], missing: true, pending: false, target: hero('size') },
        { name: 'tone', type: 'string', value: 'neutral', options: ['neutral', 'brand', 'success', 'warning', 'danger'], pending: false, target: hero('tone') },
        { name: 'count', type: 'number', value: 3, pending: false, target: hero('count') },
        { name: 'compact', type: 'boolean', value: false, pending: false, target: hero('compact') },
        { name: 'onClose', type: 'function', value: null, summary: 'onClose()', pending: false, target: hero('onClose') },
      ],
    },
  };
  const propStart = Object.fromEntries(Object.entries(propViews).map(([uid, v]) => [uid, Object.fromEntries(v.items.map((x) => [x.name, x.value]))]));
  const select = (uid: string) => {
    const e = els[uid] ?? els.e1;
    const edited = (textByEl[e.uid] ??= {});
    const o = orders[e.uid];
    const file = e.source?.file ?? '/proj/src/App.tsx';
    const at = `${file.replace('/proj/', '')}:${e.source?.line}`;
    state.selection = {
      props: propViews[e.uid],
      order: o ? { items: o.items, index: o.items.findIndex((i) => i.uid === e.uid), axis: o.axis, pending: o.pending, target: o.target } : undefined,
      texts: e.text?.segments.map((s, i) => ({
        segment: i,
        value: edited[i] ?? s.value.trim(),
        pending: i in edited,
        origin: 'jsx',
        target: { kind: 'source', label: at, file, line: e.source?.line, column: e.source?.column, affects: e.sameSource },
      })),
      el: e,
      file,
      ...(e.uid === 'e3' ? { scopeAll: 3 } : {}),
      targets: Object.fromEntries(
        Object.keys(e.computed).map((p): [string, Target] => {
          const agent = p === 'opacity' && uid === 'e2';
          if (p.startsWith('--')) return [p, { kind: 'css', label: `src/index.css @theme ${p}`, file: '/proj/src/index.css', affects: 0 }];
          // 只改这个：类名加在用到 Badge 的那一处
          const one = e.uid === 'e3' && state.scope === 'instance';
          return [
            p,
            {
              kind: agent ? 'agent' : 'tailwind',
              label: one ? 'src/App.tsx:16 <Badge> className' : `${at} className`,
              file: one ? '/proj/src/App.tsx' : file,
              line: one ? 16 : e.source?.line,
              column: e.source?.column,
              affects: one ? 1 : e.sameSource,
              reason: agent ? t('mock.agentReason') : undefined,
              ...(e.winners[p] ? { declared: true } : {}),
            },
          ];
        }),
      ),
      pending: (pendingByEl[e.uid] ??= {}),
      removed: (removedByEl[e.uid] ??= []),
      ...(e.assets ? { assets: { ...e.assets, items: assetsOpen ? ASSETS : null } } : {}),
    };
  };
  select('e1');

  // 上一步 / 下一步：每步之前存一份假宿主的全部状态，撤销、重做时整份换回去
  const undos: Array<{ label: () => string; data: string }> = [];
  const redos: Array<{ label: () => string; data: string }> = [];
  const dump = () => JSON.stringify({ changes: state.changes, pendingByEl, removedByEl, textByEl, orders, propViews });
  const refill = <T extends object>(to: T, from: T) => {
    for (const k of Object.keys(to)) delete (to as Record<string, unknown>)[k];
    Object.assign(to, from);
  };
  const restore = (data: string) => {
    const d = JSON.parse(data) as { changes: ChangeView[]; pendingByEl: typeof pendingByEl; removedByEl: typeof removedByEl; textByEl: typeof textByEl; orders: typeof orders; propViews: typeof propViews };
    state.changes = d.changes;
    refill(pendingByEl, d.pendingByEl);
    refill(removedByEl, d.removedByEl);
    refill(textByEl, d.textByEl);
    refill(orders, d.orders);
    refill(propViews, d.propViews);
    select(state.selection?.el.uid ?? 'e1');
  };
  const mark = (label: () => string) => {
    undos.push({ label, data: dump() });
    redos.length = 0;
  };
  const syncHistory = () => {
    state.history = { undo: undos[undos.length - 1]?.label() ?? null, redo: redos[redos.length - 1]?.label() ?? null };
  };
  const dropChanges = (pick: (c: ChangeView) => boolean) => {
    const sel = state.selection!;
    for (const c of state.changes.filter((x) => x.status === 'pending' && pick(x))) {
      for (const p of c.props) {
        delete sel.pending[p];
        sel.removed.splice(0, sel.removed.length, ...sel.removed.filter((x) => x !== p));
      }
    }
    state.changes = state.changes.filter((x) => !(x.status === 'pending' && pick(x)));
  };
  const editStyle = (edit: PanelToExt & { t: 'edit' }) => {
    const sel = state.selection!;
    const e = sel.el;
    const props = edit.edit.props;
    const key = `${e.uid}|${props.join(',')}`;
    if (edit.edit.remove) {
      const declared = props.filter((p) => sel.targets[p]?.declared);
      if (!declared.length) {
        state.notice = { level: 'info', text: t('ext.remove.nothing') };
        return;
      }
      dropChanges((c) => c.element === e.label && c.props.some((p) => declared.includes(p)));
      for (const p of declared) {
        sel.pending[p] = fallbackOf(p);
        if (!sel.removed.includes(p)) sel.removed.push(p);
      }
      state.changes.unshift({
        id: `${e.uid}|${declared.join(',')}#${++seq}`,
        kind: 'style',
        status: 'pending',
        element: e.label,
        props: declared,
        propLabel: groupLabel(declared),
        from: e.winners[declared[0]]?.rule?.utility ?? e.computed[declared[0]],
        to: t('panel.change.removed'),
        remove: true,
        target: sel.targets[declared[0]],
        pageUrl: state.page!.url,
        createdAt: Date.now(),
      } satisfies ChangeView);
      return;
    }
    for (const p of props) sel.pending[p] = edit.edit.value;
    if (edit.edit.phase !== 'commit') {
      // 和扩展一样：这些属性没有未应用的改动、预览回到原值时不算改过
      const touched = state.changes.some((c) => c.status === 'pending' && c.element === e.label && c.props.some((p) => props.includes(p)));
      if (!touched && props.every((p) => sameValue(p, edit.edit.value, e.computed[p] ?? ''))) for (const p of props) delete sel.pending[p];
      return;
    }
    dropChanges((c) => !!c.remove && c.element === e.label && c.props.some((p) => props.includes(p)));
    for (const p of props) sel.pending[p] = edit.edit.value;
    const from = e.computed[props[0]];
    const existing = state.changes.find((c) => c.status === 'pending' && c.id.startsWith(key));
    const to = edit.edit.token || edit.edit.value;
    if (existing) existing.to = to;
    else
      state.changes.unshift({
        id: `${key}#${++seq}`,
        kind: 'style',
        status: 'pending',
        element: e.label,
        props,
        propLabel: groupLabel(props),
        from,
        to,
        target: sel.targets[props[0]],
        pageUrl: state.page!.url,
        createdAt: Date.now(),
      } satisfies ChangeView);
  };

  const subs = new Set<(s: PanelState) => void>();
  const emit = () => {
    const snap = structuredClone(state);
    for (const cb of subs) cb(snap);
  };
  let seq = 0;

  const handle = (m: PanelToExt) => {
    console.debug('[mock] →', m);
    const label = stepLabel(m, state);
    if (label) mark(label);
    switch (m.t) {
      case 'ready':
        break;
      case 'openPage':
        state.connection = 'opening';
        emit();
        setTimeout(() => {
          state.connection = 'connected';
          state.page = { url: m.url, title: 'mock' };
          emit();
        }, 500);
        return;
      case 'measure':
        state.measureOn = m.on;
        if (m.on) state.pickOn = false;
        break;
      case 'pick':
        state.pickOn = m.on;
        if (m.on) state.measureOn = false;
        if (m.on)
          setTimeout(() => {
            state.pickOn = false;
            select('e2');
            emit();
          }, 900);
        break;
      case 'select':
        select(m.uid);
        break;
      case 'setScope':
        state.scope = m.scope;
        if (state.selection) select(state.selection.el.uid);
        break;
      case 'setSnap':
        state.snap = m.on;
        break;
      case 'setLocale':
        setLocale(m.locale);
        state.locale = m.locale;
        break;
      case 'edit':
        editStyle(m);
        break;
      case 'editMany':
        for (const edit of m.edits) editStyle({ t: 'edit', edit });
        break;
      case 'resetProps': {
        const label = state.selection!.el.label;
        dropChanges((c) => c.kind === 'style' && c.element === label && c.props.some((p) => m.props.includes(p)));
        break;
      }
      case 'resetText': {
        const uid = state.selection!.el.uid;
        delete textByEl[uid]?.[m.segment];
        state.changes = state.changes.filter((c) => !(c.status === 'pending' && c.id === `${uid}|text|${m.segment}`));
        select(uid);
        break;
      }
      case 'resetProp': {
        const uid = state.selection!.el.uid;
        const item = propViews[uid]?.items.find((x) => x.name === m.name);
        if (item) {
          item.value = propStart[uid][m.name];
          item.pending = false;
        }
        state.changes = state.changes.filter((c) => !(c.status === 'pending' && c.id === `${uid}|prop|${m.name}`));
        select(uid);
        break;
      }
      case 'undo':
      case 'redo': {
        const [from, to] = m.t === 'undo' ? [undos, redos] : [redos, undos];
        const step = from.pop();
        if (!step) break;
        to.push({ label: step.label, data: dump() });
        restore(step.data);
        break;
      }
      case 'editText': {
        const sel = state.selection!;
        const view = sel.texts?.find((x) => x.segment === m.segment);
        const original = sel.el.text?.segments[m.segment]?.value.trim() ?? '';
        if (!view || m.phase !== 'commit') break;
        const edited = (textByEl[sel.el.uid] ??= {});
        const id = `${sel.el.uid}|text|${m.segment}`;
        state.changes = state.changes.filter((c) => !(c.status === 'pending' && c.id === id));
        if (!m.value || m.value === original) delete edited[m.segment];
        else {
          edited[m.segment] = m.value;
          state.changes.unshift({
            id,
            kind: 'text',
            status: 'pending',
            element: sel.el.label,
            props: [],
            propLabel: t('panel.change.text'),
            from: original,
            to: m.value,
            target: view.target,
            pageUrl: state.page!.url,
            createdAt: Date.now(),
          } satisfies ChangeView);
        }
        select(sel.el.uid);
        break;
      }
      case 'reorder': {
        const uid = state.selection!.el.uid;
        const o = orders[uid];
        const from = o?.items.findIndex((i) => i.uid === m.uid) ?? -1;
        if (!o || from < 0) break;
        const [it] = o.items.splice(from, 1);
        o.items.splice(m.to, 0, it);
        const now = o.items.map((i) => i.uid);
        o.pending = now.join() !== o.start.join();
        if (m.phase !== 'commit') break;
        const id = `${uid}|order`;
        state.changes = state.changes.filter((c) => !(c.status === 'pending' && c.id === id));
        if (o.pending)
          state.changes.unshift({
            id,
            kind: 'reorder',
            status: 'pending',
            element: it.label,
            props: [],
            propLabel: t('panel.change.order'),
            from: String(o.start.indexOf(it.uid) + 1),
            to: String(m.to + 1),
            target: o.target,
            simulated: true,
            pageUrl: state.page!.url,
            createdAt: Date.now(),
          } satisfies ChangeView);
        select(uid);
        break;
      }
      case 'editProp': {
        const uid = state.selection!.el.uid;
        const item = propViews[uid]?.items.find((x) => x.name === m.name);
        if (!item) break;
        const start = propStart[uid][m.name];
        item.value = m.value;
        if (m.phase !== 'commit') break;
        const id = `${uid}|prop|${m.name}`;
        state.changes = state.changes.filter((c) => !(c.status === 'pending' && c.id === id));
        item.pending = m.value !== start;
        if (item.pending)
          state.changes.unshift({
            id,
            kind: 'prop',
            status: 'pending',
            element: state.selection!.el.label,
            props: [m.name],
            propLabel: m.name,
            from: item.missing ? t('engine.prop.unset') : JSON.stringify(start),
            to: JSON.stringify(m.value),
            target: item.target,
            pageUrl: state.page!.url,
            createdAt: Date.now(),
          } satisfies ChangeView);
        select(uid);
        break;
      }
      case 'apply': {
        // 交给 Agent：先等 Agent 改，过一会儿模拟它改完、页面核对上
        const sent = state.changes.filter((c) => (m.ids ? m.ids.includes(c.id) && (c.status === 'pending' || c.status === 'handoff') : c.status === 'pending'));
        if (!sent.length) break;
        for (const c of sent) c.status = 'handoff';
        state.notice = { level: 'info', text: t('ext.apply.prefilled', { n: sent.length }) };
        setTimeout(() => {
          for (const c of sent) if (c.status === 'handoff') c.status = 'applied';
          emit();
        }, 4000);
        break;
      }
      case 'revert': {
        const c = state.changes.find((x) => x.id === m.id);
        if (!c) break;
        c.status = 'reverting';
        state.notice = { level: 'info', text: t('ext.revert.prefilled') };
        setTimeout(() => {
          if (c.status === 'reverting') c.status = 'reverted';
          emit();
        }, 4000);
        break;
      }
      case 'discard': {
        const c = state.changes.find((x) => x.id === m.id);
        if (c?.status === 'reverting') {
          c.status = 'applied';
          break;
        }
        state.changes = state.changes.filter((x) => x.id !== m.id);
        if (c && state.selection) for (const p of c.props) delete state.selection.pending[p];
        if (c?.kind === 'text') {
          const [uid, , segment] = c.id.split('|');
          delete textByEl[uid]?.[+segment];
          if (state.selection?.el.uid === uid) select(uid);
        }
        break;
      }
      case 'clearDone':
        state.changes = state.changes.filter((c) => c.status !== 'applied' && c.status !== 'reverted');
        break;
      case 'dismissNotice':
        state.notice = null;
        break;
      case 'assetsOpen':
        if (assetsOpen === m.open) return;
        assetsOpen = m.open;
        setTimeout(() => {
          if (state.selection) select(state.selection.el.uid);
          emit();
        }, 400);
        return;
      case 'fontsOpen':
        if (state.fonts) return;
        state.fonts = { page: ['Inter', 'Playfair Display'], local: null };
        setTimeout(() => {
          state.fonts = { ...state.fonts!, local: LOCAL_FONTS };
          emit();
        }, 600);
        break;
      case 'saveAsset':
        state.notice = { level: 'info', text: t('ext.assets.saved', { name: ASSETS.find((a) => a.id === m.id)?.name ?? m.id }) };
        break;
      case 'saveAllAssets':
        state.notice = { level: 'info', text: t('ext.assets.allSaved', { n: ASSETS.filter((a) => !a.streaming).length, folder: 'Downloads' }) };
        break;
      case 'copySvg':
        state.notice = { level: 'info', text: t('ext.assets.copied') };
        break;
      default:
        break;
    }
    // 交给 Agent、还原之后，之前记的几步对不上了
    if (m.t === 'apply' || m.t === 'revert') undos.length = redos.length = 0;
    syncHistory();
    emit();
  };

  // ?state=real-state.json：加载扩展自测导出的真实状态，用真实页面数据检查面板排版
  const src = new URLSearchParams(location.search).get('state');
  if (src) {
    void fetch(src)
      .then((r) => r.json() as Promise<PanelState>)
      .then((s) => {
        Object.assign(state, s, { locale: getLocale() });
        emit();
      });
  }

  const store: Record<string, unknown> = JSON.parse(localStorage.getItem('css-tuner-mock-ui') ?? '{}');
  return {
    send: (m) => setTimeout(() => handle(m), 0),
    subscribe(cb) {
      subs.add(cb);
      cb(structuredClone(state));
      return () => subs.delete(cb);
    },
    load: <T,>(k: string, fallback: T) => (k in store ? (store[k] as T) : fallback),
    save(k, v) {
      store[k] = v;
      localStorage.setItem('css-tuner-mock-ui', JSON.stringify(store));
    },
  };
}
