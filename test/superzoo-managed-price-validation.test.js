'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const {
  DEFAULT_REQUIRED_CATEGORIES,
  buildSuperZooManagedPriceCandidate,
  validateEntryShape,
} = require('../lib/superzoo-managed-price-validation');
const { buildAutomationBaseline } = require('../lib/superzoo-automation-baseline');

const CATALOG_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const PARTNER = 'SuperZoo';
const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'superzoo-managed-price.yml');

function affiliate(url) {
  return `https://www.dpbolvw.net/click-101752886-12607708?url=${encodeURIComponent(`${url}/`)}`;
}

function makeFixture(count = 2) {
  const entries = [];
  const catalog = [];
  const products = [];
  for (let index = 0; index < count; index += 1) {
    const productId = `managed-${index}`;
    const sourceIdentity = `https://www.superzoo.cz/managed-${index}`;
    entries.push({
      sourceRowIdentity: `source-row-${index}`,
      sourceIdentity,
      productId,
      offerIdentity: { kind: 'product-partner', partner: PARTNER },
      identityPackingFingerprint: `sha256:${String(index % 100).padStart(2, '0')}${'c'.repeat(62)}`,
      approvalBasis: {
        classification: 'matched_no_change',
        matchingStrategy: 'targetUrl',
        confidence: 'high',
        exactTargetUrl: true,
        reverseMatch: true,
        identityFieldsEqual: true,
        packingFieldsEqual: true,
        uniqueSourceIdentity: true,
        uniqueTargetOffer: true,
        guardsPassed: true,
      },
    });
    catalog.push({
      id: productId,
      name: `Managed ${index}`,
      size: '1kg',
      sizeKg: 1,
      offers: [{ partner: PARTNER, affiliateUrl: affiliate(sourceIdentity), price: 100, salePrice: null, originalPrice: null }],
    });
    products.push({
      canonicalUrl: sourceIdentity,
      url: `${sourceIdentity}/`,
      name: `Managed ${index}`,
      size: '1kg',
      sizeKg: 1,
      price: 100,
      salePrice: null,
      originalPrice: null,
      category: DEFAULT_REQUIRED_CATEGORIES[index % DEFAULT_REQUIRED_CATEGORIES.length],
      animalType: 'dog',
    });
  }
  const categoryKeys = ['dog-granules', 'dog-veterinary-diets', 'cat-granules', 'cat-veterinary-diets', 'rodent-complete-feed', 'rodent-food-treats'];
  const pages = DEFAULT_REQUIRED_CATEGORIES.map((category, index) => ({
    category,
    pageIndex: 0,
    pageFingerprint: `dom-${index}`,
    productSetHash: `set-${index}`,
    duplicatePage: false,
    terminationReason: 'no_next_control',
  }));
  const sidecar = {
    schemaVersion: 2,
    reviewOnly: true,
    configuredCategories: categoryKeys,
    selectedCategories: categoryKeys,
    pages,
    rejectedCards: [],
    filteredCards: [],
    summary: {
      duplicatePageCount: 0,
      categoryTerminationReasons: Object.fromEntries(DEFAULT_REQUIRED_CATEGORIES.map(category => [category, 'no_next_control'])),
    },
  };
  const raw = {
    schemaVersion: 2,
    source: 'superzoo.cz',
    reviewOnly: true,
    scrapedAt: '2026-08-18T07:00:00.000Z',
    requiredCategories: DEFAULT_REQUIRED_CATEGORIES,
    totalProducts: products.length,
    products,
    runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards: 0, categoryStats: {} },
  };
  const managedSetManifest = {
    schemaVersion: 1,
    manifestVersion: '2026-08-18T06:00:00.000Z',
    createdAt: '2026-08-18T06:00:00.000Z',
    partner: PARTNER,
    source: 'superzoo-scraper',
    selectionPolicyVersion: 'superzoo-price-only-existing-offers-v1',
    evidence: { inputs: [{ role: 'embeddedApplicationCatalog', sha256: CATALOG_SHA }], sourceCounts: {} },
    entries,
  };
  managedSetManifest.entries.sort((left, right) => left.sourceRowIdentity.localeCompare(right.sourceRowIdentity) || left.productId.localeCompare(right.productId));
  return { raw, sidecar, managedSetManifest, catalog, catalogSha256: CATALOG_SHA, managedSetSha256: MANIFEST_SHA, generatedAt: '2026-08-18T07:00:00.000Z' };
}

