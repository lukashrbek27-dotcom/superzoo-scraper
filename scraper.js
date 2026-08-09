'use strict';

const { chromium } = require('playwright');
const { countByCategory, exclusionReason, loadConfig, normalizeRawProduct, parseCliArgs, assertSafeOutputPath, redactDiagnosticText, serializeDiagnosticError, writeJsonAtomic } = require('./lib/safety');
const { extractProductCards, productCardDomFingerprint } = require('./lib/page-extractor');
const PRODUCT_CARD_DOM_FINGERPRINT_SOURCE = productCardDomFingerprint.toString();

const CATEGORIES = [
  { name: 'Granule pro psy', animalType: 'dog', url: 'https://www.superzoo.cz/psi/krmivo-granule/granule/' },
  { name: 'Veterinární diety pro psy', animalType: 'dog', url: 'https://www.superzoo.cz/psi/granule/veterinarni-diety/' },
  { name: 'Granule pro kočky', animalType: 'cat', url: 'https://www.superzoo.cz/kocky/krmivo-a-pamlsky/granule-pro-kocky/' },
  { name: 'Veterinární diety pro kočky', animalType: 'cat', url: 'https://www.superzoo.cz/kocky/krmivo-a-pamlsky/veterinarni-diety/' },
  { name: 'Plnohodnotné krmivo pro hlodavce', animalType: 'rodent', url: 'https://www.superzoo.cz/drobni-savci/krmivo-a-doplnky-stravy/plnohodnotne-krmivo/' },
  { name: 'Krmivo a pamlsky pro hlodavce', animalType: 'rodent', url: 'https://www.superzoo.cz/drobni-savci/krmivo-a-doplnky-stravy/' },
];

const DEFAULTS = { maxPages: 60, navigationTimeoutMs: 45_000, selectorTimeoutMs: 20_000, paginationTimeoutMs: 20_000, retryAttempts: 3, retryBaseDelayMs: 1_500 };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withRetry(operation, options = {}) {
  const attempts = options.attempts || DEFAULTS.retryAttempts;
  const baseDelayMs = options.baseDelayMs || DEFAULTS.retryBaseDelayMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const waitMs = baseDelayMs * (2 ** (attempt - 1));
      options.onRetry?.(error, attempt, waitMs);
      await delay(waitMs);
    }
  }
  throw lastError;
}

function pageFingerprint(products) { return products.map(product => product.sourceIdentity).sort().join('\n'); }
function assertPageFingerprintChanged(previous, current, categoryName, pageNumber) {
  if (previous && previous === current) throw new Error(`Pagination repeated the same product set for ${categoryName} on page ${pageNumber}.`);
}

function assertPageFingerprintNotSeen(seenFingerprints, current, categoryName, pageNumber) {
  if (seenFingerprints.has(current)) throw new Error(`Pagination returned a previously processed product set for ${categoryName} on page ${pageNumber}.`);
}

async function navigateToCategory(page, category, options) {
  await withRetry(async () => {
    const response = await page.goto(category.url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs });
    if (!response || !response.ok()) throw new Error(`HTTP navigation failed for ${category.name}: ${response?.status() ?? 'no response'}.`);
    const host = new URL(response.url()).hostname.toLowerCase();
    if (!['superzoo.cz', 'www.superzoo.cz'].includes(host)) throw new Error(`Unexpected navigation target for ${category.name}: ${response.url()}`);
    await page.waitForSelector('.product-item, .product-list__item, [data-testid="product-card"], [data-product-id]', { timeout: options.selectorTimeoutMs });
  }, { attempts: options.retryAttempts, baseDelayMs: options.retryBaseDelayMs, onRetry: (error, attempt, waitMs) => console.warn(`[retry] ${category.name}, attempt ${attempt}: ${redactDiagnosticText(error)}; waiting ${waitMs} ms`) });
}

async function closeCookieDialog(page) {
  try { await page.locator('#cookieConsentModal button, .js-cookie-consent button, [data-testid="cookie-consent"] button').first().click({ timeout: 3_000 }); } catch { /* optional */ }
}

async function findNextPageControl(page) {
  const control = page.locator('a, button').filter({ hasText: /Další stránka/i }).first();
  if (await control.count() === 0 || !(await control.isVisible()) || await control.isDisabled().catch(() => false)) return null;
  return control;
}

function canonicalPageUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (!['superzoo.cz', 'www.superzoo.cz'].includes(hostname)) throw new Error(`Unexpected pagination URL host: ${hostname || '(empty)'}`);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) throw new Error('Unsafe pagination URL.');
  parsed.protocol = 'https:';
  parsed.hostname = 'www.superzoo.cz';
  parsed.hash = '';
  parsed.searchParams.sort();
  return parsed.toString();
}

async function readPaginationState(page) {
  const domFingerprint = await page.evaluate(productCardDomFingerprint);
  return { canonicalUrl: canonicalPageUrl(page.url()), domFingerprint };
}

