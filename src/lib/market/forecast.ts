import {
  atr,
  clamp,
  ema,
  logistic,
  mean,
  slopePct,
  squash,
  stdev,
  vwap,
} from "./indicators";
import type { OrderFlow } from "./orderflow";
import type { Candle } from "./types";

export type Factor = {
  key: string;
  label: string;
  /** -1..1, positive = bullish */
  value: number;
  weight: number;
  detail: string;
};

export type Forecast = {
  horizonMin: number;
  /** expected move in percent */
  expectedMovePct: number;
  targetPrice: number;
  upper: number;
  lower: number;
  probUp: number;
  sigmaPct: number;
  confidence: number;
  path: { minute: number; price: number; upper: number; lower: number }[];
};

/**
 * Volatility cone: 1-minute realised sigma scaled by sqrt(time), blended with
 * ATR so the band stays honest in both quiet and violent regimes.
 */
export function sigmaPctPerMinute(m1: Candle[]): number {
  const closes = m1.slice(-120).map((c) => c.c);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i]! - closes[i - 1]!) / (closes[i - 1]! || 1));
  }
  const realised = stdev(rets) * 100;
  const price = closes[closes.length - 1] || 1;
  const atrPct = (atr(m1.slice(-120), 14) / price) * 100;
  return Math.max(0.02, realised * 0.65 + atrPct * 0.35);
}

/**
 * Builds the weighted factor set that drives both the forecast and the signal
 * engine. Every factor is normalised to -1..1 so weights stay interpretable.
 */
export function buildFactors(
  m1: Candle[],
  m5: Candle[],
  m15: Candle[],
  h1: Candle[],
  flow: OrderFlow,
  funding: number | null,
  oiChangePct: number | null,
): Factor[] {
  const price = m1[m1.length - 1]?.c ?? m5[m5.length - 1]?.c ?? 0;
  const closes5 = m5.map((c) => c.c);
  const closes15 = m15.map((c) => c.c);
  const closes1h = h1.map((c) => c.c);
  const closes1 = m1.map((c) => c.c);

  const ema9 = ema(closes5, 9).at(-1) ?? price;
  const ema21 = ema(closes5, 21).at(-1) ?? price;
  const ema50 = ema(closes5, 50).at(-1) ?? price;
  const ema200 = ema(closes5, 200).at(-1) ?? price;

  const trend5 = clamp(((ema9 - ema21) / (ema21 || 1)) * 220, -1, 1);
  const trend15 = clamp(slopePct(closes15, 20) * 9, -1, 1);
  const trend1h = clamp(slopePct(closes1h, 20) * 6, -1, 1);
  const micro = clamp(slopePct(closes1, 12) * 22, -1, 1);

  const vw = vwap(m5.slice(-288));
  const vwapDev = clamp(((price - vw) / (vw || 1)) * 120, -1, 1);
  const stack =
    price > ema50 && ema50 > ema200 ? 1 : price < ema50 && ema50 < ema200 ? -1 : 0;

  const atr5 = atr(m5.slice(-100), 14) || price * 0.001;
  const rangePos = (() => {
    const slice = m5.slice(-48);
    if (!slice.length) return 0;
    const hi = Math.max(...slice.map((c) => c.h));
    const lo = Math.min(...slice.map((c) => c.l));
    return hi === lo ? 0 : ((price - lo) / (hi - lo)) * 2 - 1;
  })();

  const volPulse = (() => {
    const vols = m1.slice(-30).map((c) => c.v);
    const base = mean(m1.slice(-180).map((c) => c.v)) || 1;
    return clamp((mean(vols.slice(-5)) / base - 1) * 0.9, -1, 1);
  })();

  const factors: Factor[] = [
    {
      key: "micro",
      label: "زخم دقيقة واحدة",
      value: micro,
      weight: 1.5,
      detail: `ميل السعر اللحظي ${(slopePct(closes1, 12) * 100).toFixed(1)} نقطة/شمعة`,
    },
    {
      key: "trend5",
      label: "اتجاه 5 دقائق",
      value: trend5,
      weight: 2.1,
      detail: `EMA9 ${ema9.toFixed(3)} مقابل EMA21 ${ema21.toFixed(3)}`,
    },
    {
      key: "trend15",
      label: "اتجاه 15 دقيقة",
      value: trend15,
      weight: 1.8,
      detail: `ميل الانحدار ${slopePct(closes15, 20).toFixed(3)}%`,
    },
    {
      key: "trend1h",
      label: "الاتجاه الأكبر (ساعة)",
      value: trend1h,
      weight: 1.2,
      detail: `ميل ${slopePct(closes1h, 20).toFixed(3)}% — الفلتر العام`,
    },
    {
      key: "stack",
      label: "ترتيب المتوسطات",
      value: stack,
      weight: 1.0,
      detail:
        stack === 1 ? "السعر فوق 50 و200" : stack === -1 ? "السعر تحت 50 و200" : "متوسطات متشابكة",
    },
    {
      key: "book",
      label: "ضغط دفتر الأوامر",
      value: flow.imbalance,
      weight: 2.0,
      detail: `طلب ${(flow.bidVolume / 1000).toFixed(0)}k مقابل عرض ${(flow.askVolume / 1000).toFixed(0)}k دولار`,
    },
    {
      key: "bookNear",
      label: "ضغط قريب من السعر",
      value: flow.imbalanceNear,
      weight: 1.6,
      detail: "اختلال السيولة داخل 0.15% من السعر",
    },
    {
      key: "cvd",
      label: "دلتا الصفقات (CVD)",
      value: clamp(flow.cvdNorm * 2.4, -1, 1),
      weight: 2.2,
      detail: `صافي ${(flow.cvd / 1000).toFixed(1)}k دولار من الصفقات العدوانية`,
    },
    {
      key: "whales",
      label: "الصفقات الكبيرة",
      value: flow.whaleBias,
      weight: 1.7,
      detail: `شراء كبير ${(flow.largeBuy / 1000).toFixed(0)}k / بيع كبير ${(flow.largeSell / 1000).toFixed(0)}k`,
    },
    {
      key: "walls",
      label: "موازنة الجدران",
      value: flow.wallBias,
      weight: 1.5,
      detail: "قوة جدران الشراء مقابل جدران البيع مرجّحة بالمسافة",
    },
    {
      key: "vwap",
      label: "الانحراف عن VWAP",
      value: -vwapDev * 0.7,
      weight: 1.1,
      detail: `السعر ${price > vw ? "فوق" : "تحت"} VWAP بنسبة ${(((price - vw) / (vw || 1)) * 100).toFixed(2)}%`,
    },
    {
      key: "range",
      label: "الموقع داخل النطاق",
      value: -rangePos * 0.6,
      weight: 0.9,
      detail: rangePos > 0 ? "قريب من أعلى النطاق" : "قريب من أسفل النطاق",
    },
    {
      key: "volume",
      label: "نبض السيولة",
      value: volPulse * Math.sign(micro || 1),
      weight: 0.8,
      detail: "تسارع الأحجام يؤكد الحركة الحالية",
    },
  ];

  if (funding !== null && Number.isFinite(funding)) {
    factors.push({
      key: "funding",
      label: "معدل التمويل",
      value: clamp(-funding * 9000, -1, 1),
      weight: 1.0,
      detail: `${(funding * 100).toFixed(4)}% — ${funding > 0 ? "لونغ مزدحم (خطر تصحيح)" : "شورت مزدحم (خطر ضغط صاعد)"}`,
    });
  }
  if (oiChangePct !== null && Number.isFinite(oiChangePct)) {
    factors.push({
      key: "oi",
      label: "العقود المفتوحة",
      value: clamp(oiChangePct * 0.25 * Math.sign(micro || 1), -1, 1),
      weight: 1.0,
      detail: `${oiChangePct > 0 ? "تزايد" : "تراجع"} بنسبة ${oiChangePct.toFixed(2)}% — ${
        oiChangePct > 0 ? "أموال جديدة تدخل" : "إغلاق مراكز"
      }`,
    });
  }
  if (flow.absorption) {
    factors.push({
      key: "absorb",
      label: "امتصاص السيولة",
      value: flow.cvdNorm > 0 ? -0.8 : 0.8,
      weight: 1.9,
      detail: flow.absorption,
    });
  }

  void atr5;
  return factors;
}

