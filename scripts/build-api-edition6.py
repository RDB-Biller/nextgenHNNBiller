#!/usr/bin/env python3
"""Edition 6 (Revised) API specs: adds two feature-group specs and folds them into the complete spec and openapi.yaml.

  public/apis/hnn-08-erheat-shield.{yaml,json}              ERHEAT Shield: borrower, verifier, voucher, lender hooks, partner accounts
  public/apis/hnn-09-accounts-admins-currency.{yaml,json}   Account directory, sub-admins, demo login, currencies

Run:  python3 scripts/build-api-edition6.py   (needs PyYAML). Safe to re-run: paths are replaced, not duplicated.
"""
import json, os, copy
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.path.join(ROOT, 'public', 'apis')
EDITION = '6th Edition (Revised), 18 October 2026'

SEC = {
    'BorrowerToken': {'type': 'http', 'scheme': 'bearer', 'description': 'Patient-account token from POST /patient-api/v1/patient/login (30-day signed token).'},
    'PartnerToken': {'type': 'http', 'scheme': 'bearer', 'description': 'Partner session token from POST /partner-api/login (12-hour signed token).'},
    'SubAdminToken': {'type': 'http', 'scheme': 'bearer', 'description': 'Sub-admin session token from POST /admin-api/login. Opens only the areas the account was given; sandboxed (demo and evaluator) accounts work on a private scratch copy.'},
    'PlatformKey': {'type': 'apiKey', 'in': 'header', 'name': 'x-platform-key', 'description': 'Chief administrator key (env PLATFORM_ADMIN_KEY).'},
}
OBJ = {'type': 'object', 'additionalProperties': True}


def op(summary, desc=None, sec=None, body=None, params=(), ok='200', okdesc='OK', tag=None, errors=()):
    o = {'summary': summary}
    if tag: o['tags'] = [tag]
    if desc: o['description'] = desc
    o['security'] = [{s: []} for s in sec] if sec else []
    ps = []
    for p in params:
        name, where, d = p
        ps.append({'name': name, 'in': where, 'required': where == 'path', 'description': d, 'schema': {'type': 'string'}})
    if ps: o['parameters'] = ps
    if body is not None:
        o['requestBody'] = {'required': True, 'content': {'application/json': {'schema': OBJ, 'example': body}}}
    r = {ok: {'description': okdesc, 'content': {'application/json': {'schema': OBJ}}}}
    for code, d in errors: r[code] = {'description': d}
    o['responses'] = r
    return o


def add(paths, path, method, o):
    paths.setdefault(path, {})[method] = o


