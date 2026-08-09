'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const { convertDocument, convertProduct } = require('../convert-superzoo');
const { extractProductCards, productCardDomFingerprint } = require('../lib/page-extractor');
const {
  CJ_AFFILIATE_PREFIX,
  assertSafeOutputPath,
  buildAffiliateUrl,
  buildIdentity,
  canonicalizeProductUrl,
  exclusionReason,
  loadConfig,
  normalizeRawProduct,
  redactDiagnosticText,
  writeJson,
  writeJsonAtomic,
  serializeDiagnosticError,
  validateAffiliateUrl,
  validateAffiliateUrlDetailed,
} = require('../lib/safety');
const { verifyPinnedBaseline } = require('../prepare-review-snapshot');
const { advancePagination, assertPageFingerprintNotSeen, clickNextIfExpectedState, readPaginationState, runScraperToFiles, scrape, scrapeCategory } = require('../scraper');
const { validateConvertedProducts } = require('../validate-converted');
const { validateConfigContract, validateRawDocument } = require('../validate-raw');

const config = loadConfig();
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'safety-cases.json'), 'utf8'));
const affiliateFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'current-superzoo-affiliate-examples.json'), 'utf8'));
const avicentraFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'avicentra-manual-review-later.json'), 'utf8'));
const validHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-category.html'), 'utf8');
const category = { name: 'Granule pro psy', animalType: 'dog' };
let browser;
const browserNetwork = { attempted: 0, blocked: 0 };

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => {
  await browser?.close();
  assert.equal(browserNetwork.attempted, browserNetwork.blocked, 'Every browser request must be blocked before network access.');
});

async function offlinePage() {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    browserNetwork.attempted += 1;
    browserNetwork.blocked += 1;
    return route.abort('blockedbyclient');
  });
  return page;
}

async function paginationFixturePage(html) {
  const page = await browser.newPage();
  await page.route('https://www.superzoo.cz/pagination-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://www.superzoo.cz/pagination-fixture');
  return page;
}

function raw(overrides = {}) {
  return {
    name: 'Brit Care Adult Salmon 3 kg',
    price: '399 Kč',
    salePrice: null,
    originalPrice: null,
    url: 'https://www.superzoo.cz/brit-care-adult-salmon-3-kg/',
    image: 'https://cdn.superzoo.cz/brit-care.jpg',
    category: category.name,
    animalType: 'dog',
    ...overrides,
  };
}

function testConfig(categories = [category.name], comparatorTotal = 1) {
  const copy = structuredClone(config);
  const counts = Object.fromEntries(categories.map((name, index) => [name, index === 0 ? comparatorTotal - (categories.length - 1) : 1]));
  copy.sourcePolicy.requiredCategories = categories;
  copy.baselineContract.preFilter.totalProducts = comparatorTotal;
  copy.baselineContract.preFilter.categoryCounts = { ...counts };
  copy.baselineContract.postExclusion.totalProducts = comparatorTotal;
  copy.baselineContract.postExclusion.filteredOutProducts = 0;
  copy.baselineContract.postExclusion.categoryCounts = { ...counts };
  copy.thresholds.minimumTotalProducts = 1;
  copy.thresholds.minimumCategoryProducts = Object.fromEntries(categories.map(name => [name, 1]));
  return copy;
}

function rawDocument(products, cfg, runStats = {}) {
  const categoryCounts = products.reduce((counts, product) => {
    counts[product.category] = (counts[product.category] || 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: 2,
    source: 'superzoo.cz',
    reviewOnly: true,
    totalProducts: products.length,
    requiredCategories: [...cfg.sourcePolicy.requiredCategories],
    categoryCounts,
    runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards: 0, rejectedReasons: {}, ...runStats },
    products,
  };
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'superzoo-hardening-test-'));
}

function encodeLayers(value, count) {
  let encoded = value;
  for (let index = 0; index < count; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

function encodeAllAscii(value) {
  return [...value].map(character => `%${character.codePointAt(0).toString(16).padStart(2, '0')}`).join('');
}

function encodingVariants(value, maximumLayers = 12) {
  const variants = [value];
  let current = value;
  for (let index = 0; index < maximumLayers; index += 1) {
    current = encodeURIComponent(current);
    variants.push(current);
  }
  return variants;
}

function assertNoCredentialVariants(text, sentinels, encodedInputs = []) {
  for (const sentinel of sentinels) {
    for (const variant of encodingVariants(sentinel)) assert.equal(text.includes(variant), false, `leaked ${variant}`);
    for (const variant of encodingVariants(encodeAllAscii(sentinel))) assert.equal(text.includes(variant), false, `leaked fully encoded ${variant}`);
  }
  for (const encoded of encodedInputs) {
    let current = encoded;
    for (let index = 0; index < 16; index += 1) {
      assert.equal(text.includes(current), false, `leaked partial ${current}`);
      try {
        const next = decodeURIComponent(current);
        if (next === current) break;
        current = next;
      } catch { break; }
    }
  }
}

test('browser context blocks every request and uses the production page.evaluate extractor', async () => {
  const page = await offlinePage();
  try {
    await page.setContent(validHtml);
    await assert.rejects(page.evaluate(() => fetch('https://network-must-not-run.invalid/')), /Failed to fetch|NetworkError/i);
    const result = await page.evaluate(extractProductCards, category);
    assert.equal(result.selectorMissing, false);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].sourceProductId, 'SKU-12345');
    assert.equal(result.products[0].salePrice, '399 Kč');
    assert.equal(result.products[0].originalPrice, '499 Kč');
  } finally { await page.close(); }
});

test('pagination DOM fingerprint is identical across extractor, expected-state click, and state read for stable, linked, and anonymous cards', async () => {
  const html = '<div class="product-item" data-product-id="stable-id"></div><div class="product-item"><a href="/linked-product/">Linked</a></div><div class="product-item"></div><div class="product-item"></div><button>Další stránka</button>';
  const page = await paginationFixturePage(html);
  try {
    const extraction = await page.evaluate(extractProductCards, category);
    const state = await readPaginationState(page);
    const click = await clickNextIfExpectedState(page, { canonicalUrl: state.canonicalUrl, domFingerprint: extraction.domFingerprint });
    assert.equal(extraction.domFingerprint, state.domFingerprint);
    assert.equal(click.status, 'clicked');
    assert.equal(click.domFingerprint, extraction.domFingerprint);
    assert.match(extraction.domFingerprint, /unidentified-2/);
    assert.match(extraction.domFingerprint, /unidentified-3/);
  } finally { await page.close(); }
});

test('pagination DOM fingerprint distinguishes different card sets and keeps anonymous fallbacks deterministic', async () => {
  const page = await paginationFixturePage('<div class="product-item"></div><div class="product-item"></div>');
  try {
    const first = await page.evaluate(productCardDomFingerprint);
    const repeated = await page.evaluate(productCardDomFingerprint);
    await page.setContent('<div class="product-item"></div><div class="product-item" data-product-id="changed-id"></div>');
    const changed = await page.evaluate(productCardDomFingerprint);
    assert.equal(first, repeated);
    assert.notEqual(first, changed);
    assert.match(first, /unidentified-0/);
    assert.match(first, /unidentified-1/);
  } finally { await page.close(); }
});

