'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { convertDocument, convertProduct } = require('../convert-superzoo');
const { canonicalizeCrossCategoryProducts } = require('../lib/cross-category-dedupe');
const { loadConfig } = require('../lib/safety');
const { validateRawDocument } = require('../validate-raw');

const config = loadConfig();
const normalCategory = 'Granule pro psy';
const veterinaryCategory = 'Veterinární diety pro psy';
const otherCategory = 'Granule pro kočky';

function testConfig(categories = [normalCategory, veterinaryCategory]) {
  const copy = structuredClone(config);
  const counts = Object.fromEntries(categories.map(name => [name, 1]));
  copy.sourcePolicy.requiredCategories = categories;
  copy.baselineContract.preFilter.totalProducts = categories.length;
  copy.baselineContract.preFilter.categoryCounts = counts;
  copy.baselineContract.postExclusion.totalProducts = categories.length;
  copy.baselineContract.postExclusion.filteredOutProducts = 0;
  copy.baselineContract.postExclusion.categoryCounts = counts;
  copy.thresholds.minimumTotalProducts = 1;
  copy.thresholds.minimumCategoryProducts = counts;
  return copy;
}

function raw(overrides = {}) {
  return {
    sourceProductId: 'same-offer', name: 'Eukanuba VD Intestinal Formula Dog 12kg', price: 999,
    salePrice: null, originalPrice: null, url: 'https://www.superzoo.cz/eukanuba-vd-intestinal-formula-dog-12kg/',
    image: 'https://cdn.superzoo.cz/product.jpg', category: normalCategory, animalType: 'dog',
    availability: { status: 'unknown', rawText: null }, ...overrides,
  };
}

function document(products, cfg) {
  return {
    schemaVersion: 2, source: 'superzoo.cz', reviewOnly: true, totalProducts: products.length,
    requiredCategories: cfg.sourcePolicy.requiredCategories,
    categoryCounts: products.reduce((counts, product) => ({ ...counts, [product.category]: (counts[product.category] || 0) + 1 }), {}),
    runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards: 0, rejectedReasons: {} }, products,
  };
}

test('identical cross-category offers canonicalize once and preserve all source categories', () => {
  const cfg = testConfig();
  const inputs = [raw(), raw({ category: veterinaryCategory })];
  const groups = canonicalizeCrossCategoryProducts(inputs, cfg);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sourceCategories, [normalCategory, veterinaryCategory].sort());
  assert.equal(convertDocument(document(inputs, cfg), cfg).length, 1);
  const report = validateRawDocument(document(inputs, cfg), cfg);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.summary.legitimateCrossCategoryDuplicateClusters, 1);
  assert.equal(report.summary.legitimateCrossCategoryDuplicateRows, 2);
});

test('veterinary category semantics survive canonicalization independently of input order', () => {
  const cfg = testConfig();
  const inputs = [raw(), raw({ category: veterinaryCategory })];
  const forward = convertDocument(document(inputs, cfg), cfg);
  const reverse = convertDocument(document([...inputs].reverse(), cfg), cfg);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward[0].dietTags, ['veterinary']);
});

test('commercial availability and price conflicts fail closed', () => {
  const cfg = testConfig();
  assert.throws(() => convertDocument(document([raw(), raw({ category: veterinaryCategory, price: 1000 })], cfg), cfg), /cross_category_commercial_conflict/);
  assert.throws(() => convertDocument(document([raw(), raw({ category: veterinaryCategory, availability: { status: 'in_stock', rawText: 'Skladem' } })], cfg), cfg), /cross_category_commercial_conflict/);
});

test('identity collisions and within-category duplicates fail closed', () => {
  const cfg = testConfig();
  assert.throws(() => convertDocument(document([raw(), raw({ category: veterinaryCategory, url: 'https://www.superzoo.cz/different-product/' })], cfg), cfg), /identity_collision/);
  assert.throws(() => convertDocument(document([raw(), raw()], testConfig([normalCategory])), testConfig([normalCategory])), /duplicate_within_category/);
});

test('single-category conversion remains unchanged', () => {
  const cfg = testConfig([normalCategory]);
  const input = raw();
  assert.deepEqual(convertDocument(document([input], cfg), cfg), [convertProduct(input, cfg)]);
});
