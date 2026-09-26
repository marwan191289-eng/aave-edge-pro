import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createEngineState,
  runEngine,
  type Analysis,
  type Signal,
} from "@/lib/market/engine";
import type { FlowPayload, HistoryPayload } from "@/lib/market/types";

const SYMBOL = "AAVEUSDT";
const FLOW_MS = 2500;
const HISTORY_MS = 20_000;
const LOG_KEY = "aave-signal-log-v1";

export type LoggedSignal = Signal & {
  outcome: "pending" | "hit" | "miss";
  maxFavorablePct: number;
  maxAdversePct: number;
  resolvedAt?: number;
};

async function fetchJson<T>(part: "history" | "flow"): Promise<T> {
  const res = await fetch(`/api/public/market?part=${part}&symbol=${SYMBOL}`);
  if (!res.ok) throw new Error(`طلب ${part} فشل (${res.status})`);
  return (await res.json()) as T;
}

function loadLog(): LoggedSignal[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as LoggedSignal[]) : [];
  } catch {
    return [];
  }
}

export function useMarketEngine() {
  const stateRef = useRef(createEngineState());
  const historyRef = useRef<HistoryPayload | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [log, setLog] = useState<LoggedSignal[]>([]);
  const [lastTick, setLastTick] = useState<number | null>(null);

  useEffect(() => {
    setLog(loadLog());
  }, []);

  const persist = useCallback((next: LoggedSignal[]) => {
    setLog(next);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(next.slice(0, 80)));
    } catch {
      /* storage full or unavailable — log stays in memory */
    }
  }, []);

  /** Tracks every published signal and scores it against the live price. */
  const trackSignals = useCallback(
    (a: Analysis) => {
      setLog((prevLog) => {
        let next = prevLog;
        const sig = a.signal;
        if (sig && !prevLog.some((l) => l.id === sig.id)) {
          next = [
            { ...sig, outcome: "pending", maxFavorablePct: 0, maxAdversePct: 0 },
            ...prevLog,
          ];
        }
        next = next.map((l) => {
          if (l.outcome !== "pending") return l;
          const long = l.direction === "long";
          const movePct = ((a.price - l.entry) / l.entry) * 100 * (long ? 1 : -1);
          const maxFav = Math.max(l.maxFavorablePct, movePct);
          const maxAdv = Math.min(l.maxAdversePct, movePct);
          const hitTarget = long ? a.price >= l.targets[0]! : a.price <= l.targets[0]!;
          const hitStop = long ? a.price <= l.stop : a.price >= l.stop;
          const expired = a.at > l.expiresAt;
          const outcome: LoggedSignal["outcome"] = hitTarget
            ? "hit"
            : hitStop
              ? "miss"
              : expired
                ? maxFav > Math.abs(maxAdv)
                  ? "hit"
                  : "miss"
                : "pending";
          return {
            ...l,
            maxFavorablePct: maxFav,
            maxAdversePct: maxAdv,
            outcome,
            resolvedAt: outcome === "pending" ? undefined : a.at,
          };
        });
        if (next !== prevLog) {
          try {
            localStorage.setItem(LOG_KEY, JSON.stringify(next.slice(0, 80)));
          } catch {
            /* ignore */
          }
        }
        return next;
      });
    },
    [],
  );

  const tick = useCallback(async () => {
    try {
      const flow = await fetchJson<FlowPayload>("flow");
      if (!historyRef.current) historyRef.current = await fetchJson<HistoryPayload>("history");
      const hist = historyRef.current;
      if (!hist?.candles?.m5?.length) throw new Error("لا توجد بيانات شموع");
      const next = runEngine(hist, flow, stateRef.current);
      if (next) {
        setAnalysis(next);
        trackSignals(next);
        setLive(true);
        setError(null);
        setLastTick(Date.now());
      }
    } catch (err) {
      setLive(false);
      setError((err as Error).message);
    }
  }, [trackSignals]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void tick();
    };
    run();
    const flowTimer = setInterval(run, FLOW_MS);
    const histTimer = setInterval(() => {
      void fetchJson<HistoryPayload>("history")
        .then((h) => {
          if (h.candles?.m5?.length) historyRef.current = h;
        })
        .catch(() => undefined);
    }, HISTORY_MS);
    return () => {
      cancelled = true;
      clearInterval(flowTimer);
      clearInterval(histTimer);
    };
  }, [tick, paused]);

  const accuracy = useMemo(() => {
    const resolved = log.filter((l) => l.outcome !== "pending");
    const hits = resolved.filter((l) => l.outcome === "hit").length;
    return {
      total: log.length,
      resolved: resolved.length,
      hits,
      rate: resolved.length ? (hits / resolved.length) * 100 : null,
      avgFavorable: resolved.length
        ? resolved.reduce((s, l) => s + l.maxFavorablePct, 0) / resolved.length
        : 0,
    };
  }, [log]);

  const clearLog = useCallback(() => persist([]), [persist]);

  return {
    analysis,
    error,
    live,
    paused,
    setPaused,
    log,
    accuracy,
    clearLog,
    lastTick,
    symbol: SYMBOL,
  };
}
