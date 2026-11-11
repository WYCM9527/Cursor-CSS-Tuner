import { describe, expect, it } from 'vitest';
import { maxSpecificity, resolveNested, specificity, splitTopLevel, staticSelector } from '../src/specificity';
import { clientModuleUrl, distDirOf, isWebpackModule, joinPath, projectRootOf, serverModuleUrl, webpackCssSources } from '../src/next';
import { decodeMappings, extractMapUrl, filePathOf, jsxLineShift, originalPosition, originalPositionFor, sourcesOf } from '../src/sourcemap';
import { clip, textOf, unescapeIdent } from '../src/util';
import { dropSlot, flowOffsets, slotLine } from '../src/drop';
import { hasRun, sameOrder, textSig } from '../src/sig';
import { readDecl, type Reader } from '../src/cascade';
import { idRefs, localUrl, srgbColor } from '../src/assets';
import { holdZone, shown } from '../src/overlay';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;

/** 假的声明块：属性名按写的顺序排 */
const declBlock = (decls: Record<string, string>) =>
  Object.assign(Object.keys(decls), { getPropertyValue: (p: string) => decls[p] ?? '', getPropertyPriority: () => '' }) as unknown as CSSStyleDeclaration;

describe('面板上认元素用的文字', () => {
  type Kid = { nodeType: number; textContent: string };
  const text = (s: string): Kid => ({ nodeType: 3, textContent: s });
  const child = (s: string): Kid => ({ nodeType: 1, textContent: s });
  const elem = (tagName: string, kids: Kid[], attrs: Record<string, string> = {}) =>
    ({ tagName, childNodes: kids, textContent: kids.map((k) => k.textContent).join(''), getAttribute: (n: string) => attrs[n] ?? null }) as unknown as Element;

  it('容器只取自己直接写的字，不把里面整块的字连起来', () => {
    expect(textOf(elem('DIV', [text('  Hi  '), child('里面的字')]))).toBe('Hi');
    expect(textOf(elem('DIV', [child('里面的字')]))).toBe('');
  });

  it('按钮、标题这类元素的字包在子元素里也算', () => {
    expect(textOf(elem('BUTTON', [child(' 保存 ')]))).toBe('保存');
    expect(textOf(elem('H2', [text('第 '), child('2'), text(' 章')]))).toBe('第 2 章');
  });

  it('没有字时用 alt、aria-label', () => {
    expect(textOf(elem('IMG', [], { alt: 'Logo' }))).toBe('Logo');
    expect(textOf(elem('svg', [text('\n  ')], { 'aria-label': '关闭' }))).toBe('关闭');
  });

  it('空白压成一个空格，太长截断', () => {
    expect(clip('a\n   b', 10)).toBe('a b');
    expect(clip('x'.repeat(40), 30)).toBe(`${'x'.repeat(29)}…`);
  });
});

describe('读规则里的声明', () => {
  it('删属性的预览把声明去掉了：按预览之前的原样读，赢家不变', () => {
    const before = { 'box-shadow': '0 1px 3px #0002', 'border-radius': '8px' };
    const live = declBlock({ 'border-radius': '8px' });
    const reader: Reader = (style, prop) => {
      if (style !== live) return null;
      const index = Object.keys(before).indexOf(prop);
      return index < 0 ? 'absent' : { value: before[prop as keyof typeof before], priority: '', index };
    };
    expect(readDecl({ style: live }, 'box-shadow')).toBeNull();
    expect(readDecl({ style: live }, 'box-shadow', reader)).toMatchObject({ value: '0 1px 3px #0002', index: 0 });
  });

  it('预览加上去的声明原本没有', () => {
    const live = declBlock({ 'border-radius': '8px', 'border-top-width': '1px' });
    const reader: Reader = (style, prop) => (style === live && prop === 'border-top-width' ? 'absent' : null);
    expect(readDecl({ style: live }, 'border-top-width')).toMatchObject({ value: '1px' });
    expect(readDecl({ style: live }, 'border-top-width', reader)).toBeNull();
  });
});

