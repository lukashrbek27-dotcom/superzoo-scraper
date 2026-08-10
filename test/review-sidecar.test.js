'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadConfig } = require('../lib/safety');
const { CATEGORIES, createReviewSidecar, reviewCategoryValues, runScraperToFiles, scrapeCategory, selectReviewCategories } = require('../scraper');

const config = loadConfig();
const category = { name: 'Krmivo a pamlsky pro hlodavce', animalType: 'rodent' };
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'superzoo-sidecar-test-'));
const sidecarState = () => ({ pages: [], rejectedCards: [], filteredCards: [], rejectedByReason: {}, rejectedByCategory: {}, filteredByType: {}, filteredByCategory: {}, categoryTerminationReasons: {} });

test('review category keys are explicit, ordered, deduplicated, and fail closed outside review mode', () => {
  assert.deepEqual(selectReviewCategories([], null).map(item => item.key), CATEGORIES.map(item => item.key));
  assert.deepEqual(selectReviewCategories(['rodent-food-treats'], 'sidecar.json').map(item => item.key), ['rodent-food-treats']);
  assert.deepEqual(selectReviewCategories(['rodent-food-treats', 'dog-granules', 'rodent-food-treats'], 'sidecar.json').map(item => item.key), ['dog-granules', 'rodent-food-treats']);
  assert.throws(() => selectReviewCategories(['dog-granules'], null), /only with --review-sidecar/i);
  assert.throws(() => selectReviewCategories([''], 'sidecar.json'), /non-empty stable category key/i);
  assert.throws(() => selectReviewCategories(['unknown'], 'sidecar.json'), /Unknown --review-category key: unknown\. Allowed keys: dog-granules/i);
  assert.deepEqual(reviewCategoryValues(['--review-category=dog-granules', '--review-category=', '--review-category']), ['dog-granules', '', '']);
});

test('CLI rejects invalid review category scope before browser launch or output writes', () => {
  const root = directory();
  try {
    const script = path.resolve(__dirname, '..', 'scraper.js');
    for (const argument of ['--review-category=dog-granules', '--review-category=', '--review-category=unknown']) {
      const output = path.join(root, `${Buffer.from(argument).toString('hex')}.json`);
      const failure = `${output}.failure.json`;
      const child = spawnSync(process.execPath, [script, `--output=${output}`, `--failure-report=${failure}`, argument], { encoding: 'utf8' });
      assert.equal(child.status, 1);
      assert.equal(fs.existsSync(output), false);
      assert.equal(fs.existsSync(failure), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review sidecar is opt-in, records safe page/rejected/filtered metadata, and preserves raw products', async () => {
  const state = sidecarState();
  const excludedUrl = config.catalogExclusionContract.superZooExcludedCanonicalUrls[0];
  const page = {
    async evaluate() {
      return {
        selectorMissing: false, selector: '.product-list__item', domFingerprint: 'safe-dom-fingerprint', rejectedCards: 1, unparseableCards: 0,
        rejectedReasons: { missing_name: 1 }, rejectedCardDetails: [{ reason: 'missing_name', cardIndex: 0, sourceProductId: 'REJECTED', name: null, url: 'https://www.superzoo.cz/rejected/?utm_source=x', image: null, price: null }],
        products: [
          { sourceProductId: 'FILTERED', name: 'Seno test 1kg', price: '10 Kč', salePrice: null, originalPrice: null, url: excludedUrl, image: 'https://cdn.superzoo.cz/filtered.jpg', category: category.name, animalType: 'rodent' },
          { sourceProductId: 'FORBIDDEN', name: 'Hay test 1kg', price: '11 Kč', salePrice: null, originalPrice: null, url: 'https://www.superzoo.cz/forbidden-hay/', image: 'https://cdn.superzoo.cz/forbidden.jpg', category: category.name, animalType: 'rodent' },
          { sourceProductId: 'ACCEPTED', name: 'Safe food 1kg', price: '20 Kč', salePrice: null, originalPrice: null, url: 'https://www.superzoo.cz/safe-food-1kg/', image: 'https://cdn.superzoo.cz/safe.jpg', category: category.name, animalType: 'rodent' },
        ],
      };
    },
    url() { return 'https://www.superzoo.cz/drobni-savci/?utm_source=x'; },
  };
  const result = await scrapeCategory(page, category, config, { maxPages: 1, reviewSidecar: state, navigateToCategory: async () => {}, closeCookieDialog: async () => {}, findNextPageControl: async () => null });
  assert.equal(result.products.length, 1);
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0].pageUrl, 'https://www.superzoo.cz/drobni-savci/');
  assert.equal(state.pages[0].pageNumber, null);
  assert.equal(state.pages[0].terminationReason, 'no_next_control');
  assert.deepEqual(state.rejectedCards[0], { category: category.name, pageIndex: 0, reason: 'missing_name', sourceProductId: 'REJECTED', canonicalUrl: 'https://www.superzoo.cz/rejected', name: null, image: null, price: null, size: null, brand: null, cardSelector: '.product-list__item', cardIndex: 0 });
  assert.equal(state.filteredCards[0].filterType, 'stable_source_url');
  assert.equal(state.filteredCards[0].canonicalUrl, excludedUrl);
  assert.equal(state.filteredCards[1].filterType, 'forbidden_name');
  assert.equal(state.filteredCards[1].exclusionRuleId, null);
  const document = createReviewSidecar({ scrapedAt: '2026-01-01T00:00:00.000Z', source: 'superzoo.cz', requiredCategories: [category.name], products: result.products }, state);
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.scopedReview, false);
  assert.deepEqual(document.configuredCategories, CATEGORIES.map(item => item.key));
  assert.deepEqual(document.selectedCategories, CATEGORIES.map(item => item.key));
  assert.deepEqual(document.categories, [category.name]);
  const serialized = JSON.stringify(document);
  assert.equal(/html|cookie|header|session|storage/i.test(serialized), false);
});

test('file output creates a sidecar only when explicitly requested', async () => {
  const root = directory();
  try {
    const raw = { schemaVersion: 2, scrapedAt: '2026-01-01T00:00:00.000Z', source: 'superzoo.cz', reviewOnly: true, totalProducts: 1, requiredCategories: [category.name], categoryCounts: { [category.name]: 1 }, runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards: 0, rejectedReasons: {} }, products: [{ sourceIdentity: 'one', category: category.name }] };
    const output = path.join(root, 'raw.json'); const failure = path.join(root, 'failure.json'); const sidecar = path.join(root, 'sidecar.json');
    await runScraperToFiles({ outputPath: output, failureReportPath: failure, scrapeFunction: async () => raw });
    assert.equal(fs.existsSync(sidecar), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')).products, raw.products);
    const selected = selectReviewCategories(['rodent-food-treats'], sidecar);
    await runScraperToFiles({ outputPath: path.join(root, 'raw-enabled.json'), failureReportPath: path.join(root, 'failure-enabled.json'), reviewSidecarPath: sidecar, categories: selected, scrapeFunction: async ({ reviewSidecar }) => { reviewSidecar.document = createReviewSidecar(raw, reviewSidecar); return raw; } });
    assert.equal(fs.existsSync(sidecar), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'raw-enabled.json'), 'utf8')).products, raw.products);
    const document = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(document.scopedReview, true);
    assert.deepEqual(document.selectedCategories, ['rodent-food-treats']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
