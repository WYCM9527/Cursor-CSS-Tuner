import { splitTopLevel } from './selectors';

/** CSS 的通用字体族：写的时候不加引号，加了引号就成了叫这个名字的字体 */
export const GENERIC_FAMILIES = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'];

const GENERIC = new Set(GENERIC_FAMILIES);
/** 不加引号会被当成关键字的名字 */
const RESERVED = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);

function unquote(s: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2].replace(/\\(.)/g, '$1') : s.trim().replace(/\s+/g, ' ');
}

/** 字体栈拆成一个个字体名（去掉引号和转义） */
export function fontFamilies(stack: string): string[] {
  return splitTopLevel(stack, ',').map(unquote).filter(Boolean);
}

/** 字体栈里排第一的字体：装了它（或页面加载了它）就用它 */
export function primaryFamily(stack: string): string {
  return fontFamilies(stack)[0] ?? '';
}

export function isGenericFamily(name: string): boolean {
  return GENERIC.has(name.trim().toLowerCase());
}

/** 一个字体名写进 font-family 的样子：通用字体族和单个英文标识符原样写，其余加双引号 */
export function quoteFamily(name: string): string {
  const n = name.trim();
  if (isGenericFamily(n)) return n.toLowerCase();
  if (/^-?[A-Za-z_][\w-]*$/.test(n) && !RESERVED.has(n.toLowerCase())) return n;
  return `"${n.replace(/["\\]/g, '\\$&')}"`;
}

/** 首选的是不是同一个字体：Agent 写的时候常会补上后备字体，看起来一样 */
export function sameFontFamily(a: string, b: string): boolean {
  return primaryFamily(a).toLowerCase() === primaryFamily(b).toLowerCase();
}

/** 两串字体栈是不是同一串（引号、空白、大小写不算） */
export function sameFontStack(a: string, b: string): boolean {
  const fa = fontFamilies(a).map((f) => f.toLowerCase());
  const fb = fontFamilies(b).map((f) => f.toLowerCase());
  return fa.length === fb.length && fa.every((f, i) => f === fb[i]);
}