describe('拖动换序的落点', () => {
  const rows = [box(0, 0, 100, 20), box(0, 30, 100, 20), box(0, 60, 100, 20)];
  it('竖排：落在某项上半截插到它前面，下半截插到它后面；离得远按最近的一项算', () => {
    expect(dropSlot(rows, 50, 5, 'y')).toBe(0);
    expect(dropSlot(rows, 50, 15, 'y')).toBe(1);
    expect(dropSlot(rows, 50, 44, 'y')).toBe(2);
    expect(dropSlot(rows, 50, 300, 'y')).toBe(3);
    expect(dropSlot(rows, -40, 34, 'y')).toBe(1);
  });

  it('横排按水平中线算，插入线画在两项之间', () => {
    const cols = [box(0, 0, 40, 20), box(50, 0, 40, 20)];
    expect(dropSlot(cols, 80, 10, 'x')).toBe(2);
    expect(dropSlot(cols, 55, 10, 'x')).toBe(1);
    expect(slotLine(cols, 1, 'x')).toMatchObject({ x: 44, w: 2, y: 0, h: 20 });
    expect(slotLine(rows, 3, 'y')).toMatchObject({ x: 0, w: 100, y: 81 });
  });
});

describe('页面上画的框', () => {
  const at = (s: Partial<Parameters<typeof shown<string>>[0]>) => shown<string>({ sel: null, hover: null, muted: null, fromPanel: false, measuring: false, ...s });

  it('悬停别的元素画虚线框，选中元素不画', () => {
    expect(at({ sel: 'a', hover: 'b' })).toEqual({ hover: 'b', sel: null });
    expect(at({ hover: 'b' })).toEqual({ hover: 'b', sel: null });
  });

  it('刚点选的元素指针移开之前不画；移开再移回来画整套', () => {
    expect(at({ sel: 'a', hover: 'a', muted: 'a' })).toEqual({ hover: null, sel: null });
    expect(at({ sel: 'a', hover: 'a' })).toEqual({ hover: null, sel: 'full' });
  });

  it('点了别的元素、还没换好选中时，也不给它画虚线框', () => {
    expect(at({ sel: 'a', hover: 'b', muted: 'b' })).toEqual({ hover: null, sel: null });
  });

  it('面板上悬停选中元素那一行：刚点选过也画整套', () => {
    expect(at({ sel: 'a', hover: 'a', muted: 'a', fromPanel: true })).toEqual({ hover: null, sel: 'full' });
  });

  it('量距离时选中元素只描边', () => {
    expect(at({ sel: 'a', hover: 'b', measuring: true })).toEqual({ hover: 'b', sel: 'outline' });
  });
});

describe('把手保持带', () => {
  const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('标签在元素上面：从标签顶连到元素上边，横向盖住把手和标签', () => {
    const z = holdZone(r(275, 152, 500, 172), r(255, 152, 271, 172), r(255, 176, 454, 498));
    expect(z).toEqual(r(251, 148, 504, 180));
  });

  it('元素贴着页面顶、标签放在下面：从元素下边连到标签底', () => {
    const z = holdZone(r(22, 54, 200, 74), r(2, 54, 18, 74), r(2, 0, 300, 50));
    expect(z).toEqual(r(-2, 46, 204, 78));
  });

  it('元素贴着右边、标签往左挪：带子横向一直连到元素', () => {
    const z = holdZone(r(470, 76, 560, 96), r(450, 76, 466, 96), r(600, 100, 700, 150));
    expect(z).toEqual(r(446, 72, 604, 104));
  });
});

describe('换序预览的位移', () => {
  it('排成一列：按各项高度和原来的间距重新排', () => {
    const rows = [box(0, 0, 100, 20), box(0, 30, 100, 40), box(0, 80, 100, 20)];
    expect(flowOffsets(rows, [1, 0, 2], 'y')).toEqual([[0, 50], [0, -30], [0, 0]]);
  });

  it('排成一行：按各项宽度和原来的间距重新排', () => {
    const cols = [box(0, 0, 40, 20), box(50, 0, 60, 20)];
    expect(flowOffsets(cols, [1, 0], 'x')).toEqual([[70, 0], [-50, 0]]);
  });

  it('标题下面并排两个按钮：两个按钮左右互换，不是在竖直方向上挪 0', () => {
    const card = [box(0, 0, 100, 20), box(0, 30, 100, 40), box(0, 80, 40, 20), box(50, 80, 40, 20)];
    expect(flowOffsets(card, [0, 1, 3, 2], 'y')).toEqual([[0, 0], [0, 0], [50, 0], [-50, 0]]);
  });

  it('一行排满折到下一行：每项挪到新位置上原来那一项的地方', () => {
    const tags = [box(0, 0, 40, 20), box(50, 0, 40, 20), box(0, 30, 40, 20)];
    expect(flowOffsets(tags, [2, 0, 1], 'x')).toEqual([[50, 0], [-50, 30], [0, -30]]);
  });
});

