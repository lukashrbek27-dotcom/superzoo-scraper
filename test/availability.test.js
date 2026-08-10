'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractProductCards } = require('../lib/page-extractor');
const { loadConfig, normalizeRawProduct } = require('../lib/safety');
const { createReviewSidecar } = require('../scraper');
const { validateRawDocument } = require('../validate-raw');
const { documentedSelector, cases } = require('./fixtures/availability-cases');

const config = loadConfig();
const category = { name: config.sourcePolicy.requiredCategories[0], animalType: 'dog' };

function textNode(value) { return { innerText: value, textContent: value }; }
function card({ id, availabilityNodes = [], parentElement = null } = {}) {
  const result = {
    dataset: id ? { productId: id } : {}, parentElement, childNodes: [], innerText: '', textContent: '',
    matches: selector => selector === '[data-product-id]' && Boolean(id),
    closest: selector => selector === '.product-list__item' ? result : null,
    getAttribute: attribute => attribute === 'data-product-id' ? id || null : null,
    querySelector(selector) {
      if (selector.includes('product-name')) return textNode(`Product ${id}`);
      if (selector.startsWith('a[')) return { href: `https://www.superzoo.cz/${id}/`, getAttribute: () => `https://www.superzoo.cz/${id}/` };
      if (selector === 'img') return { src: 'https://cdn.superzoo.cz/product.jpg', dataset: {}, getAttribute: () => null };
      if (selector.includes('current-price') || selector.includes('product-price')) return textNode('199 Kč');
      return null;
    },
    querySelectorAll: selector => selector === documentedSelector ? availabilityNodes : [],
  };
  return result;
}
function availabilityNode(text, owner) { return { innerText: text, textContent: text, closest: selector => selector === '.product-list__item' ? owner : null }; }
function documentWith(cards) { return { querySelectorAll: selector => selector === '.product-list__item' ? cards : [] }; }
function treeNode({ tag = 'div', classes = [], attrs = {}, text = '', children = [] } = {}) {
  const node = { tagName: tag.toUpperCase(), parentElement: null, classNames: new Set(classes), attrs: { ...attrs }, childNodes: [] };
  node.dataset = Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  node.getAttribute = name => node.attrs[name] ?? null;
  node.href = node.attrs.href;
  node.src = node.attrs.src;
  if (text) node.childNodes.push({ nodeType: 3, textContent: text });
  for (const child of children) { child.parentElement = node; node.childNodes.push(child); }
  node._descendants = () => node.childNodes.flatMap(child => child.nodeType === 3 ? [] : [child, ...child._descendants()]);
  Object.defineProperties(node, { textContent: { get: () => node.childNodes.map(child => child.textContent || '').join('') }, innerText: { get: () => node.textContent } });
  node.matches = selector => selector.split(',').some(part => matchesSimpleSelector(node, part.trim()));
  node.querySelectorAll = selector => node._descendants().filter(candidate => candidate.matches(selector));
  node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
  node.closest = selector => { for (let current = node; current; current = current.parentElement) if (current.matches(selector)) return current; return null; };
  return node;
}
function matchesSimpleSelector(node, selector) {
  if (selector === documentedSelector) return node.tagName === 'SPAN' && node.classNames.has('text-green-500')
    && node.parentElement?.tagName === 'STRONG' && node.parentElement.parentElement?.tagName === 'A'
    && ['text-green-500', 'ajax', 'js-modal'].every(name => node.parentElement.parentElement.classNames.has(name))
    && node.parentElement.parentElement.parentElement?.tagName === 'P'
    && ['mb-0', 'text-sm'].every(name => node.parentElement.parentElement.parentElement.classNames.has(name))
    && node.parentElement.parentElement.parentElement.parentElement?.classNames.has('product-box__availability-cta');
  if (selector === '.product-list__item') return node.classNames.has('product-list__item');
  if (selector === '[data-product-id]') return node.attrs['data-product-id'] != null;
  if (selector === 'img') return node.tagName === 'IMG';
  if (selector === 'del') return node.tagName === 'DEL';
  if (selector === 'h2' || selector === 'h3') return node.tagName === selector.toUpperCase();
  if (selector === 'a[href]' || selector.startsWith('a[href')) return node.tagName === 'A' && Boolean(node.attrs.href);
  if (selector === '[data-testid="product-name"]') return node.attrs['data-testid'] === 'product-name';
  if (selector === '[data-testid="current-price"]') return node.attrs['data-testid'] === 'current-price';
  if (selector === '[data-testid="original-price"]') return node.attrs['data-testid'] === 'original-price';
  if (selector === '[data-testid="price"]') return node.attrs['data-testid'] === 'price';
  if (selector.startsWith('.')) return node.classNames.has(selector.slice(1));
  return false;
}
function availabilityTree(text) {
  const span = treeNode({ tag: 'span', classes: ['text-green-500'], text });
  const strong = treeNode({ tag: 'strong', children: [span] });
  const anchor = treeNode({ tag: 'a', classes: ['text-green-500', 'ajax', 'js-modal'], attrs: { href: '/dostupnost-produktu/?productId=test' }, children: [strong] });
  const paragraph = treeNode({ tag: 'p', classes: ['mb-0', 'text-sm'], children: [anchor] });
  return treeNode({ classes: ['product-box__availability-cta'], children: [paragraph] });
}
function productTreeCard(id, availabilityTexts = [], children = []) {
  return treeNode({ classes: ['product-list__item'], attrs: { 'data-product-id': id }, children: [
    treeNode({ tag: 'h2', text: `Product ${id}` }), treeNode({ tag: 'a', attrs: { href: `https://www.superzoo.cz/${id}/` }, text: 'Detail' }),
    treeNode({ tag: 'img', attrs: { src: 'https://cdn.superzoo.cz/product.jpg' } }), treeNode({ tag: 'span', attrs: { 'data-testid': 'current-price' }, text: '199 KÄŤ' }),
    ...availabilityTexts.map(availabilityTree), ...children,
  ] });
}
function treeDocument(children) { return treeNode({ tag: 'body', children }); }
function raw(availability) {
  return {
    name: 'Brit Care Adult Salmon 3 kg', price: '399 Kč', salePrice: null, originalPrice: null,
    url: 'https://www.superzoo.cz/brit-care-adult-salmon-3-kg/', image: 'https://cdn.superzoo.cz/brit-care.jpg',
    category: category.name, animalType: 'dog', ...(availability === undefined ? {} : { availability }),
  };
}
function configForOneProduct() {
  const copy = structuredClone(config);
  copy.sourcePolicy.requiredCategories = [category.name];
  copy.thresholds.minimumCategoryProducts = { [category.name]: 1 };
  copy.thresholds.minimumTotalProducts = 1;
  copy.baselineContract.preFilter.totalProducts = 1;
  copy.baselineContract.preFilter.categoryCounts = { [category.name]: 1 };
  copy.baselineContract.postExclusion.totalProducts = 1;
  copy.baselineContract.postExclusion.filteredOutProducts = 0;
  copy.baselineContract.postExclusion.categoryCounts = { [category.name]: 1 };
  return copy;
}
function documentFor(product) {
  return { schemaVersion: 2, source: 'superzoo.cz', reviewOnly: true, totalProducts: 1, requiredCategories: [category.name], categoryCounts: { [category.name]: 1 }, runStats: { rejectedCards: 0, unparseableCards: 0, filteredOutCards: 0, rejectedReasons: {} }, products: [product] };
}

