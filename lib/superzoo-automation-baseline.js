'use strict';

const crypto = require('node:crypto');
const {
  canonicalizeProductUrl,
  loadConfig,
  validateAffiliateUrlDetailed,
} = require('./safety');

const SCHEMA_VERSION = 2;
const CONTRACT = 'superzoo-automation-baseline-v2';
const PARTNER = 'SuperZoo';
const SOURCE = 'superzoo-scraper';
const DECISION_STATES = new Set(['approved', 'baseline_ignored', 'rejected', 'pending_review']);
const MATCH_METHODS = new Set([
  'canonical_url_packing',
  'normalized_title_packing_v1',
  'canonical_url_multipack_alias_v1',
]);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalSourceUrl(value, config) {
  try { return canonicalizeProductUrl(value, config); } catch { return null; }
}

function packingEvidence(value) {
  const size = typeof value?.size === 'string' && value.size.trim() ? value.size.trim() : null;
  const sizeKg = Number.isFinite(Number(value?.sizeKg)) && Number(value.sizeKg) > 0 ? Number(value.sizeKg) : null;
  const key = sizeKg !== null
    ? `kg:${sizeKg}`
    : size !== null
      ? `size:${size.toLowerCase().replace(/\s+/gu, '')}`
      : null;
  return { size, sizeKg, key };
}

function identityKey(sourceIdentity, packing) {
  return sourceIdentity && packing?.key ? `${sourceIdentity}|${packing.key}` : null;
}

function identityFingerprint(entry) {
  return `sha256:${sha256(JSON.stringify({
    partner: entry.partner,
    productId: entry.productId ?? null,
    sourceIdentity: entry.sourceIdentity,
    packing: entry.packing,
    rawSourceIdentity: entry.rawSourceIdentity ?? null,
    rawPacking: entry.rawPacking ?? null,
    matchMethod: entry.matchMethod ?? null,
    state: entry.state,
  }))}`;
}

