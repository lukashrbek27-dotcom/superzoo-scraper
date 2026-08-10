'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadConfig } = require('../lib/safety');
const { CATEGORIES, createReviewSidecar, main, reviewCategoryValues, reviewMaxPages, runScraperToFiles, scrapeCategory, selectReviewCategories } = require('../scraper');

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

test('review max-pages is fail-closed and available only for a scoped review sidecar', () => {
  const selected = selectReviewCategories(['dog-granules'], 'sidecar.json');
  assert.equal(reviewMaxPages(undefined, 'sidecar.json', selected), undefined);
  assert.equal(reviewMaxPages('1', 'sidecar.json', selected), 1);
  assert.throws(() => reviewMaxPages('1', null, selected), /only with --review-sidecar/i);
  assert.throws(() => reviewMaxPages('1', 'sidecar.json', CATEGORIES), /scoped --review-category/i);
  for (const value of [true, '', '0', '-1', '1.5', '2', 'NaN']) {
    assert.throws(() => reviewMaxPages(value, 'sidecar.json', selected), /exactly 1/i);
  }
});

test('main forwards scoped review max-pages exactly once and omits it by default', async () => {
  const baseArguments = ['--output=raw.json', '--failure-report=failure.json', '--review-sidecar=sidecar.json', '--review-category=dog-granules'];
  let received;
  await main([...baseArguments, '--review-max-pages=1'], { runScraperToFilesFunction: async options => { received = options; } });
  assert.equal(received.maxPages, 1);
  assert.deepEqual(received.categories.map(category => category.key), ['dog-granules']);
  await main(baseArguments, { runScraperToFilesFunction: async options => { received = options; } });
  assert.equal(Object.hasOwn(received, 'maxPages'), false);
});

test('invalid review max-pages CLI input fails before browser launch or output writes', () => {
  const root = directory();
  try {
    const script = path.resolve(__dirname, '..', 'scraper.js');
    const validScope = ['--review-sidecar=sidecar.json', '--review-category=dog-granules'];
    const invalidInvocations = [
      ['--review-max-pages=1'],
      ['--review-sidecar=sidecar.json', '--review-max-pages=1'],
      [...validScope, '--review-max-pages'],
      [...validScope, '--review-max-pages='],
      ...['0', '-1', '1.5', '2', 'NaN'].map(value => [...validScope, `--review-max-pages=${value}`]),
    ];
    for (const [index, argumentsForRun] of invalidInvocations.entries()) {
      const output = path.join(root, `invalid-max-pages-${index}.json`);
      const failure = `${output}.failure.json`;
      const child = spawnSync(process.execPath, [script, `--output=${output}`, `--failure-report=${failure}`, ...argumentsForRun], { encoding: 'utf8' });
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

test('scoped review maxPages stops after the first page without advancing pagination', async () => {
  const state = sidecarState();
  const page = {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      if (this.calls > 1) throw new Error('A second listing page must not be evaluated.');
      return {
        selectorMissing: false, selector: '.product-list__item', domFingerprint: 'first-page', rejectedCards: 0, unparseableCards: 0,
        rejectedReasons: {}, rejectedCardDetails: [],
        products: [{ sourceProductId: 'FIRST', name: 'Safe food 1kg', price: '20 KÄŤ', salePrice: null, originalPrice: null, url: 'https://www.superzoo.cz/first-page-food/', image: 'https://cdn.superzoo.cz/first.jpg', category: category.name, animalType: 'rodent' }],
      };
    },
    url() { return 'https://www.superzoo.cz/drobni-savci/'; },
  };
  let nextControlChecks = 0;
  const result = await scrapeCategory(page, category, config, {
    maxPages: 1, reviewSidecar: state, navigateToCategory: async () => {}, closeCookieDialog: async () => {},
    findNextPageControl: async () => { nextControlChecks += 1; return {}; },
  });
  assert.equal(result.products.length, 1);
  assert.equal(page.calls, 1);
  assert.equal(nextControlChecks, 1);
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0].terminationReason, 'review_max_pages');
  assert.equal(state.categoryTerminationReasons[category.name], 'review_max_pages');
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
    let receivedOptions;
    await runScraperToFiles({ outputPath: path.join(root, 'raw-enabled.json'), failureReportPath: path.join(root, 'failure-enabled.json'), reviewSidecarPath: sidecar, categories: selected, maxPages: 1, scrapeFunction: async options => { receivedOptions = options; options.reviewSidecar.document = createReviewSidecar(raw, options.reviewSidecar); return raw; } });
    assert.equal(fs.existsSync(sidecar), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'raw-enabled.json'), 'utf8')).products, raw.products);
    const document = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(document.scopedReview, true);
    assert.deepEqual(document.selectedCategories, ['rodent-food-treats']);
    assert.equal(receivedOptions.maxPages, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
