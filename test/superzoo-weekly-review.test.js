'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyExplicitDecision,
  buildWeeklyReport,
  renderWeeklyMarkdown,
} = require('../lib/superzoo-weekly-review');
const { identityFingerprint } = require('../lib/superzoo-automation-baseline');
const { buildErrorNotification, buildReviewNotification, sendResend } = require('../lib/superzoo-automation-alerts');

const entry = (state, key = 'https://www.superzoo.cz/a|kg:1', productId = 'p1') => ({
  state, partner: 'SuperZoo', productId: state === 'approved' ? productId : null, sourceIdentity: key.split('|')[0], identityKey: key,
  packing: { size: '1 kg', sizeKg: 1, key: 'kg:1' }, identityFingerprint: null, dailyEligibility: state === 'approved' ? 'exact_safe' : undefined,
});
const baseline = (overrides = {}) => {
  const value = {
  schemaVersion: 1, contract: 'superzoo-automation-baseline-v1', partner: 'SuperZoo', source: 'superzoo-scraper', identityContract: 'canonical-source-url-plus-packing',
  evidence: { authoritativeCatalog: { sha256: 'a'.repeat(64) }, baselineRaw: { sha256: 'b'.repeat(64) }, baselineReviewSidecar: { sha256: 'c'.repeat(64) }, publicCatalogParity: { sha256: 'a'.repeat(64), byteIdentical: true } },
  generatorReady: true, blockers: [], counts: { approved: 1, exactSafeApproved: 1, unresolvedApproved: 0, baselineIgnored: 1, rejected: 1, pendingReview: 0, unresolvedEvidence: 0 },
  approved: [entry('approved')], baselineIgnored: [entry('baseline_ignored', 'https://www.superzoo.cz/ignored|kg:1')], rejected: [entry('rejected', 'https://www.superzoo.cz/rejected|kg:1')], pendingReview: [],
    automation: { autoAdd: false, autoDelete: false, priceFieldsOnly: ['price', 'salePrice', 'originalPrice'] }, ...overrides,
  };
  for (const list of ['approved', 'baselineIgnored', 'rejected', 'pendingReview']) {
    for (const item of value[list]) item.identityFingerprint = identityFingerprint(item);
  }
  return value;
};
const raw = products => ({ schemaVersion: 2, source: 'superzoo.cz', reviewOnly: true, products });
const product = (url, size = '1kg', price = 100) => ({ canonicalUrl: url, sourceIdentity: url, canonicalIdentity: `${url}|${size}`, size, sizeKg: Number.parseFloat(size), name: url.split('/').pop(), price, salePrice: null, originalPrice: null });

test('baseline_ignored, rejected and approved identities are not NEW', () => {
  const report = buildWeeklyReport({ baseline: baseline(), raw: raw([product('https://www.superzoo.cz/a'), product('https://www.superzoo.cz/ignored'), product('https://www.superzoo.cz/rejected'), product('https://www.superzoo.cz/new')]), baselineSha256: 'd'.repeat(64) });
  assert.equal(report.counts.new, 1);
  assert.equal(report.new[0].sourceIdentity, 'https://www.superzoo.cz/new');
});

test('approved missing is MISSING and no auto delete exists', () => {
  const report = buildWeeklyReport({ baseline: baseline(), raw: raw([]), baselineSha256: 'd'.repeat(64) });
  assert.equal(report.counts.missing, 1);
  assert.equal(report.remoteActions.autoDelete, false);
});

test('unresolved approved identity is diagnostic only and is never remapped', () => {
  const unresolved = { ...entry('approved', 'https://www.superzoo.cz/unresolved|kg:2', 'p2'), dailyEligibility: 'unresolved', unresolvedReason: 'missing_from_baseline_scrape' };
  const value = baseline({ approved: [entry('approved'), unresolved], counts: { approved: 2, exactSafeApproved: 1, unresolvedApproved: 1, baselineIgnored: 1, rejected: 1, pendingReview: 0, unresolvedEvidence: 0 } });
  for (const item of value.approved) item.identityFingerprint = identityFingerprint(item);
  const report = buildWeeklyReport({ baseline: value, raw: raw([product('https://www.superzoo.cz/unresolved', '2kg')]), baselineSha256: 'd'.repeat(64) });
  assert.equal(report.new.length, 0);
  assert.equal(report.remoteActions.autoAdd, false);
});

test('baseline unresolved missing and packing mismatch are known, not new review changes', () => {
  const unresolvedMissing = { ...entry('approved', 'https://www.superzoo.cz/missing|kg:2', 'p2'), dailyEligibility: 'unresolved', unresolvedReason: 'missing_from_baseline_scrape' };
  const unresolvedPacking = { ...entry('approved', 'https://www.superzoo.cz/packing|kg:3', 'p3'), dailyEligibility: 'unresolved', unresolvedReason: 'packing_mismatch_in_baseline_scrape' };
  const value = baseline({
    approved: [entry('approved'), unresolvedMissing, unresolvedPacking],
    counts: { approved: 3, exactSafeApproved: 1, unresolvedApproved: 2, baselineIgnored: 1, rejected: 1, pendingReview: 0, unresolvedEvidence: 0 },
  });
  const report = buildWeeklyReport({ baseline: value, raw: raw([product('https://www.superzoo.cz/a'), product('https://www.superzoo.cz/packing', '4kg')]), baselineSha256: 'd'.repeat(64) });
  assert.equal(report.counts.missing, 0);
  assert.equal(report.counts.identityChange, 0);
  assert.equal(report.newMissing.length, 0);
  assert.equal(report.newIdentityChange.length, 0);
  assert.equal(report.counts.knownBaselineUnresolved, 2);
  assert.equal(buildReviewNotification(report).shouldNotify, false);
});