test('pagination click permits an unchanged DOM and detects a real post-click product change', async () => {
  const html = '<div class="product-item" data-product-id="before"></div><button onclick="document.querySelector(\'.product-item\').dataset.productId=\'after\'">Další stránka</button>';
  const page = await paginationFixturePage(html);
  try {
    const before = await readPaginationState(page);
    const click = await clickNextIfExpectedState(page, before);
    const after = await readPaginationState(page);
    assert.equal(click.status, 'clicked');
    assert.equal(click.domFingerprint, before.domFingerprint);
    assert.notEqual(after.domFingerprint, before.domFingerprint);
  } finally { await page.close(); }
});

test('valid category raw document passes its isolated contract', () => {
  const cfg = testConfig();
  const report = validateRawDocument(rawDocument([raw()], cfg), cfg);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
});

test('empty category fails closed', () => {
  const cfg = testConfig();
  const report = validateRawDocument(rawDocument([], cfg), cfg);
  assert.ok(report.errors.some(error => error.code === 'empty_result'));
  assert.ok(report.errors.some(error => error.code === 'missing_required_category'));
});

test('changed selectors are visible through the production browser extractor', async () => {
  const page = await offlinePage();
  try {
    await page.setContent('<main><section>no product selectors</section></main>');
    const result = await page.evaluate(extractProductCards, category);
    assert.equal(result.selectorMissing, true);
  } finally { await page.close(); }
});

test('rejected and unparseable browser cards keep concrete reasons', async () => {
  const page = await offlinePage();
  try {
    await page.setContent('<div class="product-item"><h2>Missing price</h2><a href="https://www.superzoo.cz/missing/"></a><img src="https://cdn.superzoo.cz/a.jpg"></div><div class="product-item" id="broken"><h2>Broken</h2></div>');
    await page.evaluate(() => { document.querySelector('#broken').querySelector = () => { throw new Error('fixture failure'); }; });
    const result = await page.evaluate(extractProductCards, category);
    assert.equal(result.rejectedCards, 1);
    assert.equal(result.unparseableCards, 1);
    assert.equal(result.rejectedReasons.missing_current_price, 1);
    assert.equal(result.rejectedReasons.unparseable_card, 1);
  } finally { await page.close(); }
});

test('textually unparseable price flows from page.evaluate through runStats into raw validation failure', async () => {
  const page = await offlinePage();
  const html = `${validHtml}<div class="product-item" data-product-id="BAD-PRICE"><h2>Brit Care Invalid 1 kg</h2><a href="https://www.superzoo.cz/invalid-price/">Detail</a><img src="https://cdn.superzoo.cz/bad.jpg"><span data-testid="current-price">price on request</span></div>`;
  try {
    await page.setContent(html);
    const result = await scrapeCategory(page, category, testConfig(), {
      maxPages: 1,
      paginationTimeoutMs: 50,
      retryBaseDelayMs: 1,
      navigateToCategory: async () => {},
      closeCookieDialog: async () => {},
      findNextPageControl: async () => null,
    });
    assert.equal(result.stats.rejectedCards, 1);
    assert.equal(result.stats.rejectedReasons.invalid_price, 1);
    const cfg = testConfig();
    const report = validateRawDocument(rawDocument(result.products, cfg, result.stats), cfg);
    assert.ok(report.errors.some(error => error.code === 'too_many_rejected_cards'));
  } finally { await page.close(); }
});

test('duplicate source identity across categories is blocking and diagnosed', () => {
  const second = 'Veterinární diety pro psy';
  const cfg = testConfig([category.name, second], 2);
  const products = [raw({ sourceProductId: 'same', url: 'https://www.superzoo.cz/a/' }), raw({ sourceProductId: 'same', url: 'https://www.superzoo.cz/b/', category: second })];
  const report = validateRawDocument(rawDocument(products, cfg), cfg);
  assert.equal(report.summary.duplicateSourceIdentities, 1);
  assert.equal(report.diagnostics.duplicateSourceIdentities[0].identity, 'superzoo-product:same');
  assert.ok(report.errors.some(error => error.code === 'duplicate_source_threshold'));
});

test('duplicate canonical identity across categories is blocking and diagnosed', () => {
  const second = 'Veterinární diety pro psy';
  const cfg = testConfig([category.name, second], 2);
  const products = [raw({ sourceProductId: 'one' }), raw({ sourceProductId: 'two', category: second })];
  const report = validateRawDocument(rawDocument(products, cfg), cfg);
  assert.equal(report.summary.duplicateCanonicalIdentities, 1);
  assert.ok(report.errors.some(error => error.code === 'duplicate_canonical_threshold'));
});

test('zero and negative current prices fail', () => {
  const cfg = testConfig();
  for (const [index, price] of [fixture.zeroPrice, fixture.negativePrice].entries()) {
    const report = validateRawDocument(rawDocument([raw({ price, url: `https://www.superzoo.cz/invalid-${index}/` })], cfg), cfg);
    assert.ok(report.errors.some(error => error.code === 'invalid_price'));
  }
});

test('sale conversion uses current price and only a higher optional original price', () => {
  const cfg = testConfig();
  const sale = convertProduct(raw({ salePrice: '399 Kč', originalPrice: '499 Kč' }), cfg);
  assert.equal(sale.offers[0].price, 399);
  assert.equal(sale.offers[0].salePrice, 399);
  assert.equal(sale.offers[0].originalPrice, 499);
  const regular = convertProduct(raw({ originalPrice: '399 Kč' }), cfg);
  assert.equal(regular.offers[0].price, 399);
  assert.equal(regular.offers[0].originalPrice, null);
});

test('URL identity prevents the old brand-name-size collision', () => {
  const products = convertDocument({ products: [raw({ url: 'https://www.superzoo.cz/first/' }), raw({ url: 'https://www.superzoo.cz/second/' })] }, testConfig());
  assert.notEqual(products[0].id, products[1].id);
});

test('hay and other named out-of-scope products are rejected', () => {
  assert.throws(() => convertProduct(raw({ name: 'Seno luční 1 kg', url: 'https://www.superzoo.cz/other-hay/', category: 'Krmivo a pamlsky pro hlodavce', animalType: 'rodent' }), config), /out-of-scope/i);
});

test('stable excluded URL remains blocked after ID and name change', () => {
  const disguised = raw({ id: 'new-id', name: 'Nature Land luční produkt 10 kg', url: fixture.excludedUrl, category: 'Krmivo a pamlsky pro hlodavce', animalType: 'rodent' });
  assert.equal(exclusionReason(disguised, config), 'stable_source_url');
  assert.throws(() => convertProduct(disguised, config), /stable_source_url/);
});

test('www and non-www variants cannot bypass URL exclusions in either direction', () => {
  const excludedWww = fixture.excludedUrl;
  const excludedBare = excludedWww.replace('www.superzoo.cz', 'superzoo.cz');
  assert.equal(canonicalizeProductUrl(excludedWww, config), canonicalizeProductUrl(excludedBare, config));
  assert.equal(exclusionReason(raw({ url: excludedBare, name: 'Disguised product 10 kg' }), config), 'stable_source_url');
  const reverseConfig = structuredClone(config);
  reverseConfig.catalogExclusionContract.superZooExcludedCanonicalUrls[0] = reverseConfig.catalogExclusionContract.superZooExcludedCanonicalUrls[0].replace('www.superzoo.cz', 'superzoo.cz');
  assert.equal(exclusionReason(raw({ url: reverseConfig.catalogExclusionContract.superZooExcludedCanonicalUrls[0].replace('superzoo.cz', 'www.superzoo.cz'), name: 'Disguised product 1 kg' }), reverseConfig), 'stable_source_url');
});

