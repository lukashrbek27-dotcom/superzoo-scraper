'use strict';

const { assertSafeOutputPath, buildIdentity, exclusionReason, loadConfig, normalizeRawProduct, normalizeText, parseCliArgs, readJson, redactDiagnosticText, writeJsonAtomic } = require('./lib/safety');

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
function convertProduct(product, config) {
  const raw = normalizeRawProduct(product, config);
  const blocked = exclusionReason(raw, config); if (blocked) throw new Error(`Out-of-scope product cannot be converted (${blocked}): ${raw.name}`);
  if (!Number.isFinite(raw.price) || raw.price <= 0) throw new Error(`Invalid current price for ${raw.name}.`);
  const identity = buildIdentity(raw, config); const brand = parseBrand(raw);
  const converted = { id: identity.productId, brand, name: cleanName(raw.name, brand), size: identity.size.size, sizeKg: identity.size.sizeKg, type: mapType(raw), species: mapSpecies(raw.animalType), image: raw.image, offers: [{ partner: 'SuperZoo', price: raw.price, salePrice: raw.salePrice, originalPrice: raw.originalPrice, affiliateUrl: raw.affiliateUrl }] };
  if (/veterinar|veterinary|prescription/.test(normalizeText(`${raw.category} ${raw.name}`))) converted.dietTags = ['veterinary'];
  return converted;
}
function convertDocument(document, config) {
  if (!document || !Array.isArray(document.products) || document.products.length === 0) throw new Error('Input must contain a non-empty products array.');
  const sourceSeen = new Set(); const canonicalSeen = new Set(); const ids = new Set(); const output = [];
  for (const rawInput of document.products) {
    const raw = normalizeRawProduct(rawInput, config);
    if (sourceSeen.has(raw.sourceIdentity)) throw new Error(`Duplicate source identity: ${raw.sourceIdentity}`);
    if (canonicalSeen.has(raw.canonicalIdentity)) throw new Error(`Duplicate canonical identity: ${raw.canonicalIdentity}`);
    sourceSeen.add(raw.sourceIdentity); canonicalSeen.add(raw.canonicalIdentity);
    const product = convertProduct(raw, config);
    if (ids.has(product.id)) throw new Error(`Converted product ID collision: ${product.id}`);
    ids.add(product.id); output.push(product);
  }
  return output;
}
function main() {
  const args = parseCliArgs(process.argv.slice(2)); const input = args.input || process.env.SUPERZOO_CONVERTER_INPUT; const output = args.output || process.env.SUPERZOO_CONVERTER_OUTPUT;
  if (!input || !output) throw new Error('Use --input=<staging-raw.json> and --output=<staging-converted.json>.');
  assertSafeOutputPath(output); const products = convertDocument(readJson(input), loadConfig(args.config)); writeJsonAtomic(output, products); console.log(`[convert] review-only output: ${redactDiagnosticText(output)} (${products.length} products)`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[convert] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { cleanName, convertDocument, convertProduct, mapSpecies, mapType, parseBrand };