test('availability is card-local, exact, whitespace-normalized, and fail-closed', () => {
  const inStock = card({ id: 'in-stock' });
  inStock.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode('  sKlAdEm  ', inStock)] : [];
  const unknown = card({ id: 'unknown' });
  unknown.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.unknown, unknown)] : [];
  const negated = card({ id: 'negated' });
  negated.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.negated, negated)] : [];
  const containsStock = card({ id: 'contains-stock' });
  containsStock.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.containsStock, containsStock)] : [];
  const storeStock = card({ id: 'store-stock' });
  storeStock.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.storeStock, storeStock)] : [];
  const multiple = card({ id: 'multiple' });
  multiple.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.inStock, multiple), availabilityNode(cases.unknown, multiple)] : [];
  const missing = card({ id: 'missing' });
  const nested = card({ id: 'nested' });
  const parent = card({ id: 'parent' });
  parent.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.inStock, nested)] : [];
  nested.parentElement = parent;
  const sibling = card({ id: 'sibling' });
  sibling.querySelectorAll = selector => selector === documentedSelector ? [availabilityNode(cases.inStock, sibling)] : [];

  const products = extractProductCards(category, documentWith([inStock, unknown, negated, containsStock, storeStock, multiple, missing, parent, nested, sibling])).products;
  assert.deepEqual(products.map(product => product.availability), [
    { status: 'in_stock', rawText: 'sKlAdEm' },
    { status: 'unknown', rawText: 'Na objednávku' },
    { status: 'unknown', rawText: 'Není skladem' },
    { status: 'unknown', rawText: 'Pouze skladem online' },
    { status: 'unknown', rawText: 'Skladem na prodejnÄ›' },
    { status: 'unknown', rawText: null },
    { status: 'unknown', rawText: null },
    { status: 'unknown', rawText: null },
    { status: 'in_stock', rawText: 'Skladem' },
  ]);
  assert.deepEqual(products.map(product => product.sourceProductId), ['in-stock', 'unknown', 'negated', 'contains-stock', 'store-stock', 'multiple', 'missing', 'parent', 'sibling']);
});