test('percent-encoded unreserved path characters normalize across lower and upper hex', () => {
  const plain = 'https://www.superzoo.cz/seno-nature-land-hay-lucni-10kg/';
  assert.equal(canonicalizeProductUrl('https://superzoo.cz/%73eno-nature-land-hay-lucni-10kg', config), canonicalizeProductUrl(plain, config));
  assert.equal(canonicalizeProductUrl('https://superzoo.cz/product%7ename', config), canonicalizeProductUrl('https://www.superzoo.cz/product%7Ename/', config));
  assert.equal(exclusionReason(raw({ url: 'https://superzoo.cz/%73eno-nature-land-hay-lucni-10kg', name: 'Disguised product 10 kg' }), config), 'stable_source_url');
});

test('fragments, UTM, campaign, ref, protocol, host case, and trailing slash do not change identity', () => {
  const expected = canonicalizeProductUrl(raw().url, config);
  for (const candidate of [
    `http://SUPERZOO.CZ/brit-care-adult-salmon-3-kg`,
    `${raw().url}?utm_source=test`,
    `${raw().url}?campaign=random`,
    `${raw().url}?ref=affiliate#fragment`,
    `${raw().url}#fragment`,
  ]) assert.equal(canonicalizeProductUrl(candidate, config), expected);
});

test('malicious hostname, credentials, unexpected port, protocol, and malformed path encoding fail closed', () => {
  for (const candidate of [
    'https://superzoo.cz.evil.example/item',
    'https://evil-superzoo.cz/item',
    'https://user:password@www.superzoo.cz/item',
    'https://www.superzoo.cz:444/item',
    'https://www.superzoo.cz:443/item',
    'http://www.superzoo.cz:80/item',
    'ftp://www.superzoo.cz/item',
    'https://www.superzoo.cz/',
    'https://www.superzoo.cz/item?broken=%',
    'https://www.superzoo.cz/item?broken=%G0',
    'https://www.superzoo.cz/item?broken=%A',
    'https://www.superzoo.cz/%',
    'https://www.superzoo.cz/%G0',
    'https://www.superzoo.cz/%A',
    'https://www.superzoo.cz/bad%ZZpath',
    'https://www.superzoo.cz/bad%path',
  ]) assert.throws(() => canonicalizeProductUrl(candidate, config));
});

test('reserved escapes remain distinct and legitimate different product URLs do not collide', () => {
  assert.notEqual(canonicalizeProductUrl('https://www.superzoo.cz/product%2Fvariant', config), canonicalizeProductUrl('https://www.superzoo.cz/product/variant', config));
  assert.notEqual(canonicalizeProductUrl('https://www.superzoo.cz/product-a', config), canonicalizeProductUrl('https://www.superzoo.cz/product-b', config));
});

test('product IDs are stable when input order changes', () => {
  const input = [raw({ url: 'https://www.superzoo.cz/a/' }), raw({ url: 'https://www.superzoo.cz/b/' }), raw({ url: 'https://www.superzoo.cz/c/' })];
  const first = convertDocument({ products: input }, testConfig());
  const second = convertDocument({ products: [...input].reverse() }, testConfig());
  const ids = products => Object.fromEntries(products.map(product => [new URL(product.offers[0].affiliateUrl).searchParams.get('url'), product.id]));
  assert.deepEqual(ids(first), ids(second));
});

test('affiliate targets preserve trailing slash, no slash, and safe original path encoding', () => {
  const targets = [
    'https://www.superzoo.cz/product/',
    'https://www.superzoo.cz/product',
    'https://www.superzoo.cz/krmivo-%C4%8Derven%C3%A9/',
  ];
  for (const target of targets) {
    const affiliate = buildAffiliateUrl(target, config);
    const validation = validateAffiliateUrlDetailed(affiliate, config);
    assert.equal(validation.valid, true, validation.reason);
    assert.equal(validation.targetUrl, target);
    assert.equal(affiliate, `${CJ_AFFILIATE_PREFIX}${encodeURIComponent(target)}`);
  }
});

test('affiliate destination is encoded exactly once and rejects double encoding or malicious host', () => {
  const target = 'https://www.superzoo.cz/product/';
  assert.equal(validateAffiliateUrl(`${CJ_AFFILIATE_PREFIX}${encodeURIComponent(target)}`, config), true);
  assert.equal(validateAffiliateUrl(`${CJ_AFFILIATE_PREFIX}${encodeURIComponent(encodeURIComponent(target))}`, config), false);
  assert.equal(validateAffiliateUrl(`${CJ_AFFILIATE_PREFIX}${encodeURIComponent('https://superzoo.cz.evil.example/product/')}`, config), false);
  assert.equal(validateAffiliateUrl(`${CJ_AFFILIATE_PREFIX}${encodeURIComponent('https://user:pass@www.superzoo.cz/product/')}`, config), false);
});

test('affiliate targets reject raw, encoded, encoded-name, and double-encoded nested destinations', () => {
  const targets = [
    'https://www.superzoo.cz/product/?url=https://evil.example/steal',
    'https://www.superzoo.cz/product/?redirect=https%3A%2F%2Fevil.example%2F',
    'https://www.superzoo.cz/product/?%72edirect=https%3A%2F%2Fevil.example%2F',
    'https://www.superzoo.cz/product/?%2572edirect=https%253A%252F%252Fevil.example%252F',
  ];
  for (const target of targets) {
    const affiliate = `${CJ_AFFILIATE_PREFIX}${encodeURIComponent(target)}`;
    assert.equal(validateAffiliateUrl(affiliate, config), false, target);
    assert.throws(() => buildAffiliateUrl(target, config), /nested destination/i);
  }
});

test('identity canonicalizes while an existing safe affiliate URL remains byte-identical', () => {
  const existing = `${CJ_AFFILIATE_PREFIX}${encodeURIComponent('https://www.superzoo.cz/product/?utm_source=runtime')}`;
  const normalized = normalizeRawProduct(raw({ url: 'http://superzoo.cz/product', affiliateUrl: existing }), config);
  assert.equal(normalized.canonicalUrl, 'https://www.superzoo.cz/product');
  assert.equal(normalized.affiliateUrl, existing);
});

test('pinned real runtime affiliate examples remain compatible', () => {
  assert.equal(affiliateFixture.provenance.sourceCatalogSha256, '6dc596ff1c64bab86ec0413bd8d0e5ae28c19681f7537c3435f5f6ac193f8c23');
  for (const offer of affiliateFixture.offers) assert.equal(validateAffiliateUrl(offer.affiliateUrl, config), true, offer.productId);
});

test('credential-like diagnostics redact message, stack, nested cause, query values, and URL userinfo', () => {
  const sentinels = ['ghp_SENTINELTOKEN123456', 'github_pat_SENTINELTOKEN123456', 'Bearer SENTINELBEARER123', 'SENTINELAPIKEY123', 'SENTINELPASSWORD123', 'SENTINELUSERINFO123'];
  const cause = new Error('cause password=SENTINELPASSWORD123 and https://SENTINELUSERINFO123@example.test/path');
  const error = new Error('ordinary context Authorization: Bearer SENTINELBEARER123 api_key=SENTINELAPIKEY123 https://x.test/?token=ghp_SENTINELTOKEN123456');
  error.stack = `${error.message}\nchild github_pat_SENTINELTOKEN123456`;
  error.cause = cause;
  const serialized = serializeDiagnosticError(error);
  const text = JSON.stringify(serialized);
  for (const sentinel of sentinels) assert.equal(text.includes(sentinel), false, sentinel);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /ordinary context/);
});

