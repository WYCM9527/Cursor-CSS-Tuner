/**
 * 同一个类名写在好几段类名字符串里（三元的两个分支、几个变体）时，元素用的是哪一段：
 * 这一段的类名在元素上最全的那段，一样全时取靠后的（cn / cva 里后写的盖住先写的）。
 * segs 是这几段各自的类名，has 判断元素带不带某个类；返回 segs 的下标。规划（选中元素）和页面（同源元素）都用它，结果才对得上
 */
export function activeSegment(segs: readonly (readonly string[])[], has: (cls: string) => boolean): number {
  let best = 0;
  let bestScore = -1;
  segs.forEach((seg, i) => {
    const score = seg.length ? seg.filter(has).length / seg.length : 0;
    if (score >= bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
