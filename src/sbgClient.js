'use strict';

const config = require('./config');

/**
 * Client for the Stanbic Bank Ghana "SBG Money Transfer" disbursement API.
 *
 * Verified against the official API document (STANBIC-GH GODIGI, v0.0.1, July 2025)
 * and the public Postman collection. This API DISBURSES (pays out) from an onboarded
 * Stanbic account to a Stanbic account, another bank, or a mobile wallet. It is the
 * settlement/payout rail — not the patient collection rail.
 *
 * Two deployment targets exist; both are supported via SBG_BASE_URL + SBG_PATH_PREFIX:
 *   - Marketplace gateway (Postman):  https://api.marketplaceuat.stanbic.com.gh
 *                                      path prefix /api/sbg-transfer
 *   - Direct smartapp host (doc):      https://ghuatsmartapp03.gh.sbicdirectory.com:8443/sbg-money-api
 *                                      path prefix "" (endpoints begin at /v1/...)
 *
 * Endpoints (relative to the path prefix):
 *   POST /v1/auth/login                     -> responseBody.data.accessToken
 *   GET  /v1/institutions[?category=]       -> responseBody.data[] (BANKS | MOMO)
 *   GET  /v1/account-validation             -> responseBody.data.serviceRequestId (the ticket)
 *   GET  /v1/service-charge                 -> responseBody.data.charge
 *   POST /v1/disbursements                  -> responseBody.data.status
 *   GET  /v1/disbursements/{serviceRequestId} -> transfer status
 *   GET  /v1/disbursements?startDate&endDate  -> history
 *
 * Success is signalled by responseHeader.statusCode "000" / responseCode "SUCCESS",
 * not merely HTTP 200 — both are checked.
 */

const SUCCESS_STATUS = '000';

class SbgError extends Error {
  constructor(message, { httpStatus, statusCode, responseCode, responseMessage, body } = {}) {
    super(message);
    this.name = 'SbgError';
    this.httpStatus = httpStatus;
    this.statusCode = statusCode;       // e.g. "000", "A10", "A44"
    this.responseCode = responseCode;   // e.g. "SUCCESS", "FAILED"
    this.responseMessage = responseMessage;
    this.body = body;
  }
}

class SbgClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || config.sbg.baseUrl || '').replace(/\/$/, '');
    // Path prefix in front of /v1/... . Marketplace gateway = /api/sbg-transfer; direct host = "".
    this.pathPrefix = (opts.pathPrefix != null ? opts.pathPrefix : config.sbg.pathPrefix || '').replace(/\/$/, '');
    this.username = opts.username || config.sbg.username;
    this.password = opts.password || config.sbg.password;
    this.sandbox = opts.sandbox != null ? opts.sandbox : config.sandbox;
    this._token = null;
    this._tokenExpiry = 0;
  }

  _url(p) { return `${this.baseUrl}${this.pathPrefix}${p}`; }

  async _request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.token()}`;

    const res = await fetch(this._url(path), {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    const header = json?.responseHeader || {};
    const statusCode = header.statusCode;
    const responseCode = header.responseCode;

    // The bank returns its own status envelope; a 200 with statusCode != "000" is still a failure.
    if (!res.ok || (statusCode && statusCode !== SUCCESS_STATUS)) {
      throw new SbgError(
        `SBG ${method} ${path} failed: HTTP ${res.status}${statusCode ? ` / ${statusCode} ${responseCode || ''}` : ''}`,
        { httpStatus: res.status, statusCode, responseCode,
          responseMessage: header.responseMessage, body: json });
    }
    return json;
  }

  async token() {
    if (this.sandbox) return 'sandbox-token';
    const now = Date.now();
    if (this._token && now < this._tokenExpiry) return this._token;

    const data = await this._request('/v1/auth/login', {
      method: 'POST', auth: false,
      body: { username: this.username, password: this.password },
    });
    this._token = data?.responseBody?.data?.accessToken;
    if (!this._token) throw new SbgError('SBG login returned no accessToken', { body: data });
    // Doc: token lasts up to an hour. Refresh a little early.
    this._tokenExpiry = now + 50 * 60 * 1000;
    return this._token;
  }

  /** Institutions the beneficiary can belong to. Optional category BANKS | MOMO. */
  async listInstitutions(category) {
    if (this.sandbox) {
      const all = [
        { index: 0, name: 'Stanbic Bank Ghana', serviceRoutingCode: '300591', category: 'BANKS' },
        { index: 1, name: 'MTN Mobile Money', serviceRoutingCode: 'MTN', category: 'MOMO' },
        { index: 2, name: 'Telecel Cash', serviceRoutingCode: 'VOD', category: 'MOMO' },
      ];
      const data = category ? all.filter((i) => i.category === category) : all;
      return { responseBody: { data } };
    }
    const qs = category ? `?category=${encodeURIComponent(category)}` : '';
    return this._request(`/v1/institutions${qs}`);
  }

  /**
   * Validate a beneficiary account against an institution.
   * Per the doc this REQUIRES category + serviceRoutingCode + beneficiaryAccount, and
   * RETURNS the serviceRequestId (ticket) that tracks the rest of the transaction.
   */
  async validateAccount({ category, serviceRoutingCode, beneficiaryAccount }) {
    if (this.sandbox) {
      return { responseBody: { data: {
        serviceRequestId: `S${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
        beneficiaryAccount, beneficiaryName: 'EURACARE HOSPITAL LTD',
      } } };
    }
    const qs = new URLSearchParams({
      category: category || 'BANKS', serviceRoutingCode, beneficiaryAccount,
    });
    return this._request(`/v1/account-validation?${qs}`);
  }

  /** Charge applicable to an amount, keyed by the ticket from account-validation. */
  async getServiceCharge({ serviceRequestId, amount }) {
    if (this.sandbox) {
      const charge = Math.max(1, Math.round(Number(amount) * 0.01 * 100) / 100);
      return { responseBody: { data: { currency: 'GHS', amount: Number(amount), charge } } };
    }
    const qs = new URLSearchParams({ serviceRequestId, amount: String(amount) });
    return this._request(`/v1/service-charge?${qs}`);
  }

  /** Confirm the transfer — the actual payout. Bound to the validated ticket. */
  async disburse({ serviceRequestId, narration, extraDetails = '' }) {
    if (this.sandbox) {
      return { responseBody: { data: {
        serviceRequestId, status: 'SUCCESS', narration,
        reference: `SBX-${Date.now()}`,
        createdDate: new Date().toISOString(),
      } } };
    }
    return this._request('/v1/disbursements', {
      method: 'POST', body: { serviceRequestId, narration, extraDetails },
    });
  }

  /** Status of a transfer: PENDING | SUCCESS | FAILED. */
  async getDisbursement(serviceRequestId) {
    if (this.sandbox) {
      return { responseBody: { data: { serviceRequestId, status: 'SUCCESS',
        lastModifiedDate: new Date().toISOString() } } };
    }
    return this._request(`/v1/disbursements/${encodeURIComponent(serviceRequestId)}`);
  }

  async listDisbursements({ startDate, endDate, page, size } = {}) {
    if (this.sandbox) return { responseBody: { data: [] } };
    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate) qs.set('endDate', endDate);
    if (page != null) qs.set('page', String(page));
    if (size != null) qs.set('size', String(size));
    return this._request(`/v1/disbursements?${qs}`);
  }
}

// Helpers to read the bank's envelope regardless of nesting.
const sbgData = (res) => res?.responseBody?.data ?? res?.data ?? res;

module.exports = { SbgClient, SbgError, sbgData, sbg: new SbgClient() };
