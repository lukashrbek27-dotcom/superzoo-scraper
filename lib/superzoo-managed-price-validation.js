'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaultThresholds = require('../config/price-overlay-thresholds.json');
const {
  assertSafeOutputPath,
  canonicalizeProductUrl,
  parseCliArgs,
  validateAffiliateUrlDetailed,
  writeJsonAtomic,
} = require('./safety');
const { validateManagedSetManifest } = require('./superzoo-price-overlay-managed-set');
const { validateAutomationBaseline } = require('./superzoo-automation-baseline');

const SCHEMA_VERSION = 2;
const SOURCE = 'superzoo-scraper';
const PARTNER = 'SuperZoo';
const PRICE_FIELDS = new Set(['price', 'salePrice', 'originalPrice']);
const ENTRY_FIELDS = new Set(['source', 'partner', 'productId', 'offerIdentity', ...PRICE_FIELDS]);
const DEFAULT_REQUIRED_CATEGORIES = [
  'Granule pro psy',
  'Veterinární diety pro psy',
  'Granule pro kočky',
  'Veterinární diety pro kočky',
  'Plnohodnotné krmivo pro hlodavce',
  'Krmivo a pamlsky pro hlodavce',
];

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function isCanonicalUtcIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function readJsonFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes) };
}

function addBlocker(groups, code, example = null) {
  const group = groups.get(code) || { code, count: 0, examples: [] };
  group.count += 1;
  if (example !== null && group.examples.length < 20) group.examples.push(String(example));
  groups.set(code, group);
}

function canonicalSourceUrl(value, config) {
  try { return canonicalizeProductUrl(value, config); } catch { return null; }
}

function catalogOfferTargetUrl(offer, config) {
  const checked = validateAffiliateUrlDetailed(offer?.affiliateUrl, config);
  if (!checked.valid) return null;
  return canonicalSourceUrl(checked.targetUrl, config);
}

function canonicalPriceState(value, label) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: null, errors: [`${label}_invalid_state`] };
  if (typeof value.price !== 'number' || !Number.isFinite(value.price)) errors.push(`${label}_malformed_price`);
  const hasSale = hasOwn(value, 'salePrice');
  const hasOriginal = hasOwn(value, 'originalPrice');
  if (hasSale !== hasOriginal) errors.push(`${label}_incomplete_sale_pair`);
  const salePrice = hasSale ? value.salePrice : null;
  const originalPrice = hasOriginal ? value.originalPrice : null;
  for (const [field, fieldValue] of [['salePrice', salePrice], ['originalPrice', originalPrice]]) {
    if (fieldValue !== null && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) errors.push(`${label}_malformed_${field}`);
  }
  if (salePrice !== null && originalPrice !== null && (
    salePrice <= 0 || originalPrice <= salePrice || salePrice !== value.price
  )) errors.push(`${label}_invalid_sale_combination`);
  return { state: errors.length ? null : { price: value.price, salePrice, originalPrice }, errors };
}

function priceRangeErrors(state, thresholds, label = 'price') {
  const errors = [];
  if (!state) return errors;
  if (state.price < thresholds.minimumPriceCzk || state.price > thresholds.maximumPriceCzk) errors.push(`${label}_outside_guard_range`);
  if (state.salePrice !== null && (state.salePrice < thresholds.minimumPriceCzk || state.salePrice > thresholds.maximumPriceCzk)) errors.push(`${label}_sale_outside_guard_range`);
  if (state.originalPrice !== null && (state.originalPrice < thresholds.minimumPriceCzk || state.originalPrice > thresholds.maximumPriceCzk)) errors.push(`${label}_original_outside_guard_range`);
  return errors;
}

function priceStateEqual(left, right) {
  return left?.price === right?.price
    && (left?.salePrice ?? null) === (right?.salePrice ?? null)
    && (left?.originalPrice ?? null) === (right?.originalPrice ?? null);
}

