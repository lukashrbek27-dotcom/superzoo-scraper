'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAutomationBaseline,
  buildWeeklyDiff,
  canonicalJson,
  validateAutomationBaseline,
} = require('../lib/superzoo-automation-baseline');

const HASHES = {
  catalogSha256: 'a'.repeat(64),
  publicCatalogSha256: 'a'.repeat(64),
  rawSha256: 'b'.repeat(64),
  sidecarSha256: 'c'.repeat(64),
};

const affiliate = slug => `https://www.dpbolvw.net/click-101752886-12607708?url=${encodeURIComponent(`https://www.superzoo.cz/${slug}/`)}`;
const product = (id, slug, sizeKg = 1, overrides = {}) => ({
  id,
  brand: 'Brand',
  name: id,
  size: `${sizeKg}kg`,
  sizeKg,
  type: 'extruded',
  species: 'Pes',
  offers: [{ partner: 'SuperZoo', price: 100, salePrice: null, originalPrice: null, affiliateUrl: affiliate(slug) }],
  ...overrides,
});
const rawProduct = (slug, sizeKg = 1, overrides = {}) => ({
  sourceIdentity: `https://www.superzoo.cz/${slug}`,
  canonicalIdentity: `https://www.superzoo.cz/${slug}|${sizeKg}kg`,
  canonicalUrl: `https://www.superzoo.cz/${slug}`,
  name: slug,
  size: `${sizeKg}kg`,
  sizeKg,
  price: 100,
  salePrice: null,
  originalPrice: null,
  ...overrides,
});
const sidecar = (overrides = {}) => ({
  schemaVersion: 2,
  source: 'superzoo.cz',
  reviewOnly: true,
  scrapedAt: '2026-08-18T08:50:25.367Z',
  configuredCategories: ['Granule pro psy'],
  selectedCategories: ['Granule pro psy'],
  rejectedCards: [],
  filteredCards: [],
  summary: { duplicatePageCount: 0, categoryTerminationReasons: { 'Granule pro psy': 'no_next_control' } },
  ...overrides,
});
const raw = (products, overrides = {}) => ({
  schemaVersion: 2,
  source: 'superzoo.cz',
  reviewOnly: true,
  scrapedAt: '2026-08-18T08:50:25.367Z',
  products,
  ...overrides,
});

function build({ catalog = [product('p1', 'one')], rawProducts = [rawProduct('one')], sidecarValue = sidecar(), hashes = HASHES } = {}) {
  return buildAutomationBaseline({
    catalog,
    publicCatalog: structuredClone(catalog),
    raw: raw(rawProducts),
    sidecar: sidecarValue,
    ...hashes,
  });
}

test('current catalog SuperZoo offers become approved and count is derived dynamically', () => {
  const catalog = [product('p1', 'one'), product('p2', 'two', 2), product('other', 'ignored', 1, { offers: [{ partner: 'Other', price: 1, affiliateUrl: 'https://example.test' }] })];
  const result = build({ catalog, rawProducts: [rawProduct('one'), rawProduct('two', 2)] });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.baseline.counts.approved, 2);
  assert.equal(result.baseline.counts.exactSafeApproved, 2);
  assert.deepEqual(result.baseline.approved.map(entry => entry.productId), ['p1', 'p2']);
});

test('exact scraped non-catalog product becomes baseline_ignored', () => {
  const { baseline } = build({ rawProducts: [rawProduct('one'), rawProduct('new-product', 2)] });
  assert.equal(baseline.counts.baselineIgnored, 1);
  assert.equal(baseline.baselineIgnored[0].state, 'baseline_ignored');
});

test('approved product cannot also be baseline_ignored', () => {
  const { baseline } = build();
  assert.equal(baseline.baselineIgnored.some(entry => entry.identityKey === baseline.approved[0].identityKey), false);
});

test('conflicting duplicate raw source identity fails', () => {
  const result = build({ rawProducts: [rawProduct('one'), rawProduct('one', 1, { price: 101 })] });
  assert(result.blockers.some(item => item.code === 'duplicate_source_identity'));
  assert.equal(result.baseline.generatorReady, false);
});

