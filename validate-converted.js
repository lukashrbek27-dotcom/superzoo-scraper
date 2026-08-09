'use strict';

const { assertSafeOutputPath, canonicalizeProductUrl, exclusionReason, inferSize, loadConfig, parseCliArgs, readJson, redactDiagnosticText, validateAffiliateUrl, writeJson } = require('./lib/safety');
const ALLOWED_TYPES = new Set(['extruded', 'cold_pressed', 'freeze_dried', 'wet', 'barf', 'cat_pouch', 'rodent_mix', 'rodent_granules']);
const ALLOWED_SPECIES = new Set(['Pes', 'Kočka', 'Hlodavec']);
function issue(collection, code, message, productIndex = null, identity = null) { collection.push({ code, message: redactDiagnosticText(message), productIndex, identity: identity == null ? null : redactDiagnosticText(identity) }); }

function validateConvertedProducts(products, config) {
  const errors = []; const warnings = [];
  if (!Array.isArray(products)) issue(errors, 'invalid_top_level', 'Converted output must be a JSON array.');
  if (!Array.isArray(products) || products.length === 0) issue(errors, 'empty_result', 'Converted output contains zero products.');
  const ids = new Map(); const offerIdentities = new Map();
  for (const [index, product] of (Array.isArray(products) ? products : []).entries()) {
    if (!product?.id) issue(errors, 'missing_product_id', 'Product ID is empty.', index);
    if (ids.has(product?.id)) issue(errors, 'duplicate_product_id', `Duplicate ID at indexes ${ids.get(product.id)} and ${index}: ${product.id}.`, index, product.id); else if (product?.id) ids.set(product.id, index);
    if (!String(product?.brand || '').trim()) issue(errors, 'missing_brand', 'Brand is empty.', index);
    if (!String(product?.name || '').trim()) issue(errors, 'missing_name', 'Name is empty.', index);
    if (!ALLOWED_TYPES.has(product?.type)) issue(errors, 'invalid_type', `Unsupported type: ${product?.type}.`, index);
    if (!ALLOWED_SPECIES.has(product?.species)) issue(errors, 'invalid_species', `Unsupported species: ${product?.species}.`, index);
    if (!/^https?:\/\//i.test(String(product?.image || ''))) issue(errors, 'missing_image', 'Image must be an http/https URL.', index);
    if (!product?.size || !Number.isFinite(product?.sizeKg) || product.sizeKg <= 0) issue(warnings, 'missing_size', 'Size could not be safely inferred.', index);
    const offers = Array.isArray(product?.offers) ? product.offers : [];
    if (offers.length !== 1) issue(errors, 'invalid_offer_count', `Expected exactly one SuperZoo offer, received ${offers.length}.`, index);
    for (const offer of offers) {
      if (offer.partner !== 'SuperZoo') issue(errors, 'invalid_partner', `Unexpected partner: ${offer.partner}.`, index);
      if (!Number.isFinite(offer.price) || offer.price <= 0) issue(errors, 'invalid_price', `Offer price must be positive; received ${offer.price}.`, index);
      if (offer.salePrice != null && (!Number.isFinite(offer.salePrice) || offer.salePrice <= 0 || offer.salePrice !== offer.price)) issue(errors, 'invalid_sale_price', 'salePrice must equal the positive current runtime price.', index);
      if (offer.originalPrice != null && (!Number.isFinite(offer.originalPrice) || offer.originalPrice <= offer.price)) issue(errors, 'invalid_original_price', 'originalPrice must be greater than current price.', index);
      if (!validateAffiliateUrl(offer.affiliateUrl, config)) { issue(errors, 'invalid_affiliate_url', 'Affiliate URL is not the exact CJ redirect to a SuperZoo target.', index); continue; }
      const target = new URL(offer.affiliateUrl).searchParams.get('url');
      const canonicalTarget = canonicalizeProductUrl(target, config);
      const blocked = exclusionReason({ id: product.id, name: product.name, category: '', url: canonicalTarget }, config);
      if (blocked) issue(errors, 'out_of_scope_product', `Out-of-scope converted target (${blocked}): ${canonicalTarget}.`, index, canonicalTarget);
      const variant = product.size || inferSize(product.name).variant;
      const identity = `${canonicalTarget}|${variant}`;
      if (offerIdentities.has(identity)) issue(errors, 'duplicate_offer_identity', `Duplicate target URL/variant at indexes ${offerIdentities.get(identity)} and ${index}.`, index, identity); else offerIdentities.set(identity, index);
    }
  }
  const contract = config.catalogExclusionContract;
  if (contract.activeExclusionCount !== 35 || contract.legacyExcludedProductIds.length !== 35) issue(errors, 'exclusion_contract_mismatch', 'Expected exactly 35 active exclusion IDs.');
  if (contract.superZooStableUrlCount !== 24 || contract.superZooExcludedCanonicalUrls.length !== 24) issue(errors, 'exclusion_url_contract_mismatch', 'Expected exactly 24 stable SuperZoo exclusion URLs.');
  if (contract.manualReviewLaterCount !== 3 || contract.manualReviewLaterProductIds.length !== 3) issue(errors, 'manual_review_contract_mismatch', 'Expected exactly 3 manualReviewLater IDs.');
  return { schemaVersion: 1, validator: 'superzoo-converted', generatedAt: new Date().toISOString(), passed: errors.length === 0, summary: { products: Array.isArray(products) ? products.length : 0, offers: Array.isArray(products) ? products.reduce((sum, product) => sum + (product.offers?.length || 0), 0) : 0, duplicateProductIds: errors.filter(item => item.code === 'duplicate_product_id').length, duplicateOfferIdentities: errors.filter(item => item.code === 'duplicate_offer_identity').length, outOfScopeProducts: errors.filter(item => item.code === 'out_of_scope_product').length, missingSizes: warnings.filter(item => item.code === 'missing_size').length }, errors, warnings };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2)); if (!args.input || !args.report) throw new Error('Use --input=<converted.json> and --report=<report.json>.');
  assertSafeOutputPath(args.report);
  const report = validateConvertedProducts(readJson(args.input), loadConfig(args.config)); report.inputPath = args.input; writeJson(args.report, report);
  console.log(`[validate-converted] ${report.passed ? 'PASS' : 'FAIL'} products=${report.summary.products} errors=${report.errors.length} warnings=${report.warnings.length}`); if (!report.passed) process.exitCode = 1;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[validate-converted] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { validateConvertedProducts };
