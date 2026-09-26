import type { Candle } from "./types";

/** Numeric helpers -------------------------------------------------------- */

export const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];

export function mean(values: number[]): number {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Squashes any real number into -1..1 (tanh-like, cheap and stable). */
export function squash(v: number, scale = 1): number {
  const x = v / (scale || 1);
  return Math.tanh(x);
}

export function logistic(v: number): number {
  return 1 / (1 + Math.exp(-v));
}

export function percentRank(values: number[], value: number): number {
  if (!values.length) return 0.5;
  let below = 0;
  for (const v of values) if (v <= value) below++;
  return below / values.length;
}

/** Moving averages -------------------------------------------------------- */

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(prev)) {
      if (i >= period - 1) {
        prev = mean(values.slice(i - period + 1, i + 1));
        out.push(prev);
      } else out.push(NaN);
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function wma(values: number[], period: number): number {
  const slice = values.slice(-period);
  let num = 0;
  let den = 0;
  slice.forEach((v, i) => {
    const w = i + 1;
    num += v * w;
    den += w;
  });
  return den ? num / den : NaN;
}

/** Oscillators ------------------------------------------------------------ */

export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function stochRsi(values: number[], period = 14, kPeriod = 3) {
  const r = rsi(values, period).filter((v) => !Number.isNaN(v));
  const window = r.slice(-period);
  if (window.length < 3) return { k: 50, d: 50 };
  const lo = Math.min(...window);
  const hi = Math.max(...window);
  const raw = hi === lo ? 50 : ((r[r.length - 1]! - lo) / (hi - lo)) * 100;
  const prevRaws: number[] = [];
  for (let i = 0; i < kPeriod; i++) {
    const w = r.slice(-period - i, r.length - i);
    if (w.length < 3) break;
    const l = Math.min(...w);
    const h = Math.max(...w);
    prevRaws.push(h === l ? 50 : ((r[r.length - 1 - i]! - l) / (h - l)) * 100);
  }
  return { k: raw, d: mean(prevRaws.length ? prevRaws : [raw]) };
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i]! - s[i]!);
  const clean = line.filter((v) => !Number.isNaN(v));
  const sig = ema(clean, signal);
  const macdLine = clean[clean.length - 1] ?? NaN;
  const signalLine = sig[sig.length - 1] ?? NaN;
  const prevHist =
    (clean[clean.length - 2] ?? NaN) - (sig[sig.length - 2] ?? NaN);
  return {
    macd: macdLine,
    signal: signalLine,
    hist: macdLine - signalLine,
    prevHist,
  };
}

/** Volatility & trend ---------------------------------------------------- */

export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    out.push(
      Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)),
    );
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number {
  const tr = trueRanges(candles);
  if (!tr.length) return 0;
  const e = ema(tr, Math.min(period, tr.length));
  const v = e[e.length - 1];
  return Number.isNaN(v ?? NaN) ? mean(tr.slice(-period)) : (v as number);
}

export function bollinger(values: number[], period = 20, mult = 2) {
  const window = values.slice(-period);
  const m = mean(window);
  const sd = stdev(window);
  return {
    mid: m,
    upper: m + mult * sd,
    lower: m - mult * sd,
    width: m ? ((2 * mult * sd) / m) * 100 : 0,
    sd,
  };
}

export function adx(candles: Candle[], period = 14) {
  if (candles.length < period + 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i]!.h - candles[i - 1]!.h;
    const down = candles[i - 1]!.l - candles[i]!.l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = trueRanges(candles);
  const trE = ema(tr, period);
  const pE = ema(plusDM, period);
  const mE = ema(minusDM, period);
  const i = tr.length - 1;
  const atrV = trE[i] || 1;
  const plusDI = (100 * (pE[i] || 0)) / atrV;
  const minusDI = (100 * (mE[i] || 0)) / atrV;
  const dxSeries: number[] = [];
  for (let j = Math.max(0, i - period * 2); j <= i; j++) {
    const a = trE[j] || 1;
    const p = (100 * (pE[j] || 0)) / a;
    const m = (100 * (mE[j] || 0)) / a;
    const sum = p + m;
    dxSeries.push(sum ? (100 * Math.abs(p - m)) / sum : 0);
  }
  return { adx: mean(dxSeries.slice(-period)), plusDI, minusDI };
}

/** Session / volume ------------------------------------------------------- */

export function vwap(candles: Candle[]): number {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vol += c.v;
  }
  return vol ? pv / vol : (last(candles)?.c ?? 0);
}

export function obv(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[i - 1]!;
    const c = candles[i]!;
    const p = candles[i - 1]!;
    out.push(c.c > p.c ? prev + c.v : c.c < p.c ? prev - c.v : prev);
  }
  return out;
}

/** Linear regression slope normalised by price (per candle, in %). */
export function slopePct(values: number[], period = 20): number {
  const y = values.slice(-period);
  const n = y.length;
  if (n < 3) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i]! - yMean);
    den += (i - xMean) * (i - xMean);
  }
  const slope = den ? num / den : 0;
  return yMean ? (slope / yMean) * 100 : 0;
}

/** Supertrend direction (+1 up, -1 down). */
export function supertrend(candles: Candle[], period = 10, mult = 3) {
  if (candles.length < period + 2) return { dir: 0, level: 0 };
  let dir = 1;
  let upper = 0;
  let lower = 0;
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const a = atr(slice.slice(-period * 3), period);
    const c = candles[i]!;
    const hl2 = (c.h + c.l) / 2;
    const nUpper = hl2 + mult * a;
    const nLower = hl2 - mult * a;
    upper = upper && nUpper > upper && candles[i - 1]!.c <= upper ? upper : nUpper;
    lower = lower && nLower < lower && candles[i - 1]!.c >= lower ? lower : nLower;
    if (c.c > upper) dir = 1;
    else if (c.c < lower) dir = -1;
  }
  return { dir, level: dir === 1 ? lower : upper };
}

/** Candle pattern pressure: body/wick analysis of the last N candles. */
export function candlePressure(candles: Candle[], n = 5): number {
  const slice = candles.slice(-n);
  let score = 0;
  slice.forEach((c, i) => {
    const range = c.h - c.l || 1e-9;
    const body = (c.c - c.o) / range;
    const upperWick = (c.h - Math.max(c.c, c.o)) / range;
    const lowerWick = (Math.min(c.c, c.o) - c.l) / range;
    const w = (i + 1) / slice.length;
    score += w * (body * 1.4 + (lowerWick - upperWick) * 0.8);
  });
  return clamp(score / n, -1, 1);
}

export function resample(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    out.push({
      t: group[0]!.t,
      o: group[0]!.o,
      h: Math.max(...group.map((c) => c.h)),
      l: Math.min(...group.map((c) => c.l)),
      c: group[group.length - 1]!.c,
      v: group.reduce((s, c) => s + c.v, 0),
    });
  }
  return out;
}
