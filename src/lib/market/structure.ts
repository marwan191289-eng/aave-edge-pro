import { atr, clamp, mean } from "./indicators";
import type { Candle } from "./types";

export type Swing = { t: number; price: number; kind: "high" | "low" };

export type Zone = {
  price: number;
  low: number;
  high: number;
  kind: "support" | "resistance";
  /** 0..100 composite strength */
  strength: number;
  touches: number;
  volume: number;
  distancePct: number;
  sources: string[];
};

/** Fractal swing points with a configurable lookback on each side. */
export function findSwings(candles: Candle[], span = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = span; i < candles.length - span; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j]!.h >= c.h) isHigh = false;
      if (candles[j]!.l <= c.l) isLow = false;
    }
    if (isHigh) out.push({ t: c.t, price: c.h, kind: "high" });
    if (isLow) out.push({ t: c.t, price: c.l, kind: "low" });
  }
  return out;
}

/** Volume profile: value area high/low and point of control. */
export function volumeProfile(candles: Candle[], buckets = 60) {
  if (!candles.length) return { poc: 0, vah: 0, val: 0, bins: [] as { price: number; volume: number }[] };
  const hi = Math.max(...candles.map((c) => c.h));
  const lo = Math.min(...candles.map((c) => c.l));
  const step = (hi - lo) / buckets || 1e-9;
  const bins = new Array(buckets).fill(0) as number[];
  for (const c of candles) {
    const idx = clamp(Math.floor(((c.h + c.l + c.c) / 3 - lo) / step), 0, buckets - 1);
    bins[idx] = (bins[idx] ?? 0) + c.v;
  }
  const total = bins.reduce((s, v) => s + v, 0) || 1;
  let pocIdx = 0;
  bins.forEach((v, i) => {
    if (v > (bins[pocIdx] ?? 0)) pocIdx = i;
  });
  // expand around POC until 70% of volume is captured
  let lower = pocIdx;
  let upper = pocIdx;
  let acc = bins[pocIdx] ?? 0;
  while (acc / total < 0.7 && (lower > 0 || upper < buckets - 1)) {
    const down = lower > 0 ? (bins[lower - 1] ?? 0) : -1;
    const up = upper < buckets - 1 ? (bins[upper + 1] ?? 0) : -1;
    if (up >= down) {
      upper++;
      acc += up;
    } else {
      lower--;
      acc += down;
    }
  }
  return {
    poc: lo + (pocIdx + 0.5) * step,
    vah: lo + (upper + 1) * step,
    val: lo + lower * step,
    bins: bins.map((volume, i) => ({ price: lo + (i + 0.5) * step, volume })),
  };
}

function roundNumbers(price: number): number[] {
  const out: number[] = [];
  for (const step of [1, 5, 10]) {
    out.push(Math.floor(price / step) * step, Math.ceil(price / step) * step);
  }
  return Array.from(new Set(out.filter((v) => v > 0)));
}

/**
 * Builds support/resistance zones by clustering swing points, volume-profile
 * nodes, session extremes and psychological round levels, then scoring each
 * cluster on touches, traded volume, recency and confluence breadth.
 */
