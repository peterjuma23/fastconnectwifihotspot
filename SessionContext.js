// src/contexts/SessionContext.js
// Global session state: phone, active session, device credentials

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getSessionStatus } from '../services/api';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [phone, setPhone]             = useState(() => sessionStorage.getItem('fc_phone') || '');
  const [session, setSession]         = useState(null);   // active session data
  const [sessionState, setSessionState] = useState('loading'); // loading | no-session | connected | disconnected
  const [loading, setLoading]         = useState(true);
  const pollRef = useRef(null);

  // Persist phone across refreshes (session storage — cleared on tab close)
  const savePhone = useCallback(p => {
    setPhone(p);
    sessionStorage.setItem('fc_phone', p);
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setSessionState('no-session');
    setPhone('');
    sessionStorage.removeItem('fc_phone');
  }, []);

  // Check session status from API
  const checkSession = useCallback(async (phoneNum = phone) => {
    if (!phoneNum) { setSessionState('no-session'); setLoading(false); return; }
    try {
      const data = await getSessionStatus(phoneNum);
      if (data.active) {
        setSession(data);
        setSessionState('connected');
      } else {
        // Check if we have a locally-remembered disconnected session
        const remembered = sessionStorage.getItem('fc_disconnected_session');
        if (remembered) {
          const s = JSON.parse(remembered);
          if (new Date(s.endTime) > new Date()) {
            setSession(s);
            setSessionState('disconnected');
          } else {
            sessionStorage.removeItem('fc_disconnected_session');
            setSessionState('no-session');
          }
        } else {
          setSessionState('no-session');
        }
      }
    } catch {
      setSessionState('no-session');
    } finally {
      setLoading(false);
    }
  }, [phone]);

  // Auto-check on mount
  useEffect(() => { checkSession(); }, []); // eslint-disable-line

  // Poll session status every 30s to detect expiry
  useEffect(() => {
    if (sessionState !== 'connected' || !phone) return;
    pollRef.current = setInterval(() => checkSession(), 30000);
    return () => clearInterval(pollRef.current);
  }, [sessionState, phone, checkSession]);

  const disconnect = useCallback(() => {
    if (session) {
      sessionStorage.setItem('fc_disconnected_session', JSON.stringify(session));
    }
    setSessionState('disconnected');
  }, [session]);

  const reconnect = useCallback(async () => {
    setLoading(true);
    await checkSession();
    sessionStorage.removeItem('fc_disconnected_session');
  }, [checkSession]);

  const onPaymentSuccess = useCallback(async (phoneNum) => {
    savePhone(phoneNum);
    setLoading(true);
    // Poll until session is provisioned (up to 30s)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const data = await getSessionStatus(phoneNum);
        if (data.active) {
          clearInterval(poll);
          setSession(data);
          setSessionState('connected');
          setLoading(false);
        }
      } catch {}
      if (attempts >= 15) { clearInterval(poll); setLoading(false); }
    }, 2000);
  }, [savePhone]);

  return (
    <SessionContext.Provider value={{
      phone, setPhone: savePhone,
      session, setSession,
      sessionState, setSessionState,
      loading, clearSession,
      checkSession, disconnect, reconnect, onPaymentSuccess,
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
