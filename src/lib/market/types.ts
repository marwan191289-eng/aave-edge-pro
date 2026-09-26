export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type Level = [number, number]; // price, qty

export type Trade = {
  p: number;
  q: number;
  m: boolean; // true = buyer is maker => sell aggressor
  t: number;
};

export type HistoryPayload = {
  ok: boolean;
  symbol: string;
  at: number;
  candles: {
    m1: Candle[];
    m5: Candle[];
    m15: Candle[];
    h1: Candle[];
    h4: Candle[];
  };
  sources: string[];
  errors: string[];
};

export type FlowPayload = {
  ok: boolean;
  symbol: string;
  at: number;
  price: number;
  bids: Level[];
  asks: Level[];
  trades: Trade[];
  ticker: {
    change24h: number;
    high24h: number;
    low24h: number;
    quoteVolume24h: number;
  } | null;
  derivatives: {
    markPrice: number | null;
    fundingRate: number | null;
    openInterest: number | null;
    nextFundingTime: number | null;
    bybitBids: Level[];
    bybitAsks: Level[];
  } | null;
  sources: string[];
  errors: string[];
};

export type Direction = "long" | "short" | "neutral";
