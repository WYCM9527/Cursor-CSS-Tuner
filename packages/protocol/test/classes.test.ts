import { describe, expect, it } from 'vitest';
import { activeSegment } from '../src';

describe('同一个类名写在好几段类名字符串里时，元素用的是哪一段', () => {
  const has = (...classes: string[]) => (c: string) => classes.includes(c);
  /** featured ? 'bg-stone-900 text-white shadow-lg' : 'bg-white shadow-lg' */
  const segs = [
    ['bg-stone-900', 'text-white', 'shadow-lg'],
    ['bg-white', 'shadow-lg'],
  ];

  it('取这一段的类名在元素上最全的那段', () => {
    expect(activeSegment(segs, has('rounded-2xl', 'bg-stone-900', 'text-white', 'shadow-lg'))).toBe(0);
    expect(activeSegment(segs, has('rounded-2xl', 'bg-white', 'shadow-lg'))).toBe(1);
  });

  it('一样全时取靠后的：cn / cva 里后写的盖住先写的', () => {
    const same = [['shadow-lg'], ['p-6'], ['shadow-lg']];
    expect(activeSegment(same, has('shadow-lg', 'p-6'))).toBe(2);
    expect(activeSegment(same, has('shadow-lg'))).toBe(2);
  });

  it('按占这一段的比例算，不按个数：长的一段只对上一半，不如短的一段全对上', () => {
    const mixed = [['a', 'b', 'c', 'd'], ['a']];
    expect(activeSegment(mixed, has('a', 'b'))).toBe(1);
    expect(activeSegment(mixed, has('a', 'b', 'c', 'd'))).toBe(1);
    expect(activeSegment([['a'], ['a', 'b', 'c', 'd']], has('a', 'b'))).toBe(0);
  });

  it('空的一段不占便宜；哪段都对不上时也给出一段', () => {
    expect(activeSegment([['a'], []], has('a'))).toBe(0);
    expect(activeSegment(segs, has('other'))).toBe(1);
  });
});