test('tree-backed nested availability belongs only to its nearest matching product card', () => {
  const nestedOnly = productTreeCard('nested-only', [cases.inStock]);
  const parentWithoutOwnAvailability = productTreeCard('parent-without-own', [], [nestedOnly]);
  const nestedWithOwn = productTreeCard('nested-with-own', [cases.unknown]);
  const parentWithOwnAvailability = productTreeCard('parent-with-own', [cases.inStock], [nestedWithOwn]);
  const sibling = productTreeCard('sibling', [cases.inStock]);
  const documentRef = treeDocument([parentWithoutOwnAvailability, parentWithOwnAvailability, sibling]);

  const nestedCandidate = parentWithoutOwnAvailability.querySelectorAll(documentedSelector)[0];
  assert.equal(nestedCandidate.closest('.product-list__item'), nestedOnly);
  assert.equal(parentWithoutOwnAvailability.querySelectorAll(documentedSelector).length, 1);
  assert.equal(parentWithOwnAvailability.querySelectorAll(documentedSelector).length, 2);

  const products = extractProductCards(category, documentRef).products;
  assert.deepEqual(products.map(product => product.sourceProductId), ['parent-without-own', 'parent-with-own', 'sibling']);
  assert.deepEqual(products.map(product => product.availability), [
    { status: 'unknown', rawText: null },
    { status: 'in_stock', rawText: 'Skladem' },
    { status: 'in_stock', rawText: 'Skladem' },
  ]);
});

test('raw availability is backward-compatible and validator rejects unsupported forms', () => {
  const cfg = configForOneProduct();
  const current = normalizeRawProduct(raw({ status: 'in_stock', rawText: ' Skladem ' }), cfg);
  const legacy = normalizeRawProduct(raw(), cfg);
  assert.deepEqual(current.availability, { status: 'in_stock', rawText: 'Skladem' });
  assert.deepEqual(legacy.availability, { status: 'unknown', rawText: null });
  assert.equal(current.sourceIdentity, legacy.sourceIdentity);
  assert.equal(validateRawDocument(documentFor(raw({ status: 'in_stock', rawText: 'Skladem' })), cfg).passed, true);
  assert.equal(validateRawDocument(documentFor(raw({ status: 'unknown', rawText: cases.unknown })), cfg).passed, true);
  assert.equal(validateRawDocument(documentFor(raw({ status: 'unknown', rawText: null })), cfg).passed, true);
  assert.equal(validateRawDocument(documentFor(raw()), cfg).passed, true);
  const invalid = validateRawDocument(documentFor(raw({ status: 'out_of_stock', rawText: 'Vyprodáno' })), cfg);
  assert.ok(invalid.errors.some(error => error.code === 'invalid_availability_status'));
  for (const rawText of [42, {}, '  Skladem  ']) {
    const invalidRawText = validateRawDocument(documentFor(raw({ status: 'unknown', rawText })), cfg);
    assert.ok(invalidRawText.errors.some(error => error.code === 'invalid_availability_raw_text'));
  }
});

test('review sidecar summarizes availability without treating unknown as in stock', () => {
  const state = { pages: [], rejectedCards: [], filteredCards: [], rejectedByReason: {}, rejectedByCategory: {}, filteredByType: {}, filteredByCategory: {}, categoryTerminationReasons: {} };
  const sidecar = createReviewSidecar({ scrapedAt: '2026-01-01T00:00:00.000Z', source: 'superzoo.cz', products: [
    { sourceIdentity: 'one', category: category.name, availability: { status: 'in_stock', rawText: 'Skladem' } },
    { sourceIdentity: 'two', category: category.name, availability: { status: 'unknown', rawText: 'Na objednávku' } },
    { sourceIdentity: 'three', category: category.name },
  ] }, state);
  assert.deepEqual(sidecar.summary.availabilityByStatus, { in_stock: 1, unknown: 2 });
});
