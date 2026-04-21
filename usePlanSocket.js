// src/hooks/usePlanSocket.js
// Real-time plan updates via WebSocket with polling fallback

import { useEffect, useCallback, useRef } from 'react';
import { getPlanChanges } from '../services/api';

const WS_URL = process.env.REACT_APP_WS_URL || `wss://${window.location.host}/ws/plans`;
const POLL_INTERVAL = 60000; // 60 seconds fallback polling

export function usePlanSocket(onPlanChange) {
  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const reconnectRef = useRef(null);
  const lastUpdateRef = useRef(Date.now());
  const mountedRef = useRef(true);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await getPlanChanges(lastUpdateRef.current);
        if (data.hasChanges) {
          lastUpdateRef.current = data.timestamp;
          onPlanChange({ action: 'PLAN_UPDATED' });
        }
      } catch {}
    }, POLL_INTERVAL);
  }, [onPlanChange]);

  const connectWS = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        // WS connected — stop polling fallback
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
      };

      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (['PLAN_UPDATED','PLAN_CREATED','PLAN_DELETED'].includes(msg.action)) {
            lastUpdateRef.current = msg.timestamp;
            onPlanChange(msg);
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        // Fall back to polling, retry WS after 15s
        startPolling();
        reconnectRef.current = setTimeout(connectWS, 15000);
      };

      ws.onerror = () => ws.close();
    } catch {
      startPolling();
    }
  }, [onPlanChange, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    connectWS();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (pollRef.current) clearInterval(pollRef.current);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connectWS]);
}
