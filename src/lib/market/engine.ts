import {
  adx,
  atr,
  bollinger,
  candlePressure,
  clamp,
  ema,
  macd,
  mean,
  rsi,
  stochRsi,
  supertrend,
  vwap,
} from "./indicators";
import { analyzeFlow, detectWalls, stopClusters, type OrderFlow, type StopZone, type Wall } from "./orderflow";
import { buildFactors, factorScore, forecast, type Factor, type Forecast } from "./forecast";
import { buildZones, fibLevels, marketStructure, volumeProfile, type Zone } from "./structure";
import type { Candle, Direction, FlowPayload, HistoryPayload } from "./types";

export type Signal = {
  id: string;
  createdAt: number;
  direction: Direction;
  grade: "A+" | "A" | "B" | "مراقبة";
  score: number;
  confidence: number;
  entry: number;
  stop: number;
  targets: number[];
  riskReward: number;
  expiresAt: number;
  validForMin: number;
  leverage: string;
  reasons: string[];
  warnings: string[];
  trigger: string;
};

export type Regime = {
  label: string;
  trending: boolean;
  choppy: boolean;
  adx: number;
  bbWidth: number;
  volatilityPct: number;
  liquidityLabel: string;
};

export type Analysis = {
  at: number;
  price: number;
  flow: OrderFlow;
  walls: Wall[];
  stops: StopZone[];
  zones: Zone[];
  factors: Factor[];
  score: number;
  forecast5: Forecast;
  forecast15: Forecast;
  regime: Regime;
  structure: ReturnType<typeof marketStructure>;
  fib: ReturnType<typeof fibLevels>;
  profile: ReturnType<typeof volumeProfile>;
  indicators: {
    rsi5: number;
    rsi15: number;
    stochK: number;
    macdHist: number;
    macdCross: "صاعد" | "هابط" | "محايد";
    atr5: number;
    atrPct: number;
    vwap: number;
    ema9: number;
    ema21: number;
    ema50: number;
    ema200: number;
    supertrend: number;
    bbWidth: number;
    pressure: number;
  };
  signal: Signal | null;
  derivatives: {
    funding: number | null;
    openInterest: number | null;
    oiChangePct: number | null;
    markPrice: number | null;
    nextFundingTime: number | null;
  };
  sources: string[];
  warnings: string[];
};

export type EngineState = {
  /** persistence counters for order-book buckets, used for spoof detection */
  wallAges: Map<string, number>;
  oiHistory: { t: number; v: number }[];
  lastSignal: Signal | null;
  /** consecutive polls the raw score has agreed on a direction */
  streak: { dir: Direction; count: number };
};

export function createEngineState(): EngineState {
  return {
    wallAges: new Map(),
    oiHistory: [],
    lastSignal: null,
    streak: { dir: "neutral", count: 0 },
  };
}

const SCORE_ENTER = 0.3;
const SCORE_EXIT = 0.14;
const MIN_STREAK = 3; // ~3 polls of agreement before a signal is published
const COOLDOWN_MS = 90_000;

function regimeOf(m5: Candle[], m1: Candle[], flow: OrderFlow): Regime {
  const closes = m5.map((c) => c.c);
  const price = closes[closes.length - 1] ?? 0;
  const a = adx(m5.slice(-80), 14);
  const bb = bollinger(closes, 20, 2);
  const atrPct = price ? (atr(m1.slice(-90), 14) / price) * 100 : 0;
  const trending = a.adx >= 22;
  const choppy = a.adx < 18 || bb.width < 0.45;
  const depth = flow.bookDepthUsd;
  return {
    label: trending
      ? a.plusDI > a.minusDI
        ? "اتجاه صاعد واضح"
        : "اتجاه هابط واضح"
      : choppy
        ? "سوق عرضي متذبذب"
        : "انتقالي / بناء زخم",
    trending,
    choppy,
    adx: a.adx,
    bbWidth: bb.width,
    volatilityPct: atrPct,
    liquidityLabel:
      depth > 3_000_000 ? "سيولة ممتازة" : depth > 800_000 ? "سيولة جيدة" : "سيولة ضعيفة — حذر",
  };
}

function nearestZone(zones: Zone[], kind: "support" | "resistance", price: number) {
  return zones
    .filter((z) => z.kind === kind)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];
}