async function waitForPaginationChange(page, previousState, categoryName, options) {
  try {
    await page.waitForFunction(({ previousFingerprint, fingerprintSource }) => {
      const fingerprint = Function(`return (${fingerprintSource});`)();
      const current = fingerprint();
      return Boolean(current && current !== previousFingerprint);
    }, { previousFingerprint: previousState.domFingerprint, fingerprintSource: PRODUCT_CARD_DOM_FINGERPRINT_SOURCE }, { timeout: options.paginationTimeoutMs, polling: 250 });
  } catch {
    throw new Error(`Pagination did not change product content for ${categoryName} within ${options.paginationTimeoutMs} ms.`);
  }
  const nextState = await readPaginationState(page);
  if (!nextState.domFingerprint || nextState.domFingerprint === previousState.domFingerprint) throw new Error(`Pagination repeated the same product content for ${categoryName}.`);
  return nextState;
}

async function clickNextIfExpectedState(page, previousState) {
  return page.evaluate(({ expectedCanonicalUrl, expectedFingerprint, fingerprintSource }) => {
    const fingerprint = Function(`return (${fingerprintSource});`)();
    const domFingerprint = fingerprint();
    const current = new URL(window.location.href);
    const safeUrl = ['http:', 'https:'].includes(current.protocol) && ['superzoo.cz', 'www.superzoo.cz'].includes(current.hostname.toLowerCase())
      && !current.username && !current.password && !current.port;
    if (!safeUrl) return { status: 'unsafe_url', canonicalUrl: '', domFingerprint };
    current.protocol = 'https:';
    current.hostname = 'www.superzoo.cz';
    current.hash = '';
    current.searchParams.sort();
    const canonicalUrl = current.toString();
    if (domFingerprint !== expectedFingerprint) return { status: 'state_changed', canonicalUrl, domFingerprint };
    if (canonicalUrl !== expectedCanonicalUrl) return { status: 'url_changed', canonicalUrl, domFingerprint };
    const control = Array.from(document.querySelectorAll('a, button')).find(element => {
      const label = String(element.innerText || element.textContent || '');
      const disabled = element.disabled || element.getAttribute('aria-disabled') === 'true';
      const visible = Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      return /Dal\u0161\u00ed str\u00e1nka/iu.test(label) && !disabled && visible;
    });
    if (!control) return { status: 'missing_control', canonicalUrl, domFingerprint };
    control.click();
    return { status: 'clicked', canonicalUrl, domFingerprint };
  }, { expectedCanonicalUrl: previousState.canonicalUrl, expectedFingerprint: previousState.domFingerprint, fingerprintSource: PRODUCT_CARD_DOM_FINGERPRINT_SOURCE });
}

async function advancePagination(page, categoryName, previousState, options, dependencies = {}) {
  const attempts = options.paginationRetryAttempts || 2;
  const readState = dependencies.readState || (() => readPaginationState(page));
  const waitForChange = dependencies.waitForChange || (() => waitForPaginationChange(page, previousState, categoryName, options));
  const clickIfExpectedState = dependencies.clickIfExpectedState || (() => clickNextIfExpectedState(page, previousState));
  const wait = dependencies.delay || delay;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let clickResult;
    try { clickResult = await clickIfExpectedState(attempt); } catch (error) { lastError = error; }
    if (clickResult?.status === 'state_changed') return { canonicalUrl: clickResult.canonicalUrl, domFingerprint: clickResult.domFingerprint };
    if (clickResult?.status === 'url_changed') throw new Error(`Pagination URL changed but product content repeated for ${categoryName}.`);
    if (clickResult?.status === 'unsafe_url') throw new Error(`Pagination reached an unsafe URL for ${categoryName}.`);
    if (clickResult?.status === 'missing_control') lastError = new Error(`Pagination control disappeared for ${categoryName}.`);
    try { return await waitForChange(attempt); } catch (error) { lastError = error; }
    const after = await readState();
    if (after.domFingerprint !== previousState.domFingerprint) return after;
    if (after.canonicalUrl !== previousState.canonicalUrl) throw new Error(`Pagination URL changed but product content repeated for ${categoryName}.`);
    if (attempt < attempts) await wait(options.retryBaseDelayMs * (2 ** (attempt - 1)));
  }
  throw new Error(`Pagination transition failed for ${categoryName} after ${attempts} attempts: ${lastError?.message || 'state did not change'}.`);
}

function mergeReasonCounts(target, source) {
  for (const [reason, count] of Object.entries(source || {})) target[reason] = (target[reason] || 0) + count;
}