function validateRelativePrice(oldState, desiredState, thresholds) {
  if (!oldState || !desiredState || priceStateEqual(oldState, desiredState)) return [];
  const errors = [];
  if (oldState.price > 0 && Math.abs(desiredState.price - oldState.price) / oldState.price > thresholds.maximumRelativePriceChange) {
    errors.push('relative_price_change_exceeded');
  }
  if (oldState.price > 0 && desiredState.price > 0
      && Math.max(desiredState.price / oldState.price, oldState.price / desiredState.price) >= thresholds.suspiciousMultiplicativeFactor) {
    errors.push('suspicious_10x_or_100x_price_shift');
  }
  return errors;
}

function makeOverlayEntry(productId, desiredState, oldState) {
  const entry = {
    source: SOURCE,
    partner: PARTNER,
    productId,
    offerIdentity: { kind: 'product-partner', partner: PARTNER },
    price: desiredState.price,
  };
  if (desiredState.salePrice !== null || desiredState.originalPrice !== null || oldState.salePrice !== null || oldState.originalPrice !== null) {
    entry.salePrice = desiredState.salePrice;
    entry.originalPrice = desiredState.originalPrice;
  }
  return entry;
}

function validateEntryShape(entry) {
  const keys = Object.keys(entry || {});
  if (keys.some(key => !ENTRY_FIELDS.has(key))) return false;
  if (!keys.includes('source') || !keys.includes('partner') || !keys.includes('productId') || !keys.includes('offerIdentity') || !keys.includes('price')) return false;
  if (typeof entry.productId !== 'string' || !entry.productId) return false;
  if (entry.source !== SOURCE || entry.partner !== PARTNER || entry.offerIdentity?.kind !== 'product-partner' || entry.offerIdentity?.partner !== PARTNER) return false;
  if (JSON.stringify(Object.keys(entry.offerIdentity).sort()) !== JSON.stringify(['kind', 'partner'])) return false;
  return keys.filter(key => PRICE_FIELDS.has(key)).every(key => key === 'price'
    ? typeof entry[key] === 'number' && Number.isFinite(entry[key])
    : typeof entry[key] === 'number' && Number.isFinite(entry[key]) || entry[key] === null);
}

function categoryTechnicalBlockers(raw, sidecar, groups) {
  if (!raw || raw.schemaVersion !== 2 || raw.source !== 'superzoo.cz' || raw.reviewOnly !== true) addBlocker(groups, 'technical_raw_contract_failed');
  if (!sidecar || sidecar.schemaVersion !== 2 || sidecar.reviewOnly !== true) {
    addBlocker(groups, 'missing_or_invalid_review_sidecar');
    return;
  }
  const categories = Array.isArray(raw?.requiredCategories) && raw.requiredCategories.length
    ? raw.requiredCategories
    : DEFAULT_REQUIRED_CATEGORIES;
  const selected = new Set(sidecar.selectedCategories || []);
  const configured = new Set(sidecar.configuredCategories || []);
  if (selected.size !== configured.size || [...configured].some(key => !selected.has(key))) addBlocker(groups, 'incomplete_selected_category_scope');
  const pages = Array.isArray(sidecar.pages) ? sidecar.pages : [];
  const terminations = sidecar.summary?.categoryTerminationReasons || sidecar.categoryTerminationReasons || {};
  for (const category of categories) {
    const categoryPages = pages.filter(page => page?.category === category);
    if (categoryPages.length === 0) addBlocker(groups, 'missing_category_page_state', category);
    if (terminations[category] !== 'no_next_control') addBlocker(groups, 'category_not_terminated_safely', category);
  }
  if (pages.some(page => page?.duplicatePage === true)) addBlocker(groups, 'duplicate_page_state');
  if (Number(sidecar.summary?.duplicatePageCount || 0) !== 0) addBlocker(groups, 'duplicate_page_state');
  if (pages.some(page => !page?.pageFingerprint || !page?.productSetHash)) addBlocker(groups, 'incomplete_page_fingerprint');
  if (sidecar.technicalStatus === 'FAIL' || sidecar.technical?.passed === false) addBlocker(groups, 'technical_scraper_failure');
}

