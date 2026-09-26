import { clamp, mean, stdev } from "./indicators";
import type { Candle, FlowPayload, Level, Trade } from "./types";

export type Wall = {
  price: number;
  qty: number;
  notional: number;
  side: "bid" | "ask";
  distancePct: number;
  /** how many standard deviations above the average book bucket */
  sigma: number;
  strength: number;
  /** persistence in polls; low persistence + big size = likely spoof */
  age: number;
  spoof: boolean;
  label: string;
};

export type StopZone = {
  price: number;
  distancePct: number;
  side: "below" | "above";
  kind: string;
  weight: number;
};

export type OrderFlow = {
  spread: number;
  spreadPct: number;
  midPrice: number;
  bidVolume: number;
  askVolume: number;
  imbalance: number; // -1..1
  imbalanceNear: number; // within 0.15%
  cvd: number;
  cvdNorm: number;
  buyVolume: number;
  sellVolume: number;
  aggressorRatio: number;
  largeBuy: number;
  largeSell: number;
  whaleBias: number;
  tradesPerMin: number;
  absorption: string | null;
  walls: Wall[];
  bookDepthUsd: number;
  wallBias: number;
};

const bucketSize = (price: number) => Math.max(price * 0.0005, 0.01);

function aggregate(levels: Level[], price: number) {
  const step = bucketSize(price);
  const map = new Map<number, number>();
  for (const [p, q] of levels) {
    const key = Math.round(p / step) * step;
    map.set(key, (map.get(key) ?? 0) + q);
  }
  return Array.from(map.entries()).map(([p, q]) => ({ price: p, qty: q }));
}

/**
 * Detects order-book walls: buckets whose resting size is a statistical
 * outlier versus the rest of the book. Persistence across polls separates
 * real liquidity from spoofed (flashing) orders.
 */
export function detectWalls(
  flow: FlowPayload,
  history: Map<string, number>,
  maxPerSide = 4,
): Wall[] {
  const price = flow.price;
  if (!price) return [];
  const build = (levels: Level[], side: "bid" | "ask"): Wall[] => {
    const buckets = aggregate(levels, price).filter(
      (b) => Math.abs(b.price - price) / price < 0.02,
    );
    if (buckets.length < 8) return [];
    const qtys = buckets.map((b) => b.qty);
    const m = mean(qtys);
    const sd = stdev(qtys) || 1e-9;
    return buckets
      .map((b) => {
        const sigma = (b.qty - m) / sd;
        const key = `${side}:${b.price.toFixed(3)}`;
        const age = (history.get(key) ?? 0) + 1;
        history.set(key, age);
        const notional = b.qty * b.price;
        const strength = clamp(sigma * 14 + Math.log10(Math.max(notional, 1)) * 8, 0, 100);
        return {
          price: b.price,
          qty: b.qty,
          notional,
          side,
          distancePct: ((b.price - price) / price) * 100,
          sigma,
          strength,
          age,
          spoof: sigma > 3.2 && age <= 2,
          label:
            sigma > 6
              ? "جدار ضخم"
              : sigma > 4
                ? "جدار قوي"
                : sigma > 2.6
                  ? "جدار متوسط"
                  : "تكتل سيولة",
        } satisfies Wall;
      })
      .filter((w) => w.sigma > 2.4)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, maxPerSide);
  };
  const walls = [...build(flow.bids, "bid"), ...build(flow.asks, "ask")];
  if (flow.derivatives?.bybitBids?.length) {
    // merge Bybit book into the same statistical frame for confirmation
    const extra = [
      ...build(flow.derivatives.bybitBids, "bid"),
      ...build(flow.derivatives.bybitAsks, "ask"),
    ];
    for (const e of extra) {
      const match = walls.find(
        (w) => w.side === e.side && Math.abs(w.price - e.price) / price < 0.0008,
      );
      if (match) {
        match.strength = clamp(match.strength + 12, 0, 100);
        match.notional += e.notional;
        match.label = `${match.label} (مؤكد على منصتين)`;
      } else walls.push(e);
    }
  }
  return walls.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

