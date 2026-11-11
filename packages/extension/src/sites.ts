import { readFileSync, statSync } from 'node:fs';
import {
  arrayOrderSite,
  classLiteralSites,
  indexCssRules,
  jsxAttrSite,
  jsxChildSite,
  jsxOrderCheck,
  jsxPropSite,
  locateClassSite,
  lookupCssRule,
  recipeVariants,
  type CssRuleIndex,
  type CssRuleSpec,
  type OrderSite,
  type PropSiteInfo,
  type RecipeInfo,
  type TextSite,
} from '@css-tuner/engine';

/** JSX 位置上 className 的静态信息 */
export interface SiteInfo {
  /** className 字面量里的类名 */
  tokens: string[];
  /** 同 tokens，按写在哪段字符串里分开（三元的两个分支、clsx 的几个参数各是一段），顺序同源码 */
  segments: string[][];
  hasClassName: boolean;
  /** 经 cn / twMerge / tv 合并，调用处传进来的类能覆盖组件自己的 */
  merges: boolean;
  /** className 表达式用到了组件的 className 参数 */
  passesClassName: boolean;
  /** 调用了同文件 cva / tv 配方时，基础类字符串的位置 */
  recipe: { line: number; column: number } | null;
}

/** 写类名用的字符串字面量（变体、类名常量） */
export interface LiteralInfo {
  line: number;
  column: number;
  tokens: string[];
  /** 如 `buttonVariants.size.default` */
  name: string;
}

interface FileEntry {
  mtime: number;
  size: number;
  source: string;
  sites: Map<string, SiteInfo | null>;
  literals?: LiteralInfo[] | null;
  texts?: Map<string, TextSite | { error: string }>;
  orders?: Map<string, ReturnType<typeof jsxOrderCheck>>;
  props?: Map<string, PropSiteInfo | { error: string }>;
  recipes?: Map<string, RecipeInfo | null>;
}

const MAX_FILES = 64;

/** 读源码里的 className 位置、类名字符串和文字写在哪（按文件 mtime 缓存），规划写回位置时用 */
export class ClassSiteReader {
  private files = new Map<string, FileEntry>();

  private entry(file: string): FileEntry | null {
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    let f = this.files.get(file);
    if (!f || f.mtime !== st.mtimeMs || f.size !== st.size) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      f = { mtime: st.mtimeMs, size: st.size, source, sites: new Map() };
      this.files.delete(file);
      this.files.set(file, f);
      if (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value as string);
    }
    return f;
  }

  site(file: string, line: number, column: number): SiteInfo | null {
    const f = this.entry(file);
    if (!f) return null;
    const key = `${line}:${column}`;
    let t = f.sites.get(key);
    if (t === undefined) {
      const site = locateClassSite(f.source, file, line, column);
      t =
        'error' in site
          ? null
          : {
              tokens: site.tokens.map((x) => x.text),
              segments: site.segments.map((s) => site.tokens.filter((x) => x.seg === s).map((x) => x.text)),
              hasClassName: site.hasClassName,
              merges: site.merges,
              passesClassName: site.passesClassName,
              recipe: site.recipe,
            };
      f.sites.set(key, t);
    }
    return t;
  }

  literals(file: string): LiteralInfo[] | null {
    const f = this.entry(file);
    if (!f) return null;
    if (f.literals === undefined) {
      const all = classLiteralSites(f.source, file);
      f.literals = 'error' in all ? null : all.map((s) => ({ line: s.line, column: s.column, tokens: s.tokens.map((t) => t.text), name: s.name ?? '' }));
    }
    return f.literals;
  }

  /** (line, column) 处 JSX 元素的第 index 个子节点是什么文字 */
  textChild(file: string, line: number, column: number, index: number): TextSite | { error: string } | null {
    return this.text(file, `c${line}:${column}:${index}`, (source) => jsxChildSite(source, file, line, column, index));
  }

  /** (line, column) 处 JSX 元素上 name 属性的值是什么文字 */
  textAttr(file: string, line: number, column: number, name: string): TextSite | { error: string } | null {
    return this.text(file, `a${line}:${column}:${name}`, (source) => jsxAttrSite(source, file, line, column, name));
  }

  /** 这几处 JSX 是不是同一个父元素下的几项（换序写回前的检查） */
  jsxOrder(file: string, sites: OrderSite[]): ReturnType<typeof jsxOrderCheck> | null {
    const f = this.entry(file);
    if (!f) return null;
    f.orders ??= new Map();
    const key = sites.map((s) => `${s.line}:${s.column}:${s.name ?? ''}`).join(',');
    let r = f.orders.get(key);
    if (!r) {
      r = jsxOrderCheck(f.source, file, sites);
      f.orders.set(key, r);
    }
    return r;
  }

  /** .map() 列表对应的数组字面量在哪（数组可能在别的文件里，每次重新找） */
  arraySite(file: string, line: number, column: number, count: number): ReturnType<typeof arrayOrderSite> | null {
    const f = this.entry(file);
    if (!f) return null;
    return arrayOrderSite({ file, source: f.source, line, column, count, read: readOrNull });
  }

  /** (line, column) 处组件调用上 name 属性的写法 */
  propSite(file: string, line: number, column: number, name: string, tag?: string): PropSiteInfo | { error: string } | null {
    const f = this.entry(file);
    if (!f) return null;
    f.props ??= new Map();
    const key = `${line}:${column}:${name}:${tag ?? ''}`;
    let s = f.props.get(key);
    if (!s) {
      s = jsxPropSite(f.source, file, line, column, name, tag);
      f.props.set(key, s);
    }
    return s;
  }

  /** (line, column) 处元素 className 用到的 cva / tv 配方 */
  recipe(file: string, line: number, column: number): RecipeInfo | null {
    const f = this.entry(file);
    if (!f) return null;
    f.recipes ??= new Map();
    const key = `${line}:${column}`;
    if (!f.recipes.has(key)) f.recipes.set(key, recipeVariants(f.source, file, line, column));
    return f.recipes.get(key) ?? null;
  }

  private text(file: string, key: string, read: (source: string) => TextSite | { error: string }): TextSite | { error: string } | null {
    const f = this.entry(file);
    if (!f) return null;
    f.texts ??= new Map();
    let s = f.texts.get(key);
    if (!s) {
      s = read(f.source);
      f.texts.set(key, s);
    }
    return s;
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 规则实际写在哪个文件：开发服务器把 @import 内联进入口样式表，页面上只看得到入口文件 */
export class CssRuleLocator {
  private indexes = new Map<string, { deps: Array<[string, number]>; index: CssRuleIndex }>();

  sourceOf(entry: string, spec: Pick<CssRuleSpec, 'selector' | 'fullSelector' | 'conditions' | 'ordinal'>): { file: string; selector: string } | null {
    let e = this.indexes.get(entry);
    if (!e || e.deps.some(([f, m]) => mtimeOf(f) !== m)) {
      const index = indexCssRules(entry, readOrNull);
      e = { deps: index.files.map((f) => [f, mtimeOf(f)]), index };
      this.indexes.set(entry, e);
    }
    const r = lookupCssRule(e.index, spec);
    return 'error' in r ? null : { file: r.file, selector: r.selector };
  }
}