# ---------------------------------------------------------------------------------------------- 08 ERHEAT Shield
def erheat():
    p = {}; B = ['BorrowerToken']; PK = ['PlatformKey']; T = 'ERHEAT borrower'
    add(p, '/erheat/api/lines', 'get', op('Lines, limits and the borrower’s Trust Passport', 'Which of the six lines (rent, health, education, energy, agriculture, transport) are open, with fields, limits, wording and the person’s passport.', B, tag=T))
    add(p, '/erheat/api/health/facilities', 'get', op('Facilities that use the Biller (Health directory)', 'Public. Used so a patient can pick their facility; the facility is texted to confirm.', None, tag=T))
    add(p, '/erheat/api/health/pending', 'get', op('Open Biller bills for the signed-in phone', 'Each item has billId, facility, billTotal, patientPayable and a note. A Health request made from a bill is confirmed by the bill itself.', B, tag=T))
    add(p, '/erheat/api/profile', 'get', op('Saved details per line', 'Optional prefill: meter number, landlord, school, supplier, route. Nothing is required.', B, tag=T))
    add(p, '/erheat/api/profile', 'put', op('Save details per line', 'Send null for a line to remove it. Each request still asks whether to use the details on file or different ones.', B, {'lines': {'energy': {'evidence': {'reference': '12345678'}, 'payee': {'name': 'Shell Madina', 'phone': '+233200000000'}}, 'rent': None}}, tag=T))
    add(p, '/erheat/api/history', 'get', op('Awarded requests and totals', 'Approved onwards, with totals borrowed and repaid.', B, tag=T))
    add(p, '/erheat/api/passport', 'get', op('Trust Passport', 'Level (new, trusted, preferred), ceiling (500, 1000, 2000; never above the hard cap), verified, repaid, defaults, open requests.', B, tag=T))
    add(p, '/erheat/api/apps', 'get', op('The borrower’s requests', None, B, tag=T))
    add(p, '/erheat/api/apps/{id}', 'get', op('One request with its next step', None, B, params=[('id', 'path', 'Request id')], tag=T, errors=[('404', 'Not found')]))
    add(p, '/erheat/api/apply', 'post', op('Ask for a loan', 'Creates the request and texts the verifier. With billId the Biller bill is the confirmation (amount cannot exceed the patient share; one request per bill); with facilityId the facility is texted. Everything is in GHS.', B,
        {'line': 'rent', 'amount': 900, 'purpose': 'November rent', 'payee': {'name': 'Kojo Boateng', 'phone': '0200000000'}, 'verifier': {'name': 'Kojo Boateng', 'phone': '0200000000'}, 'evidence': {'monthlyRent': '450', 'dueDate': '2026-11-01'}, 'lang': 'en'},
        ok='200', okdesc='The request in its borrower view', tag=T,
        errors=[('403', 'Phone not verified'), ('404', 'ERHEAT Shield is not open yet'), ('409', 'Line not open, or an open request exists on the line'), ('422', 'Amount above the limit or invalid details'), ('429', 'Monthly request limit reached')]))
    add(p, '/erheat/api/apps/{id}/consent', 'post', op('Consent and submit to the lender', 'Only when the request is verified. Stores the consent text version and, if a lender URL is set, pushes the signed packet.', B, {'agree': True}, params=[('id', 'path', 'Request id')], tag=T, errors=[('409', 'Not ready to submit'), ('422', 'Consent not given')]))
    add(p, '/erheat/api/apps/{id}/cancel', 'post', op('Cancel an open request', None, B, {}, params=[('id', 'path', 'Request id')], tag=T))
    add(p, '/erheat/api/apps/{id}/resend/{vid}', 'post', op('Text the verifier again', None, B, {}, params=[('id', 'path', 'Request id'), ('vid', 'path', 'Verifier id')], tag=T))
    V = 'ERHEAT verifier and voucher'
    add(p, '/erheat/v/{token}', 'get', op('Verifier page (HTML)', 'No account. The one-time link in the SMS is the credential.', None, params=[('token', 'path', 'Link token from the SMS')], tag=V))
    add(p, '/erheat/v/{token}', 'post', op('Confirm or decline', 'Form or JSON: decision confirm | decline, confirmedAmount?, accountName?, note?', None, {'decision': 'confirm', 'confirmedAmount': 900, 'accountName': 'K Boateng'}, params=[('token', 'path', 'Link token')], tag=V))
    add(p, '/erheat/redeem', 'post', op('Redeem a voucher', 'The vendor enters the voucher code and the customer’s one-time number. Rate limited.', None, {'code': 'AB12CD34', 'otp': '123456', 'phone': '+233200000000'}, tag=V, errors=[('422', 'Wrong, used or expired voucher')]))
    L = 'ERHEAT lender hooks'; hp = [('secret', 'path', 'Hook secret from Master Control > ERHEAT')]
    add(p, '/erheat-hooks/{secret}/decision', 'post', op('Lender decision', 'approvedAmount defaults to the verified amount; it must be above zero and at most that amount (never above GHS 2,000). Voucher lines get a voucher on approval.', None, {'applicationNo': 'ERH-482913', 'decision': 'approved', 'approvedAmount': 900, 'reference': 'CU-7781'}, params=hp, tag=L, errors=[('404', 'Wrong secret'), ('409', 'Request is not in a state that accepts this'), ('422', 'Invalid decision or amount')]))
    add(p, '/erheat-hooks/{secret}/paid', 'post', op('The payee has been paid', None, None, {'applicationNo': 'ERH-482913', 'reference': 'MOMO-55102', 'paidAt': '2026-10-18T10:05:00Z'}, params=hp, tag=L))
    add(p, '/erheat-hooks/{secret}/repayment', 'post', op('Repayment, closure or default', 'Idempotent on reference. outstanding of 0 closes the request. { applicationNo, event: "default" } reports a default.', None, {'applicationNo': 'ERH-482913', 'amount': 300, 'reference': 'CU-R-1', 'outstanding': 600}, params=hp, tag=L))
    add(p, '/erheat-hooks/{secret}/applications/{appNo}', 'get', op('Verified-Need Packet', 'Borrower, payee, evidence, confirmations, flags, consent, passport and payment instruction.', None, params=hp + [('appNo', 'path', 'Application number, e.g. ERH-482913')], tag=L, errors=[('404', 'application_not_found')]))
    M = 'ERHEAT Master Control'
    add(p, '/api/platform/erheat/config', 'get', op('ERHEAT settings, lines and hook URLs', None, PK + ['SubAdminToken'], tag=M))
    add(p, '/api/platform/erheat/config', 'put', op('Change settings', 'enabled, requireVerifiedPhone, hardCap, ladder {new, trusted, preferred}, verifierTtlHours, appTtlDays, maxApps30d, lender {name, pushUrl}, lines {<line>: {enabled, min, cap}}', PK + ['SubAdminToken'], {'enabled': True, 'lines': {'rent': {'enabled': True, 'min': 50, 'cap': 1000}}, 'lender': {'name': 'ConfirmU', 'pushUrl': 'https://lender.example/erheat'}}, tag=M))
    add(p, '/api/platform/erheat/secret/rotate', 'post', op('Rotate the hook secret', 'Old URLs stop working at once.', PK, {}, tag=M))
    add(p, '/api/platform/erheat/apps', 'get', op('Every request', None, PK + ['SubAdminToken'], params=[('status', 'query', 'Filter'), ('line', 'query', 'Filter'), ('limit', 'query', 'Default 100')], tag=M))
    add(p, '/api/platform/erheat/apps/{id}', 'get', op('One request in full', None, PK + ['SubAdminToken'], params=[('id', 'path', 'Request id')], tag=M))
    add(p, '/api/platform/erheat/apps/{id}/simulate', 'post', op('Act as the lender (sandbox only)', None, PK, {'action': 'approve', 'amount': 900}, params=[('id', 'path', 'Request id')], tag=M, errors=[('403', 'Only in sandbox mode')]))
    PA = 'Partner accounts'
    add(p, '/partner-api/signup-options', 'get', op('Roles and sectors for the sign-up form', None, None, tag=PA))
    add(p, '/partner-api/signup', 'post', op('Ask for a partner account', 'Creates a PENDING account. Nobody signs in until Master Control approves.', None, {'name': 'Esi Owusu', 'org': 'Ridge Clinic', 'role': 'hospital_admin', 'email': 'esi@ridge.example', 'password': 'at-least-8-chars'}, ok='201', tag=PA))
    add(p, '/partner-api/login', 'post', op('Sign in', 'Email or phone as handle, and password. 12-hour session.', None, {'handle': 'esi@ridge.example', 'password': '...'}, tag=PA))
    add(p, '/partner-api/me', 'get', op('The signed-in partner', None, ['PartnerToken'], tag=PA))
    add(p, '/partner-api/password', 'post', op('Change password', 'Ends every session.', ['PartnerToken'], {'current': '...', 'password': '...'}, tag=PA))
    add(p, '/partner-api/requests', 'get', op('Requests for the account’s sector', 'Finance accounts see every line.', ['PartnerToken'], params=[('status', 'query', 'Filter')], tag=PA))
    add(p, '/partner-api/redeem', 'post', op('Redeem a voucher', 'Energy, agriculture and transport sectors.', ['PartnerToken'], {'code': 'AB12CD34', 'otp': '123456'}, tag=PA))
    add(p, '/partner-api/request-universal', 'post', op('Ask for the universal account', None, ['PartnerToken'], {}, tag=PA))
    A = 'Partner administration'
    add(p, '/api/platform/partners', 'get', op('Accounts, roles and sectors', None, PK + ['SubAdminToken'], tag=A))
    add(p, '/api/platform/partners', 'post', op('Issue a partner login', 'Returns a temporary password (the person must change it) and can text it: sendSms. Give role or sector.', PK + ['SubAdminToken'], {'name': 'Esi Owusu', 'org': 'Ridge Clinic', 'role': 'hospital_admin', 'handle': 'esi@ridge.example', 'sendSms': False}, ok='201', tag=A))
    add(p, '/api/platform/partners/{id}', 'patch', op('Edit an account', None, PK + ['SubAdminToken'], {'sector': 'health', 'status': 'active'}, params=[('id', 'path', 'Account id')], tag=A))
    for path, s in [('approve', 'Approve a sign-up (optionally with a different role or sector)'), ('reject', 'Reject a sign-up'), ('reset-password', 'Issue a new temporary password'), ('universal', 'Grant or remove the universal account')]:
        add(p, f'/api/platform/partners/{{id}}/{path}', 'post', op(s, None, PK + ['SubAdminToken'], {}, params=[('id', 'path', 'Account id')], tag=A))
    return p


