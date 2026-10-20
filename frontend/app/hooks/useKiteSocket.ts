"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getWSUrl } from "../lib/api";

interface Tick {
  token: number;
  tradingSymbol: string;
  last: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  oi: number;
  timestamp: number;
}

interface WSMessage {
  type: string;
  data?: any;
}

export function useKiteSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [ticks, setTicks] = useState<Map<number, Tick>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWSUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log("[ws] Connected to gateway");
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "tick" && Array.isArray(msg.data)) {
          setTicks((prev) => {
            const next = new Map(prev);
            msg.data.forEach((t: Tick) => next.set(t.token, t));
            return next;
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 3 seconds
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, ticks };
}