async function scrapeCategory(page, category, config, options = DEFAULTS) {
  await (options.navigateToCategory || navigateToCategory)(page, category, options);
  await (options.closeCookieDialog || closeCookieDialog)(page);
  const accepted = [];
  const stats = { pages: 0, accepted: 0, filteredOutCards: 0, rejectedCards: 0, unparseableCards: 0, rejectedReasons: {}, selectors: [] };
  const seenFingerprints = new Set();

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
    const extraction = await page.evaluate(extractProductCards, category);
    if (extraction.selectorMissing) throw new Error(`Required product selectors are missing for ${category.name} on page ${pageNumber}.`);
    stats.pages += 1;
    stats.rejectedCards += extraction.rejectedCards;
    stats.unparseableCards += extraction.unparseableCards;
    mergeReasonCounts(stats.rejectedReasons, extraction.rejectedReasons);
    stats.selectors.push(extraction.selector);
    if (extraction.products.length === 0) throw new Error(`Category ${category.name} returned zero valid product cards on page ${pageNumber}; reasons=${JSON.stringify(extraction.rejectedReasons)}.`);

    const currentPage = [];
    for (const extracted of extraction.products) {
      const normalized = normalizeRawProduct(extracted, config);
      const reason = exclusionReason(normalized, config);
      if (reason) { stats.filteredOutCards += 1; stats.rejectedReasons[`filtered_${reason}`] = (stats.rejectedReasons[`filtered_${reason}`] || 0) + 1; continue; }
      if (!Number.isFinite(normalized.price) || normalized.price <= 0) { stats.rejectedCards += 1; stats.rejectedReasons.invalid_price = (stats.rejectedReasons.invalid_price || 0) + 1; continue; }
      accepted.push(normalized);
      currentPage.push(normalized);
    }
    if (currentPage.length === 0) throw new Error(`Category ${category.name} produced no in-scope products on page ${pageNumber}.`);
    const fingerprint = pageFingerprint(currentPage);
    assertPageFingerprintNotSeen(seenFingerprints, fingerprint, category.name, pageNumber);
    seenFingerprints.add(fingerprint);

    const nextControl = await (options.findNextPageControl || findNextPageControl)(page);
    if (!nextControl) break;
    if (pageNumber === options.maxPages) throw new Error(`Category ${category.name} exceeded the ${options.maxPages}-page safety limit.`);
    const previousState = { canonicalUrl: canonicalPageUrl(page.url()), domFingerprint: extraction.domFingerprint };
    await advancePagination(page, category.name, previousState, options);
  }
  if (accepted.length === 0) throw new Error(`Required category ${category.name} is empty.`);
  stats.accepted = accepted.length;
  stats.selectors = [...new Set(stats.selectors)];
  return { products: accepted, stats };
}

async function scrape(options = {}) {
  const config = loadConfig(options.configPath);
  const settings = { ...DEFAULTS, ...options };
  const browserType = options.browserType || chromium;
  const browser = await browserType.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1920, height: 1080 }, locale: 'cs-CZ' });
    context.setDefaultTimeout(settings.selectorTimeoutMs);
    context.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await context.newPage();
    const products = [];
    const categoryStats = {};
    for (const category of options.categories || CATEGORIES) {
      console.log(`[scrape] required category: ${category.name}`);
      const result = await (options.scrapeCategoryFunction || scrapeCategory)(page, category, config, settings);
      categoryStats[category.name] = result.stats;
      products.push(...result.products);
    }
    if (products.length === 0) throw new Error('SuperZoo scrape returned zero products.');
    const sum = key => Object.values(categoryStats).reduce((total, stats) => total + stats[key], 0);
    const rejectedReasons = {}; for (const stats of Object.values(categoryStats)) mergeReasonCounts(rejectedReasons, stats.rejectedReasons);
    return { schemaVersion: 2, scrapedAt: new Date().toISOString(), source: 'superzoo.cz', affiliate: 'CJ - Mazlíček+', reviewOnly: true, totalProducts: products.length, requiredCategories: config.sourcePolicy.requiredCategories, categoryCounts: countByCategory(products), runStats: { rejectedCards: sum('rejectedCards'), unparseableCards: sum('unparseableCards'), filteredOutCards: sum('filteredOutCards'), rejectedReasons, categoryStats }, products };
  } finally { await browser.close(); }
}

async function runScraperToFiles({ outputPath, failureReportPath, configPath, scrapeFunction = scrape }) {
  if (!outputPath || !failureReportPath) throw new Error('Use --output=<staging.json> and --failure-report=<failure.json>.');
  assertSafeOutputPath(outputPath);
  assertSafeOutputPath(failureReportPath);
  try {
    const result = await scrapeFunction({ configPath });
    writeJsonAtomic(outputPath, result);
    console.log(`[scrape] review-only staging output: ${redactDiagnosticText(outputPath)} (${result.totalProducts} products)`);
  } catch (error) {
    writeJsonAtomic(failureReportPath, { schemaVersion: 1, status: 'FAIL', stage: 'scrape', generatedAt: new Date().toISOString(), error: serializeDiagnosticError(error) });
    throw error;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  return runScraperToFiles({
    outputPath: args.output || process.env.SUPERZOO_OUTPUT_PATH,
    failureReportPath: args['failure-report'] || process.env.SUPERZOO_FAILURE_REPORT_PATH,
    configPath: args.config,
  });
}

if (require.main === module) main().catch(error => { console.error(`[scrape] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; });

module.exports = { CATEGORIES, DEFAULTS, advancePagination, assertPageFingerprintChanged, assertPageFingerprintNotSeen, canonicalPageUrl, clickNextIfExpectedState, pageFingerprint, readPaginationState, runScraperToFiles, scrape, scrapeCategory, waitForPaginationChange, withRetry };