test('encoded credentials, aggregate errors, deep causes, and circular diagnostics fail closed', () => {
  const sentinels = ['SENTINEL_ENCODED_AUTH_123', 'SENTINEL_ENCODED_KEY_123', 'SENTINEL_AGGREGATE_123', 'SENTINEL_DEEP_CAUSE_123'];
  const root = new AggregateError([
    new Error('aggregate Authorization%3A%20Bearer%20SENTINEL_AGGREGATE_123'),
    { message: 'safe aggregate context ?%74oken=SENTINEL_ENCODED_KEY_123' },
  ], 'ordinary aggregate context Authorization%3A%20Bearer%20SENTINEL_ENCODED_AUTH_123');
  root.cause = new Error('level one');
  root.cause.cause = new Error('level two');
  root.cause.cause.cause = new Error('deep token=SENTINEL_DEEP_CAUSE_123');
  root.cause.cause.cause.cause = root;
  const text = JSON.stringify(serializeDiagnosticError(root));
  for (const sentinel of sentinels) assert.equal(text.includes(sentinel), false, sentinel);
  assert.match(text, /ordinary aggregate context/);
  assert.match(text, /safe aggregate context/);
  assert.match(text, /Circular/);
  assert.doesNotThrow(() => serializeDiagnosticError({ get message() { throw new Error('getter failed'); } }));
});

