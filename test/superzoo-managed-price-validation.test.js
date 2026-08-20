'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
const BASELINE_SHA = 'b'.repeat(64);
const PARTNER = 'SuperZoo';
const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'superzoo-managed-price.yml');
const VALIDATOR = path.join(__dirname, '..', 'lib', 'superzoo-managed-price-validation.js');

function affiliate(url) {
  return `https://www.dpbolvw.net/click-101752886-12607708?url=${encodeURIComponent(`${url}/`)}`;
}

function makeFixture(count = 2) {
  const catalog = [];
  const products = [];
  for (let index = 0; index < count; index += 1) {
    const productId = `managed-${index}`;
    const sourceIdentity = `https://www.superzoo.cz/managed-${index}`;
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
    source: 'superzoo.cz',
    reviewOnly: true,
    scrapedAt: '2026-08-18T07:00:00.000Z',
    configuredCategories: categoryKeys,
    selectedCategories: categoryKeys,
    categories: DEFAULT_REQUIRED_CATEGORIES,
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
  const automationBaseline = buildAutomationBaseline({
    catalog,
    publicCatalog: structuredClone(catalog),
    raw,
    sidecar,
    catalogSha256: CATALOG_SHA,
    publicCatalogSha256: CATALOG_SHA,
    rawSha256: 'c'.repeat(64),
    sidecarSha256: 'd'.repeat(64),
  }).baseline;
  return { raw, sidecar, automationBaseline, catalog, catalogSha256: CATALOG_SHA, automationBaselineSha256: BASELINE_SHA, generatedAt: '2026-08-18T07:00:00.000Z' };
}

function runCase(change = () => {}) {
  const fixture = makeFixture();
  change(fixture);
  return buildSuperZooManagedPriceCandidate(fixture);
}

function hasBlocker(result, code) {
  return result.report.blockers.some(blocker => blocker.code === code);
}

test('valid managed coverage passes and derives count from automation baseline', () => {
  const result = runCase();
  assert.equal(result.report.passed, true);
  assert.equal(result.report.managedCoverage.observed, 2);
  assert.equal(result.report.managedCoverage.required, 2);
});

test('large automation baseline coverage is evaluated without a hardcoded validator count', () => {
  const result = buildSuperZooManagedPriceCandidate(makeFixture(534));
  assert.equal(result.report.passed, true);
  assert.deepEqual(result.report.managedCoverage, { observed: 534, required: 534, ratio: 1 });
});

test('normalized-title and exact-url multipack baseline methods retain full managed coverage', () => {
  const titleFixture = makeFixture(1);
  titleFixture.catalog[0] = {
    ...titleFixture.catalog[0],
    name: 'Krmivo Exact Recipe',
    size: '6kg',
    sizeKg: 6,
    offers: [{ ...titleFixture.catalog[0].offers[0], affiliateUrl: affiliate('https://www.superzoo.cz/legacy-url') }],
  };
  titleFixture.raw.products[0] = {
    ...titleFixture.raw.products[0],
    canonicalUrl: 'https://www.superzoo.cz/current-url',
    url: 'https://www.superzoo.cz/current-url',
    name: 'Krmivo Exact Recipe 6 kg',
    size: '6kg',
    sizeKg: 6,
  };
  titleFixture.automationBaseline = buildAutomationBaseline({
    catalog: titleFixture.catalog, publicCatalog: structuredClone(titleFixture.catalog), raw: titleFixture.raw, sidecar: titleFixture.sidecar,
    catalogSha256: CATALOG_SHA, publicCatalogSha256: CATALOG_SHA, rawSha256: 'c'.repeat(64), sidecarSha256: 'd'.repeat(64),
  }).baseline;
  let result = buildSuperZooManagedPriceCandidate(titleFixture);
  assert.equal(titleFixture.automationBaseline.approved[0].matchMethod, 'normalized_title_packing_v1');
  assert.deepEqual(result.report.managedCoverage, { observed: 1, required: 1, ratio: 1 });
  assert.equal(result.report.passed, true);

  const multipackFixture = makeFixture(1);
  multipackFixture.catalog[0] = {
    ...multipackFixture.catalog[0], name: 'Prescription sample 12x', size: '85g', sizeKg: 0.085,
    offers: [{ ...multipackFixture.catalog[0].offers[0], affiliateUrl: affiliate('https://www.superzoo.cz/same-product') }],
  };
  multipackFixture.raw.products[0] = {
    ...multipackFixture.raw.products[0], canonicalUrl: 'https://www.superzoo.cz/same-product', url: 'https://www.superzoo.cz/same-product',
    name: 'Prescription sample 12x85g', size: '12x85g', sizeKg: 1.02,
  };
  multipackFixture.automationBaseline = buildAutomationBaseline({
    catalog: multipackFixture.catalog, publicCatalog: structuredClone(multipackFixture.catalog), raw: multipackFixture.raw, sidecar: multipackFixture.sidecar,
    catalogSha256: CATALOG_SHA, publicCatalogSha256: CATALOG_SHA, rawSha256: 'c'.repeat(64), sidecarSha256: 'd'.repeat(64),
  }).baseline;
  result = buildSuperZooManagedPriceCandidate(multipackFixture);
  assert.equal(multipackFixture.automationBaseline.approved[0].matchMethod, 'canonical_url_multipack_alias_v1');
  assert.deepEqual(result.report.managedCoverage, { observed: 1, required: 1, ratio: 1 });
  assert.equal(result.report.passed, true);
});

test('unknown baseline match method fails closed', () => {
  const result = runCase(fixture => {
    fixture.automationBaseline.approved[0].matchMethod = 'fuzzy_title';
    fixture.automationBaseline.approved[0].identityFingerprint = require('../lib/superzoo-automation-baseline').identityFingerprint(fixture.automationBaseline.approved[0]);
  });
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'invalid_match_method'));
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
  const result = runCase(fixture => fixture.sidecar.rejectedCards.push({ canonicalUrl: fixture.automationBaseline.approved[0].sourceIdentity }));
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'managed_card_rejected'));
});

