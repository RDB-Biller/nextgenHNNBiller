'use strict';

const config = require('./config');

/**
 * Thin client over the Stanbic "SBG Transfer" disbursement API.
 *
 * Endpoints (from the Postman collection):
 *   POST /api/sbg-transfer/v1/auth/login            -> accessToken
 *   GET  /api/sbg-transfer/v1/institutions          -> banks / receiving institutions
 *   GET  /api/sbg-transfer/v1/account-validation    -> validate beneficiary account
 *   GET  /api/sbg-transfer/v1/service-charge         -> fee for a serviceRequestId+amount
 *   POST /api/sbg-transfer/v1/disbursements          -> send money (pay out)
 *   GET  /api/sbg-transfer/v1/disbursements          -> history
 *   GET  /api/sbg-transfer/v1/disbursements/{id}     -> status check
 *
 * NOTE: this API DISBURSES (pays out). It is the settlement / payout rail of the
 * platform, not the patient collection rail. See README for the money-flow model.
 */
class SbgClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || config.sbg.baseUrl;
    this.username = opts.username || config.sbg.username;
    this.password = opts.password || config.sbg.password;
    this.sandbox = opts.sandbox != null ? opts.sandbox : config.sandbox;
    this._token = null;
    this._tokenExpiry = 0;
  }

  async _request(path, { method = 'GET', body, auth = true } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.token()}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!res.ok) {
      const err = new Error(`SBG ${method} ${path} failed: ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async token() {
    if (this.sandbox) return 'sandbox-token';
    const now = Date.now();
    if (this._token && now < this._tokenExpiry) return this._token;

    const data = await this._request('/api/sbg-transfer/v1/auth/login', {
      method: 'POST',
      auth: false,
      body: { username: this.username, password: this.password },
    });
    // Response shape from the collection: responseBody.data.accessToken
    this._token =
      data?.responseBody?.data?.accessToken ||
      data?.data?.accessToken ||
      data?.accessToken;
    // Refresh a little early; adjust to your real token TTL.
    this._tokenExpiry = now + 25 * 60 * 1000;
    if (!this._token) throw new Error('SBG login returned no accessToken');
    return this._token;
  }

  async listInstitutions() {
    if (this.sandbox) {
      return {
        data: [
          { serviceRoutingCode: '300591', name: 'Stanbic Bank Ghana' },
          { serviceRoutingCode: '300592', name: 'MTN Mobile Money' },
          { serviceRoutingCode: '300593', name: 'Vodafone Cash' },
        ],
      };
    }
    return this._request('/api/sbg-transfer/v1/institutions');
  }

  async validateAccount({ serviceRoutingCode, beneficiaryAccount }) {
    if (this.sandbox) {
      return {
        data: {
          serviceRoutingCode,
          beneficiaryAccount,
          accountName: 'EURACARE HOSPITAL LTD',
          valid: true,
        },
      };
    }
    const qs = new URLSearchParams({ serviceRoutingCode, beneficiaryAccount });
    return this._request(`/api/sbg-transfer/v1/account-validation?${qs}`);
  }

  async getServiceCharge({ serviceRequestId, amount }) {
    if (this.sandbox) {
      const fee = Math.max(1, Math.round(Number(amount) * 0.01 * 100) / 100);
      return { data: { serviceRequestId, amount: Number(amount), charge: fee } };
    }
    const qs = new URLSearchParams({ serviceRequestId, amount: String(amount) });
    return this._request(`/api/sbg-transfer/v1/service-charge?${qs}`);
  }

  /**
   * Execute a payout. In the collection, the destination + amount are bound to a
   * serviceRequestId that was created by the preceding account-validation /
   * service-charge calls. We carry that id through.
   */
  async disburse({ serviceRequestId, narration, extraDetails = '' }) {
    if (this.sandbox) {
      return {
        data: {
          serviceRequestId,
          status: 'SUCCESS',
          narration,
          reference: `SBX-${Date.now()}`,
        },
      };
    }
    return this._request('/api/sbg-transfer/v1/disbursements', {
      method: 'POST',
      body: { serviceRequestId, narration, extraDetails },
    });
  }

  async getDisbursement(serviceRequestId) {
    if (this.sandbox) {
      return {
        data: { serviceRequestId, status: 'SUCCESS', settledAt: new Date().toISOString() },
      };
    }
    return this._request(
      `/api/sbg-transfer/v1/disbursements/${encodeURIComponent(serviceRequestId)}`
    );
  }

  async listDisbursements({ startDate, endDate, page, size } = {}) {
    if (this.sandbox) return { data: [], page: page || 0, size: size || 20 };
    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate) qs.set('endDate', endDate);
    if (page != null) qs.set('page', String(page));
    if (size != null) qs.set('size', String(size));
    return this._request(`/api/sbg-transfer/v1/disbursements?${qs}`);
  }
}

module.exports = { SbgClient, sbg: new SbgClient() };
