import { aliasesOf } from '@css-tuner/protocol';
import { collectRules, matchRules, pickWinner } from './cascade';
import { originalReader } from './preview';
import { isOwnSheet } from './util';

/**
 * 删属性的预览值：把这些属性在元素上生效的那条作者声明（规则或内联样式）临时去掉，量出计算值再放回。
 * 内联样式里预览加上的值也先撤掉，量到的才是删掉之后页面本来的样子；改动都在同步代码里完成，页面不会画出中间状态
 */
export function fallbackValues(el: Element, props: string[]): Record<string, string> {
  const matched = matchRules(el, collectRules(isOwnSheet));
  const inline = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  const saved = new Map<CSSStyleDeclaration, string>();
  const hold = (style: CSSStyleDeclaration) => {
    if (!saved.has(style)) saved.set(style, style.cssText);
  };
  // 先把各属性的胜出声明都找好再动手：简写里带 var() 时（border-color: var(--x)），去掉一边之后另外几边的值就读不出来了
  const winners = props.map((prop) => pickWinner(el, matched, prop, originalReader));
  for (const [i, prop] of props.entries()) {
    const w = winners[i];
    const style = w ? (w.inline ? inline : w.fr?.style) : undefined;
    if (style) {
      hold(style);
      for (const name of aliasesOf(prop)) style.removeProperty(name);
    }
    if (!inline || style === inline) continue;
    for (const name of aliasesOf(prop)) {
      const was = originalReader(inline, name);
      if (was === null) continue;
      hold(inline);
      if (was === 'absent') inline.removeProperty(name);
      else inline.setProperty(name, was.value, was.priority);
    }
  }
  const cs = getComputedStyle(el);
  const out = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p).trim()]));
  for (const [style, text] of saved) style.cssText = text;
  return out;
}