function buildSignal(
  state: EngineState,
  price: number,
  score: number,
  factors: Factor[],
  f5: Forecast,
  f15: Forecast,
  regime: Regime,
  zones: Zone[],
  walls: Wall[],
  stops: StopZone[],
  flow: OrderFlow,
  atr5: number,
  structure: ReturnType<typeof marketStructure>,
  now: number,
): Signal | null {
  const rawDir: Direction = score > 0 ? "long" : score < 0 ? "short" : "neutral";
  const strong = Math.abs(score) >= SCORE_ENTER;

  // streak tracking: anti-chop hysteresis
  if (rawDir !== "neutral" && strong && rawDir === state.streak.dir) {
    state.streak.count += 1;
  } else if (rawDir !== "neutral" && strong) {
    state.streak = { dir: rawDir, count: 1 };
  } else if (Math.abs(score) < SCORE_EXIT) {
    state.streak = { dir: "neutral", count: 0 };
  }

  const prev = state.lastSignal;
  if (prev && prev.expiresAt > now) {
    const flipped = rawDir !== "neutral" && rawDir !== prev.direction && Math.abs(score) >= SCORE_ENTER + 0.1;
    if (!flipped) return prev; // hold the active signal — no flip-flopping
  }
  if (prev && now - prev.createdAt < COOLDOWN_MS && rawDir !== prev.direction) return prev;

  const confirmed =
    state.streak.dir === rawDir &&
    state.streak.count >= MIN_STREAK &&
    rawDir !== "neutral" &&
    !regime.choppy &&
    Math.abs(f5.expectedMovePct) > regime.volatilityPct * 0.35 &&
    (rawDir === "long" ? f5.probUp > 0.58 : f5.probUp < 0.42) &&
    (rawDir === "long" ? f15.probUp > 0.5 : f15.probUp < 0.5);

  if (!confirmed) {
    if (prev && prev.expiresAt <= now) state.lastSignal = null;
    return state.lastSignal;
  }

  const long = rawDir === "long";
  const support = nearestZone(zones, "support", price);
  const resistance = nearestZone(zones, "resistance", price);
  const bidWall = walls.filter((w) => w.side === "bid" && !w.spoof).sort((a, b) => b.price - a.price)[0];
  const askWall = walls.filter((w) => w.side === "ask" && !w.spoof).sort((a, b) => a.price - b.price)[0];

  const buffer = Math.max(atr5 * 0.55, price * 0.0015);
  const stopBase = long
    ? Math.min(support?.low ?? price - buffer * 2, bidWall ? bidWall.price - buffer * 0.5 : Infinity)
    : Math.max(resistance?.high ?? price + buffer * 2, askWall ? askWall.price + buffer * 0.5 : -Infinity);
  const stop = long
    ? Math.min(price - buffer, Number.isFinite(stopBase) ? stopBase - buffer * 0.3 : price - buffer * 2)
    : Math.max(price + buffer, Number.isFinite(stopBase) ? stopBase + buffer * 0.3 : price + buffer * 2);

  const risk = Math.abs(price - stop) || buffer;
  const capTarget = long
    ? (resistance?.price ?? price + risk * 3.2)
    : (support?.price ?? price - risk * 3.2);
  const t1 = long ? price + risk * 1.1 : price - risk * 1.1;
  const t2 = long ? price + risk * 1.9 : price - risk * 1.9;
  const t3 = long
    ? Math.max(price + risk * 3, capTarget)
    : Math.min(price - risk * 3, capTarget);
  const targets = [t1, t2, t3];
  const riskReward = Math.abs(t2 - price) / risk;

  const confidence = Math.round(
    clamp(f5.confidence * 0.55 + Math.min(state.streak.count, 6) * 5 + regime.adx * 0.5, 10, 96),
  );
  const grade: Signal["grade"] =
    confidence >= 82 && riskReward >= 1.8 ? "A+" : confidence >= 70 ? "A" : confidence >= 58 ? "B" : "مراقبة";

  const top = [...factors]
    .filter((x) => Math.sign(x.value) === (long ? 1 : -1))
    .sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight))
    .slice(0, 4);

  const warnings: string[] = [];
  if (walls.some((w) => w.spoof)) warnings.push("توجد جدران مشبوهة (تظهر وتختفي) — لا تعتمد عليها");
  if (regime.liquidityLabel.includes("ضعيفة")) warnings.push("السيولة ضعيفة الآن، الانزلاق السعري محتمل");
  const opposing = long ? askWall : bidWall;
  if (opposing && Math.abs(((opposing.price - price) / price) * 100) < 0.12)
    warnings.push(`جدار ${long ? "بيع" : "شراء"} قريب جداً عند ${opposing.price.toFixed(3)}`);
  if (flow.spreadPct > 0.06) warnings.push("الفارق السعري واسع — انتظر تحسن السيولة");

  const signal: Signal = {
    id: `${now}-${rawDir}`,
    createdAt: now,
    direction: rawDir,
    grade,
    score,
    confidence,
    entry: price,
    stop,
    targets,
    riskReward,
    expiresAt: now + 1000 * 60 * 15,
    validForMin: 15,
    leverage: confidence >= 82 ? "3x — 5x" : confidence >= 70 ? "2x — 3x" : "1x — 2x",
    reasons: [
      `${structure.label} مع ${structure.bos}`,
      ...top.map((x) => `${x.label}: ${x.detail}`),
      `التوقع لخمس دقائق: ${f5.expectedMovePct > 0 ? "+" : ""}${f5.expectedMovePct.toFixed(2)}% باحتمال ${(f5.probUp * 100).toFixed(0)}% للصعود`,
    ],
    warnings,
    trigger: long
      ? `تأكيد الدخول عند بقاء السعر فوق ${(price - buffer * 0.35).toFixed(3)} مع استمرار دلتا شراء موجبة`
      : `تأكيد الدخول عند بقاء السعر تحت ${(price + buffer * 0.35).toFixed(3)} مع استمرار دلتا بيع سالبة`,
  };
  state.lastSignal = signal;
  return signal;
}

