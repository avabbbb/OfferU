// difflib.SequenceMatcher(None, a, b).ratio() for strings, ported from CPython
// (including the autojunk "popular element" rule for b of 200+ items) so
// duplicate detection in reconcile_memory matches Python exactly.

export function sequenceRatio(aText: string, bText: string): number {
  const a = [...aText];
  const b = [...bText];
  const total = a.length + b.length;
  if (!total) return 1;

  const b2j = new Map<string, number[]>();
  b.forEach((ch, index) => {
    const list = b2j.get(ch);
    if (list) list.push(index);
    else b2j.set(ch, [index]);
  });
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [ch, indices] of [...b2j]) if (indices.length > ntest) b2j.delete(ch);
  }

  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    // isjunk=None so bjunk is empty: extend over any equal neighbours (this is what picks up popular chars).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1; bestj -= 1; bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  };

  let matches = 0;
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / total;
}
