'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertSafeOutputPath, countByCategory, exclusionReason, loadConfig, normalizeRawProduct, parseCliArgs, redactDiagnosticText, sha256, writeJsonAtomic } = require('./lib/safety');

const PROJECT_ROOT = __dirname;

function countsEqual(actual, expected) {
  const keys = new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})]);
  return [...keys].every(key => Number(actual?.[key] || 0) === Number(expected?.[key] || 0));
}

function resolveBaselineArtifactPath(config) {
  const relativePath = config?.baselineContract?.artifactPath;
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Baseline artifactPath must be a repository-relative path.');
  const resolved = path.resolve(PROJECT_ROOT, relativePath);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Baseline artifactPath must stay inside this repository.');
  return resolved;
}

function prepareSnapshot(document, config) {
  if (!document || !Array.isArray(document.products)) throw new Error('Input snapshot must contain a products array.');
  const products = [];
  const filteredReasons = {};
  let filteredOutCards = 0;
  for (const product of document.products) {
    const normalized = normalizeRawProduct(product, config);
    const reason = exclusionReason(normalized, config);
    if (reason) { filteredOutCards += 1; filteredReasons[reason] = (filteredReasons[reason] || 0) + 1; continue; }
    if (!Number.isFinite(normalized.price) || normalized.price <= 0) throw new Error(`Legacy snapshot contains invalid current price for ${normalized.name}.`);
    products.push(normalized);
  }
  return { schemaVersion: 2, scrapedAt: document.scrapedAt, preparedAt: new Date().toISOString(), source: 'superzoo.cz', affiliate: 'CJ - Mazlíček+', reviewOnly: true, preparedFromLegacySnapshot: true, totalProducts: products.length, requiredCategories: config.sourcePolicy.requiredCategories, categoryCounts: countByCategory(products), runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards, rejectedReasons: filteredReasons }, products };
}

function verifyPinnedBaseline(config) {
  const contract = config.baselineContract;
  const artifactPath = resolveBaselineArtifactPath(config);
  const bytes = fs.readFileSync(artifactPath);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== contract.expectedSha256) throw new Error(`Pinned baseline hash mismatch: expected ${contract.expectedSha256}, received ${actualSha256}.`);
  const document = JSON.parse(bytes.toString('utf8'));
  const preFilterCounts = countByCategory(document.products || []);
  if (document.products?.length !== contract.preFilter.totalProducts || !countsEqual(preFilterCounts, contract.preFilter.categoryCounts)) {
    throw new Error('Pinned baseline pre-filter counts do not match the configured contract.');
  }
  const prepared = prepareSnapshot(document, config);
  if (prepared.totalProducts !== contract.postExclusion.totalProducts
      || prepared.runStats.filteredOutCards !== contract.postExclusion.filteredOutProducts
      || !countsEqual(prepared.categoryCounts, contract.postExclusion.categoryCounts)) {
    throw new Error('Pinned baseline post-exclusion counts do not match the configured contract.');
  }
  return {
    artifactPath,
    prepared,
    report: {
      schemaVersion: 1,
      validator: 'superzoo-immutable-baseline',
      generatedAt: new Date().toISOString(),
      passed: true,
      artifactPath: contract.artifactPath,
      sha256: actualSha256,
      preFilterProducts: document.products.length,
      postExclusionProducts: prepared.totalProducts,
      filteredOutProducts: prepared.runStats.filteredOutCards,
      postExclusionCategoryCounts: prepared.categoryCounts,
      errors: [],
      warnings: [],
    },
  };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.output && !args['verify-only']) throw new Error('Usage: node prepare-review-snapshot.js --verify-only OR --output=<temporary-staging.json> [--report=<temporary-report.json>]');
  if (args.output) assertSafeOutputPath(args.output);
  if (args.report) assertSafeOutputPath(args.report);
  const config = loadConfig(args.config);
  const verification = verifyPinnedBaseline(config);
  if (args['verify-only']) {
    const { validateRawDocument } = require('./validate-raw');
    const validation = validateRawDocument(verification.prepared, config, { inputPath: config.baselineContract.artifactPath });
    if (!validation.passed) throw new Error(`Pinned baseline raw validation failed: ${JSON.stringify(validation.errors)}`);
    console.log(`[prepare-review-snapshot] verified offline ${verification.report.preFilterProducts} -> ${verification.prepared.totalProducts}; filtered ${verification.prepared.runStats.filteredOutCards}; raw validation PASS.`);
    return;
  }
  writeJsonAtomic(args.output, verification.prepared);
  if (args.report) writeJsonAtomic(args.report, verification.report);
  console.log(`[prepare-review-snapshot] verified ${verification.report.preFilterProducts} -> ${verification.prepared.totalProducts}; filtered ${verification.prepared.runStats.filteredOutCards}.`);
}

if (require.main === module) { try { main(); } catch (error) { console.error(`[prepare-review-snapshot] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { countsEqual, prepareSnapshot, resolveBaselineArtifactPath, verifyPinnedBaseline };