# ---------------------------------------------------------------------------------------------- 09 accounts, admins, currencies
def accounts():
    p = {}; PK = ['PlatformKey']; PS = ['PlatformKey', 'SubAdminToken']
    D = 'Account directory'
    add(p, '/api/platform/accounts', 'get', op('Every account of every kind', 'kind = patient | partner | facility | insurer | emr_provider | staff | subadmin. Each row has status, last activity and clearances. Sub-admins need the accounts area.', PS, params=[('kind', 'query', 'Filter by kind'), ('q', 'query', 'Search')], tag=D))
    add(p, '/api/platform/accounts/{kind}/{id}', 'patch', op('Deactivate, reactivate or change clearances', 'grants: productLab (use Product Lab) and goLive (switch sandbox to live) apply to facility, insurer, emr_provider and staff accounts. Sub-admins cannot change grants, staff or sub-admin accounts.', PS, {'disabled': True, 'grants': {'productLab': True, 'goLive': False}}, params=[('kind', 'path', 'Account kind'), ('id', 'path', 'Account id')], tag=D, errors=[('403', 'Not allowed for this account kind')]))
    S = 'Sub-admins'
    add(p, '/api/platform/admins', 'get', op('Sub-admins, presets, areas and the demo switch', 'Chief only.', PK, tag=S))
    add(p, '/api/platform/admins', 'post', op('Invite a sub-admin', 'Email and/or phone. Preset: partner_manager, support, messaging_manager, finance_officer, evaluator, or custom with areas: clients, payers, messaging, product_lab, claims, finance, operating_mode, partners, accounts.', PK, {'name': 'Efua Asare', 'email': 'efua@hnn.example', 'preset': 'support', 'readOnly': False}, ok='201', tag=S))
    add(p, '/api/platform/admins/{id}', 'patch', op('Change areas, preset, read-only or status', None, PK, {'areas': ['clients', 'accounts'], 'readOnly': True, 'status': 'suspended'}, params=[('id', 'path', 'Sub-admin id')], tag=S))
    add(p, '/api/platform/admins/{id}', 'delete', op('Remove a sub-admin', 'Their sessions end at once.', PK, params=[('id', 'path', 'Sub-admin id')], tag=S))
    add(p, '/api/platform/admins/{id}/invite', 'post', op('Send a new invite link', 'The old link stops working.', PK, {'sendSms': True}, params=[('id', 'path', 'Sub-admin id')], tag=S))
    add(p, '/api/platform/admins/demo', 'get', op('Is the public demo login on?', None, PK, tag=S))
    add(p, '/api/platform/admins/demo', 'put', op('Switch the public demo login on or off', None, PK, {'enabled': True}, tag=S))
    add(p, '/admin-api/demo', 'get', op('The dummy credentials for the sign-in page', 'Public. Returns { enabled: false } when the demo is off.', None, tag=S))
    add(p, '/admin-api/login', 'post', op('Sub-admin sign-in', 'Returns a signed Bearer token. A demo or evaluator sign-in gets its own visitor id, which picks a private scratch copy of the seeded data (kept 2 hours after last use, max 150). Changes there are visible to that visitor only and never reach real data; messages, money and AI calls are simulated; secrets and contact details are masked.', None, {'handle': 'efua@hnn.example', 'password': '...'}, tag=S, errors=[('401', 'Incorrect login or password'), ('429', 'Too many tries')]))
    add(p, '/admin-api/accept-invite', 'post', op('Set a password from an invite', None, None, {'token': '<invite token>', 'password': 'at-least-10-chars'}, tag=S))
    add(p, '/admin-api/me', 'get', op('The signed-in sub-admin and their areas', None, ['SubAdminToken'], tag=S))
    add(p, '/admin-api/password', 'post', op('Change own password', None, ['SubAdminToken'], {'current': '...', 'password': '...'}, tag=S))
    C = 'Currencies'
    add(p, '/currency/api/list', 'get', op('Currencies and rates', 'Public, CORS open. main = GHS and USD; other = about 100, Nigeria and East Africa first (NGN, KES, UGX, TZS, RWF, ETB, BIF, SSP, SOS, DJF, ERN) then by region. Display only: everything is billed, lent and repaid in GHS.', None, tag=C))
    add(p, '/currency/api/convert', 'get', op('Convert an amount', 'Through the USD pivot, rounded to the target currency’s decimals.', None, params=[('amount', 'query', 'Number'), ('from', 'query', 'Currency code'), ('to', 'query', 'Currency code')], tag=C))
    add(p, '/api/platform/currencies', 'get', op('Rates, default and note (Master Control)', None, PS, tag=C))
    add(p, '/api/platform/currencies', 'put', op('Save rates', 'Rates are units per 1 USD. Until saved, the seed rates are shown as indicative.', PS, {'rates': {'GHS': 11.0, 'KES': 129.0, 'NGN': 1500.0}, 'defaultCurrency': 'GHS', 'note': 'Source and date'}, tag=C))
    add(p, '/patient-api/v1/patient/update', 'patch', op('Set the person’s default display currency', 'Body field currency (any code from /currency/api/list). The ER HEAT app asks GHS or USD at first sign-in.', ['BorrowerToken'], {'currency': 'KES'}, tag=C))
    return p