function indexCatalog(catalog, config, groups) {
  const byId = new Map();
  const allById = new Map();
  const bySource = new Map();
  const bySourcePacking = new Map();
  for (const product of Array.isArray(catalog) ? catalog : []) {
    if (typeof product?.id !== 'string' || !product.id) {
      addBlocker(groups, 'invalid_catalog_product');
      continue;
    }
    const allByIdList = allById.get(product.id) || [];
    allByIdList.push(product);
    allById.set(product.id, allByIdList);
    const offers = Array.isArray(product.offers) ? product.offers.filter(offer => offer?.partner === PARTNER) : [];
    if (offers.length !== 1) {
      if (offers.length > 1) addBlocker(groups, 'ambiguous_catalog_partner_offer', product.id);
      continue;
    }
    const sourceUrl = catalogOfferTargetUrl(offers[0], config);
    if (!sourceUrl) {
      addBlocker(groups, 'invalid_catalog_source_url', product.id);
      continue;
    }
    const record = { product, offer: offers[0], sourceUrl };
    const byIdList = byId.get(product.id) || [];
    byIdList.push(record);
    byId.set(product.id, byIdList);
    const bySourceList = bySource.get(sourceUrl) || [];
    bySourceList.push(record);
    bySource.set(sourceUrl, bySourceList);
    const sourcePacking = sourcePackingKey(sourceUrl, product);
    if (sourcePacking) {
      const bySourcePackingList = bySourcePacking.get(sourcePacking) || [];
      bySourcePackingList.push(record);
      bySourcePacking.set(sourcePacking, bySourcePackingList);
    }
  }
  return { allById, byId, bySource, bySourcePacking };
}

function rawSourceUrl(product, config) {
  return canonicalSourceUrl(product?.canonicalUrl || product?.sourceIdentity || product?.url, config);
}

function sidecarIdentityUrl(record, config) {
  return canonicalSourceUrl(record?.canonicalUrl || record?.sourceIdentity, config);
}

function packingKey(value) {
  if (Number.isFinite(Number(value?.sizeKg)) && Number(value.sizeKg) > 0) return `kg:${Number(value.sizeKg)}`;
  if (typeof value?.size === 'string' && value.size.trim()) return `size:${value.size.trim().toLowerCase().replace(/\s+/gu, '')}`;
  const identity = typeof value?.canonicalIdentity === 'string' ? value.canonicalIdentity : '';
  const separator = identity.lastIndexOf('|');
  return separator > 0 ? `size:${identity.slice(separator + 1).trim().toLowerCase()}` : null;
}

function sourcePackingKey(sourceUrl, value) {
  const packing = packingKey(value);
  return packing ? `${sourceUrl}|${packing}` : null;
}

function equivalentRawObservation(left, right) {
  return left?.canonicalIdentity === right?.canonicalIdentity
    && left?.price === right?.price
    && (left?.salePrice ?? null) === (right?.salePrice ?? null)
    && (left?.originalPrice ?? null) === (right?.originalPrice ?? null)
    && left?.name === right?.name;
}