test('ambiguous catalog mapping fails', () => {
  const result = build({ catalog: [product('p1', 'one'), product('p2', 'one')] });
  assert(result.blockers.some(item => item.code === 'ambiguous_mapping'));
});

test('wrong partner baseline mutation fails validation', () => {
  const { baseline } = build();
  baseline.partner = 'Wrong';
  assert(validateAutomationBaseline(baseline, HASHES).includes('wrong_partner'));
});

test('invalid catalog affiliate URL fails', () => {
  const broken = product('p1', 'one');
  broken.offers[0].affiliateUrl = 'https://example.test/not-superzoo';
  const result = build({ catalog: [broken] });
  assert(result.blockers.some(item => item.code === 'invalid_catalog_source_identity'));
});

test('packing mismatch remains explicit unresolved approved', () => {
  const { baseline } = build({ rawProducts: [rawProduct('one', 2)] });
  assert.equal(baseline.counts.approved, 1);
  assert.equal(baseline.counts.exactSafeApproved, 0);
  assert.equal(baseline.approved[0].unresolvedReason, 'packing_mismatch_in_baseline_scrape');
});

test('rejected or unparseable card never becomes baseline_ignored', () => {
  const rejected = { reason: 'missing_image', category: 'Granule pro psy', pageIndex: 0, canonicalUrl: 'https://www.superzoo.cz/rejected', name: 'Rejected' };
  const { baseline } = build({ sidecarValue: sidecar({ rejectedCards: [rejected] }) });
  assert.equal(baseline.baselineIgnored.some(entry => entry.sourceIdentity.endsWith('/rejected')), false);
  assert.equal(baseline.unresolvedEvidence.length, 1);
});

test('weekly NEW ignores baseline_ignored and rejected decisions', () => {
  const { baseline } = build({ rawProducts: [rawProduct('one'), rawProduct('old-ignored')] });
  const rejected = { ...baseline.baselineIgnored[0], state: 'rejected' };
  rejected.sourceIdentity = 'https://www.superzoo.cz/rejected';
  rejected.identityKey = 'https://www.superzoo.cz/rejected|kg:1';
  rejected.identityFingerprint = require('../lib/superzoo-automation-baseline').identityFingerprint(rejected);
  baseline.rejected.push(rejected);
  const diff = buildWeeklyDiff({ baseline, raw: raw([rawProduct('one'), rawProduct('old-ignored'), rawProduct('rejected')]) });
  assert.equal(diff.new.length, 0);
});

test('truly new post-baseline identity is NEW', () => {
  const { baseline } = build();
  const diff = buildWeeklyDiff({ baseline, raw: raw([rawProduct('one'), rawProduct('future-new')]) });
  assert.deepEqual(diff.new.map(entry => entry.sourceIdentity), ['https://www.superzoo.cz/future-new']);
});

test('approved missing from future scrape is MISSING', () => {
  const { baseline } = build();
  const diff = buildWeeklyDiff({ baseline, raw: raw([]) });
  assert.deepEqual(diff.missing.map(entry => entry.productId), ['p1']);
});

test('packing change is reported as IDENTITY_CHANGE', () => {
  const { baseline } = build();
  const diff = buildWeeklyDiff({ baseline, raw: raw([rawProduct('one', 2)]) });
  assert.equal(diff.identityChanges.length, 1);
});

test('automation contract cannot auto-add or auto-delete', () => {
  const { baseline } = build();
  const diff = buildWeeklyDiff({ baseline, raw: raw([rawProduct('one'), rawProduct('new')]) });
  assert.deepEqual(baseline.automation, { autoAdd: false, autoDelete: false, priceFieldsOnly: ['price', 'salePrice', 'originalPrice'] });
  assert.deepEqual(diff.remoteActions, { autoAdd: false, autoDelete: false, publish: false });
});

test('regeneration is deterministic', () => {
  const left = canonicalJson(build().baseline);
  const right = canonicalJson(build().baseline);
  assert.equal(left, right);
});

test('SHA evidence mismatch fails validation', () => {
  const { baseline } = build();
  assert(validateAutomationBaseline(baseline, { ...HASHES, rawSha256: 'd'.repeat(64) }).includes('evidence_sha_mismatch'));
});