describe('换序校验的指纹', () => {
  const li = (text: string) => textSig('li', text, '');
  it('和一项里面文字的先后无关', () => {
    expect(li('调参应用')).toBe(li('应用调参'));
    expect(li('调参')).not.toBe(li('应用'));
    expect(textSig('img', '', 'a.png')).toBe('img|a:a.png');
  });

  it('只差数字时也认得出（跟着位置变的编号），但各项不算数字分不开时只认全部文字', () => {
    const want = [li('02需求访谈'), li('01方案设计')];
    expect(sameOrder([li('01需求访谈'), li('02方案设计')], want)).toBe(true);
    expect(sameOrder([li('01方案设计'), li('02需求访谈')], want)).toBe(false);
    expect(sameOrder([li('2'), li('1')], [li('1'), li('2')])).toBe(false);
    expect(sameOrder([li('1'), li('2')], [li('1'), li('2')])).toBe(true);
    expect(sameOrder([li('1')], [li('1'), li('2')])).toBe(false);
  });

  it('一项由几个元素组成时逐个比', () => {
    const unit = (...xs: string[]) => xs.map(li).join(' + ');
    expect(sameOrder([unit('3天', '4时'), unit('甲')], [unit('5天', '6时'), unit('甲')])).toBe(true);
    expect(sameOrder([unit('甲'), unit('3天', '4时')], [unit('5天', '6时'), unit('甲')])).toBe(false);
  });

  it('可以有一项自己在变（轮播文案），其余各项在原位就算对上；改之前的顺序不会被当成对上', () => {
    const want = [li('给正在难熬的人'), li('社区'), li('赞助'), li('关于')];
    expect(sameOrder([li('给小时候的自己'), li('社区'), li('赞助'), li('关于')], want)).toBe(true);
    expect(sameOrder([li('给小时候的自己'), li('赞助'), li('社区'), li('关于')], want)).toBe(false);
    expect(sameOrder([li('社区'), li('给小时候的自己'), li('赞助'), li('关于')], want)).toBe(false);
    expect(sameOrder([li('给小时候的自己'), li('社区'), li('另一项'), li('关于')], want)).toBe(false);
    expect(sameOrder([li('乙'), li('丙')], [li('甲'), li('丙')])).toBe(false);
  });

  it('找父元素时按子元素的指纹序列先筛：要连着出现，允许一项对不上', () => {
    const want = [li('甲'), li('乙'), li('丙')];
    expect(hasRun([li('头'), li('甲'), li('乙'), li('丙')], want)).toBe(true);
    expect(hasRun([li('甲'), li('变了'), li('丙')], want)).toBe(true);
    expect(hasRun([li('甲'), li('头'), li('乙'), li('尾'), li('丙')], want)).toBe(false);
  });
});

describe('specificity', () => {
  it('基础选择器', () => {
    expect(specificity('div')).toEqual([0, 0, 1]);
    expect(specificity('.card .title')).toEqual([0, 2, 0]);
    expect(specificity('#app > ul li.active')).toEqual([1, 1, 2]);
    expect(specificity('a:hover::before')).toEqual([0, 1, 2]);
    expect(specificity('input[type="text"]')).toEqual([0, 1, 1]);
  });

  it('Tailwind 转义类名算一个类', () => {
    expect(specificity('.md\\:px-6')).toEqual([0, 1, 0]);
    expect(specificity('.hover\\:bg-tri-void\\/80:hover')).toEqual([0, 2, 0]);
    expect(specificity('.p-4\\.5')).toEqual([0, 1, 0]);
  });

  it(':where / :is / :not / :has / :nth-child(of)', () => {
    expect(specificity(':where(.a, #b) .c')).toEqual([0, 1, 0]);
    expect(specificity(':is(.a, #b) .c')).toEqual([1, 1, 0]);
    expect(specificity('li:not(.x)')).toEqual([0, 1, 1]);
    expect(specificity('.a:has(> img)')).toEqual([0, 1, 1]);
    expect(specificity(':nth-child(2n of .item)')).toEqual([0, 2, 0]);
    expect(specificity('.group-hover\\:x:is(:where(.group):hover *)')).toEqual([0, 2, 0]);
  });

  it('选择器列表取最大', () => {
    expect(maxSpecificity('.a, #b, div')).toEqual([1, 0, 0]);
  });
});

