'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('unique normalized title plus packing resolves a changed canonical URL without fuzzy matching', () => {
  const catalog = [product('p1', 'legacy-url', 6, { name: 'Krmivo Exact Recipe' })];
  const result = build({ catalog, rawProducts: [rawProduct('current-url', 6, { name: 'Krmivo Exact Recipe 6 kg' })] });
  const entry = result.baseline.approved[0];
  assert.equal(result.blockers.length, 0);
  assert.equal(entry.dailyEligibility, 'exact_safe');
  assert.equal(entry.matchMethod, 'normalized_title_packing_v1');
  assert.equal(entry.sourceIdentity, 'https://www.superzoo.cz/legacy-url');
  assert.equal(entry.rawSourceIdentity, 'https://www.superzoo.cz/current-url');
});

test('same-size similar title and ambiguous normalized title remain unresolved', () => {
  let result = build({
    catalog: [product('p1', 'legacy-url', 6, { name: 'Krmivo Exact Recipe' })],
    rawProducts: [rawProduct('current-url', 6, { name: 'Krmivo Exact Recipe Plus 6 kg' })],
  });
  assert.equal(result.baseline.approved[0].dailyEligibility, 'unresolved');
  result = build({
    catalog: [
      product('p1', 'legacy-one', 6, { name: 'Krmivo Exact Recipe' }),
      product('p2', 'legacy-two', 6, { name: 'Krmivo Exact Recipe' }),
    ],
    rawProducts: [rawProduct('current-url', 6, { name: 'Krmivo Exact Recipe 6 kg' })],
  });
  assert.equal(result.baseline.counts.exactSafeApproved, 0);
  assert.equal(result.baseline.approved.every(entry => entry.dailyEligibility === 'unresolved'), true);
});

test('exact source multipack alias resolves only unit-to-total evidence', () => {
  const catalog = [product('p1', 'same-product', 0.085, { name: 'Prescription sample 12x', size: '85g' })];
  const result = build({
    catalog,
    rawProducts: [rawProduct('same-product', 1.02, { name: 'Prescription sample 12x85g', size: '12x85g' })],
  });
  const entry = result.baseline.approved[0];
  assert.equal(entry.dailyEligibility, 'exact_safe');
  assert.equal(entry.matchMethod, 'canonical_url_multipack_alias_v1');
  assert.deepEqual(entry.rawPacking, { size: '12x85g', sizeKg: 1.02, key: 'kg:1.02' });
});