test('duplicate source, ambiguous mapping, duplicate identity, wrong partner and unknown product fail', () => {
  let result = runCase(fixture => fixture.raw.products.push({ ...fixture.raw.products[0], price: 101 }));
  assert.ok(hasBlocker(result, 'duplicate_source_identity'));
  result = runCase(fixture => fixture.catalog.push({ ...fixture.catalog[0], id: 'ambiguous' }));
  assert.ok(hasBlocker(result, 'ambiguous_managed_source_mapping'));
  result = runCase(fixture => fixture.automationBaseline.approved.push({ ...fixture.automationBaseline.approved[0] }));
  assert.ok(hasBlocker(result, 'duplicate_source_identity'));
  result = runCase(fixture => { fixture.automationBaseline.approved[0].partner = 'Other'; });
  assert.equal(result.report.passed, false);
  result = runCase(fixture => { fixture.automationBaseline.approved[0].productId = 'unknown-product'; });
  assert.ok(hasBlocker(result, 'unknown_or_ambiguous_managed_product'));
});

test('catalog and automation baseline SHA mismatches fail closed', () => {
  let result = runCase(fixture => { fixture.expectedCatalogSha256 = 'd'.repeat(64); });
  assert.equal(result.report.passed, false);
  result = runCase(fixture => { fixture.expectedAutomationBaselineSha256 = 'e'.repeat(64); });
  assert.equal(result.report.passed, false);
  assert.ok(hasBlocker(result, 'automation_baseline_sha_mismatch'));
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

test('scheduled producer workflow is read-only, reproducible, and has no production side effects', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*- cron: '0 4 \* \* \*'/u);
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/u);
  assert.match(workflow, /group: superzoo-managed-price-review/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /repository: lukashrbek27-dotcom\/mazlicek-plus\s+ref: 467a67fd0afca9644fabd8a761c5c0d1efe3b5b0\s+token: \$\{\{ secrets\.SUPERZOO_CATALOG_READ_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /ref: main/u);
  assert.match(workflow, /sparse-checkout: \|\s+src\/data\/partner-foods\.json\s+sparse-checkout-cone-mode: false/u);
  assert.equal((workflow.match(/persist-credentials: false/gu) || []).length, 2);
  assert.match(workflow, /test "\$catalog_commit" = "467a67fd0afca9644fabd8a761c5c0d1efe3b5b0"/u);
  assert.match(workflow, /run: npm test/u);
  assert.match(workflow, /mktemp -d "\$RUNNER_TEMP\/superzoo-managed-price-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-XXXXXX"/u);
  assert.match(workflow, /--automation-baseline="config\/superzoo-automation-baseline\.json"/u);
  assert.doesNotMatch(workflow, /--managed-set=/u);
  assert.match(workflow, /superzoo-managed-price-provenance\.js/u);
  assert.match(workflow, /superzoo-managed-price-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(workflow, /git\s+(?:commit|push)|gcloud|current\.json|PRICE_OVERLAY_SOURCE_URL|firebase|firestore|FCM|publisher|deploy-production/iu);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /retention-days: 14/u);
  const summaryStep = workflow.slice(workflow.indexOf('- name: Write managed-price job summary'), workflow.indexOf('- name: Upload managed-price evidence'));
  assert.match(summaryStep, /output_root="\$\{SUPERZOO_MANAGED_OUTPUT_ROOT:-\}"/u);
  assert.match(summaryStep, /if \[ -n "\$output_root" \]; then/u);
  assert.doesNotMatch(summaryStep, /report="\$SUPERZOO_MANAGED_OUTPUT_ROOT/u);
  assert.match(summaryStep, /ended before creating a managed-price report/u);
});

test('daily validator loads without the legacy managed-set module', () => {
  const source = fs.readFileSync(VALIDATOR, 'utf8');
  assert.doesNotMatch(source, /superzoo-price-overlay-managed-set/u);
  const script = [
    "const Module = require('node:module');",
    'const originalLoad = Module._load;',
    "Module._load = (request, parent, isMain) => { if (request === './superzoo-price-overlay-managed-set') { const error = new Error('simulated missing legacy module'); error.code = 'MODULE_NOT_FOUND'; throw error; } return originalLoad(request, parent, isMain); };",
    `require(${JSON.stringify(VALIDATOR)});`,
  ].join('\n');
  const result = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