/** Aggregated order-flow read from book + tape. */
export function analyzeFlow(
  flow: FlowPayload,
  candles: Candle[],
  walls: Wall[],
): OrderFlow {
  const price = flow.price;
  const bestBid = flow.bids[0]?.[0] ?? price;
  const bestAsk = flow.asks[0]?.[0] ?? price;
  const spread = Math.max(bestAsk - bestBid, 0);

  const inRange = (levels: Level[], pct: number) =>
    levels
      .filter(([p]) => Math.abs(p - price) / price <= pct)
      .reduce((s, [p, q]) => s + p * q, 0);

  const bidVolume = inRange(flow.bids, 0.01);
  const askVolume = inRange(flow.asks, 0.01);
  const nearBid = inRange(flow.bids, 0.0015);
  const nearAsk = inRange(flow.asks, 0.0015);

  const trades: Trade[] = flow.trades ?? [];
  let buyVolume = 0;
  let sellVolume = 0;
  let largeBuy = 0;
  let largeSell = 0;
  const notionals = trades.map((t) => t.p * t.q);
  const bigThreshold = notionals.length
    ? mean(notionals) + 2.5 * (stdev(notionals) || 0)
    : 0;
  for (const t of trades) {
    const n = t.p * t.q;
    if (t.m) {
      sellVolume += n;
      if (n >= bigThreshold) largeSell += n;
    } else {
      buyVolume += n;
      if (n >= bigThreshold) largeBuy += n;
    }
  }
  const cvd = buyVolume - sellVolume;
  const totalTape = buyVolume + sellVolume || 1;
  const span = trades.length
    ? Math.max((trades[trades.length - 1]!.t - trades[0]!.t) / 60000, 0.1)
    : 1;

  const lastCandle = candles[candles.length - 1];
  const priceMove = lastCandle ? (lastCandle.c - lastCandle.o) / (lastCandle.o || 1) : 0;
  const cvdNorm = cvd / totalTape;
  let absorption: string | null = null;
  if (cvdNorm > 0.18 && priceMove < 0.0004)
    absorption = "شراء عنيف بدون صعود — سيولة بيع تمتص الطلب (حذر من الهبوط)";
  else if (cvdNorm < -0.18 && priceMove > -0.0004)
    absorption = "بيع عنيف بدون هبوط — سيولة شراء تمتص العرض (فرصة صعود)";

  const bidWalls = walls.filter((w) => w.side === "bid");
  const askWalls = walls.filter((w) => w.side === "ask");
  const wallBias = clamp(
    (bidWalls.reduce((s, w) => s + w.strength / (1 + Math.abs(w.distancePct)), 0) -
      askWalls.reduce((s, w) => s + w.strength / (1 + Math.abs(w.distancePct)), 0)) /
      120,
    -1,
    1,
  );

  return {
    spread,
    spreadPct: price ? (spread / price) * 100 : 0,
    midPrice: (bestBid + bestAsk) / 2 || price,
    bidVolume,
    askVolume,
    imbalance: clamp((bidVolume - askVolume) / (bidVolume + askVolume || 1), -1, 1),
    imbalanceNear: clamp((nearBid - nearAsk) / (nearBid + nearAsk || 1), -1, 1),
    cvd,
    cvdNorm,
    buyVolume,
    sellVolume,
    aggressorRatio: buyVolume / (sellVolume || 1),
    largeBuy,
    largeSell,
    whaleBias: clamp((largeBuy - largeSell) / (largeBuy + largeSell || 1), -1, 1),
    tradesPerMin: trades.length / span,
    absorption,
    walls,
    bookDepthUsd: bidVolume + askVolume,
    wallBias,
  };
}

/**
 * Estimates stop-loss / liquidation clusters: below swing lows and above
 * swing highs (retail stop placement), round numbers, and leverage-implied
 * liquidation prices measured from the recent average entry (VWAP).
 */
export function stopClusters(
  candles: Candle[],
  price: number,
  vwapValue: number,
  atrValue: number,
): StopZone[] {
  const out: StopZone[] = [];
  const recent = candles.slice(-60);
  if (!recent.length) return out;

  const lows = recent.map((c) => c.l).sort((a, b) => a - b).slice(0, 6);
  const highs = recent.map((c) => c.h).sort((a, b) => b - a).slice(0, 6);
  const buffer = Math.max(atrValue * 0.25, price * 0.0006);

  for (const l of lows) {
    const p = l - buffer;
    if (p < price)
      out.push({
        price: p,
        distancePct: ((p - price) / price) * 100,
        side: "below",
        kind: "وقف خسارة تحت قاع",
        weight: 60,
      });
  }
  for (const h of highs) {
    const p = h + buffer;
    if (p > price)
      out.push({
        price: p,
        distancePct: ((p - price) / price) * 100,
        side: "above",
        kind: "وقف خسارة فوق قمة",
        weight: 60,
      });
  }
  for (const lev of [10, 25, 50]) {
    const down = vwapValue * (1 - 1 / lev);
    const up = vwapValue * (1 + 1 / lev);
    if (down < price && (price - down) / price < 0.06)
      out.push({
        price: down,
        distancePct: ((down - price) / price) * 100,
        side: "below",
        kind: `تصفية رفع ${lev}x للونغ`,
        weight: 45 + lev / 2,
      });
    if (up > price && (up - price) / price < 0.06)
      out.push({
        price: up,
        distancePct: ((up - price) / price) * 100,
        side: "above",
        kind: `تصفية رفع ${lev}x للشورت`,
        weight: 45 + lev / 2,
      });
  }

  // merge near-identical zones
  const merged: StopZone[] = [];
  for (const z of out.sort((a, b) => a.price - b.price)) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.price - z.price) / price < 0.0012) {
      prev.weight = clamp(prev.weight + z.weight * 0.6, 0, 100);
      prev.kind = `${prev.kind} + ${z.kind}`;
    } else merged.push({ ...z });
  }
  return merged.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)).slice(0, 8);
}
