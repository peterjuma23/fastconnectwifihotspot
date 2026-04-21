// src/App.js — FastConnect Captive Portal React App (Simplified - Plans Only)

import React, { useState, useEffect, useCallback } from 'react';
import { getPlans, redeemVoucher } from './services/api';
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

// ── Plan Card (No Payment) ──────────────────────────────────────
function PlanCard({ plan }) {
  return (
    <div className={`plan-card ${plan.is_popular ? 'plan-card--popular' : ''}`}>
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
      <button className="pay-btn" disabled style={{ opacity: 0.7, cursor: 'not-allowed', background: '#9CA3AF' }}>
        <span className="mpesa-m">M</span> Coming Soon
      </button>
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

// ── Plans View (Main Portal - No Payment, No Connected/Disconnected) ──
function PlansView() {
  const [plans, setPlans] = useState([]);
  const [showVoucher, setShowVoucher] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchPlans = useCallback(async () => {
    try {
      const data = await getPlans();
      setPlans(data.plans || []);
    } catch (err) {
      toast('Could not load plans. Please refresh.', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  const handleVoucherSuccess = useCallback(async (res, phone) => {
    setShowVoucher(false);
    toast(`Voucher redeemed! ${res.planName} active.`, 'success');
    toast('Please contact support to activate your connection', 'info');
  }, []);

  return (
    <>
      <header className="header header--blue">
        <Logo />
        <h1 className="header-title">Get Connected</h1>
        <p className="header-sub">Choose a plan and contact support to activate</p>
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
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </div>
        )}
        <div style={{ textAlign: 'center', marginTop: '16px', padding: '12px', background: '#FEF3C7', borderRadius: '10px', color: '#D97706', fontSize: '13px', fontWeight: '600' }}>
          ⚡ Online payments coming soon. Contact support to activate your plan.
        </div>
        <button className="voucher-link" onClick={() => setShowVoucher(true)}>
          🎟 Have a voucher? Redeem it here
        </button>
      </div>

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

// ── Root App ──────────────────────────────────────────────────
export default function App() {
  return (
    <>
      <ToastContainer />
      <div className="app">
        <PlansView />
      </div>
    </>
  );
}