test('missing catalog packing remains unresolved', () => {
  const result = build({
    catalog: [product('p1', 'legacy-url', 1, { name: 'No packing', size: null, sizeKg: null })],
    rawProducts: [rawProduct('current-url', 1, { name: 'No packing 1 kg' })],
  });
  assert.equal(result.baseline.approved[0].dailyEligibility, 'unresolved');
  assert.equal(result.baseline.approved[0].unresolvedReason, 'missing_catalog_packing_identity');
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

test('tracked Phase 2A baseline resolves only the 16 audited deterministic mappings', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'superzoo-automation-baseline.json'), 'utf8'));
  const titleResolved = [
    'superzoo-acana-krmivo-adult-small-breed-recip-6000', 'superzoo-acana-krmivo-classics-red-meat-9-7-k-9700',
    'superzoo-acana-krmivo-grasslands-dog-2-kg-2000', 'superzoo-calibra-krmivo-dog-expert-nutrition-li-12000',
    'superzoo-calibra-krmivo-dog-expert-nutrition-mo-12000', 'superzoo-calibra-krmivo-dog-expert-nutrition-se-12000',
    'superzoo-calibra-krmivo-dog-life-adult-medium-b-12000', 'superzoo-calibra-krmivo-dog-life-senior-medium-12000',
    'superzoo-calibra-krmivo-dog-premium-line-adult-12000', 'superzoo-calibra-krmivo-dog-premium-line-puppy-12000',
    'superzoo-calibra-krmivo-dog-premium-line-senior-12000', 'superzoo-calibra-krmivo-dog-premium-line-sensit-12000',
    'superzoo-calibra-krmivo-premium-line-senior-lig-3000',
  ].sort();
  const multipackResolved = [
    'superzoo-hill-s-prescription-diet-c-d-multicare-stress-s-ku-etem-85',
    'superzoo-hill-s-prescription-diet-gastrointestinal-biome-s-ku-et-85',
    'superzoo-hill-s-prescription-diet-k-d-p-e-o-ledviny-12x85g-85',
  ].sort();
  const reviewRequired = [
    'fera24-acana-grasslands-dog-11-4kg', 'fera24-acana-sport-amp-agility-17kg', 'fera24-royal-canin-mini-sterilised-8-kg-granule-pro-kastrovane-male-psy-8kg',
    'superzoo-carnilove-true-fresh-adult-fish-11-4kg-11400', 'superzoo-eukanuba-adult-mono-protein-duck-2-3kg-2300', 'superzoo-eukanuba-adult-mono-protein-salmon-12kg-12000',
    'superzoo-eukanuba-daily-care-excess-weight-12kg-12000', 'superzoo-eukanuba-daily-care-puppy-sensitive-dig-12000', 'superzoo-eukanuba-krmivo-adult-large-jehn-s-r-18-18000',
    'superzoo-eukanuba-krmivo-adult-small-s-ku-ec-m-1-18000', 'superzoo-eukanuba-krmivo-puppy-large-s-ku-ec-m-1-18000', 'superzoo-hill-s-hill-s-precription-diet-feline-85',
    'superzoo-hill-s-konzerva-presription-diet-meta-370', 'superzoo-hill-s-precription-diet-r-d-weight-re-350', 'superzoo-hill-s-prescription-diet-canine-w-d-konzerva-370g-370',
    'superzoo-hill-s-prescription-diet-hill-s-prescription-diet-felin-85', 'superzoo-hill-s-prescription-diet-i-d-low-fat-konzerva-360g-360', 'superzoo-hill-s-prescription-diet-kapsi-ka-i-d-feline-chicken-12-85',
    'superzoo-hill-s-prescription-diet-kapsi-ka-i-d-feline-salmon-12x-85', 'superzoo-hill-s-prescription-diet-konzerva-canine-k-d-350g-350', 'superzoo-hill-s-prescription-diet-konzerva-gastrointestinal-biom-370',
    'superzoo-hill-s-prescription-diet-konzerva-hill-s-prescription-d-0', 'superzoo-hill-s-prescription-diet-konzerva-hill-s-prescription-d-360', 'superzoo-hill-s-prescription-diet-konzerva-hill-s-prescription-d-370',
    'superzoo-hill-s-prescription-diet-konzerva-l-d-liver-care-370g-370', 'superzoo-hill-s-prescription-diet-konzerva-metabolic-na-regulaci-370', 'superzoo-hill-s-prescription-diet-u-d-konzerva-370g-370',
    'superzoo-n-d-cat-ocean-adult-herring-orange-300', 'superzoo-n-d-gf-pumpkin-cat-duck-cantaloupe-300', 'superzoo-n-d-gf-pumpkin-cat-herring-orange-300',
    'superzoo-n-d-gf-quinoa-dog-skin-coat-veniso-2500', 'superzoo-nutrin-krmivo-complete-grain-free-se-1500', 'superzoo-nutrin-krmivo-complete-grain-free-se-400',
    'superzoo-nutrin-krmivo-complete-s-ovocem-pro-k-400', 'superzoo-nutrin-krmivo-complete-se-zeleninou-p-1500', 'superzoo-nutrin-krmivo-complete-se-zeleninou-p-400',
    'superzoo-ontario-adult-medium-fish-rice-0-75kg-750', 'superzoo-ontario-puppy-mini-lamb-rice-0-75kg-750', 'superzoo-ontario-puppy-mini-lamb-rice-2-25kg-2250',
    'superzoo-ontario-senior-mini-fish-rice-0-75-kg-750', 'superzoo-ontario-senior-mini-fish-rice-2-25kg-2250', 'superzoo-ostatn-kapsi-ky-hill-s-pd-feline-c-d-85',
    'superzoo-ostatn-kapsi-ky-hill-s-prescription-d-85', 'superzoo-prospera-plus-mini-junior-8kg-8000', 'superzoo-rasco-premium-adult-lamb-rice-100g-100',
    'superzoo-rasco-premium-adult-medium-100g-100', 'superzoo-rasco-premium-puppy-medium-100g-100', 'superzoo-rasco-premium-senior-mini-medium-100g-100',
  ].sort();
  const resolvedBy = method => baseline.approved.filter(entry => entry.matchMethod === method).map(entry => entry.productId).sort();
  assert.deepEqual(baseline.counts, { approved: 981, exactSafeApproved: 933, unresolvedApproved: 48, baselineIgnored: 321, rejected: 0, pendingReview: 0, unresolvedEvidence: 17 });
  assert.deepEqual(resolvedBy('normalized_title_packing_v1'), titleResolved);
  assert.deepEqual(resolvedBy('canonical_url_multipack_alias_v1'), multipackResolved);
  assert.deepEqual(baseline.approved.filter(entry => entry.dailyEligibility === 'unresolved').map(entry => entry.productId).sort(), reviewRequired);
});