function runCase(change = () => {}) {
  const fixture = makeFixture();
  change(fixture);
  return buildSuperZooManagedPriceCandidate(fixture);
}

function hasBlocker(result, code) {
  return result.report.blockers.some(blocker => blocker.code === code);
}

test('valid managed coverage passes and derives count from manifest', () => {
  const result = runCase();
  assert.equal(result.report.passed, true);
  assert.equal(result.report.managedCoverage.observed, 2);
  assert.equal(result.report.managedCoverage.required, 2);
});

test('production-sized manifest coverage is evaluated as 534/534 without a hardcoded validator count', () => {
  const result = buildSuperZooManagedPriceCandidate(makeFixture(534));
  assert.equal(result.report.passed, true);
  assert.deepEqual(result.report.managedCoverage, { observed: 534, required: 534, ratio: 1 });
});

test('new non-managed product and non-managed rejection do not block', () => {
  const result = runCase(fixture => {
    fixture.raw.products.push({ canonicalUrl: 'https://www.superzoo.cz/new-product', price: 100, salePrice: null, originalPrice: null });
    fixture.raw.totalProducts = fixture.raw.products.length;
    fixture.sidecar.rejectedCards.push({ canonicalUrl: 'https://www.superzoo.cz/new-no-image' });
  });
  assert.equal(result.report.passed, true);
  assert.equal(result.report.nonManagedProducts, 1);
});

test('missing managed row fails closed', () => {
  const result = runCase(fixture => fixture.raw.products.pop());
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'managed_coverage_missing'));
});

test('rejected managed row fails closed', () => {
  const result = runCase(fixture => fixture.sidecar.rejectedCards.push({ canonicalUrl: fixture.managedSetManifest.entries[0].sourceIdentity }));
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'managed_card_rejected'));
});

test('duplicate source, ambiguous mapping, duplicate identity, wrong partner and unknown product fail', () => {
  let result = runCase(fixture => fixture.raw.products.push({ ...fixture.raw.products[0], price: 101 }));
  assert.ok(hasBlocker(result, 'duplicate_source_identity'));
  result = runCase(fixture => fixture.catalog.push({ ...fixture.catalog[0], id: 'ambiguous' }));
  assert.ok(hasBlocker(result, 'ambiguous_managed_source_mapping'));
  result = runCase(fixture => fixture.managedSetManifest.entries.push({ ...fixture.managedSetManifest.entries[0] }));
  assert.ok(hasBlocker(result, 'duplicate_manifest_source_identity'));
  result = runCase(fixture => { fixture.managedSetManifest.entries[0].offerIdentity.partner = 'Other'; });
  assert.equal(result.report.passed, false);
  result = runCase(fixture => { fixture.managedSetManifest.entries[0].productId = 'unknown-product'; });
  assert.ok(hasBlocker(result, 'unknown_or_ambiguous_managed_product'));
});

test('catalog and managed manifest SHA mismatches fail closed', () => {
  let result = runCase(fixture => { fixture.expectedCatalogSha256 = 'd'.repeat(64); });
  assert.equal(result.report.passed, false);
  result = runCase(fixture => { fixture.expectedManagedSetSha256 = 'e'.repeat(64); });
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'managed_set_sha_mismatch'));
});

for (const [name, mutate, blocker] of [
  ['malformed price', fixture => { fixture.raw.products[0].price = '100'; }, 'raw_managed-0_malformed_price'],
  ['below minimum price', fixture => { fixture.raw.products[0].price = 9; }, 'price_outside_guard_range'],
  ['above maximum price', fixture => { fixture.raw.products[0].price = 50001; }, 'price_outside_guard_range'],
  ['incomplete sale pair', fixture => { delete fixture.raw.products[0].originalPrice; fixture.raw.products[0].salePrice = 80; }, 'raw_managed-0_incomplete_sale_pair'],
  ['relative anomaly', fixture => { fixture.raw.products[0].price = 250; }, 'relative_price_change_exceeded'],
  ['multiplicative anomaly', fixture => { fixture.raw.products[0].price = 1000; }, 'suspicious_10x_or_100x_price_shift'],
]) {
  test(`${name} fails closed`, () => {
    const result = runCase(mutate);
    assert.equal(result.report.passed, false);
    assert.ok(hasBlocker(result, blocker));
  });
}