function buildSuperZooManagedPriceCandidate(options = {}) {
  const {
    raw,
    sidecar,
    managedSetManifest,
    automationBaseline = null,
    catalog,
    catalogSha256,
    managedSetSha256,
    automationBaselineSha256 = null,
    expectedCatalogSha256,
    expectedManagedSetSha256,
    expectedAutomationBaselineSha256,
    previousSnapshot = null,
    generatedAt,
    thresholds = defaultThresholds,
    config,
    runtimeStatus = { passed: true },
  } = options;
  const groups = new Map();
  const effectiveConfig = config || require('./safety').loadConfig();
  if (!isCanonicalUtcIso(generatedAt)) addBlocker(groups, 'invalid_generated_at');
  if (!runtimeStatus || runtimeStatus.passed !== true) addBlocker(groups, 'technical_scraper_failure');
  if (previousSnapshot) {
    if (!isCanonicalUtcIso(previousSnapshot.snapshotVersion)) addBlocker(groups, 'invalid_previous_snapshot_version');
    else if (isCanonicalUtcIso(generatedAt) && Date.parse(generatedAt) <= Date.parse(previousSnapshot.snapshotVersion)) addBlocker(groups, 'snapshot_version_not_newer');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(catalogSha256 || ''))) addBlocker(groups, 'invalid_catalog_sha256');
  const scopeSha256 = automationBaseline ? automationBaselineSha256 : managedSetSha256;
  if (!/^[a-f0-9]{64}$/u.test(String(scopeSha256 || ''))) addBlocker(groups, 'invalid_managed_scope_sha256');
  if (expectedCatalogSha256 && catalogSha256 !== expectedCatalogSha256) addBlocker(groups, 'catalog_sha_mismatch');
  if (automationBaseline) {
    if (expectedAutomationBaselineSha256 && automationBaselineSha256 !== expectedAutomationBaselineSha256) addBlocker(groups, 'automation_baseline_sha_mismatch');
    for (const error of validateAutomationBaseline(automationBaseline, { catalogSha256 })) addBlocker(groups, error);
  } else {
    if (expectedManagedSetSha256 && managedSetSha256 !== expectedManagedSetSha256) addBlocker(groups, 'managed_set_sha_mismatch');
    for (const error of validateManagedSetManifest(managedSetManifest)) addBlocker(groups, error);
    const embeddedEvidence = managedSetManifest?.evidence?.inputs?.find(input => input?.role === 'embeddedApplicationCatalog');
    if (!embeddedEvidence || embeddedEvidence.sha256 !== catalogSha256) addBlocker(groups, 'managed_set_catalog_evidence_mismatch');
  }

  categoryTechnicalBlockers(raw, sidecar, groups);
  const catalogIndex = indexCatalog(catalog, effectiveConfig, groups);
  const rawProducts = Array.isArray(raw?.products) ? raw.products : [];
  const rawBySource = new Map();
  const rawBySourcePacking = new Map();
  for (const product of rawProducts) {
    const sourceUrl = rawSourceUrl(product, effectiveConfig);
    if (!sourceUrl) {
      addBlocker(groups, 'invalid_raw_source_identity');
      continue;
    }
    const list = rawBySource.get(sourceUrl) || [];
    list.push(product);
    rawBySource.set(sourceUrl, list);
    const sourcePacking = sourcePackingKey(sourceUrl, product);
    if (sourcePacking) {
      const sourcePackingList = rawBySourcePacking.get(sourcePacking) || [];
      sourcePackingList.push(product);
      rawBySourcePacking.set(sourcePacking, sourcePackingList);
    }
  }

  const approvedBaselineEntries = Array.isArray(automationBaseline?.approved) ? automationBaseline.approved : [];
  const managedEntries = automationBaseline
    ? approvedBaselineEntries.filter(entry => entry?.dailyEligibility === 'exact_safe').map(entry => ({
      sourceIdentity: entry.sourceIdentity,
      productId: entry.productId,
      offerIdentity: { kind: 'product-partner', partner: entry.partner },
    }))
    : Array.isArray(managedSetManifest?.entries) ? managedSetManifest.entries : [];
  const managedUrls = new Set(managedEntries.map(entry => entry?.sourceIdentity).filter(Boolean));
  const sidecarRejected = Array.isArray(sidecar?.rejectedCards) ? sidecar.rejectedCards : [];
  const sidecarFiltered = Array.isArray(sidecar?.filteredCards) ? sidecar.filteredCards : [];
  for (const record of [...sidecarRejected, ...sidecarFiltered]) {
    const sourceUrl = sidecarIdentityUrl(record, effectiveConfig);
    if (sourceUrl && managedUrls.has(sourceUrl)) addBlocker(groups, sidecarRejected.includes(record) ? 'managed_card_rejected' : 'managed_card_filtered', sourceUrl);
  }

  const entries = [];
  let observed = 0;
  let saleClears = 0;
  for (const managed of managedEntries) {
    if (typeof managed?.sourceIdentity !== 'string' || !canonicalSourceUrl(managed.sourceIdentity, effectiveConfig)) {
      addBlocker(groups, 'invalid_managed_source_identity', managed?.productId || '(missing)');
    }
    const allCatalogById = catalogIndex.allById.get(managed?.productId) || [];
    if (allCatalogById.length === 1 && !(Array.isArray(allCatalogById[0].offers) ? allCatalogById[0].offers : []).some(offer => offer?.partner === PARTNER)) {
      addBlocker(groups, 'wrong_partner', managed?.productId || '(missing)');
    }
    const catalogById = catalogIndex.byId.get(managed?.productId) || [];
    if (catalogById.length !== 1) {
      addBlocker(groups, 'unknown_or_ambiguous_managed_product', managed?.productId || '(missing)');
      continue;
    }
    const target = catalogById[0];
    if (target.offer.partner !== PARTNER || managed?.offerIdentity?.partner !== PARTNER) addBlocker(groups, 'wrong_partner', managed?.productId);
    if (target.sourceUrl !== managed.sourceIdentity) addBlocker(groups, 'managed_source_mapping_mismatch', managed?.productId);
    const targetSourcePacking = sourcePackingKey(target.sourceUrl, target.product);
    const catalogBySourcePacking = targetSourcePacking ? (catalogIndex.bySourcePacking.get(targetSourcePacking) || []) : [];
    if (catalogBySourcePacking.length !== 1) addBlocker(groups, 'ambiguous_managed_source_mapping', managed.sourceIdentity);
    const observedProducts = targetSourcePacking ? (rawBySourcePacking.get(targetSourcePacking) || []) : (rawBySource.get(managed.sourceIdentity) || []);
    const equivalentProducts = observedProducts.length > 1 && observedProducts.every(product => equivalentRawObservation(observedProducts[0], product));
    if (observedProducts.length === 0 || (observedProducts.length > 1 && !equivalentProducts)) {
      addBlocker(groups, observedProducts.length === 0 ? 'managed_coverage_missing' : 'duplicate_source_identity', managed.sourceIdentity);
      continue;
    }
    const rawProduct = observedProducts[0];
    if (rawProduct.productId && rawProduct.productId !== managed.productId) addBlocker(groups, 'managed_product_identity_mismatch', managed.productId);
    const oldResult = canonicalPriceState(target.offer, `catalog_${managed.productId}`);
    const desiredResult = canonicalPriceState(rawProduct, `raw_${managed.productId}`);
    for (const error of oldResult.errors) addBlocker(groups, error, managed.productId);
    for (const error of desiredResult.errors) addBlocker(groups, error, managed.productId);
    if (!oldResult.state || !desiredResult.state) continue;
    for (const error of priceRangeErrors(desiredResult.state, thresholds)) addBlocker(groups, error, managed.productId);
    for (const error of validateRelativePrice(oldResult.state, desiredResult.state, thresholds)) addBlocker(groups, error, managed.productId);
    observed += 1;
    if (oldResult.state.salePrice !== null && desiredResult.state.salePrice === null && desiredResult.state.originalPrice === null) saleClears += 1;
    if (!priceStateEqual(oldResult.state, desiredResult.state)) entries.push(makeOverlayEntry(managed.productId, desiredResult.state, oldResult.state));
  }

  const managedCount = managedEntries.length;
  if (observed !== managedCount) addBlocker(groups, 'managed_coverage_incomplete', `${observed}/${managedCount}`);
  const changedManagedRatio = managedCount ? entries.length / managedCount : 1;
  const saleClearRatio = managedCount ? saleClears / managedCount : 1;
  if (changedManagedRatio > thresholds.maximumChangedManagedRatio) addBlocker(groups, 'changed_managed_ratio_exceeded');
  if (saleClearRatio > thresholds.maximumSaleClearRatio) addBlocker(groups, 'sale_clear_ratio_exceeded');
  for (const entry of entries) if (!validateEntryShape(entry)) addBlocker(groups, 'candidate_forbidden_field');

  const blockers = [...groups.values()].sort((left, right) => compareText(left.code, right.code));
  const ready = blockers.length === 0;
  const safeEntries = ready ? entries.sort((left, right) => compareText(left.productId, right.productId)) : [];
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    snapshotVersion: generatedAt,
    generatedAt,
    source: SOURCE,
    partner: PARTNER,
    catalogSha256,
    scopeType: automationBaseline ? 'automation-baseline-exact-safe-approved' : 'legacy-managed-set',
    scopeSha256,
    reviewOnly: true,
    generatorReady: ready,
    noOp: ready && safeEntries.length === 0,
    entries: safeEntries,
    remoteActions: { publish: false, upload: false, deploy: false, scheduler: false, gcs: false },
  };
  const report = {
    schemaVersion: 1,
    validator: 'superzoo-managed-price',
    verdict: ready ? 'SUPERZOO_MANAGED_PRICE_PASS' : 'SUPERZOO_MANAGED_PRICE_BLOCKED',
    passed: ready,
    generatedAt,
    catalogSha256,
    scopeType: automationBaseline ? 'automation-baseline-exact-safe-approved' : 'legacy-managed-set',
    scopeSha256,
    approvedTotal: automationBaseline ? approvedBaselineEntries.length : managedCount,
    unresolvedApproved: automationBaseline ? approvedBaselineEntries.filter(entry => entry?.dailyEligibility === 'unresolved').length : 0,
    managedSetEntries: managedCount,
    managedCoverage: { observed, required: managedCount, ratio: managedCount ? observed / managedCount : 0 },
    changedManaged: safeEntries.length,
    changedManagedRatio,
    saleClears,
    saleClearRatio,
    nonManagedProducts: rawProducts.filter(product => {
      const sourceUrl = rawSourceUrl(product, effectiveConfig);
      return sourceUrl && !managedUrls.has(sourceUrl);
    }).length,
    rawSha256: options.rawSha256 || null,
    sidecarSha256: options.sidecarSha256 || null,
    blockers,
    remoteActions: { publish: false, upload: false, deploy: false, scheduler: false, gcs: false },
  };
  return { candidate, report };
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const rawPath = requiredArg(args, 'raw');
  const sidecarPath = requiredArg(args, 'sidecar');
  const managedSetPath = args['managed-set'] || null;
  const automationBaselinePath = args['automation-baseline'] || null;
  if ((!managedSetPath && !automationBaselinePath) || (managedSetPath && automationBaselinePath)) {
    throw new Error('Provide exactly one of --managed-set or --automation-baseline');
  }
  const catalogPath = requiredArg(args, 'catalog');
  const outputDir = requiredArg(args, 'output-dir');
  assertSafeOutputPath(path.join(outputDir, 'superzoo-managed-price-candidate.json'));
  assertSafeOutputPath(path.join(outputDir, 'superzoo-managed-price-validation.json'));
  const raw = readJsonFile(rawPath);
  const sidecar = readJsonFile(sidecarPath);
  const managedSet = managedSetPath ? readJsonFile(managedSetPath) : null;
  const automationBaseline = automationBaselinePath ? readJsonFile(automationBaselinePath) : null;
  const catalog = readJsonFile(catalogPath);
  const generatedAt = args['generated-at'] || raw.value?.scrapedAt;
  const previous = args.previous ? readJsonFile(args.previous).value : null;
  const result = buildSuperZooManagedPriceCandidate({
    raw: raw.value,
    sidecar: sidecar.value,
    managedSetManifest: managedSet?.value,
    automationBaseline: automationBaseline?.value,
    catalog: catalog.value,
    catalogSha256: catalog.sha256,
    managedSetSha256: managedSet?.sha256,
    automationBaselineSha256: automationBaseline?.sha256,
    expectedCatalogSha256: args['expected-catalog-sha256'],
    expectedManagedSetSha256: args['expected-managed-set-sha256'],
    expectedAutomationBaselineSha256: args['expected-automation-baseline-sha256'],
    previousSnapshot: previous,
    generatedAt,
    rawSha256: raw.sha256,
    sidecarSha256: sidecar.sha256,
  });
  writeJsonAtomic(path.join(outputDir, 'superzoo-managed-price-candidate.json'), result.candidate);
  writeJsonAtomic(path.join(outputDir, 'superzoo-managed-price-validation.json'), result.report);
  process.stdout.write(`${JSON.stringify({ verdict: result.report.verdict, passed: result.report.passed, managedCoverage: result.report.managedCoverage, blockers: result.report.blockers }, null, 2)}\n`);
  if (!result.report.passed) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[superzoo-managed-price] FAILED: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  DEFAULT_REQUIRED_CATEGORIES,
  ENTRY_FIELDS,
  PARTNER,
  PRICE_FIELDS,
  SOURCE,
  buildSuperZooManagedPriceCandidate,
  canonicalPriceState,
  isCanonicalUtcIso,
  main,
  priceRangeErrors,
  validateEntryShape,
  validateRelativePrice,
};
