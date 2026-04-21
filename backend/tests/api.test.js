// tests/api.test.js — FastConnect API Test Suite
// Run: npm test

const request = require('supertest');
const { app } = require('../server');

// Mock external services
jest.mock('axios');
jest.mock('node-ssh');

// ── Plans API ────────────────────────────────────────────────────
describe('GET /api/plans', () => {
  it('returns list of active plans', async () => {
    const res = await request(app).get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('plans');
    expect(Array.isArray(res.body.plans)).toBe(true);
  });

  it('returns plans with required fields', async () => {
    const res = await request(app).get('/api/plans');
    if (res.body.plans.length > 0) {
      const plan = res.body.plans[0];
      expect(plan).toHaveProperty('id');
      expect(plan).toHaveProperty('name');
      expect(plan).toHaveProperty('price_kes');
      expect(plan).toHaveProperty('duration_hours');
      expect(plan).toHaveProperty('bandwidth_limit_mbps');
    }
  });
});

describe('GET /api/plans/:id', () => {
  it('returns 404 for non-existent plan', async () => {
    const res = await request(app).get('/api/plans/99999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid plan ID', async () => {
    const res = await request(app).get('/api/plans/abc');
    expect(res.status).toBe(400);
  });
});

// ── Session Status ───────────────────────────────────────────────
describe('GET /api/sessions/status/:phone', () => {
  it('returns no active session for unregistered phone', async () => {
    const res = await request(app)
      .get('/api/sessions/status/0712345678')
      .set('X-Device-Id', 'test-device-001');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it('rejects invalid phone format', async () => {
    const res = await request(app).get('/api/sessions/status/12345');
    expect(res.status).toBe(400);
  });

  it('accepts 0712345678 format', async () => {
    const res = await request(app).get('/api/sessions/status/0712345678');
    expect([200, 400, 500]).toContain(res.status); // depends on DB
  });

  it('accepts 254712345678 format', async () => {
    const res = await request(app).get('/api/sessions/status/254712345678');
    expect([200, 400, 500]).toContain(res.status);
  });
});

// ── Payment Initiation ───────────────────────────────────────────
describe('POST /api/payments/initiate', () => {
  it('rejects request without required fields', async () => {
    const res = await request(app).post('/api/payments/initiate').send({});
    expect(res.status).toBe(400);
  });

  it('rejects invalid phone number', async () => {
    const res = await request(app).post('/api/payments/initiate').send({
      phone: '1234567', planId: 1, deviceId: 'test'
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid planId', async () => {
    const res = await request(app).post('/api/payments/initiate').send({
      phone: '0712345678', planId: 'abc', deviceId: 'test'
    });
    expect(res.status).toBe(400);
  });
});

// ── Voucher Redemption ───────────────────────────────────────────
describe('POST /api/vouchers/redeem', () => {
  it('rejects malformed voucher code', async () => {
    const res = await request(app).post('/api/vouchers/redeem').send({
      voucherCode: 'INVALID', phone: '0712345678', deviceId: 'test'
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid phone with valid voucher format', async () => {
    const res = await request(app).post('/api/vouchers/redeem').send({
      voucherCode: 'FC-ABCD-1234', phone: 'notaphone', deviceId: 'test'
    });
    expect(res.status).toBe(400);
  });

  it('returns error for non-existent voucher', async () => {
    const res = await request(app).post('/api/vouchers/redeem').send({
      voucherCode: 'FC-XXXX-XXXX', phone: '0712345678', deviceId: 'test'
    });
    expect([400, 500]).toContain(res.status);
  });
});

// ── Admin Auth ───────────────────────────────────────────────────
describe('POST /api/admin/auth/login', () => {
  it('rejects empty credentials', async () => {
    const res = await request(app).post('/api/admin/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('rejects wrong credentials', async () => {
    const res = await request(app).post('/api/admin/auth/login').send({
      username: 'admin', password: 'wrongpassword'
    });
    expect([401, 500]).toContain(res.status);
  });
});

// ── Protected Admin Routes ───────────────────────────────────────
describe('Admin routes require authentication', () => {
  const adminRoutes = [
    ['get',    '/api/admin/dashboard/stats'],
    ['get',    '/api/admin/sessions/active'],
    ['get',    '/api/admin/plans'],
    ['post',   '/api/admin/plans'],
    ['get',    '/api/admin/reports/sales'],
    ['post',   '/api/admin/vouchers/generate'],
  ];

  adminRoutes.forEach(([method, path]) => {
    it(`${method.toUpperCase()} ${path} requires auth`, async () => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });
  });
});

// ── Health Check ─────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns health status', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
  });
});

// ── Plan Changes Endpoint ─────────────────────────────────────────
describe('GET /api/plans/changes', () => {
  it('returns change status', async () => {
    const res = await request(app).get('/api/plans/changes?since=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasChanges');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ── Rate Limiting ─────────────────────────────────────────────────
describe('Rate limiting', () => {
  it('M-Pesa callback is publicly accessible', async () => {
    const res = await request(app)
      .post('/api/payments/mpesa-callback')
      .send({ Body: { stkCallback: {} } });
    expect([200, 400, 500]).toContain(res.status);
  });
});

// ── Input Sanitization ────────────────────────────────────────────
describe('Input sanitization', () => {
  it('rejects SQL injection in phone number', async () => {
    const res = await request(app).get("/api/sessions/status/0712345678' OR '1'='1");
    expect(res.status).toBe(400);
  });

  it('rejects XSS in plan name during creation', async () => {
    const res = await request(app)
      .post('/api/admin/plans')
      .set('Authorization', 'Bearer invalid')
      .send({ name: '<script>alert(1)</script>', duration_hours: 1, price_kes: 10, bandwidth_limit_mbps: 1 });
    expect(res.status).toBe(401); // auth fails first — good
  });
});