function normalizedTitle(value) {
  return String(value || '')
    .replace(/&(?:amp|#0*38|#x0*26);/giu, '&')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\b\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:kg|g)\b/giu, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g)\b/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function titlePackingKey(name, packing) {
  const title = normalizedTitle(name);
  return title && packing?.key ? `${title}|${packing.key}` : null;
}

function multipackEvidence(value) {
  const text = String(value || '').replace(/,/gu, '.');
  const match = text.match(/\b(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g)\b/iu);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = Number(match[2]);
  const unitKg = match[3].toLowerCase() === 'kg' ? unit : unit / 1000;
  const totalKg = Number((count * unitKg).toFixed(6));
  return count > 1 && unitKg > 0 && totalKg > 0 ? { count, unitKg, totalKg } : null;
}

function addBlocker(groups, code, example = null) {
  const group = groups.get(code) || { code, count: 0, examples: [] };
  group.count += 1;
  if (example !== null && group.examples.length < 20) group.examples.push(String(example));
  groups.set(code, group);
}

function catalogOfferSourceIdentity(offer, config) {
  const checked = validateAffiliateUrlDetailed(offer?.affiliateUrl, config);
  return checked.valid ? canonicalSourceUrl(checked.targetUrl, config) : null;
}

function rawSourceIdentity(product, config) {
  return canonicalSourceUrl(product?.canonicalUrl || product?.sourceIdentity || product?.url, config);
}

function equivalentRawObservation(left, right) {
  return left?.canonicalIdentity === right?.canonicalIdentity
    && left?.name === right?.name
    && left?.price === right?.price
    && (left?.salePrice ?? null) === (right?.salePrice ?? null)
    && (left?.originalPrice ?? null) === (right?.originalPrice ?? null);
}

function indexRaw(raw, config, groups) {
  const byIdentity = new Map();
  const bySource = new Map();
  const byTitlePacking = new Map();
  const unresolved = [];
  for (const product of Array.isArray(raw?.products) ? raw.products : []) {
    const sourceIdentity = rawSourceIdentity(product, config);
    const packing = packingEvidence(product);
    const key = identityKey(sourceIdentity, packing);
    if (!sourceIdentity || !key) {
      unresolved.push({
        state: 'unresolved',
        evidenceType: 'accepted_card_without_stable_identity',
        reason: !sourceIdentity ? 'invalid_source_identity' : 'missing_packing_identity',
        category: product?.category || null,
        pageIndex: null,
        sourceIdentity,
        name: product?.name || null,
      });
      continue;
    }
    const record = { product, sourceIdentity, packing, identityKey: key };
    const identities = byIdentity.get(key) || [];
    identities.push(record);
    byIdentity.set(key, identities);
    const sources = bySource.get(sourceIdentity) || [];
    sources.push(record);
    bySource.set(sourceIdentity, sources);
    const titleKey = titlePackingKey(product?.name, packing);
    if (titleKey) {
      const titles = byTitlePacking.get(titleKey) || [];
      titles.push(record);
      byTitlePacking.set(titleKey, titles);
    }
  }
  for (const [key, records] of byIdentity) {
    if (records.length > 1 && !records.every(record => equivalentRawObservation(records[0].product, record.product))) {
      addBlocker(groups, 'duplicate_source_identity', key);
    }
  }
  unresolved.sort((left, right) => compareText(left.sourceIdentity || '', right.sourceIdentity || '')
    || compareText(left.name || '', right.name || ''));
  return { byIdentity, bySource, byTitlePacking, unresolved };
}

function makeApprovedEntry(product, offer, sourceIdentity, rawIndex, catalogTitleCounts) {
  const packing = packingEvidence(product);
  const key = identityKey(sourceIdentity, packing);
  const exact = key ? (rawIndex.byIdentity.get(key) || []) : [];
  const sameSource = sourceIdentity ? (rawIndex.bySource.get(sourceIdentity) || []) : [];
  const normalizedTitleKey = titlePackingKey(product?.name, packing);
  let dailyEligibility = 'exact_safe';
  let unresolvedReason = null;
  let matchMethod = 'canonical_url_packing';
  let rawSourceIdentity = null;
  let rawPacking = null;
  let resolvedIdentityKey = key;
  if (!sourceIdentity || !key) {
    dailyEligibility = 'unresolved';
    unresolvedReason = !sourceIdentity ? 'invalid_catalog_source_identity' : 'missing_catalog_packing_identity';
  } else if (exact.length === 0) {
    const titleMatches = normalizedTitleKey && catalogTitleCounts.get(normalizedTitleKey) === 1
      ? (rawIndex.byTitlePacking.get(normalizedTitleKey) || [])
      : [];
    const exactMultipack = sameSource.length === 1 ? multipackEvidence(`${sameSource[0].product?.name || ''} ${sameSource[0].sourceIdentity || ''}`) : null;
    const catalogUnitKg = packing.sizeKg;
    if (titleMatches.length === 1) {
      const raw = titleMatches[0];
      matchMethod = 'normalized_title_packing_v1';
      rawSourceIdentity = raw.sourceIdentity;
      resolvedIdentityKey = raw.identityKey;
    } else if (exactMultipack && catalogUnitKg !== null && exactMultipack.unitKg === catalogUnitKg
        && sameSource[0].packing?.sizeKg === exactMultipack.totalKg) {
      matchMethod = 'canonical_url_multipack_alias_v1';
      rawPacking = sameSource[0].packing;
      resolvedIdentityKey = sameSource[0].identityKey;
    } else {
      dailyEligibility = 'unresolved';
      unresolvedReason = sameSource.length > 0 ? 'packing_mismatch_in_baseline_scrape' : 'missing_from_baseline_scrape';
    }
  }
  const entry = {
    state: 'approved',
    partner: PARTNER,
    productId: product?.id ?? null,
    sourceIdentity,
    packing,
    identityKey: resolvedIdentityKey,
    ...(rawSourceIdentity ? { rawSourceIdentity } : {}),
    ...(rawPacking ? { rawPacking } : {}),
    matchMethod,
    identityFingerprint: null,
    dailyEligibility,
    unresolvedReason,
  };
  entry.identityFingerprint = identityFingerprint(entry);
  return entry;
}

function makeBaselineIgnoredEntry(record) {
  const entry = {
    state: 'baseline_ignored',
    partner: PARTNER,
    sourceIdentity: record.sourceIdentity,
    packing: record.packing,
    identityKey: record.identityKey,
    identityFingerprint: null,
  };
  entry.identityFingerprint = identityFingerprint(entry);
  return entry;
}

function unresolvedSidecarEvidence(sidecar, config) {
  return (Array.isArray(sidecar?.rejectedCards) ? sidecar.rejectedCards : []).map(record => ({
    state: 'unresolved',
    evidenceType: 'rejected_or_unparseable_card',
    reason: record?.reason || 'unknown',
    category: record?.category || null,
    pageIndex: Number.isInteger(record?.pageIndex) ? record.pageIndex : null,
    sourceIdentity: canonicalSourceUrl(record?.canonicalUrl || record?.sourceIdentity, config),
    name: record?.name || null,
  })).sort((left, right) => compareText(left.sourceIdentity || '', right.sourceIdentity || '')
    || compareText(left.reason, right.reason)
    || (left.pageIndex ?? -1) - (right.pageIndex ?? -1));
}

function validateInputTechnicalContract(raw, sidecar, groups) {
  if (raw?.schemaVersion !== 2 || raw?.source !== 'superzoo.cz' || raw?.reviewOnly !== true) {
    addBlocker(groups, 'invalid_raw_contract');
  }
  if (sidecar?.schemaVersion !== 2 || sidecar?.source !== 'superzoo.cz' || sidecar?.reviewOnly !== true) {
    addBlocker(groups, 'invalid_sidecar_contract');
    return;
  }
  const selected = new Set(sidecar.selectedCategories || []);
  const configured = new Set(sidecar.configuredCategories || []);
  if (!selected.size || selected.size !== configured.size || [...configured].some(category => !selected.has(category))) {
    addBlocker(groups, 'incomplete_category_scope');
  }
  const terminations = sidecar.summary?.categoryTerminationReasons || {};
  const categories = Array.isArray(sidecar.categories) && sidecar.categories.length
    ? sidecar.categories
    : [...configured];
  for (const category of categories) {
    if (terminations[category] !== 'no_next_control') addBlocker(groups, 'unsafe_category_termination', category);
  }
  if (Number(sidecar.summary?.duplicatePageCount || 0) !== 0) addBlocker(groups, 'duplicate_page_state');
}

function buildAutomationBaseline(options = {}) {
  const {
    catalog,
    publicCatalog,
    raw,
    sidecar,
    catalogSha256,
    publicCatalogSha256,
    rawSha256,
    sidecarSha256,
    config = loadConfig(),
  } = options;
  const groups = new Map();
  for (const [label, value] of Object.entries({ catalogSha256, publicCatalogSha256, rawSha256, sidecarSha256 })) {
    if (!/^[a-f0-9]{64}$/u.test(String(value || ''))) addBlocker(groups, `invalid_${label}`);
  }
  if (catalogSha256 !== publicCatalogSha256 || JSON.stringify(catalog) !== JSON.stringify(publicCatalog)) {
    addBlocker(groups, 'catalog_parity_mismatch');
  }
  validateInputTechnicalContract(raw, sidecar, groups);
  const rawIndex = indexRaw(raw, config, groups);
  const catalogCandidates = [];
  for (const product of Array.isArray(catalog) ? catalog : []) {
    const offers = Array.isArray(product?.offers) ? product.offers.filter(offer => offer?.partner === PARTNER) : [];
    if (offers.length === 1) catalogCandidates.push({ product, offer: offers[0], packing: packingEvidence(product) });
  }
  const catalogTitleCounts = new Map();
  for (const candidate of catalogCandidates) {
    const key = titlePackingKey(candidate.product?.name, candidate.packing);
    if (key) catalogTitleCounts.set(key, (catalogTitleCounts.get(key) || 0) + 1);
  }
  const approved = [];
  const approvedIdentityKeys = new Set();
  const productIds = new Set();

  for (const product of Array.isArray(catalog) ? catalog : []) {
    const offers = Array.isArray(product?.offers) ? product.offers.filter(offer => offer?.partner === PARTNER) : [];
    if (offers.length === 0) continue;
    if (offers.length !== 1) {
      addBlocker(groups, 'ambiguous_catalog_partner_offer', product?.id || '(missing)');
      continue;
    }
    if (typeof product?.id !== 'string' || !product.id) addBlocker(groups, 'invalid_catalog_product_id');
    if (productIds.has(product?.id)) addBlocker(groups, 'duplicate_product_partner_identity', product?.id);
    productIds.add(product?.id);
    const sourceIdentity = catalogOfferSourceIdentity(offers[0], config);
    if (!sourceIdentity) addBlocker(groups, 'invalid_catalog_source_identity', product?.id);
    const entry = makeApprovedEntry(product, offers[0], sourceIdentity, rawIndex, catalogTitleCounts);
    if (entry.identityKey && approvedIdentityKeys.has(entry.identityKey)) {
      addBlocker(groups, 'ambiguous_mapping', entry.identityKey);
    }
    if (entry.identityKey) approvedIdentityKeys.add(entry.identityKey);
    approved.push(entry);
  }

  const baselineIgnored = [];
  for (const [key, records] of rawIndex.byIdentity) {
    if (approvedIdentityKeys.has(key)) continue;
    if (records.length > 1 && !records.every(record => equivalentRawObservation(records[0].product, record.product))) continue;
    baselineIgnored.push(makeBaselineIgnoredEntry(records[0]));
  }

  approved.sort((left, right) => compareText(left.productId || '', right.productId || ''));
  baselineIgnored.sort((left, right) => compareText(left.identityKey, right.identityKey));
  const unresolvedEvidence = [
    ...unresolvedSidecarEvidence(sidecar, config),
    ...rawIndex.unresolved,
  ].sort((left, right) => compareText(left.sourceIdentity || '', right.sourceIdentity || '')
    || compareText(left.reason, right.reason)
    || compareText(left.name || '', right.name || ''));
  const exactSafeApproved = approved.filter(entry => entry.dailyEligibility === 'exact_safe').length;
  const unresolvedApproved = approved.length - exactSafeApproved;
  const blockers = [...groups.values()].sort((left, right) => compareText(left.code, right.code));
  const baseline = {
    schemaVersion: SCHEMA_VERSION,
    contract: CONTRACT,
    partner: PARTNER,
    source: SOURCE,
    identityContract: 'canonical-source-url-plus-packing-with-deterministic-fallbacks-v2',
    evidence: {
      authoritativeCatalog: { sha256: catalogSha256 },
      publicCatalogParity: { sha256: publicCatalogSha256, byteIdentical: catalogSha256 === publicCatalogSha256 },
      baselineRaw: { sha256: rawSha256, scrapedAt: raw?.scrapedAt || null },
      baselineReviewSidecar: { sha256: sidecarSha256, scrapedAt: sidecar?.scrapedAt || null },
    },
    counts: {
      approved: approved.length,
      exactSafeApproved,
      unresolvedApproved,
      baselineIgnored: baselineIgnored.length,
      rejected: 0,
      pendingReview: 0,
      unresolvedEvidence: unresolvedEvidence.length,
    },
    approved,
    baselineIgnored,
    rejected: [],
    pendingReview: [],
    unresolvedEvidence,
    automation: { autoAdd: false, autoDelete: false, priceFieldsOnly: ['price', 'salePrice', 'originalPrice'] },
    generatorReady: blockers.length === 0,
    blockers,
  };
  return { baseline, blockers };
}

function validateAutomationBaseline(baseline, expected = {}) {
  const errors = [];
  const add = code => { if (!errors.includes(code)) errors.push(code); };
  if (baseline?.schemaVersion !== SCHEMA_VERSION || baseline?.contract !== CONTRACT) add('invalid_baseline_contract');
  if (baseline?.partner !== PARTNER || baseline?.source !== SOURCE) add('wrong_partner');
  if (baseline?.identityContract !== 'canonical-source-url-plus-packing-with-deterministic-fallbacks-v2') add('invalid_identity_contract');
  for (const [field, expectedValue] of [
    ['authoritativeCatalog', expected.catalogSha256],
    ['baselineRaw', expected.rawSha256],
    ['baselineReviewSidecar', expected.sidecarSha256],
  ]) {
    const actual = baseline?.evidence?.[field]?.sha256;
    if (!/^[a-f0-9]{64}$/u.test(String(actual || ''))) add('invalid_evidence_sha256');
    if (expectedValue && actual !== expectedValue) add('evidence_sha_mismatch');
  }
  if (expected.publicCatalogSha256 && baseline?.evidence?.publicCatalogParity?.sha256 !== expected.publicCatalogSha256) add('evidence_sha_mismatch');
  if (baseline?.evidence?.publicCatalogParity?.byteIdentical !== true) add('catalog_parity_mismatch');
  if (baseline?.generatorReady !== true || (baseline?.blockers || []).length) add('baseline_not_generator_ready');
  if (baseline?.automation?.autoAdd !== false || baseline?.automation?.autoDelete !== false
      || JSON.stringify(baseline?.automation?.priceFieldsOnly) !== JSON.stringify(['price', 'salePrice', 'originalPrice'])) add('unsafe_automation_contract');

  const approved = Array.isArray(baseline?.approved) ? baseline.approved : [];
  const ignored = Array.isArray(baseline?.baselineIgnored) ? baseline.baselineIgnored : [];
  const rejected = Array.isArray(baseline?.rejected) ? baseline.rejected : [];
  const pending = Array.isArray(baseline?.pendingReview) ? baseline.pendingReview : [];
  const keys = new Set();
  const productIds = new Set();
  for (const entry of [...approved, ...ignored, ...rejected, ...pending]) {
    if (!DECISION_STATES.has(entry?.state) || entry?.partner !== PARTNER) add('invalid_decision_state');
    const unresolvedApproved = entry?.state === 'approved' && entry?.dailyEligibility === 'unresolved';
    if (!entry?.sourceIdentity || (!unresolvedApproved && (!entry?.identityKey || !entry?.packing?.key))) add('invalid_baseline_identity');
    if (entry?.identityFingerprint !== identityFingerprint(entry)) add('identity_fingerprint_mismatch');
    if (entry?.identityKey) {
      if (keys.has(entry.identityKey)) add('duplicate_source_identity');
      keys.add(entry.identityKey);
    }
    if (entry?.state === 'approved') {
      if (!entry.productId || productIds.has(entry.productId)) add('duplicate_product_partner_identity');
      productIds.add(entry.productId);
      if (!['exact_safe', 'unresolved'].includes(entry.dailyEligibility)) add('invalid_daily_eligibility');
      if (!MATCH_METHODS.has(entry.matchMethod)) add('invalid_match_method');
      if (entry.matchMethod === 'normalized_title_packing_v1' && !entry.rawSourceIdentity) add('invalid_match_evidence');
      if (entry.matchMethod === 'canonical_url_multipack_alias_v1' && !entry.rawPacking?.key) add('invalid_match_evidence');
    }
  }
  const sortedApproved = [...approved].sort((a, b) => compareText(a.productId || '', b.productId || ''));
  const sortedIgnored = [...ignored].sort((a, b) => compareText(a.identityKey, b.identityKey));
  if (JSON.stringify(sortedApproved) !== JSON.stringify(approved) || JSON.stringify(sortedIgnored) !== JSON.stringify(ignored)) add('baseline_not_deterministically_sorted');
  const exactSafeApproved = approved.filter(entry => entry.dailyEligibility === 'exact_safe').length;
  const counts = baseline?.counts || {};
  if (counts.approved !== approved.length || counts.exactSafeApproved !== exactSafeApproved
      || counts.unresolvedApproved !== approved.length - exactSafeApproved
      || counts.baselineIgnored !== ignored.length || counts.rejected !== rejected.length
      || counts.pendingReview !== pending.length || counts.unresolvedEvidence !== (baseline?.unresolvedEvidence || []).length) add('baseline_count_mismatch');
  return errors.sort(compareText);
}

function buildWeeklyDiff({ baseline, raw, config = loadConfig() }) {
  const groups = new Map();
  const rawIndex = indexRaw(raw, config, groups);
  const approved = Array.isArray(baseline?.approved) ? baseline.approved : [];
  const unresolvedApproved = approved.filter(entry => entry?.dailyEligibility === 'unresolved');
  const knownBaselineUnresolved = [];
  const unresolvedSources = new Set(unresolvedApproved.map(entry => entry.sourceIdentity).filter(Boolean));
  for (const entry of unresolvedApproved) {
    const exact = entry.identityKey ? rawIndex.byIdentity.has(entry.identityKey) : false;
    if (!exact) {
      knownBaselineUnresolved.push({
        productId: entry.productId,
        identityKey: entry.identityKey,
        sourceIdentity: entry.sourceIdentity,
        packing: entry.packing,
        state: 'approved',
        unresolvedReason: entry.unresolvedReason || 'unresolved',
      });
    }
  }
  const known = new Set([
    ...approved,
    ...(baseline?.baselineIgnored || []),
    ...(baseline?.rejected || []),
  ].map(entry => entry.identityKey));
  const newItems = [];
  for (const [key, records] of rawIndex.byIdentity) {
    if (!known.has(key) && records.every(record => equivalentRawObservation(records[0].product, record.product))) {
      if (records.some(record => unresolvedSources.has(record.sourceIdentity))) continue;
      newItems.push({ identityKey: key, sourceIdentity: records[0].sourceIdentity, packing: records[0].packing, name: records[0].product?.name || null });
    }
  }
  const missing = approved.filter(entry => !rawIndex.byIdentity.has(entry.identityKey)).map(entry => ({
    productId: entry.productId,
    identityKey: entry.identityKey,
    sourceIdentity: entry.sourceIdentity,
  })).filter(item => !unresolvedApproved.some(entry => entry.productId === item.productId));
  const identityChanges = approved.filter(entry => entry.dailyEligibility !== 'unresolved'
    && !rawIndex.byIdentity.has(entry.identityKey) && rawIndex.bySource.has(entry.sourceIdentity)).map(entry => ({
    productId: entry.productId,
    sourceIdentity: entry.sourceIdentity,
    expectedPacking: entry.packing,
    observedPacking: rawIndex.bySource.get(entry.sourceIdentity).map(record => record.packing),
  }));
  return {
    new: newItems.sort((a, b) => compareText(a.identityKey, b.identityKey)),
    missing: missing.sort((a, b) => compareText(a.productId, b.productId)),
    identityChanges: identityChanges.sort((a, b) => compareText(a.productId, b.productId)),
    knownBaselineUnresolved: knownBaselineUnresolved.sort((a, b) => compareText(a.productId, b.productId)),
    blockers: [...groups.values()].sort((a, b) => compareText(a.code, b.code)),
    remoteActions: { autoAdd: false, autoDelete: false, publish: false },
  };
}

module.exports = {
  CONTRACT,
  PARTNER,
  MATCH_METHODS,
  SCHEMA_VERSION,
  SOURCE,
  buildAutomationBaseline,
  buildWeeklyDiff,
  canonicalJson,
  identityFingerprint,
  identityKey,
  normalizedTitle,
  packingEvidence,
  sha256,
  validateAutomationBaseline,
};