describe('splitTopLevel / resolveNested', () => {
  it('忽略括号和引号里的逗号', () => {
    expect(splitTopLevel(':is(.a, .b), [data-x="1,2"], .c')).toEqual([':is(.a, .b)', '[data-x="1,2"]', '.c']);
  });

  it('展开嵌套', () => {
    expect(resolveNested('.panel', '& .row')).toBe(':is(.panel) .row');
    expect(resolveNested('.panel', '.row')).toBe(':is(.panel) .row');
    expect(resolveNested('.a, .b', '&:hover, & > .c')).toBe(':is(.a, .b):hover, :is(.a, .b) > .c');
    expect(resolveNested(null, '.x')).toBe('.x');
  });

  it('统计影响元素数时去掉动态伪类', () => {
    expect(staticSelector('.btn:hover')).toBe('.btn');
    expect(staticSelector('.hover\\:x:hover')).toBe('.hover\\:x');
  });
});

describe('sourcemap', () => {
  it('解码 VLQ 并映射到原始位置', () => {
    // 第 1 行第 0 列 → 源 0 第 0 行第 0 列；第 2 行第 4 列 → 源 0 第 2 行第 2 列
    const map = { sources: ['App.tsx'], mappings: 'AAAA;IAEE' };
    const decoded = decodeMappings(map.mappings);
    expect(originalPositionFor(map, decoded, 1, 1)).toEqual({ source: 'App.tsx', line: 1, column: 1 });
    expect(originalPositionFor(map, decoded, 2, 5)).toEqual({ source: 'App.tsx', line: 3, column: 3 });
    expect(originalPositionFor(map, decoded, 2, 9)).toEqual({ source: 'App.tsx', line: 3, column: 3 });
  });

  it('分段 sourcemap（Turbopack）：按偏移找到所在段，列偏移只作用于段的第一行', () => {
    const app = { sources: ['file:///p/src/App.tsx'], mappings: 'AAAA;IAEE' };
    const lib = { sources: ['file:///p/node_modules/react/jsx.js'], mappings: 'AAAA', ignoreList: [0] };
    const map = { sections: [{ offset: { line: 3, column: 0 }, map: app }, { offset: { line: 10, column: 4 }, map: lib }] };
    expect(originalPosition(map, 2, 1)).toBeNull();
    expect(originalPosition(map, 4, 1)).toEqual({ source: 'file:///p/src/App.tsx', line: 1, column: 1, ignored: false });
    expect(originalPosition(map, 5, 6)).toEqual({ source: 'file:///p/src/App.tsx', line: 3, column: 3, ignored: false });
    expect(originalPosition(map, 11, 5)).toEqual({ source: 'file:///p/node_modules/react/jsx.js', line: 1, column: 1, ignored: true });
    expect(sourcesOf(map)).toEqual(['file:///p/src/App.tsx', 'file:///p/node_modules/react/jsx.js']);
  });

  it('file:// 源转本地路径，CSS 里的 sourceMappingURL 注释也认', () => {
    expect(filePathOf('file:///Users/me/vibe%20coding/%E5%8F%AF/src/a.tsx')).toBe('/Users/me/vibe coding/可/src/a.tsx');
    expect(filePathOf('file:///C:/proj/a.css')).toBe('C:/proj/a.css');
    expect(filePathOf('turbopack:///[project]/a.css')).toBeNull();
    expect(extractMapUrl('.a{}\n/*# sourceMappingURL=x._.css.map*/')).toBe('x._.css.map');
    expect(extractMapUrl('x()\n//# sourceMappingURL=data:application/json;base64,e30=')).toBe('data:application/json;base64,e30=');
  });
});

