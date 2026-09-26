import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { Candle, Level } from "@/lib/market/types";

const querySchema = z.object({
  part: z.enum(["history", "flow"]).default("flow"),
  symbol: z
    .string()
    .min(4)
    .max(20)
    .regex(/^[A-Z0-9]+$/)
    .default("AAVEUSDT"),
});

const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://data-api.binance.vision",
];

async function binance(path: string): Promise<unknown> {
  let lastError: unknown = null;
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        lastError = new Error(`Binance ${res.status}: ${await res.text()}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Binance unreachable");
}

async function bybit(path: string): Promise<any> {
  const res = await fetch(`https://api.bybit.com${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Bybit ${res.status}: ${await res.text()}`);
  return await res.json();
}

const toCandles = (rows: unknown): Candle[] =>
  (rows as (string | number)[][]).map((r) => ({
    t: Number(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5]),
  }));

const toLevels = (rows: unknown): Level[] =>
  ((rows as string[][]) ?? []).map((r) => [Number(r[0]), Number(r[1])] as Level);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export const Route = createFileRoute("/api/public/market")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const parsed = querySchema.safeParse({
          part: url.searchParams.get("part") ?? undefined,
          symbol: (url.searchParams.get("symbol") ?? "AAVEUSDT").toUpperCase(),
        });
        if (!parsed.success) return json({ ok: false, error: "bad request" }, 400);
        const { part, symbol } = parsed.data;
        const errors: string[] = [];
        const sources: string[] = [];

        if (part === "history") {
          const tf: [keyof HistoryCandles, string, number][] = [
            ["m1", "1m", 360],
            ["m5", "5m", 400],
            ["m15", "15m", 320],
            ["h1", "1h", 240],
            ["h4", "4h", 180],
          ];
          const results = await Promise.all(
            tf.map(async ([key, interval, limit]) => {
              try {
                const rows = await binance(
                  `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
                );
                return [key, toCandles(rows)] as const;
              } catch (err) {
                errors.push(`klines ${interval}: ${(err as Error).message}`);
                return [key, [] as Candle[]] as const;
              }
            }),
          );
          const candles = Object.fromEntries(results) as HistoryCandles;
          if (candles.m5.length) sources.push("Binance Spot");
          return json({
            ok: candles.m5.length > 0,
            symbol,
            at: Date.now(),
            candles,
            sources,
            errors,
          });
        }

        const [depth, trades, ticker, bybitTicker, bybitBook] = await Promise.all([
          binance(`/api/v3/depth?symbol=${symbol}&limit=1000`).catch((e) => {
            errors.push(`depth: ${(e as Error).message}`);
            return null;
          }),
          binance(`/api/v3/aggTrades?symbol=${symbol}&limit=1000`).catch((e) => {
            errors.push(`trades: ${(e as Error).message}`);
            return null;
          }),
          binance(`/api/v3/ticker/24hr?symbol=${symbol}`).catch((e) => {
            errors.push(`ticker: ${(e as Error).message}`);
            return null;
          }),
          bybit(`/v5/market/tickers?category=linear&symbol=${symbol}`).catch((e) => {
            errors.push(`bybit tickers: ${(e as Error).message}`);
            return null;
          }),
          bybit(`/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`).catch(
            (e) => {
              errors.push(`bybit book: ${(e as Error).message}`);
              return null;
            },
          ),
        ]);

        const t = ticker as Record<string, string> | null;
        const bt = bybitTicker?.result?.list?.[0] ?? null;
        if (depth) sources.push("Binance Spot");
        if (bt) sources.push("Bybit Perp");

        const tradeRows = (trades as Record<string, unknown>[] | null) ?? [];
        const price = t ? Number(t["lastPrice"]) : Number(tradeRows.at(-1)?.["p"] ?? 0);

        return json({
          ok: Boolean(depth),
          symbol,
          at: Date.now(),
          price,
          bids: toLevels((depth as Record<string, unknown> | null)?.["bids"]),
          asks: toLevels((depth as Record<string, unknown> | null)?.["asks"]),
          trades: tradeRows.map((r) => ({
            p: Number(r["p"]),
            q: Number(r["q"]),
            m: Boolean(r["m"]),
            t: Number(r["T"]),
          })),
          ticker: t
            ? {
                change24h: Number(t["priceChangePercent"]),
                high24h: Number(t["highPrice"]),
                low24h: Number(t["lowPrice"]),
                quoteVolume24h: Number(t["quoteVolume"]),
              }
            : null,
          derivatives: bt
            ? {
                markPrice: Number(bt.markPrice),
                fundingRate: Number(bt.fundingRate),
                openInterest: Number(bt.openInterestValue ?? bt.openInterest),
                nextFundingTime: Number(bt.nextFundingTime),
                bybitBids: toLevels(bybitBook?.result?.b),
                bybitAsks: toLevels(bybitBook?.result?.a),
              }
            : null,
          sources,
          errors,
        });
      },
    },
  },
});

type HistoryCandles = {
  m1: Candle[];
  m5: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
};
