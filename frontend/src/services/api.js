// src/services/api.js
// Centralized API client for FastConnect portal

import axios from 'axios';

const BASE_URL = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach idempotency key to payment requests
api.interceptors.request.use(config => {
  if (config.url?.includes('/payments/initiate') && config.method === 'post') {
    config.headers['Idempotency-Key'] = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  // Device ID header for session binding
  config.headers['X-Device-Id'] = getDeviceId();
  return config;
});

api.interceptors.response.use(
  res => res.data,
  err => {
    const message = err.response?.data?.error || 'Network error. Please try again.';
    return Promise.reject(new Error(message));
  }
);

// ── Device ID ──────────────────────────────────────────────────
function getDeviceId() {
  let id = sessionStorage.getItem('fc_device_id');
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}-${navigator.userAgent.length}`;
    sessionStorage.setItem('fc_device_id', id);
  }
  return id;
}

// ── Plans ───────────────────────────────────────────────────────
export const getPlans = () => api.get('/api/plans');
export const getPlan  = id => api.get(`/api/plans/${id}`);
export const getPlanChanges = since => api.get(`/api/plans/changes?since=${since}`);

// ── Sessions ────────────────────────────────────────────────────
export const getSessionStatus = phone => api.get(`/api/sessions/status/${phone}`);

// ── Payments ────────────────────────────────────────────────────
export const initiatePayment = payload => api.post('/api/payments/initiate', {
  ...payload,
  deviceId: getDeviceId(),
});
export const getPaymentStatus = checkoutRequestId =>
  api.get(`/api/payments/status/${checkoutRequestId}`);

// ── Vouchers ────────────────────────────────────────────────────
export const redeemVoucher = (voucherCode, phone) =>
  api.post('/api/vouchers/redeem', { voucherCode, phone, deviceId: getDeviceId() });

export default api;