describe('React 18 的 JSX 开发态位置', () => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const vlq = (n: number) => {
    let v = n < 0 ? (-n << 1) | 1 : n << 1;
    let s = '';
    do {
      let d = v & 31;
      v >>>= 5;
      if (v) d |= 32;
      s += B64[d];
    } while (v);
    return s;
  };
  /** 每行一段，[原始行, 原始列]（1 起）映射到这一行的第 0 列 */
  const mapOf = (rows: Array<[number, number]>) => {
    let line = 0;
    let col = 0;
    const mappings = rows
      .map(([l, c]) => {
        const s = vlq(0) + vlq(0) + vlq(l - 1 - line) + vlq(c - 1 - col);
        line = l - 1;
        col = c - 1;
        return s;
      })
      .join(';');
    return { sources: ['main.jsx'], mappings };
  };
  const obj = (file: string, line: number, column: number) => `{ fileName: ${file}, lineNumber: ${line}, columnNumber: ${column} }`;
  const main = JSON.stringify('/p/src/main.jsx');

  it('plugin-react 4 在前面插了 react-refresh 的代码：位置对象映射回原始 JSX，多数差同样的行数', () => {
    const code = [obj(main, 26, 7), obj(main, 27, 7), obj(main, 25, 5), obj(JSON.stringify('/p/src/other.jsx'), 90, 1)].join('\n');
    expect(jsxLineShift(code, mapOf([[7, 7], [8, 7], [6, 5], [1, 1]]), '/p/src/main.jsx')).toBe(19);
  });

  it('位置本来就对、或者差的行数各不相同时不纠正', () => {
    const code = [obj(main, 7, 7), obj(main, 8, 7)].join('\n');
    expect(jsxLineShift(code, mapOf([[7, 7], [8, 7]]), '/p/src/main.jsx')).toBe(0);
    expect(jsxLineShift([obj(main, 30, 7), obj(main, 9, 7), obj(main, 20, 3)].join('\n'), mapOf([[7, 7], [8, 7], [6, 3]]), '/p/src/main.jsx')).toBe(0);
  });

  it('文件名是 _jsxFileName 这种变量时也算', () => {
    const code = [obj('_jsxFileName', 10, 5), obj('_jsxFileName', 12, 7)].join('\n');
    expect(jsxLineShift(code, mapOf([[7, 5], [9, 7]]), '/p/src/main.jsx')).toBe(3);
  });
});

describe('Next.js 栈帧', () => {
  const dist = '/Users/me/vibe coding/my site/.next/dev';
  const chunk = 'file:///Users/me/vibe%20coding/my%20site/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__1sns-o6._.js';

  it('服务端组件帧去掉伪造前缀和 ?N 计数，热更新后的 ?id= 保留并解掉多的一层编码', () => {
    expect(serverModuleUrl(`about://React/Server/${chunk}?68`)).toBe(chunk);
    expect(serverModuleUrl(`rsc://React/Server/${chunk}`)).toBe(chunk);
    const hmr = 'file:///Users/me/vibe%2520coding/p/.next/dev/server/chunks/ssr/%255Broot%255D__x._.js?id=%255Bproject%255D/src/app/page.tsx+%255Bapp-rsc%255D+(ecmascript)';
    expect(serverModuleUrl(`about://React/Server/${hmr}?3`)).toBe(
      'file:///Users/me/vibe%20coding/p/.next/dev/server/chunks/ssr/%5Broot%5D__x._.js?id=%5Bproject%5D/src/app/page.tsx+%5Bapp-rsc%5D+(ecmascript)',
    );
    expect(serverModuleUrl('http://127.0.0.1:3000/_next/static/chunks/a.js')).toBeNull();
  });

  it('从服务端帧认出构建目录，推出项目根', () => {
    expect(distDirOf(`about://React/Server/${chunk}?68`)).toBe(dist);
    expect(distDirOf('about://React/Server/file:///C:/proj/.next/dev/server/app/page.js?1')).toBe('C:/proj/.next/dev');
    expect(distDirOf('http://127.0.0.1:3000/_next/static/chunks/a.js')).toBeNull();
    expect(projectRootOf(dist)).toBe('/Users/me/vibe coding/my site');
    expect(projectRootOf('/p/build/dev')).toBe('/p');
    expect(projectRootOf('/p/out')).toBe('/p');
    expect(joinPath('/Users/me/p', 'app/[locale]/page.tsx')).toBe('/Users/me/p/app/[locale]/page.tsx');
  });

  it('客户端 chunk 帧换成构建目录里的 file:// 路径，带上查询串', () => {
    expect(clientModuleUrl('http://127.0.0.1:3000/_next/static/chunks/src_a.js?id=7', dist)).toBe(
      'file:///Users/me/vibe coding/my site/.next/dev/static/chunks/src_a.js?id=7',
    );
    expect(clientModuleUrl('http://127.0.0.1:3000/_next/static/chunks/a.js', 'C:/proj/.next/dev')).toBe('file:///C:/proj/.next/dev/static/chunks/a.js');
    expect(clientModuleUrl('http://127.0.0.1:3000/src/App.tsx', dist)).toBeNull();
  });

  it('webpack 模式：业务模块帧原样交给接口，node_modules 里的不算', () => {
    expect(isWebpackModule('webpack-internal:///(app-pages-browser)/./src/components/Counter.tsx')).toBe(true);
    expect(isWebpackModule('webpack-internal:///(app-pages-browser)/../../node_modules/.pnpm/next@16.4.4/node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js')).toBe(false);
    expect(isWebpackModule('http://127.0.0.1:3000/_next/static/chunks/a.js')).toBe(false);
    expect(serverModuleUrl('about://React/Server/webpack-internal:///(rsc)/./src/app/page.tsx?4')).toBe('webpack-internal:///(rsc)/./src/app/page.tsx');
    expect(distDirOf('about://React/Server/webpack-internal:///(rsc)/./src/app/page.tsx?4')).toBeNull();
  });

  it('webpack 模式的 CSS 从 pathinfo 注释认出源文件', () => {
    const loaders = '../../node_modules/.pnpm/next@16.4.4/node_modules/next/dist/build/webpack/loaders/css-loader/src/index.js??ruleSet[1].rules[15].oneOf[10].use[2]!../../node_modules/.pnpm/next@16.4.4/node_modules/next/dist/build/webpack/loaders/postcss-loader/src/index.js??ruleSet[1].rules[15].oneOf[10].use[3]';
    const head = (file: string) => `/*!*****!*\\\n  !*** css ${loaders}!${file} ***!\n  \\*****/\n`;
    expect(webpackCssSources(`${head('./src/app/globals.css')}.a { color: red }\n`)).toEqual(['./src/app/globals.css']);
    expect(webpackCssSources(`${head('./src/a.module.css')}.a{}\n${head('./src/b.css')}.b{}\n${head('./src/a.module.css')}`)).toEqual(['./src/a.module.css', './src/b.css']);
    expect(webpackCssSources(`${head('../../node_modules/pkg/style.css')}.x{}`)).toEqual([]);
    expect(webpackCssSources('.a { color: red }')).toEqual([]);
  });
});