export function factorScore(factors: Factor[]): number {
  const wSum = factors.reduce((s, f) => s + f.weight, 0) || 1;
  return factors.reduce((s, f) => s + f.value * f.weight, 0) / wSum;
}

/**
 * Projects the next `horizonMin` minutes: drift from the weighted factor score
 * scaled by realised volatility, with a sqrt-time confidence band and a
 * probability derived from the score's strength and factor agreement.
 */
export function forecast(
  m1: Candle[],
  factors: Factor[],
  price: number,
  horizonMin: number,
): Forecast {
  const score = factorScore(factors);
  const sigma1 = sigmaPctPerMinute(m1);
  const agreement =
    factors.length > 1
      ? 1 -
        stdev(factors.map((f) => Math.sign(f.value) || 0)) /
          1.15
      : 0.5;
  const confidence = clamp(
    (Math.abs(score) * 1.35 + clamp(agreement, 0, 1) * 0.55) * 100,
    5,
    97,
  );

  // drift: score * sigma over the horizon, damped so it never exceeds ~1.6 sigma
  const sigmaH = sigma1 * Math.sqrt(horizonMin);
  const drift = squash(score * 2.1) * sigmaH * 1.15;
  const probUp = clamp(logistic(score * 4.1) * 100, 2, 98) / 100;

  const path = Array.from({ length: horizonMin + 1 }, (_, i) => {
    const s = sigma1 * Math.sqrt(i);
    const d = (drift * i) / horizonMin;
    return {
      minute: i,
      price: price * (1 + d / 100),
      upper: price * (1 + (d + 1.15 * s) / 100),
      lower: price * (1 + (d - 1.15 * s) / 100),
    };
  });

  return {
    horizonMin,
    expectedMovePct: drift,
    targetPrice: price * (1 + drift / 100),
    upper: price * (1 + (drift + 1.15 * sigmaH) / 100),
    lower: price * (1 + (drift - 1.15 * sigmaH) / 100),
    probUp,
    sigmaPct: sigmaH,
    confidence,
    path,
  };
}