test('changed-managed ratio and sale-clear ratio thresholds fail closed', () => {
  let result = buildSuperZooManagedPriceCandidate((() => { const fixture = makeFixture(20); fixture.raw.products[0].price = 110; fixture.raw.products[1].price = 120; return fixture; })());
  assert.ok(hasBlocker(result, 'changed_managed_ratio_exceeded'));
  result = buildSuperZooManagedPriceCandidate((() => {
    const fixture = makeFixture(100);
    for (let i = 0; i < 3; i += 1) { fixture.catalog[i].offers[0].price = 80; fixture.catalog[i].offers[0].salePrice = 80; fixture.catalog[i].offers[0].originalPrice = 100; fixture.raw.products[i].price = 80; }
    return fixture;
  })());
  assert.ok(hasBlocker(result, 'sale_clear_ratio_exceeded'));
});

test('technical pagination/challenge/network status fails closed', () => {
  const result = runCase(fixture => { fixture.runtimeStatus = { passed: false }; });
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'technical_scraper_failure'));
});

test('blocked validation never exposes partial candidate entries', () => {
  const result = runCase(fixture => { fixture.raw.products.pop(); });
  assert.equal(result.report.passed, false);
  assert.deepEqual(result.candidate.entries, []);
  assert.equal(result.candidate.generatorReady, false);
});

test('unchanged managed prices produce a PASS no-op', () => {
  const result = runCase();
  assert.equal(result.candidate.noOp, true);
  assert.deepEqual(result.candidate.entries, []);
});

test('automation baseline adapts only exact-safe approved entries into managed coverage', () => {
  const fixture = makeFixture(2);
  fixture.sidecar.source = 'superzoo.cz';
  fixture.sidecar.scrapedAt = fixture.raw.scrapedAt;
  fixture.sidecar.categories = DEFAULT_REQUIRED_CATEGORIES;
  const baseline = buildAutomationBaseline({
    catalog: fixture.catalog,
    publicCatalog: structuredClone(fixture.catalog),
    raw: fixture.raw,
    sidecar: fixture.sidecar,
    catalogSha256: fixture.catalogSha256,
    publicCatalogSha256: fixture.catalogSha256,
    rawSha256: 'c'.repeat(64),
    sidecarSha256: 'd'.repeat(64),
  }).baseline;
  baseline.approved[1].dailyEligibility = 'unresolved';
  baseline.approved[1].unresolvedReason = 'missing_from_baseline_scrape';
  baseline.approved[1].identityFingerprint = require('../lib/superzoo-automation-baseline').identityFingerprint(baseline.approved[1]);
  baseline.counts.exactSafeApproved = 1;
  baseline.counts.unresolvedApproved = 1;
  const result = buildSuperZooManagedPriceCandidate({
    ...fixture,
    managedSetManifest: null,
    managedSetSha256: null,
    automationBaseline: baseline,
    automationBaselineSha256: 'e'.repeat(64),
  });
  assert.equal(result.report.passed, true);
  assert.equal(result.report.approvedTotal, 2);
  assert.equal(result.report.unresolvedApproved, 1);
  assert.deepEqual(result.report.managedCoverage, { observed: 1, required: 1, ratio: 1 });
});

test('candidate entries contain only identity and price fields', () => {
  const fixture = makeFixture(20);
  fixture.raw.products[0].price = 110;
  const result = buildSuperZooManagedPriceCandidate(fixture);
  assert.equal(result.report.passed, true);
  assert.equal(result.candidate.entries.every(validateEntryShape), true);
  assert.deepEqual(Object.keys(result.candidate.entries[0]).sort(), ['offerIdentity', 'partner', 'price', 'productId', 'source']);
  assert.equal(/gcloud|current\.json|firebase|firestore|child_process/i.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'superzoo-managed-price-validation.js'), 'utf8')), false);
});

test('workflow is dispatch-only and has no production side effects', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /--automation-baseline="config\/superzoo-automation-baseline\.json"/u);
  assert.doesNotMatch(workflow, /--managed-set=/u);
  assert.doesNotMatch(workflow, /schedule:/u);
  assert.doesNotMatch(workflow, /gcloud|current\.json|PRICE_OVERLAY_SOURCE_URL|firebase|firestore|FCM|publisher|publish/iu);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /contents: read/u);
});