MODULES = [
    ('hnn-08-erheat-shield', 'HNN Biller — ERHEAT Shield API', '1.0.0', erheat,
     'Emergency micro-loans on six lines (rent, health, education, energy, agriculture, transport). **The Biller never lends or holds funds**: it verifies the need through the person who knows it, takes the borrower’s consent and hands a Verified-Need Packet to the lender, who decides and pays the payee. Covers the borrower API (used by the ER HEAT app), health sync with Biller bills, the optional profile, history, verifier and voucher pages, lender hooks, Master Control and partner accounts. Everything is in GHS.\n\nThe lender contract (decision, paid and repayment hooks, signed push with `x-erheat-signature: sha256=<HMAC-SHA256 of the raw body>`) is HNN’s own proposal and is not confirmed with any lender.'),
    ('hnn-09-accounts-admins-currency', 'HNN Biller — Accounts, Sub-admins and Currencies API', '1.0.0', accounts,
     'The account directory with deactivation and clearances, sub-admins (areas, presets, invites, own passwords), the public demo and evaluator accounts (private scratch copy per visitor), and the currency list and converter (display only; everything is billed in GHS).'),
]


def doc(title, version, desc, paths):
    return {'openapi': '3.0.3', 'info': {'title': title, 'version': version, 'description': desc + f'\n\n_{EDITION}._'}, 'servers': [{'url': 'https://nextgenhnnbiller-production-bdf1.up.railway.app'}, {'url': 'http://localhost:4000'}], 'paths': paths, 'components': {'securitySchemes': copy.deepcopy(SEC)}}