describe('SVG 存成独立文件时的引用', () => {
  it('计算值里指向本页的 url() 改回 #id，别的地址不动', () => {
    const page = 'http://localhost:5173/media.html';
    expect(localUrl('url("http://localhost:5173/media.html#g1")', page)).toBe('url("#g1")');
    expect(localUrl('url("#g1") none', `${page}#top`)).toBe('url("#g1") none');
    expect(localUrl('url("http://cdn.x/sprite.svg#a")', page)).toBe('url("http://cdn.x/sprite.svg#a")');
    expect(localUrl('rgb(1, 2, 3)', page)).toBe('rgb(1, 2, 3)');
  });

  it('新写法的颜色换成 sRGB，别的值不动', () => {
    expect(srgbColor('oklch(0.637 0.237 25.331)')).toMatch(/^#[0-9a-f]{6}$/);
    expect(srgbColor('oklch(0.637 0.237 25.331 / 0.5)')).toMatch(/^rgba\(\d+, \d+, \d+, 0\.5\)$/);
    expect(srgbColor('rgb(59, 91, 219)')).toBe('rgb(59, 91, 219)');
    expect(srgbColor('url("#g1")')).toBe('url("#g1")');
    expect(srgbColor('none')).toBe('none');
  });

  it('找出属性里引用的 id', () => {
    expect(idRefs('href', '#icon-heart')).toEqual(['icon-heart']);
    expect(idRefs('href', '/sprite.svg#a')).toEqual([]);
    expect(idRefs('style', 'fill: url("#g1"); stroke: url(#g2)')).toEqual(['g1', 'g2']);
    expect(idRefs('clip-path', 'url(#c)')).toEqual(['c']);
  });
});

describe('unescapeIdent', () => {
  it('还原 Tailwind 类名', () => {
    expect(unescapeIdent('md\\:px-6')).toBe('md:px-6');
    expect(unescapeIdent('hover\\:bg-tri-void\\/80')).toBe('hover:bg-tri-void/80');
    expect(unescapeIdent('p-4\\.5')).toBe('p-4.5');
    expect(unescapeIdent('w-\\[37\\%\\]')).toBe('w-[37%]');
    expect(unescapeIdent('\\31 23')).toBe('123');
  });
});
