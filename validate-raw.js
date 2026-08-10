'use strict';

const { assertSafeOutputPath, buildIdentity, canonicalizeProductUrl, countByCategory, exclusionReason, loadConfig, normalizeRawProduct, parseCliArgs, readJson, redactDiagnosticText, writeJson } = require('./lib/safety');
const { classifyNormalizedProducts } = require('./lib/cross-category-dedupe');

function issue(collection, code, message, productIndex = null, identity = null) { collection.push({ code, message: redactDiagnosticText(message), productIndex, identity: identity == null ? null : redactDiagnosticText(identity) }); }
function sumCounts(counts) { return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0); }
function validateAvailability(value, errors, index) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(errors, 'invalid_availability', 'availability must be an object when present.', index); return; }
  if (!['in_stock', 'unknown'].includes(value.status)) issue(errors, 'invalid_availability_status', 'availability.status must be in_stock or unknown.', index);
  if (value.rawText !== null && typeof value.rawText !== 'string') issue(errors, 'invalid_availability_raw_text', 'availability.rawText must be a string or null.', index);
  if (typeof value.rawText === 'string' && value.rawText !== value.rawText.replace(/\s+/g, ' ').trim()) issue(errors, 'invalid_availability_raw_text', 'availability.rawText must be whitespace-normalized.', index);
}

function validateConfigContract(config) {
  const errors = [];
  const baseline = config?.baselineContract;
  const legacy = baseline?.preFilter;
  const comparator = baseline?.postExclusion;
  if (config?.schemaVersion !== 2 || baseline?.kind !== 'immutable_legacy_raw_comparator_source'
      || !baseline?.artifactPath || !baseline?.expectedSha256) issue(errors, 'invalid_baseline_contract', 'Expected an immutable legacy raw comparator artifact contract.');
  if (!legacy || sumCounts(legacy.categoryCounts) !== legacy.totalProducts) issue(errors, 'invalid_legacy_metadata', 'Legacy category counts must sum to legacy total.');
  if (!comparator || sumCounts(comparator.categoryCounts) !== comparator.totalProducts) issue(errors, 'invalid_comparator_metadata', 'Comparator category counts must sum to comparator total.');
  if (legacy && comparator && legacy.totalProducts - comparator.totalProducts !== comparator.filteredOutProducts) issue(errors, 'invalid_filter_delta', 'Legacy minus comparator total must equal filteredOutProducts.');
  const contract = config?.catalogExclusionContract;
  if (contract?.legacyExcludedProductIds?.length !== contract?.activeExclusionCount) issue(errors, 'exclusion_contract_mismatch', 'Active exclusion ID count mismatch.');
  if (contract?.superZooExcludedCanonicalUrls?.length !== contract?.superZooStableUrlCount) issue(errors, 'exclusion_url_contract_mismatch', 'SuperZoo stable URL count mismatch.');
  if (contract?.manualReviewLaterProductIds?.length !== contract?.manualReviewLaterCount) issue(errors, 'manual_review_contract_mismatch', 'manualReviewLater count mismatch.');
  const active = new Set(contract?.legacyExcludedProductIds || []);
  if ((contract?.manualReviewLaterProductIds || []).some(id => active.has(id))) issue(errors, 'manual_review_active_overlap', 'manualReviewLater IDs must not be active exclusions.');
  const canonicalUrls = [];
  for (const url of contract?.superZooExcludedCanonicalUrls || []) {
    try { canonicalUrls.push(canonicalizeProductUrl(url, config)); } catch (error) { issue(errors, 'invalid_exclusion_url', redactDiagnosticText(error)); }
  }
  if (new Set(canonicalUrls).size !== canonicalUrls.length) issue(errors, 'duplicate_exclusion_url', 'Stable exclusion URLs must be unique.');
  return errors;
}

