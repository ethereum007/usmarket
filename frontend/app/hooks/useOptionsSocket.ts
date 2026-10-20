"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getWSUrl } from "../lib/api";

interface OptionsTick {
  token: number;
  last: number;
  volume: number;
  oi: number;
  oiDayHigh: number;
  oiDayLow: number;
  timestamp: number;
}

export function useOptionsSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [optionsTicks, setOptionsTicks] = useState<Map<number, OptionsTick>>(new Map());
  const subscribedRef = useRef<Set<number>>(new Set());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWSUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Re-subscribe on reconnect
      if (subscribedRef.current.size > 0) {
        ws.send(
          JSON.stringify({
            type: "subscribe_options",
            tokens: Array.from(subscribedRef.current),
          })
        );
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "options_tick" && Array.isArray(msg.data)) {
          setOptionsTicks((prev) => {
            const next = new Map(prev);
            for (const t of msg.data) {
              next.set(t.token, t);
            }
            return next;
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  const subscribeOptions = useCallback((tokens: number[]) => {
    tokens.forEach((t) => subscribedRef.current.add(t));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: "subscribe_options", tokens })
      );
    }
  }, []);

  const unsubscribeOptions = useCallback((tokens: number[]) => {
    tokens.forEach((t) => subscribedRef.current.delete(t));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: "unsubscribe_options", tokens })
      );
    }
  }, []);

  const unsubscribeAll = useCallback(() => {
    const tokens = Array.from(subscribedRef.current);
    subscribedRef.current.clear();
    if (wsRef.current?.readyState === WebSocket.OPEN && tokens.length > 0) {
      wsRef.current.send(
        JSON.stringify({ type: "unsubscribe_options", tokens })
      );
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      unsubscribeAll();
      wsRef.current?.close();
    };
  }, [connect, unsubscribeAll]);

  return { connected, optionsTicks, subscribeOptions, unsubscribeOptions, unsubscribeAll };
}
