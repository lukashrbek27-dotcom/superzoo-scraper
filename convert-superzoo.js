'use strict';

const { assertSafeOutputPath, buildIdentity, exclusionDecision, exclusionReason, loadConfig, normalizeRawProduct, normalizeText, parseCliArgs, readJson, redactDiagnosticText, writeJsonAtomic } = require('./lib/safety');
const { canonicalizeCrossCategoryProducts } = require('./lib/cross-category-dedupe');

const KNOWN_BRANDS = ['Brit Premium by Nature', 'Brit Care', 'Brit', "Hill's Prescription Diet", "Hill's", 'Royal Canin', 'Rasco Premium', 'Rasco', 'Carnilove', 'Applaws', 'Kattovit', 'Kitekat', 'AVICENTRA', 'Versele-Laga', 'Nature Land', 'VITAKRAFT', 'Ontario', 'Acana', 'Orijen', 'Calibra', 'Purina', 'Whiskas', 'Felix', 'Friskies', 'Iams', 'Eukanuba', 'Beaphar', 'Nutrin', 'Apetit', 'Josera', 'Animonda', 'Bozita', 'Savita', 'Monge', 'Trainer', 'Farmina', 'N&D', 'N & D', 'Pro Plan', 'Proplan', 'Taste of the Wild', 'Sanabelle', 'Smolke'];
function parseBrand(product) {
  if (String(product.brand || '').trim()) return String(product.brand).trim();
  const clean = String(product.name || '').replace(/^(Krmivo|Granule|Konzerva|Kapsička|Pamlsek|Vzorek)\s+/iu, '').trim();
  const matched = KNOWN_BRANDS.find(brand => normalizeText(clean).startsWith(normalizeText(brand)));
  if (matched) return matched === 'N & D' ? 'N&D' : matched;
  const first = clean.split(/\s+/).find(Boolean) || 'Ostatní';
  return ['krmivo', 'granule', 'seno', 'směs', 'complete', 'adult', 'junior', 'senior', 'pro'].includes(normalizeText(first)) ? 'Ostatní' : first;
}
function mapSpecies(type) { if (type === 'dog') return 'Pes'; if (type === 'cat') return 'Kočka'; if (type === 'rodent') return 'Hlodavec'; throw new Error(`Unsupported animalType: ${type || '(empty)'}`); }
function mapType(product) {
  const text = normalizeText(`${product.category} ${product.name}`);
  if (product.animalType === 'rodent') return /granul|pellet|complete|extrud/.test(text) ? 'rodent_granules' : 'rodent_mix';
  if (/kapsick|konzerv|wet|drink|mousse|pouch/.test(text)) return product.animalType === 'cat' && /kapsick|pouch/.test(text) ? 'cat_pouch' : 'wet';
  if (/cold pressed|lisovan/.test(text)) return 'cold_pressed';
  if (/freeze dried|liofil/.test(text)) return 'freeze_dried';
  if (/\bbarf\b|syrov/.test(text)) return 'barf';
  return 'extruded';
}
function cleanName(name, brand) {
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(name).replace(new RegExp(`^${escaped}\\s*`, 'iu'), '').replace(/\s+\d+\s*[x×]\s*\d+(?:[,.]\d+)?\s*(?:kg|g)\b.*$/iu, '').replace(/\s+\d+(?:[,.]\d+)?\s*(?:kg|g)\b.*$/iu, '').trim().replace(/^[-–,\s]+|[-–,\s]+$/g, '') || String(name).trim();
}
function scopeReject(product, config, options = {}) {
  const raw = normalizeRawProduct(product, config);
  const decision = exclusionDecision(raw, config, { mainFoodScope: options.mainFoodScope === true, scopeBeforeLegacy: true });
  if (!decision || decision.reason !== 'main_food_scope') return null;
  return { ...decision, reviewIdentity: buildIdentity(raw, config).productId, name: raw.name, animalType: raw.animalType, category: raw.category, price: raw.price, size: raw.size, sizeKg: raw.sizeKg, url: raw.canonicalUrl };
}
function convertProduct(product, config) {
  const raw = normalizeRawProduct(product, config);
  const blocked = exclusionReason(raw, config); if (blocked) throw new Error(`Out-of-scope product cannot be converted (${blocked}): ${raw.name}`);
  if (!Number.isFinite(raw.price) || raw.price <= 0) throw new Error(`Invalid current price for ${raw.name}.`);
  const identity = buildIdentity(raw, config); const brand = parseBrand(raw);
  const converted = { id: identity.productId, brand, name: cleanName(raw.name, brand), size: identity.size.size, sizeKg: identity.size.sizeKg, type: mapType(raw), species: mapSpecies(raw.animalType), image: raw.image, offers: [{ partner: 'SuperZoo', price: raw.price, salePrice: raw.salePrice, originalPrice: raw.originalPrice, affiliateUrl: raw.affiliateUrl }] };
  if (/veterinar|veterinary|prescription/.test(normalizeText(`${raw.category} ${raw.name}`))) converted.dietTags = ['veterinary'];
  return converted;
}
function convertDocument(document, config, options = {}) {
  if (!document || !Array.isArray(document.products) || document.products.length === 0) throw new Error('Input must contain a non-empty products array.');
  const ids = new Set(); const output = [];
  for (const group of canonicalizeCrossCategoryProducts(document.products, config)) {
    const rejected = group.sourceIndexes.map(index => scopeReject(document.products[index], config, options)).filter(Boolean);
    if (rejected.length) continue;
    const converted = group.sourceIndexes.map(index => convertProduct(document.products[index], config));
    const product = converted[0];
    const comparable = candidate => JSON.stringify({ ...candidate, dietTags: undefined });
    if (converted.some(candidate => comparable(candidate) !== comparable(product))) {
      const error = new Error(`category_conversion_semantics_conflict: ${group.product.sourceIdentity}; categories=${group.sourceCategories.join(', ')}.`);
      error.code = 'category_conversion_semantics_conflict';
      throw error;
    }
    const dietTags = [...new Set(converted.flatMap(candidate => candidate.dietTags || []))].sort();
    if (dietTags.length) product.dietTags = dietTags;
    else delete product.dietTags;
    if (ids.has(product.id)) throw new Error(`Converted product ID collision: ${product.id}`);
    ids.add(product.id); output.push(product);
  }
  return output;
}
function collectScopeRejects(document, config, options = {}) {
  const rejects = [];
  for (const group of canonicalizeCrossCategoryProducts(document.products, config)) {
    const entries = group.sourceIndexes.map(index => scopeReject(document.products[index], config, options)).filter(Boolean);
    if (entries.length) rejects.push(entries[0]);
  }
  return rejects;
}
function main() {
  const args = parseCliArgs(process.argv.slice(2)); const input = args.input || process.env.SUPERZOO_CONVERTER_INPUT; const output = args.output || process.env.SUPERZOO_CONVERTER_OUTPUT;
  if (!input || !output) throw new Error('Use --input=<staging-raw.json> and --output=<staging-converted.json>.');
  assertSafeOutputPath(output); const document = readJson(input); const config = loadConfig(args.config); const options = { mainFoodScope: args['main-food-scope-guard'] === true }; const products = convertDocument(document, config, options); writeJsonAtomic(output, products);
  if (args['scope-reject-report']) { assertSafeOutputPath(args['scope-reject-report']); writeJsonAtomic(args['scope-reject-report'], { schemaVersion: 1, source: 'superzoo.cz', reviewOnly: true, input: input, scopeRejects: collectScopeRejects(document, config, options) }); }
  console.log(`[convert] review-only output: ${redactDiagnosticText(output)} (${products.length} products)`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[convert] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { cleanName, collectScopeRejects, convertDocument, convertProduct, mapSpecies, mapType, parseBrand, scopeReject };