function validateRawDocument(document, config, options = {}) {
  const errors = validateConfigContract(config);
  const warnings = [];
  const products = Array.isArray(document?.products) ? document.products : [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) issue(errors, 'invalid_top_level', 'Raw output must be a JSON object.');
  if (document?.schemaVersion !== 2) issue(errors, 'invalid_schema_version', 'Raw output schemaVersion must be 2.');
  if (document?.source !== 'superzoo.cz') issue(errors, 'invalid_source', 'Raw output source must be superzoo.cz.');
  if (document?.reviewOnly !== true) issue(errors, 'not_review_only', 'Raw output must declare reviewOnly=true.');
  const declaredRequiredCategories = Array.isArray(document?.requiredCategories) ? document.requiredCategories : [];
  if (declaredRequiredCategories.length !== config.sourcePolicy.requiredCategories.length
      || declaredRequiredCategories.some((category, index) => category !== config.sourcePolicy.requiredCategories[index])) {
    issue(errors, 'required_category_contract_mismatch', 'Raw output requiredCategories must exactly match the pinned ordered category contract.');
  }
  if (!Array.isArray(document?.products)) issue(errors, 'missing_products_array', 'Raw output must contain products array.');
  if (products.length === 0) issue(errors, 'empty_result', 'Raw output contains zero products.');
  if (document?.totalProducts !== products.length) issue(errors, 'total_count_mismatch', `totalProducts=${document?.totalProducts}, actual=${products.length}.`);
  if (!document?.categoryCounts || typeof document.categoryCounts !== 'object' || Array.isArray(document.categoryCounts)) issue(errors, 'missing_category_counts', 'Raw output must contain categoryCounts object.');
  if (!document?.runStats || typeof document.runStats !== 'object') issue(errors, 'missing_run_stats', 'Raw output must contain runStats.');

  const normalized = [];
  for (const [index, product] of products.entries()) {
    validateAvailability(product?.availability, errors, index);
    let current;
    try { current = normalizeRawProduct(product, config); } catch (error) { issue(errors, 'invalid_or_foreign_url', redactDiagnosticText(error), index); continue; }
    normalized.push(current);
    const expected = buildIdentity(product, config);
    if (!current.name) issue(errors, 'missing_name', 'Product name is empty.', index);
    if (!Number.isFinite(current.price) || current.price <= 0) issue(errors, 'invalid_price', `Current price must be positive; received ${current.price}.`, index);
    if (!/^https?:\/\//i.test(current.image) || /^data:/i.test(current.image) || /placeholder/i.test(current.image)) issue(errors, 'missing_image', 'Product image must be a usable http/https URL.', index);
    if (!current.sourceIdentity || !current.canonicalIdentity) issue(errors, 'missing_identity', 'Product requires deterministic source and canonical identity.', index);
    if (current.sourceIdentity !== expected.sourceIdentity || current.canonicalIdentity !== expected.canonicalIdentity || current.canonicalUrl !== expected.canonicalUrl) issue(errors, 'identity_mismatch', 'Identity does not match canonical URL and variant.', index);
    const excluded = exclusionReason(current, config);
    if (excluded) issue(errors, 'out_of_scope_product', `Out-of-scope product reached raw output (${excluded}): ${current.name}.`, index, current.canonicalUrl);

  }

  const duplicateClassification = classifyNormalizedProducts(normalized);
  for (const conflict of duplicateClassification.conflicts) {
    issue(errors, conflict.code, `${conflict.code}: categories=${conflict.categories.join(', ')}; differingFields=${conflict.differingFields.join(', ') || 'none'}.`, conflict.indexes[0], conflict.identity);
  }
  const legitimateDuplicateRows = duplicateClassification.legitimateClusters.reduce((total, cluster) => total + cluster.entries.length, 0);

  const categoryCounts = countByCategory(normalized);
  for (const category of config.sourcePolicy.requiredCategories) {
    const count = categoryCounts[category] || 0;
    if (count === 0) issue(errors, 'missing_required_category', `Required category is empty: ${category}.`);
    const minimum = config.thresholds.minimumCategoryProducts[category];
    if (!Number.isFinite(minimum) || count < minimum) issue(errors, 'category_below_minimum', `${category}: ${count} products, minimum ${minimum}.`);
  }
  for (const category of new Set([...Object.keys(categoryCounts), ...Object.keys(document?.categoryCounts || {})])) {
    const declared = document?.categoryCounts?.[category] || 0;
    const actual = categoryCounts[category] || 0;
    if (actual !== declared) issue(errors, 'category_count_mismatch', `${category}: declared ${declared}, actual ${actual}.`);
  }
  if (normalized.length < config.thresholds.minimumTotalProducts) issue(errors, 'total_below_minimum', `${normalized.length} products, minimum ${config.thresholds.minimumTotalProducts}.`);
  const comparatorCount = config.baselineContract.postExclusion.totalProducts;
  const dropPercent = Number((((comparatorCount - normalized.length) / comparatorCount) * 100).toFixed(2));
  if (dropPercent > config.thresholds.maximumDropPercent) issue(errors, 'excessive_drop', `Product count dropped ${dropPercent}% from post-exclusion comparator ${comparatorCount}.`);

  const rejectedCards = Number(document?.runStats?.rejectedCards);
  const unparseableCards = Number(document?.runStats?.unparseableCards);
  if (!Number.isFinite(rejectedCards) || rejectedCards < 0) issue(errors, 'invalid_rejected_count', 'rejectedCards must be a non-negative number.');
  else if (rejectedCards > config.thresholds.maximumRejectedCards) issue(errors, 'too_many_rejected_cards', `${rejectedCards} rejected cards, maximum ${config.thresholds.maximumRejectedCards}.`);
  if (!Number.isFinite(unparseableCards) || unparseableCards < 0) issue(errors, 'invalid_unparseable_count', 'unparseableCards must be a non-negative number.');
  else if (unparseableCards > config.thresholds.maximumUnparseableCards) issue(errors, 'too_many_unparseable_cards', `${unparseableCards} unparseable cards, maximum ${config.thresholds.maximumUnparseableCards}.`);
  if ((rejectedCards > 0 || unparseableCards > 0) && (!document?.runStats?.rejectedReasons || Object.keys(document.runStats.rejectedReasons).length === 0)) issue(errors, 'missing_rejected_reasons', 'Rejected/unparseable cards require concrete rejectedReasons.');
  return {
    schemaVersion: 1, validator: 'superzoo-raw', generatedAt: new Date().toISOString(), passed: errors.length === 0,
    baselineContract: { kind: config.baselineContract.kind, artifactPath: config.baselineContract.artifactPath, comparatorProducts: comparatorCount, sourceLegacySha256: config.baselineContract.expectedSha256 },
    summary: { products: normalized.length, comparatorProducts: comparatorCount, dropPercent, rejectedCards, unparseableCards, filteredOutCards: Number(document?.runStats?.filteredOutCards || 0), legitimateCrossCategoryDuplicateClusters: duplicateClassification.legitimateClusters.length, legitimateCrossCategoryDuplicateRows: legitimateDuplicateRows, duplicateSourceIdentities: duplicateClassification.conflicts.filter(conflict => conflict.code === 'duplicate_within_category').length, duplicateCanonicalIdentities: duplicateClassification.conflicts.filter(conflict => conflict.code === 'identity_collision').length, outOfScopeProducts: errors.filter(item => item.code === 'out_of_scope_product').length, categoryCounts },
    diagnostics: { legitimateCrossCategoryDuplicates: duplicateClassification.legitimateClusters.map(cluster => ({ identity: redactDiagnosticText(cluster.identity), categories: cluster.categories, indexes: cluster.entries.map(entry => entry.index) })), duplicateConflicts: duplicateClassification.conflicts.map(conflict => ({ ...conflict, identity: redactDiagnosticText(conflict.identity) })), rejectedReasons: document?.runStats?.rejectedReasons || {} },
    errors, warnings, inputPath: options.inputPath,
  };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.input || !args.report) throw new Error('Usage: node validate-raw.js --input=<raw.json> --report=<report.json> [--config=<config.json>]');
  assertSafeOutputPath(args.report);
  const report = validateRawDocument(readJson(args.input), loadConfig(args.config), { inputPath: args.input });
  writeJson(args.report, report);
  console.log(`[validate-raw] ${report.passed ? 'PASS' : 'FAIL'} products=${report.summary.products} errors=${report.errors.length} warnings=${report.warnings.length}`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) { try { main(); } catch (error) { console.error(`[validate-raw] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { validateConfigContract, validateRawDocument };