def dump(path, d):
    with open(path, 'w') as f: yaml.safe_dump(d, f, sort_keys=False, allow_unicode=True, width=120)


def main():
    new_paths = {}
    for name, title, ver, fn, desc in MODULES:
        paths = fn(); new_paths.update(paths)
        d = doc(title, ver, desc, paths)
        dump(os.path.join(API, name + '.yaml'), d)
        with open(os.path.join(API, name + '.json'), 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False)
        print(name, len(paths), 'paths')
    # complete spec
    cp = os.path.join(API, 'hnn-00-complete')
    c = yaml.safe_load(open(cp + '.yaml'))
    c['paths'].update(copy.deepcopy(new_paths)); c['components']['securitySchemes'].update(copy.deepcopy(SEC)); c['info']['version'] = '1.5.0'
    if EDITION not in c['info']['description']: c['info']['description'] += f'\n\n_{EDITION}: adds ERHEAT Shield, partner accounts, the account directory, sub-admins and currencies._'
    dump(cp + '.yaml', c); json.dump(c, open(cp + '.json', 'w'), indent=2, ensure_ascii=False)
    # root spec
    rp = os.path.join(ROOT, 'openapi.yaml'); r = yaml.safe_load(open(rp))
    r['paths'].update(copy.deepcopy(new_paths)); r['components']['securitySchemes'].update(copy.deepcopy(SEC)); r['info']['version'] = '0.9.0'
    dump(rp, r)
    print('complete:', len(c['paths']), 'paths; openapi.yaml:', len(r['paths']), 'paths')


if __name__ == '__main__':
    main()
