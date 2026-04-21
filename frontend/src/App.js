// src/App.js — FastConnect Captive Portal React App

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { usePlanSocket } from './hooks/usePlanSocket';
import { getPlans, initiatePayment, getPaymentStatus, redeemVoucher } from './services/api';
import './App.css';

// ── Toast System ────────────────────────────────────────────────
let _addToast = null;
export function toast(msg, type = 'info') {
  _addToast && _addToast({ msg, type, id: Date.now() });
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  _addToast = useCallback(t => {
    setToasts(prev => [...prev, t]);
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), 3500);
  }, []);
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}</span>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ── Countdown Timer Hook ─────────────────────────────────────────
function useCountdown(endTime) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!endTime) return;
    const calc = () => Math.max(0, Math.floor((new Date(endTime) - Date.now()) / 1000));
    setRemaining(calc());
    const t = setInterval(() => setRemaining(calc()), 1000);
    return () => clearInterval(t);
  }, [endTime]);
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { remaining, display: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` };
}

// ── Plan Card ────────────────────────────────────────────────────
function PlanCard({ plan, onSelect }) {
  return (
    <div className={`plan-card ${plan.is_popular ? 'plan-card--popular' : ''}`} onClick={() => onSelect(plan)}>
      {plan.is_popular && <div className="plan-badge">⭐ Popular</div>}
      <div className="plan-card__top">
        <div className="plan-card__name">{plan.name}</div>
        <div className="plan-card__price">
          <span className="plan-card__price-num">KES {plan.price_kes}</span>
          <span className="plan-card__price-sub">one-time</span>
        </div>
      </div>
      <div className="plan-card__features">
        {[
          `${plan.duration_hours}h access`,
          `${plan.bandwidth_limit_mbps} Mbps`,
          'Unlimited data',
        ].map(f => (
          <span key={f} className="plan-feat">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#16A34A"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            {f}
          </span>
        ))}
      </div>
      <button className="pay-btn" onClick={e => { e.stopPropagation(); onSelect(plan); }}>
        <span className="mpesa-m">M</span> Pay KES {plan.price_kes}
      </button>
    </div>
  );
}

// ── Phone Modal ──────────────────────────────────────────────────
function PhoneModal({ plan, onClose, onSuccess }) {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pollState, setPollState] = useState(null); // null | 'waiting' | 'success' | 'failed'
  const [checkoutId, setCheckoutId] = useState('');
  const pollRef = useRef(null);

  const valid = /^[71][0-9]{8}$/.test(phone.replace(/\s/g, ''));

  const submit = async () => {
    setError(''); setLoading(true);
    try {
      const res = await initiatePayment({ phone: `0${phone}`, planId: plan.id });
      setCheckoutId(res.checkoutRequestId);
      setPollState('waiting');
      // Poll for payment status
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const status = await getPaymentStatus(res.checkoutRequestId);
          if (status.status === 'completed') {
            clearInterval(pollRef.current);
            setPollState('success');
            setTimeout(() => onSuccess(`0${phone}`), 1500);
          } else if (status.status === 'failed') {
            clearInterval(pollRef.current);
            setPollState('failed');
          }
        } catch {}
        if (attempts >= 30) { clearInterval(pollRef.current); setPollState('failed'); }
      }, 3000);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  useEffect(() => () => pollRef.current && clearInterval(pollRef.current), []);

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        {pollState === null && <>
          <button className="modal-close" onClick={onClose}>×</button>
          <h2 className="modal-title">Pay with M-Pesa</h2>
          <p className="modal-sub">{plan.name}</p>
          <div className="modal-amount">
            <span>Amount</span>
            <strong>KES {plan.price_kes}</strong>
          </div>
          <label className="input-label">M-Pesa Phone Number</label>
          <div className="phone-wrap">
            <span className="phone-prefix">🇰🇪 +254</span>
            <input
              type="tel"
              placeholder="712 345 678"
              maxLength={9}
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/\D/g,''))}
              className="input"
              autoFocus
            />
          </div>
          <p className="input-hint">Enter your Safaricom number (e.g. 712345678)</p>
          {error && <div className="input-error">{error}</div>}
          <button className="btn-submit" onClick={submit} disabled={!valid || loading}>
            {loading ? <span className="spinner" /> : 'Send STK Push'}
          </button>
        </>}

        {pollState === 'waiting' && (
          <div className="payment-status">
            <div className="payment-status__icon payment-status__icon--pending">📱</div>
            <h3>Check your phone</h3>
            <p>M-Pesa PIN prompt sent to <strong>0{phone}</strong>.<br />Enter your PIN to complete payment.</p>
            <div className="waiting-row"><span className="spinner spinner--blue" /> Waiting for confirmation…</div>
          </div>
        )}

        {pollState === 'success' && (
          <div className="payment-status">
            <div className="payment-status__icon payment-status__icon--success">✅</div>
            <h3>Payment Successful!</h3>
            <p>KES {plan.price_kes} received. Setting up your connection…</p>
          </div>
        )}

        {pollState === 'failed' && (
          <div className="payment-status">
            <div className="payment-status__icon payment-status__icon--error">❌</div>
            <h3>Payment Not Confirmed</h3>
            <p>We didn't receive a payment confirmation. If money was deducted, contact support.</p>
            <button className="btn-submit" onClick={() => { setPollState(null); setLoading(false); }}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Voucher Modal ────────────────────────────────────────────────
function VoucherModal({ onClose, onSuccess }) {
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const formatCode = val => {
    let v = val.replace(/[^A-Z0-9]/gi,'').toUpperCase().slice(0,10);
    if (v.length > 6) v = v.slice(0,2)+'-'+v.slice(2,6)+'-'+v.slice(6);
    else if (v.length > 2) v = v.slice(0,2)+'-'+v.slice(2);
    return v;
  };

  const redeem = async () => {
    setError(''); setLoading(true);
    try {
      const res = await redeemVoucher(code, `0${phone}`);
      onSuccess(res, `0${phone}`);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const validCode = /^FC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
  const validPhone = /^[71][0-9]{8}$/.test(phone.replace(/\s/g,''));

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <button className="modal-close" onClick={onClose}>×</button>
        <h2 className="modal-title">Redeem Voucher</h2>
        <p className="modal-sub">Enter your voucher code to get online</p>

        <label className="input-label">Voucher Code</label>
        <input
          type="text"
          placeholder="FC-XXXX-XXXX"
          value={code}
          onChange={e => setCode(formatCode(e.target.value))}
          className="input input--mono"
          maxLength={12}
          autoFocus
        />
        <p className="input-hint">Demo voucher: FC-DEMO-2024</p>

        <label className="input-label" style={{marginTop:'14px'}}>Your Phone Number</label>
        <div className="phone-wrap">
          <span className="phone-prefix">🇰🇪 +254</span>
          <input type="tel" placeholder="712 345 678" maxLength={9}
            value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,''))} className="input" />
        </div>

        {error && <div className="input-error">{error}</div>}
        <button className="btn-submit" onClick={redeem} disabled={!validCode || !validPhone || loading} style={{background:'#2563EB'}}>
          {loading ? <span className="spinner" /> : 'Redeem Voucher'}
        </button>
      </div>
    </div>
  );
}

// ── Connected View ───────────────────────────────────────────────
function ConnectedView() {
  const { session, disconnect } = useSession();
  const { display } = useCountdown(session?.endTime);
  const snap = session?.planSnapshot || {};

  const copy = (text, label) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    toast(`${label} copied!`, 'success');
  };

  return (
    <>
      <header className="header header--green">
        <Logo />
        <div className="status-badge status-badge--connected"><span className="dot dot--pulse" />Connected</div>
        <h1 className="header-title">{snap.name || session?.planName}</h1>
        <p className="header-sub">Unlimited data · {snap.bandwidth_limit_mbps || 2} Mbps</p>
        <div className="timer-box">
          <div className="timer-label">Time Remaining</div>
          <div className="timer-display">{display}</div>
          <div className="timer-plan">Expires {session?.endTime ? new Date(session.endTime).toLocaleString('en-KE') : ''}</div>
        </div>
      </header>

      <div className="creds-box">
        <div className="creds-label">WiFi Credentials</div>
        <div className="cred-row">
          <span className="cred-key">Username</span>
          <span className="cred-val">{session?.hotspotUsername}</span>
          <button className="copy-btn" onClick={() => copy(session?.hotspotUsername, 'Username')}>Copy</button>
        </div>
        <div className="cred-row">
          <span className="cred-key">Password</span>
          <span className="cred-val">{session?.hotspotPassword}</span>
          <button className="copy-btn" onClick={() => copy(session?.hotspotPassword, 'Password')}>Copy</button>
        </div>
      </div>

      <div className="content">
        <div className="info-card">
          <div className="info-row"><span className="info-key">Connected since</span><span className="info-val">{session?.startTime ? new Date(session.startTime).toLocaleTimeString('en-KE') : '—'}</span></div>
          <div className="info-row"><span className="info-key">Phone</span><span className="info-val">{session?.phone ? '0' + '*** ***' : '—'}</span></div>
          <div className="info-row"><span className="info-key">Signal</span><span className="info-val" style={{color:'#16A34A'}}>Excellent</span></div>
        </div>
        <button className="btn-disconnect" onClick={disconnect}>Disconnect from Network</button>
      </div>
    </>
  );
}

// ── Disconnected View ────────────────────────────────────────────
function DisconnectedView() {
  const { session, reconnect, setSessionState } = useSession();
  const [loading, setLoading] = useState(false);
  const snap = session?.planSnapshot || {};
  const endTime = session?.endTime;
  const totalMs = (snap.duration_hours || 24) * 3600000;
  const remainingMs = endTime ? Math.max(0, new Date(endTime) - Date.now()) : 0;
  const pct = Math.round(100 - (remainingMs / totalMs) * 100);

  const handleReconnect = async () => {
    setLoading(true);
    toast('Reconnecting…', 'info');
    await reconnect();
    setLoading(false);
  };

  return (
    <>
      <header className="header header--orange">
        <Logo />
        <div className="status-badge status-badge--disconnected"><span className="dot" />Disconnected</div>
        <h1 className="header-title">Your plan is still active</h1>
        <p className="header-sub">Tap Reconnect to restore your connection</p>
      </header>

      <div className="content">
        <div className="info-card">
          <p className="info-plan-name">{snap.name}</p>
          <p className="info-expiry">Expires {endTime ? new Date(endTime).toLocaleString('en-KE') : '—'}</p>
          <div className="progress-bar"><div className="progress-fill progress-fill--orange" style={{width:`${pct}%`}} /></div>
          <p className="progress-label">{pct}% of plan used</p>
        </div>
        <button className="btn-reconnect" onClick={handleReconnect} disabled={loading}>
          {loading ? <span className="spinner" /> : 'Reconnect Now'}
        </button>
        <button className="btn-secondary" onClick={() => setSessionState('no-session')}>Buy a New Plan</button>
      </div>
    </>
  );
}

// ── Plans View (main portal) ─────────────────────────────────────
function PlansView() {
  const { onPaymentSuccess } = useSession();
  const [plans, setPlans] = useState([]);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showVoucher, setShowVoucher] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastPlanFetch = useRef(Date.now());

  const fetchPlans = useCallback(async () => {
    try {
      const data = await getPlans();
      setPlans(data.plans || []);
      lastPlanFetch.current = Date.now();
    } catch { toast('Could not load plans. Please refresh.', 'error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  // Real-time plan updates via WebSocket
  usePlanSocket(useCallback(({ action }) => {
    fetchPlans();
    if (action !== 'SESSION_CREATED') toast('Plans have been updated', 'info');
  }, [fetchPlans]));

  const handlePaySuccess = useCallback(async phone => {
    setSelectedPlan(null);
    toast('Payment confirmed! Setting up your connection…', 'success');
    await onPaymentSuccess(phone);
  }, [onPaymentSuccess]);

  const handleVoucherSuccess = useCallback(async (res, phone) => {
    setShowVoucher(false);
    toast(`Voucher redeemed! ${res.planName} active.`, 'success');
    await onPaymentSuccess(phone);
  }, [onPaymentSuccess]);

  return (
    <>
      <header className="header header--blue">
        <Logo />
        <h1 className="header-title">Get Connected</h1>
        <p className="header-sub">Choose a plan and pay with M-Pesa</p>
      </header>

      <div className="content">
        <div className="section-title">Available Plans</div>
        {loading ? (
          <div className="loading-plans">
            {[1,2,3].map(i => <div key={i} className="plan-skeleton" />)}
          </div>
        ) : (
          <div className="plans-grid">
            {plans.map(plan => (
              <PlanCard key={plan.id} plan={plan} onSelect={setSelectedPlan} />
            ))}
          </div>
        )}
        <button className="voucher-link" onClick={() => setShowVoucher(true)}>
          🎟 Have a voucher? Redeem it here
        </button>
      </div>

      {selectedPlan && (
        <PhoneModal
          plan={selectedPlan}
          onClose={() => setSelectedPlan(null)}
          onSuccess={handlePaySuccess}
        />
      )}
      {showVoucher && (
        <VoucherModal
          onClose={() => setShowVoucher(false)}
          onSuccess={handleVoucherSuccess}
        />
      )}
    </>
  );
}

// ── Logo Component ───────────────────────────────────────────────
function Logo() {
  return (
    <div className="logo">
      <div className="logo-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
          <path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.24 4.24 0 00-6 0zm-4-4l2 2a7.07 7.07 0 0110 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>
        </svg>
      </div>
      <span className="logo-text">FastConnect Internet</span>
    </div>
  );
}

// ── Root Portal ──────────────────────────────────────────────────
function Portal() {
  const { sessionState, loading } = useSession();

  if (loading) {
    return (
      <div className="loading-screen">
        <Logo />
        <div className="spinner spinner--white" style={{width:32,height:32,marginTop:24}} />
      </div>
    );
  }

  return (
    <div className="app">
      {sessionState === 'connected'    && <ConnectedView />}
      {sessionState === 'disconnected' && <DisconnectedView />}
      {sessionState === 'no-session'   && <PlansView />}
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <ToastContainer />
      <Portal />
    </SessionProvider>
  );
}