test('failure JSON is redacted and the original failure remains non-zero', async () => {
  const directory = tempDirectory();
  const failureReportPath = path.join(directory, 'failure.json');
  try {
    await assert.rejects(runScraperToFiles({
      outputPath: path.join(directory, 'raw.json'),
      failureReportPath,
      scrapeFunction: async () => {
        const error = new Error('useful launch failure token=SENTINEL_EXIT_TOKEN_123');
        error.cause = new Error('Authorization: Bearer SENTINEL_CAUSE_TOKEN_123');
        throw error;
      },
    }), /useful launch failure/);
    const reportText = fs.readFileSync(failureReportPath, 'utf8');
    assert.equal(reportText.includes('SENTINEL_EXIT_TOKEN_123'), false);
    assert.equal(reportText.includes('SENTINEL_CAUSE_TOKEN_123'), false);
    assert.match(reportText, /useful launch failure/);
    assert.match(reportText, /\[REDACTED(?:_CREDENTIAL)?\]/);

    const safetyPath = path.resolve(__dirname, '..', 'lib', 'safety.js');
    const child = spawnSync(process.execPath, ['-e', `const {redactDiagnosticText}=require(${JSON.stringify(safetyPath)}); console.error(redactDiagnosticText('token=SENTINEL_CHILD_TOKEN_123')); process.exitCode=1;`], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr.includes('SENTINEL_CHILD_TOKEN_123'), false);
    assert.match(child.stderr, /\[REDACTED(?:_CREDENTIAL)?\]/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('convert CLI stderr uses shared redaction and never prints raw encoded sentinels', () => {
  const directory = tempDirectory();
  const convertPath = path.resolve(__dirname, '..', 'convert-superzoo.js');
  const missing = path.join(directory, 'Authorization%3A%20Bearer%20SENTINEL_ENCODED_AUTH_123-%3F%74oken=SENTINEL_ENCODED_KEY_123.json');
  try {
    const child = spawnSync(process.execPath, [convertPath, `--input=${missing}`, `--output=${path.join(directory, 'converted.json')}`], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr.includes('SENTINEL_ENCODED_AUTH_123'), false);
    assert.equal(child.stderr.includes('SENTINEL_ENCODED_KEY_123'), false);
    assert.match(child.stderr, /\[REDACTED_CREDENTIAL\]/);
    assert.match(child.stderr, /ENOENT|no such file/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('generated diagnostic JSON redacts encoded credentials in keys and nested values', () => {
  const directory = tempDirectory();
  const reportPath = path.join(directory, 'diagnostic.json');
  try {
    writeJson(reportPath, {
      message: 'ordinary report context Authorization%3A%20Bearer%20SENTINEL_ENCODED_AUTH_123',
      nested: { '?%74oken=SENTINEL_ENCODED_KEY_123': 'safe nested context' },
    });
    const reportText = fs.readFileSync(reportPath, 'utf8');
    assert.equal(reportText.includes('SENTINEL_ENCODED_AUTH_123'), false);
    assert.equal(reportText.includes('SENTINEL_ENCODED_KEY_123'), false);
    assert.match(reportText, /ordinary report context/);
    assert.match(reportText, /safe nested context/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('pre-launch, browser-launch, and first-category failures produce safe reports without output', async () => {
  const directory = tempDirectory();
  try {
    for (const stage of ['pre-launch', 'browser-launch', 'first-category']) {
      const outputPath = path.join(directory, `${stage}-raw.json`);
      const failureReportPath = path.join(directory, `${stage}-failure.json`);
      await assert.rejects(runScraperToFiles({ outputPath, failureReportPath, scrapeFunction: async () => { throw new Error(`${stage} failed`); } }), new RegExp(stage));
      assert.equal(fs.existsSync(outputPath), false);
      const report = JSON.parse(fs.readFileSync(failureReportPath, 'utf8'));
      assert.equal(report.status, 'FAIL');
      assert.match(report.error.message, new RegExp(stage));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('browser closes when a category fails', async () => {
  let closed = false;
  const fakeBrowser = {
    newContext: async () => ({
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      addInitScript: async () => {}, newPage: async () => ({}),
    }),
    close: async () => { closed = true; },
  };
  await assert.rejects(scrape({
    browserType: { launch: async () => fakeBrowser },
    categories: [category],
    scrapeCategoryFunction: async () => { throw new Error('first category failed'); },
  }), /first category failed/);
  assert.equal(closed, true);
});

function paginationHarness(clickBehavior) {
  const original = { canonicalUrl: 'https://www.superzoo.cz/list', domFingerprint: 'page-one' };
  let state = { ...original };
  let clicks = 0;
  return {
    original,
    get clicks() { return clicks; },
    dependencies: {
      readState: async () => ({ ...state }),
      clickIfExpectedState: async attempt => {
        if (state.domFingerprint !== original.domFingerprint) return { status: 'state_changed', ...state };
        if (state.canonicalUrl !== original.canonicalUrl) return { status: 'url_changed', ...state };
        clicks += 1;
        await clickBehavior({ attempt, setState: next => { state = { ...next }; } });
        return { status: 'clicked', ...state };
      },
      waitForChange: async () => {
        if (state.domFingerprint !== original.domFingerprint) return { ...state };
        throw new Error('bounded transition timeout');
      },
      delay: async () => {},
    },
  };
}

const paginationOptions = { paginationRetryAttempts: 2, retryBaseDelayMs: 1, paginationTimeoutMs: 10 };

test('pagination click timeout after content transition does not click twice', async () => {
  const harness = paginationHarness(async ({ setState }) => { setState({ canonicalUrl: harness.original.canonicalUrl, domFingerprint: 'page-two' }); throw new Error('click timeout'); });
  const result = await advancePagination({}, category.name, harness.original, paginationOptions, harness.dependencies);
  assert.equal(result.domFingerprint, 'page-two');
  assert.equal(harness.clicks, 1);
});

test('pagination transition between the final read and retry stays at one click', async () => {
  const original = { canonicalUrl: 'https://www.superzoo.cz/list', domFingerprint: 'page-one' };
  let state = { ...original };
  let clicks = 0;
  const result = await advancePagination({}, category.name, original, paginationOptions, {
    clickIfExpectedState: async () => {
      if (state.domFingerprint !== original.domFingerprint) return { status: 'state_changed', ...state };
      clicks += 1;
      return { status: 'clicked', ...state };
    },
    waitForChange: async () => { throw new Error('bounded transition timeout'); },
    readState: async () => ({ ...state }),
    delay: async () => { state = { canonicalUrl: original.canonicalUrl, domFingerprint: 'page-two' }; },
  });
  assert.equal(result.domFingerprint, 'page-two');
  assert.equal(clicks, 1);
});

test('pagination fingerprint history rejects A to B to A without exposing fingerprint content', () => {
  const seen = new Set();
  assertPageFingerprintNotSeen(seen, 'page-A-SENTINEL_PAGE_CONTENT', category.name, 1); seen.add('page-A-SENTINEL_PAGE_CONTENT');
  assertPageFingerprintNotSeen(seen, 'page-B', category.name, 2); seen.add('page-B');
  assert.throws(() => assertPageFingerprintNotSeen(seen, 'page-A-SENTINEL_PAGE_CONTENT', category.name, 3), error => {
    assert.doesNotMatch(error.message, /SENTINEL_PAGE_CONTENT/);
    return /previously processed product set/i.test(error.message);
  });
});

test('pagination fingerprint history accepts a normal A to B to C sequence', () => {
  const seen = new Set();
  for (const [index, fingerprint] of ['page-A', 'page-B', 'page-C'].entries()) {
    assertPageFingerprintNotSeen(seen, fingerprint, category.name, index + 1);
    seen.add(fingerprint);
  }
  assert.equal(seen.size, 3);
});

test('pagination fingerprint history rejects A to B to C to B', () => {
  const seen = new Set();
  for (const [index, fingerprint] of ['page-A', 'page-B', 'page-C'].entries()) {
    assertPageFingerprintNotSeen(seen, fingerprint, category.name, index + 1);
    seen.add(fingerprint);
  }
  assert.throws(() => assertPageFingerprintNotSeen(seen, 'page-B', category.name, 4), /previously processed product set/i);
});

test('pagination retries only after the original state survives the bounded wait', async () => {
  const harness = paginationHarness(async ({ attempt, setState }) => { if (attempt === 1) throw new Error('click failed'); setState({ canonicalUrl: harness.original.canonicalUrl, domFingerprint: 'page-two' }); });
  const result = await advancePagination({}, category.name, harness.original, paginationOptions, harness.dependencies);
  assert.equal(result.domFingerprint, 'page-two');
  assert.equal(harness.clicks, 2);
});

test('pagination repeated original state after retry is blocking', async () => {
  const harness = paginationHarness(async () => { throw new Error('click failed'); });
  await assert.rejects(advancePagination({}, category.name, harness.original, paginationOptions, harness.dependencies), /after 2 attempts/i);
  assert.equal(harness.clicks, 2);
});

test('pagination accepts same URL with a new fingerprint', async () => {
  const harness = paginationHarness(async ({ setState }) => { setState({ canonicalUrl: harness.original.canonicalUrl, domFingerprint: 'page-two' }); });
  const result = await advancePagination({}, category.name, harness.original, paginationOptions, harness.dependencies);
  assert.equal(result.canonicalUrl, harness.original.canonicalUrl);
  assert.equal(result.domFingerprint, 'page-two');
});

test('pagination rejects a new URL with repeated content', async () => {
  const harness = paginationHarness(async ({ setState }) => { setState({ canonicalUrl: 'https://www.superzoo.cz/list?page=2', domFingerprint: harness.original.domFingerprint }); });
  await assert.rejects(advancePagination({}, category.name, harness.original, paginationOptions, harness.dependencies), /URL changed but product content repeated/i);
  assert.equal(harness.clicks, 1);
});

test('pagination retry exhaustion propagates a failure suitable for non-zero exit', () => {
  const scraperPath = path.resolve(__dirname, '..', 'scraper.js');
  const script = `const {advancePagination}=require(${JSON.stringify(scraperPath)}); const state={canonicalUrl:'https://www.superzoo.cz/list',domFingerprint:'same'}; advancePagination({},'test',state,{paginationRetryAttempts:1,retryBaseDelayMs:1},{readState:async()=>state,clickIfExpectedState:async()=>{throw new Error('timeout')},waitForChange:async()=>{throw new Error('unchanged')},delay:async()=>{}}).catch(()=>{process.exitCode=1});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 1);
});

test('a total drop above 20 percent fails against the fixed post-exclusion comparator', () => {
  const cfg = testConfig([category.name], 10);
  const products = Array.from({ length: 7 }, (_, index) => raw({ url: `https://www.superzoo.cz/drop-${index}/` }));
  const report = validateRawDocument(rawDocument(products, cfg), cfg);
  assert.ok(report.errors.some(error => error.code === 'excessive_drop'));
});

test('another category cannot hide a required category outage', () => {
  const second = 'Veterinární diety pro psy';
  const cfg = testConfig([category.name, second], 2);
  const products = [raw({ url: 'https://www.superzoo.cz/a/' }), raw({ url: 'https://www.superzoo.cz/b/' })];
  const report = validateRawDocument(rawDocument(products, cfg), cfg);
  assert.ok(report.errors.some(error => error.code === 'missing_required_category' && error.message.includes(second)));
});

test('immutable baseline contract verifies hash and reproduces 1405 to 1377 with exact counts', () => {
  assert.deepEqual(validateConfigContract(config), []);
  const verification = verifyPinnedBaseline(config);
  assert.equal(verification.report.sha256, config.baselineContract.expectedSha256);
  assert.equal(verification.report.preFilterProducts, 1405);
  assert.equal(verification.report.postExclusionProducts, 1377);
  assert.equal(verification.report.filteredOutProducts, 28);
  assert.deepEqual(verification.report.postExclusionCategoryCounts, {
    'Granule pro psy': 781,
    'Veterinární diety pro psy': 19,
    'Granule pro kočky': 278,
    'Veterinární diety pro kočky': 50,
    'Plnohodnotné krmivo pro hlodavce': 126,
    'Krmivo a pamlsky pro hlodavce': 123,
  });
});

test('all 1405 baseline URLs retain zero canonical URL, canonical identity, and source identity collisions', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'baselines', 'superzoo-legacy-1405.json'), 'utf8'));
  const seen = { canonicalUrl: new Set(), canonicalIdentity: new Set(), sourceIdentity: new Set() };
  const collisions = { canonicalUrl: 0, canonicalIdentity: 0, sourceIdentity: 0 };
  for (const product of baseline.products) {
    const normalized = normalizeRawProduct(product, config);
    for (const key of Object.keys(seen)) {
      if (seen[key].has(normalized[key])) collisions[key] += 1;
      seen[key].add(normalized[key]);
    }
  }
  assert.equal(baseline.products.length, 1405);
  assert.deepEqual(collisions, { canonicalUrl: 0, canonicalIdentity: 0, sourceIdentity: 0 });
});

test('immutable baseline is protected from output writers and contains no credential-like values', () => {
  const baselinePath = path.resolve(__dirname, '..', config.baselineContract.artifactPath);
  const bytes = fs.readFileSync(baselinePath);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), config.baselineContract.expectedSha256);
  assert.throws(() => assertSafeOutputPath(baselinePath), /immutable audit\/test fixture/i);
  const text = bytes.toString('utf8');
  for (const pattern of [/\bghp_[A-Za-z0-9_]{8,}\b/iu, /\bgithub_pat_[A-Za-z0-9_]{8,}\b/iu, /authorization\s*[:=]/iu, /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu, /https?:\/\/[^/@\s]+@/iu]) assert.equal(pattern.test(text), false);
});

test('output guard rejects repository inputs and symlink or junction aliases without modifying protected bytes', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const protectedPaths = [
    path.join(repositoryRoot, 'package.json'),
    path.join(repositoryRoot, '.github', 'workflows', 'scrape.yml'),
    path.join(repositoryRoot, 'config', 'safety-thresholds.json'),
    path.join(repositoryRoot, 'lib', 'safety.js'),
    path.join(repositoryRoot, 'test', 'fixtures', 'valid-category.html'),
    path.join(repositoryRoot, 'test', 'fixtures', 'baselines', 'superzoo-legacy-1405.json'),
    path.join(repositoryRoot, 'test', 'fixtures', 'avicentra-manual-review-later.json'),
  ];
  const before = new Map(protectedPaths.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const directory = tempDirectory();
  try {
    for (const file of protectedPaths) assert.throws(() => assertSafeOutputPath(file), /Refusing/i, file);
    const fixtureAlias = path.join(directory, 'fixture-alias');
    fs.symlinkSync(path.join(repositoryRoot, 'test', 'fixtures'), fixtureAlias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertSafeOutputPath(path.join(fixtureAlias, 'valid-category.html')), /repository|fixture|symlink|junction/i);
    assert.throws(() => assertSafeOutputPath(path.join(fixtureAlias, 'baselines', 'superzoo-legacy-1405.json')), /repository|fixture|symlink|junction/i);
    assert.doesNotThrow(() => assertSafeOutputPath(path.join(directory, 'safe-output.json')));
    const runnerTemp = path.join(directory, 'runner-temp');
    fs.mkdirSync(runnerTemp);
    assert.doesNotThrow(() => assertSafeOutputPath(path.join(runnerTemp, 'review', 'report.json')));
    assert.doesNotThrow(() => assertSafeOutputPath(path.join(repositoryRoot, 'review-artifacts', 'report.json')));
    for (const [file, hash] of before) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('offline baseline raw validation, conversion, and converted validation all pass', () => {
  const verification = verifyPinnedBaseline(config);
  const rawReport = validateRawDocument(verification.prepared, config);
  assert.equal(rawReport.passed, true, JSON.stringify(rawReport.errors));
  const converted = convertDocument(verification.prepared, config);
  assert.equal(converted.length, 1377);
  const convertedReport = validateConvertedProducts(converted, config);
  assert.equal(convertedReport.passed, true, JSON.stringify(convertedReport.errors.slice(0, 5)));
});

test('zero rejected, unparseable, duplicate source, and duplicate canonical counts are required', () => {
  const cfg = testConfig();
  const report = validateRawDocument(rawDocument([raw()], cfg), cfg);
  assert.equal(report.passed, true);
  assert.equal(report.summary.rejectedCards, 0);
  assert.equal(report.summary.unparseableCards, 0);
  assert.equal(report.summary.duplicateSourceIdentities, 0);
  assert.equal(report.summary.duplicateCanonicalIdentities, 0);
});

test('all three complete Avicentra records remain allowed with one Krmeni.cz offer and pinned prices', () => {
  assert.equal(avicentraFixture.provenance.sourceCatalogSha256, '6dc596ff1c64bab86ec0413bd8d0e5ae28c19681f7537c3435f5f6ac193f8c23');
  const expectedPrices = new Map([
    ['krmeni-avicentra-osmak-degu-deluxe-1kg', 97],
    ['krmeni-avicentra-osmak-degu-deluxe-2x1kg', 194],
    ['krmeni-avicentra-osmak-degu-deluxe-500g', 54],
  ]);
  assert.equal(avicentraFixture.products.length, 3);
  for (const product of avicentraFixture.products) {
    assert.equal(config.catalogExclusionContract.legacyExcludedProductIds.includes(product.id), false);
    assert.equal(exclusionReason(product, config), null);
    assert.equal(product.offers.length, 1);
    assert.equal(product.offers[0].partner, 'Krmeni.cz');
    assert.equal(product.offers[0].price, expectedPrices.get(product.id));
    assert.ok(product.name && product.type && product.species && product.image && product.size);
  }
});

test('workflow remains dispatch-only, read-only, temporary, ordered, and non-mutating', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'scrape.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 50/);
  assert.match(workflow, /runner\.temp/);
  assert.match(workflow, /if: success\(\)/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /\bgit\s+(?:add|commit|push)\b|\bdeploy\b/i);
  assert.ok(workflow.indexOf('Prepare immutable baseline preflight') < workflow.indexOf('Scrape into temporary staging'));
  assert.ok(workflow.indexOf('Validate raw staging output') < workflow.indexOf('Convert into temporary staging'));
  assert.ok(workflow.indexOf('Convert into temporary staging') < workflow.indexOf('Validate converted staging output'));
});

test('unsafe raw, conversion, converted, and report destinations fail closed', () => {
  const cfg = testConfig();
  const invalidRaw = rawDocument([raw({ price: 'not a price' })], cfg, { rejectedCards: 1, rejectedReasons: { invalid_price: 1 } });
  assert.equal(validateRawDocument(invalidRaw, cfg).passed, false);
  assert.throws(() => convertDocument(invalidRaw, cfg), /invalid current price/i);
  const maliciousConverted = [convertProduct(raw(), cfg)];
  maliciousConverted[0].offers[0].affiliateUrl = `${CJ_AFFILIATE_PREFIX}${encodeURIComponent('https://evil.example/product')}`;
  assert.equal(validateConvertedProducts(maliciousConverted, cfg).passed, false);
  assert.throws(() => assertSafeOutputPath('products.json'), /tracked snapshot/i);
});

test('bounded credential redaction handles triple, six-layer, mixed-case, userinfo, malformed, and over-limit encoding', () => {
  const sentinels = [
    'ZQ9NEWAUDITCRED837461', 'SIXLAYERBEARER930174', 'MIXEDCASEAUTH440182',
    'TRIPLEPROPERTY230914', 'SIXPROPERTY661904', 'USERINFO840173', 'MALFORMED771204', 'OVERLIMIT903177',
  ];
  const triple = encodeLayers(`Authorization: Bearer ${sentinels[0]}`, 3);
  const six = encodeLayers(encodeAllAscii(`Authorization: Bearer ${sentinels[1]}`), 5);
  const mixed = encodeLayers(`Authorization: Bearer ${sentinels[2]}`, 3).replace(/%[0-9A-F]{2}/g, match => `%${match.slice(1).toLowerCase()}`);
  const tripleProperty = encodeLayers(`${encodeAllAscii('token')}=${sentinels[3]}`, 2);
  const sixProperty = encodeLayers(`${encodeAllAscii('access_token')}=${encodeAllAscii(sentinels[4])}`, 5);
  const userinfo = encodeLayers(encodeAllAscii(`https://user:${sentinels[5]}@example.test/path`), 5);
  const malformed = `ordinary malformed context token=${sentinels[6]}%G0`;
  const malformedName = `ordinary malformed name to%G0ken=${sentinels[6]}`;
  const overLimit = encodeLayers(encodeAllAscii(`Authorization: Bearer ${sentinels[7]}`), 12);
  const inputs = [triple, six, mixed, tripleProperty, sixProperty, userinfo, malformed, malformedName, overLimit];
  const output = inputs.map(redactDiagnosticText).join('\n');
  assertNoCredentialVariants(output, sentinels, inputs);
  assert.match(output, /REDACTED/);
  assert.match(output, /ordinary malformed context/);
  assert.equal(redactDiagnosticText('ordinary timeout while waiting for selector'), 'ordinary timeout while waiting for selector');
});

test('diagnostic object serialization redacts encoded keys and values and survives hostile values', () => {
  const directory = tempDirectory();
  const output = path.join(directory, 'hostile-diagnostic.json');
  const keySentinel = 'ENCODEDPROPERTY551204';
  const valueSentinel = 'ENCODEDVALUE771035';
  const aggregateSentinel = 'AGGREGATE661205';
  const causeSentinel = 'DEEPCAUSE401275';
  const encodedKey = encodeLayers(encodeAllAscii('token'), 5);
  const circular = { context: 'useful circular context' };
  circular.self = circular;
  const aggregate = new AggregateError([new Error(encodeLayers(`Authorization: Bearer ${aggregateSentinel}`, 6))], 'useful aggregate context');
  aggregate.cause = new Error(`level one token=${causeSentinel}`);
  const hostile = {
    [encodedKey]: valueSentinel,
    keyContext: `${encodedKey}=${keySentinel}`,
    aggregate,
    circular,
    big: 123n,
    symbolValue: Symbol('safe symbol'),
    get throwing() { throw new Error('getter must not execute'); },
  };
  hostile.throwingProxy = new Proxy({}, { ownKeys() { throw new Error('proxy ownKeys must not escape'); }, getPrototypeOf() { throw new Error('proxy prototype must not escape'); } });
  try {
    assert.doesNotThrow(() => writeJson(output, hostile));
    const text = fs.readFileSync(output, 'utf8');
    assertNoCredentialVariants(text, [keySentinel, valueSentinel, aggregateSentinel, causeSentinel], [encodedKey]);
    assert.match(text, /useful aggregate context/);
    assert.match(text, /useful circular context/);
    assert.match(text, /Circular/);
    assert.match(text, /Accessor/);
    assert.match(text, /BigInt/);
    assert.match(text, /Unprintable diagnostic value/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('scrape failure JSON and converter failure stderr remove every credential encoding layer', async () => {
  const directory = tempDirectory();
  const failureReportPath = path.join(directory, 'scrape-failure.json');
  const scrapeSentinel = 'SCRAPEFAILURE991247';
  const convertSentinel = 'CONVERTSTDERR417920';
  const encodedScrape = encodeLayers(`Authorization: Bearer ${scrapeSentinel}`, 6);
  const encodedConvert = encodeLayers(`Authorization: Bearer ${convertSentinel}`, 6);
  try {
    await assert.rejects(runScraperToFiles({
      outputPath: path.join(directory, 'raw.json'),
      failureReportPath,
      scrapeFunction: async () => {
        const error = new Error(`useful scrape failure ${encodedScrape}`);
        error.stack = `${error.message}\nstack ${encodedScrape}`;
        error.cause = new AggregateError([new Error(encodedScrape)], encodedScrape);
        throw error;
      },
    }));
    const failureText = fs.readFileSync(failureReportPath, 'utf8');
    assertNoCredentialVariants(failureText, [scrapeSentinel], [encodedScrape]);
    assert.match(failureText, /useful scrape failure/);

    const convertPath = path.resolve(__dirname, '..', 'convert-superzoo.js');
    const missing = path.join(directory, `${encodedConvert}.json`);
    const child = spawnSync(process.execPath, [convertPath, `--input=${missing}`, `--output=${path.join(directory, 'converted.json')}`], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assertNoCredentialVariants(`${child.stdout}\n${child.stderr}`, [convertSentinel], [encodedConvert]);
    assert.match(child.stderr, /ENOENT|no such file/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('converter success stdout redacts credential-like input and output paths', () => {
  const directory = tempDirectory();
  const inputSentinel = 'SUCCESSINPUT710924';
  const outputSentinel = 'SUCCESSOUTPUT820135';
  const input = path.join(directory, `token=${inputSentinel}.json`);
  const output = path.join(directory, `access_token=${outputSentinel}.json`);
  const convertPath = path.resolve(__dirname, '..', 'convert-superzoo.js');
  try {
    fs.writeFileSync(input, JSON.stringify({ products: [raw()] }), { encoding: 'utf8', flag: 'wx' });
    const child = spawnSync(process.execPath, [convertPath, `--input=${input}`, `--output=${output}`], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assertNoCredentialVariants(`${child.stdout}\n${child.stderr}`, [inputSentinel, outputSentinel]);
    assert.match(child.stdout, /\[REDACTED_CREDENTIAL\]/);
    assert.equal(fs.existsSync(output), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('affiliate guard recursively rejects nested destinations through repeated values and bounded encoding layers', () => {
  const nestedRedirect = 'https://safe.invalid/?redirect=https://evil.invalid/';
  const nestedDestination = 'https://safe.invalid/?destination=https://evil.invalid/';
  const targets = [
    `https://www.superzoo.cz/product/?state=${encodeURIComponent(nestedRedirect)}`,
    `https://www.superzoo.cz/product/?payload=${encodeLayers(nestedDestination, 2)}`,
    `https://www.superzoo.cz/product/?state=${encodeLayers(nestedRedirect, 3)}`,
    `https://www.superzoo.cz/product/?state=${encodeLayers(nestedRedirect, 6)}`,
    `https://www.superzoo.cz/product/?state=safe&state=${encodeLayers(nestedRedirect, 3)}`,
    `https://www.superzoo.cz/product/?payload=${encodeURIComponent(`https://safe.invalid/?${encodeAllAscii('redirect')}=${encodeURIComponent('https://evil.invalid/')}`)}`,
    `https://www.superzoo.cz/product/?payload=${encodeURIComponent('https://safe.invalid/?re%64irect%3Dhttps%253A%252F%252Fevil.invalid%252F')}`,
    `https://www.superzoo.cz/product/?payload=${encodeURIComponent('https://safe.invalid/?ReDiReCtUrL=https://evil.invalid/')}`,
    `https://www.superzoo.cz/product/?payload=${encodeURIComponent(`https://one.invalid/?state=${encodeURIComponent(nestedDestination)}`)}`,
    'https://www.superzoo.cz/product/?payload=%2525G0',
    `https://www.superzoo.cz/product/?payload=${encodeLayers(nestedRedirect, 12)}`,
  ];
  for (const name of ['url', 'redirect', 'redirect_url', 'redirectUri', 'destination', 'dest', 'target', 'return', 'returnUrl', 'next', 'continue', 'callback']) {
    targets.push(`https://www.superzoo.cz/product/?state=${encodeURIComponent(`https://safe.invalid/?${name}=https://evil.invalid/`)}`);
  }
  for (const target of targets) {
    const affiliate = `${CJ_AFFILIATE_PREFIX}${encodeURIComponent(target)}`;
    assert.equal(validateAffiliateUrl(affiliate, config), false, target);
    assert.throws(() => buildAffiliateUrl(target, config), /nested destination|percent|encoded|unstable/i, target);
  }
});

test('all immutable baseline affiliate URLs remain accepted and byte-identical', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'baselines', 'superzoo-legacy-1405.json'), 'utf8'));
  let accepted = 0;
  for (const product of baseline.products) {
    assert.equal(validateAffiliateUrl(product.affiliateUrl, config), true, product.url);
    assert.equal(normalizeRawProduct(product, config).affiliateUrl, product.affiliateUrl, product.url);
    accepted += 1;
  }
  assert.equal(accepted, 1405);
});

test('output roots are allowlisted and external, sibling-prefix, protected, relative escape, drive, and UNC paths fail closed', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const directory = tempDirectory();
  const reviewPath = path.join(repositoryRoot, 'review-artifacts', `guard-${crypto.randomUUID()}`, 'report.json');
  const external = path.join(path.parse(os.tmpdir()).root, `superzoo-external-${crypto.randomUUID()}.json`);
  const lookalike = path.join(`${os.tmpdir()}-lookalike-${crypto.randomUUID()}`, 'report.json');
  const protectedPaths = [
    'package.json', 'package-lock.json', 'products.json', '.github/workflows/scrape.yml', 'config/safety-thresholds.json',
    'lib/safety.js', 'scraper.js', 'test/fixtures/valid-category.html',
    'test/fixtures/baselines/superzoo-legacy-1405.json', 'test/fixtures/avicentra-manual-review-later.json',
  ].map(candidate => path.join(repositoryRoot, candidate));
  try {
    assert.doesNotThrow(() => assertSafeOutputPath(path.join(directory, 'child', 'report.json')));
    assert.doesNotThrow(() => assertSafeOutputPath(reviewPath));
    assert.throws(() => assertSafeOutputPath(external), /approved/i);
    assert.throws(() => assertSafeOutputPath(lookalike), /approved/i);
    assert.throws(() => assertSafeOutputPath(path.join(directory, '..', '..', `escape-${crypto.randomUUID()}.json`)), /approved/i);
    for (const candidate of protectedPaths) assert.throws(() => assertSafeOutputPath(candidate), /Refusing/i, candidate);
    if (process.platform === 'win32') {
      assert.throws(() => assertSafeOutputPath('C:drive-relative-output.json'), /approved/i);
      assert.throws(() => assertSafeOutputPath('\\\\localhost\\C$\\arbitrary-output.json'), /approved|inspect|resolve/i);
      assert.doesNotThrow(() => assertSafeOutputPath(path.join(directory.toUpperCase(), 'case-safe.json')));
    } else {
      assert.throws(() => assertSafeOutputPath('/var/tmp-superzoo-lookalike/output.json'), /approved/i);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('RUNNER_TEMP is independently accepted in an isolated process', () => {
  const directory = tempDirectory();
  const runnerTemp = path.join(directory, 'runner-root');
  fs.mkdirSync(runnerTemp);
  const safetyPath = path.resolve(__dirname, '..', 'lib', 'safety.js');
  const fakeOsTemp = path.join(path.parse(runnerTemp).root, `not-the-real-temp-${crypto.randomUUID()}`);
  const script = `const os=require('node:os'); os.tmpdir=()=>${JSON.stringify(fakeOsTemp)}; const s=require(${JSON.stringify(safetyPath)}); s.assertSafeOutputPath(${JSON.stringify(path.join(runnerTemp, 'review', 'report.json'))});`;
  try {
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: runnerTemp } });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('output guard rejects directory junctions and file symlinks without touching their targets', () => {
  const directory = tempDirectory();
  const repositoryRoot = path.resolve(__dirname, '..');
  const outside = tempDirectory();
  const outsideFile = path.join(outside, 'protected.txt');
  fs.writeFileSync(outsideFile, 'outside-original', { encoding: 'utf8', flag: 'wx' });
  try {
    const outwardLink = path.join(directory, 'outward-link');
    fs.symlinkSync(outside, outwardLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertSafeOutputPath(path.join(outwardLink, 'new.json')), /symlink|junction/i);

    const repositoryLink = path.join(directory, 'repository-link');
    fs.symlinkSync(repositoryRoot, repositoryLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertSafeOutputPath(path.join(repositoryLink, 'package.json')), /symlink|junction|repository/i);

    const fileLink = path.join(directory, 'file-link.json');
    let fileSymlinkAvailable = true;
    try { fs.symlinkSync(outsideFile, fileLink, 'file'); } catch (error) {
      fileSymlinkAvailable = false;
      assert.ok(process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code), String(error));
    }
    if (fileSymlinkAvailable) assert.throws(() => assertSafeOutputPath(fileLink), /symlink|junction|existing/i);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-original');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('writeJson and writeJsonAtomic never replace an existing final target', () => {
  const directory = tempDirectory();
  try {
    for (const [name, writer] of [['direct', writeJson], ['atomic', writeJsonAtomic]]) {
      const target = path.join(directory, `${name}.json`);
      const original = Buffer.from(`protected-${name}`);
      fs.writeFileSync(target, original, { flag: 'wx' });
      assert.throws(() => writer(target, { replaced: true }), /existing final output/i);
      assert.deepEqual(fs.readFileSync(target), original);
    }
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('atomic finalization fails a final-target race without overwrite or owned temp residue', () => {
  const directory = tempDirectory();
  const target = path.join(directory, 'race.json');
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (temporary, final) => {
    if (!injected) {
      injected = true;
      fs.writeFileSync(final, 'foreign-race-winner', { encoding: 'utf8', flag: 'wx' });
    }
    return originalLink(temporary, final);
  };
  try {
    assert.throws(() => writeJsonAtomic(target, { mustNotWin: true }), error => error?.code === 'EEXIST');
    assert.equal(fs.readFileSync(target, 'utf8'), 'foreign-race-winner');
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a pre-existing temp candidate is never overwritten and a fresh exclusive candidate is used', () => {
  const directory = tempDirectory();
  const target = path.join(directory, 'exclusive-temp.json');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  let attackerPath;
  let injected = false;
  fs.openSync = (candidate, flags, mode) => {
    if (!injected && String(candidate).includes('.tmp-') && flags === 'wx') {
      injected = true;
      attackerPath = candidate;
      const descriptor = originalOpen(candidate, 'wx', 0o600);
      try { originalWrite(descriptor, Buffer.from('attacker-owned')); } finally { fs.closeSync(descriptor); }
    }
    return originalOpen(candidate, flags, mode);
  };
  try {
    writeJsonAtomic(target, { ok: true });
    assert.equal(fs.readFileSync(attackerPath, 'utf8'), 'attacker-owned');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
    fs.unlinkSync(attackerPath);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('non-sensitive diagnostic text stays readable', () => {
  assert.equal(redactDiagnosticText('ordinary timeout while waiting for selector'), 'ordinary timeout while waiting for selector');
});
