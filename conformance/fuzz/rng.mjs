/** A small seeded random generator: the same seed and case number always produce the same request, so a finding can be replayed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every case gets its own generator derived from (seed, index), so cases do not depend on each other or on the run order. */
export function caseRng(seed, index) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return new Random(mulberry32(h >>> 0));
}

export class Random {
  constructor(next) { this.next = next; }
  /** integer in [0, n) */
  int(n) { return Math.floor(this.next() * n); }
  between(lo, hi) { return lo + this.int(hi - lo + 1); }
  chance(p) { return this.next() < p; }
  pick(list) { return list[this.int(list.length)]; }
  /** weighted pick: [[weight, value], ...] */
  weighted(pairs) {
    const total = pairs.reduce((s, [w]) => s + w, 0);
    let r = this.next() * total;
    for (const [w, v] of pairs) { r -= w; if (r < 0) return v; }
    return pairs[pairs.length - 1][1];
  }
  shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) { const j = this.int(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
}