export function buildZones(
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  price: number,
  maxPerSide = 5,
): Zone[] {
  if (!m5.length) return [];
  const a = atr(m5.slice(-120), 14) || price * 0.001;
  const tol = Math.max(a * 0.8, price * 0.0012);

  type Raw = { price: number; weight: number; source: string; t: number; volume: number };
  const raws: Raw[] = [];

  const push = (arr: Candle[], span: number, w: number, label: string) => {
    for (const s of findSwings(arr, span)) {
      const bar = arr.find((c) => c.t === s.t);
      raws.push({ price: s.price, weight: w, source: label, t: s.t, volume: bar?.v ?? 0 });
    }
  };
  push(m5, 3, 1, "سوينغ 5د");
  push(m15, 3, 1.5, "سوينغ 15د");
  push(h1, 3, 2.2, "سوينغ 1س");

  const vp = volumeProfile(m5.slice(-288));
  raws.push({ price: vp.poc, weight: 2.4, source: "نقطة التحكم POC", t: Date.now(), volume: 0 });
  raws.push({ price: vp.vah, weight: 1.6, source: "أعلى منطقة القيمة", t: Date.now(), volume: 0 });
  raws.push({ price: vp.val, weight: 1.6, source: "أدنى منطقة القيمة", t: Date.now(), volume: 0 });

  const day = m5.slice(-288);
  if (day.length) {
    raws.push({ price: Math.max(...day.map((c) => c.h)), weight: 2, source: "قمة اليوم", t: Date.now(), volume: 0 });
    raws.push({ price: Math.min(...day.map((c) => c.l)), weight: 2, source: "قاع اليوم", t: Date.now(), volume: 0 });
  }
  for (const r of roundNumbers(price)) {
    raws.push({ price: r, weight: 1.1, source: "رقم نفسي", t: Date.now(), volume: 0 });
  }

  // cluster
  const sorted = [...raws].sort((x, y) => x.price - y.price);
  const clusters: Raw[][] = [];
  for (const r of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && Math.abs(r.price - mean(cur.map((c) => c.price))) <= tol) cur.push(r);
    else clusters.push([r]);
  }

  const now = Date.now();
  const zones: Zone[] = clusters.map((cl) => {
    const p = mean(cl.map((c) => c.price));
    const weight = cl.reduce((s, c) => s + c.weight, 0);
    const recency = mean(
      cl.map((c) => clamp(1 - (now - c.t) / (1000 * 60 * 60 * 12), 0.15, 1)),
    );
    const breadth = new Set(cl.map((c) => c.source)).size;
    const volume = cl.reduce((s, c) => s + c.volume, 0);
    const strength = clamp(
      (weight * 7 + breadth * 9) * (0.6 + recency * 0.6),
      0,
      100,
    );
    return {
      price: p,
      low: Math.min(...cl.map((c) => c.price)) - tol * 0.35,
      high: Math.max(...cl.map((c) => c.price)) + tol * 0.35,
      kind: p >= price ? "resistance" : "support",
      strength,
      touches: cl.length,
      volume,
      distancePct: ((p - price) / price) * 100,
      sources: Array.from(new Set(cl.map((c) => c.source))),
    };
  });

  const sup = zones
    .filter((z) => z.kind === "support")
    .sort((x, y) => y.price - x.price)
    .slice(0, maxPerSide);
  const res = zones
    .filter((z) => z.kind === "resistance")
    .sort((x, y) => x.price - y.price)
    .slice(0, maxPerSide);
  return [...sup, ...res];
}

/** Market structure read: HH/HL vs LH/LL plus break-of-structure detection. */
export function marketStructure(candles: Candle[]) {
  const swings = findSwings(candles, 3);
  const highs = swings.filter((s) => s.kind === "high").slice(-3);
  const lows = swings.filter((s) => s.kind === "low").slice(-3);
  const upHigh = highs.length >= 2 && highs[highs.length - 1]!.price > highs[highs.length - 2]!.price;
  const upLow = lows.length >= 2 && lows[lows.length - 1]!.price > lows[lows.length - 2]!.price;
  const dnHigh = highs.length >= 2 && highs[highs.length - 1]!.price < highs[highs.length - 2]!.price;
  const dnLow = lows.length >= 2 && lows[lows.length - 1]!.price < lows[lows.length - 2]!.price;
  const bias = upHigh && upLow ? 1 : dnHigh && dnLow ? -1 : 0;
  const price = candles[candles.length - 1]?.c ?? 0;
  const lastHigh = highs[highs.length - 1]?.price ?? price;
  const lastLow = lows[lows.length - 1]?.price ?? price;
  return {
    bias,
    label:
      bias === 1 ? "هيكل صاعد (قمم وقيعان أعلى)" : bias === -1 ? "هيكل هابط (قمم وقيعان أدنى)" : "هيكل عرضي / تجميع",
    lastHigh,
    lastLow,
    bos: price > lastHigh ? "اختراق صاعد" : price < lastLow ? "كسر هابط" : "داخل النطاق",
  };
}

/** Fibonacci retracement of the most recent meaningful leg. */
export function fibLevels(candles: Candle[]) {
  const slice = candles.slice(-96);
  if (slice.length < 10) return null;
  const hi = Math.max(...slice.map((c) => c.h));
  const lo = Math.min(...slice.map((c) => c.l));
  const hiIdx = slice.findIndex((c) => c.h === hi);
  const loIdx = slice.findIndex((c) => c.l === lo);
  const up = loIdx < hiIdx;
  const diff = hi - lo;
  const level = (r: number) => (up ? hi - diff * r : lo + diff * r);
  return {
    direction: up ? "up" : "down",
    high: hi,
    low: lo,
    levels: [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => ({
      ratio: r,
      price: level(r),
    })),
    goldenZone: [level(0.618), level(0.5)].sort((a, b) => a - b) as [number, number],
  };
}