/** Full analysis pass. Pure apart from the mutable EngineState it threads. */
export function runEngine(
  history: HistoryPayload,
  flowPayload: FlowPayload,
  state: EngineState,
): Analysis | null {
  const { m1, m5, m15, h1 } = history.candles;
  if (!m5.length || !m1.length) return null;
  const now = flowPayload.at || Date.now();
  const price = flowPayload.price || m1[m1.length - 1]!.c;

  const walls = detectWalls(flowPayload, state.wallAges);
  const flow = analyzeFlow(flowPayload, m1, walls);

  const oi = flowPayload.derivatives?.openInterest ?? null;
  if (oi) {
    state.oiHistory.push({ t: now, v: oi });
    if (state.oiHistory.length > 400) state.oiHistory.shift();
  }
  const oiRef = state.oiHistory.find((x) => now - x.t > 1000 * 60 * 5) ?? state.oiHistory[0];
  const oiChangePct = oi && oiRef?.v ? ((oi - oiRef.v) / oiRef.v) * 100 : null;
  const funding = flowPayload.derivatives?.fundingRate ?? null;

  const factors = buildFactors(m1, m5, m15, h1, flow, funding, oiChangePct);
  const score = factorScore(factors);
  const f5 = forecast(m1, factors, price, 5);
  const f15 = forecast(m1, factors, price, 15);

  const regime = regimeOf(m5, m1, flow);
  const zones = buildZones(m5, m15, h1, price);
  const atr5 = atr(m5.slice(-100), 14) || price * 0.001;
  const vw = vwap(m5.slice(-288));
  const stops = stopClusters(m5, price, vw, atr5);
  const structure = marketStructure(m15);

  const closes5 = m5.map((c) => c.c);
  const md = macd(closes5);
  const st = supertrend(m5.slice(-160));
  const bb = bollinger(closes5, 20, 2);

  const signal = buildSignal(
    state,
    price,
    score,
    factors,
    f5,
    f15,
    regime,
    zones,
    walls,
    stops,
    flow,
    atr5,
    structure,
    now,
  );

  const warnings = [...(flowPayload.errors ?? []), ...(history.errors ?? [])];

  return {
    at: now,
    price,
    flow,
    walls,
    stops,
    zones,
    factors,
    score,
    forecast5: f5,
    forecast15: f15,
    regime,
    structure,
    fib: fibLevels(m15),
    profile: volumeProfile(m5.slice(-288)),
    indicators: {
      rsi5: rsi(closes5, 14).at(-1) ?? 50,
      rsi15: rsi(m15.map((c) => c.c), 14).at(-1) ?? 50,
      stochK: stochRsi(closes5).k,
      macdHist: md.hist,
      macdCross: md.hist > 0 && md.prevHist <= 0 ? "صاعد" : md.hist < 0 && md.prevHist >= 0 ? "هابط" : "محايد",
      atr5,
      atrPct: (atr5 / price) * 100,
      vwap: vw,
      ema9: ema(closes5, 9).at(-1) ?? price,
      ema21: ema(closes5, 21).at(-1) ?? price,
      ema50: ema(closes5, 50).at(-1) ?? price,
      ema200: ema(closes5, 200).at(-1) ?? price,
      supertrend: st.dir,
      bbWidth: bb.width,
      pressure: candlePressure(m1, 5),
    },
    signal,
    derivatives: {
      funding,
      openInterest: oi,
      oiChangePct,
      markPrice: flowPayload.derivatives?.markPrice ?? null,
      nextFundingTime: flowPayload.derivatives?.nextFundingTime ?? null,
    },
    sources: Array.from(new Set([...(history.sources ?? []), ...(flowPayload.sources ?? [])])),
    warnings,
  };
}

export const engineMeta = { SCORE_ENTER, SCORE_EXIT, MIN_STREAK, mean };