test('packing change is IDENTITY_CHANGE, not automatic remap', () => {
  const report = buildWeeklyReport({ baseline: baseline(), raw: raw([product('https://www.superzoo.cz/a', '2kg')]), baselineSha256: 'd'.repeat(64) });
  assert.equal(report.counts.identityChange, 1);
  assert.match(report.identityChanges[0].reason, /automatic remap/);
});

test('no changes produces no notification request', () => {
  const report = buildWeeklyReport({ baseline: baseline(), raw: raw([product('https://www.superzoo.cz/a'), product('https://www.superzoo.cz/ignored'), product('https://www.superzoo.cz/rejected')]), baselineSha256: 'd'.repeat(64) });
  assert.equal(buildReviewNotification(report).shouldNotify, false);
});

test('NEW/MISSING/IDENTITY_CHANGE request review notification', () => {
  const report = { counts: { new: 1, missing: 1, identityChange: 1 }, new: [{ name: 'New', packingLabel: '1 kg', sourceIdentity: 'https://www.superzoo.cz/new' }] };
  const notification = buildReviewNotification(report, { runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.equal(notification.shouldNotify, true);
  assert.match(notification.text, /actions\/runs\/1/);
});

test('error notification is redacted and preserves last valid prices', () => {
  const notification = buildErrorNotification({ verdict: 'BLOCKED', blockers: [{ code: 'x', count: 1 }], reason: 'token=secret-value', runUrl: 'https://github.com/o/r/actions/runs/2' });
  assert.match(notification.text, /Poslední validní produkční ceny/);
  assert.doesNotMatch(notification.text, /secret-value/);
  assert.doesNotMatch(notification.text, /raw dump/i);
});

test('explicit decisions are manual-only and do not auto-add/delete', () => {
  const updated = applyExplicitDecision({ baseline: baseline(), identityKey: 'https://www.superzoo.cz/new|kg:1', decision: 'rejected', name: 'New' });
  assert.equal(updated.rejected.length, 2);
  assert.equal(updated.approved.length, 1);
  assert.equal(updated.automation.autoAdd, false);
  assert.equal(updated.automation.autoDelete, false);
});

test('manual approval requires explicit product identity and remains unresolved', () => {
  assert.throws(() => applyExplicitDecision({ baseline: baseline(), identityKey: 'https://www.superzoo.cz/new|kg:1', decision: 'approved' }), /productId/);
  const updated = applyExplicitDecision({ baseline: baseline(), identityKey: 'https://www.superzoo.cz/new|kg:1', decision: 'approved', productId: 'new-id' });
  assert.equal(updated.approved.at(-1).dailyEligibility, 'unresolved');
  assert.match(updated.approved.at(-1).identityFingerprint, /^sha256:/u);
});

test('email transport supports dry-run and never requires a real request', async () => {
  const result = await sendResend({ notification: { shouldNotify: true, subject: 'x', text: 'safe' }, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.deepEqual(result, { sent: false, skipped: true, reason: 'missing_resend_configuration' });
});

test('email transport mock success sends only bounded notification fields', async () => {
  let request;
  const result = await sendResend({
    notification: { shouldNotify: true, subject: 'review', text: 'safe summary' },
    apiKey: 'test-secret', from: 'bot@example.test', to: 'ops@example.test',
    fetchImpl: async (_url, options) => { request = options; return { ok: true, status: 200 }; },
  });
  assert.deepEqual(result, { sent: true, skipped: false });
  assert.match(request.headers.Authorization, /^Bearer test-secret$/u);
  assert.equal(JSON.parse(request.body).to, 'ops@example.test');
  assert.equal(JSON.parse(request.body).text, 'safe summary');
  assert.doesNotMatch(request.body, /test-secret/u);
});

test('email transport mock failure is safe and does not expose the API key', async () => {
  await assert.rejects(() => sendResend({
    notification: { shouldNotify: true, subject: 'review', text: 'safe summary' },
    apiKey: 'private-key', from: 'bot@example.test', to: 'ops@example.test',
    fetchImpl: async () => ({ ok: false, status: 500 }),
  }), error => !error.message.includes('private-key') && /HTTP 500/u.test(error.message));
});

test('weekly markdown contains all sections', () => {
  const report = { verdict: 'PASS', generatedAt: '2026-01-01T00:00:00.000Z', runUrl: null, counts: { new: 0, missing: 0, identityChange: 0, known: 1, unchanged: 1 }, new: [], missing: [], identityChanges: [], blockers: [] };
  const markdown = renderWeeklyMarkdown(report);
  assert.match(markdown, /## NEW/); assert.match(markdown, /## MISSING/); assert.match(markdown, /## IDENTITY_CHANGE/);
});
