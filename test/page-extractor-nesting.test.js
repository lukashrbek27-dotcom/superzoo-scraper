'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractProductCards, productCardDomFingerprint } = require('../lib/page-extractor');
const { clickNextIfExpectedState } = require('../scraper');

const category = { key: 'test-category', name: 'Test category', animalType: 'rodent', url: 'https://www.superzoo.cz/test-category/' };

function textNode(value) {
  return { innerText: value, textContent: value };
}

function createProductCard({ id, name = 'Test product', price = '199 Kč', image = 'https://cdn.example.test/product.jpg', url = 'https://www.superzoo.cz/test-product/', parentElement = null } = {}) {
  const card = {
    dataset: id ? { productId: id } : {}, parentElement, childNodes: [], innerText: '', textContent: '',
    matches: selector => selector === '[data-product-id]' && Boolean(id),
    closest: selector => selector === '.product-list__item' ? card : null,
    getAttribute: attribute => attribute === 'data-product-id' ? id || null : null,
    querySelector(selector) {
      if (selector.includes('product-name') || selector.includes('product-title')) return name === null ? null : textNode(name);
      if (selector.startsWith('a[') || selector === 'a[href]') return url === null ? null : { href: url, getAttribute: () => url };
      if (selector === 'img') return image === null ? null : { src: image, currentSrc: image, dataset: {}, getAttribute: () => null };
      if (selector.includes('current-price') || selector.includes('product-item__price-current') || selector.includes('product-price')) return price === null ? null : textNode(price);
      return null;
    },
    querySelectorAll: () => [],
  };
  return card;
}

function createNestedAction(parentElement) {
  return { parentElement, querySelector: () => null, querySelectorAll: () => [] };
}

function documentWithSelectedCards(cards, selector = '.product-list__item') {
  return { querySelectorAll: candidate => candidate === selector ? cards : [] };
}

async function evaluateWithFakePage(functionToEvaluate, argument, documentRef, control) {
  const previous = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = documentRef;
  globalThis.window = { location: { href: 'https://www.superzoo.cz/test-category/' } };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  try {
    return await functionToEvaluate(argument);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.getComputedStyle = previous.getComputedStyle;
  }
}

test('nested matching action is not extracted as a separate product card', () => {
  const product = createProductCard({ id: 'product-1' });
  const result = extractProductCards(category, documentWithSelectedCards([product, createNestedAction(product)]));

  assert.equal(result.selector, '.product-list__item');
  assert.equal(result.products.length, 1);
  assert.equal(result.rejectedCards, 0);
  assert.deepEqual(result.rejectedReasons, {});
  assert.deepEqual(result.products[0], {
    sourceProductId: 'product-1', name: 'Test product', price: '199 Kč', salePrice: null, originalPrice: null,
    url: 'https://www.superzoo.cz/test-product/', image: 'https://cdn.example.test/product.jpg', availability: { status: 'unknown', rawText: null }, category: 'Test category', animalType: 'rodent',
  });
});

test('nested-card filtering preserves top-level sibling order and identities', () => {
  const first = createProductCard({ id: 'first', name: 'First', url: 'https://www.superzoo.cz/first/' });
  const second = createProductCard({ id: 'second', name: 'Second', url: 'https://www.superzoo.cz/second/' });
  const result = extractProductCards(category, documentWithSelectedCards([first, createNestedAction(first), second, createNestedAction(second)]));

  assert.deepEqual(result.products.map(product => product.name), ['First', 'Second']);
  assert.deepEqual(result.products.map(product => product.sourceProductId), ['first', 'second']);
  assert.equal(result.rejectedCards, 0);
});

test('top-level card with a missing name remains rejected', () => {
  const result = extractProductCards(category, documentWithSelectedCards([createProductCard({ id: 'missing-name', name: null })]));

  assert.equal(result.products.length, 0);
  assert.equal(result.rejectedCards, 1);
  assert.deepEqual(result.rejectedReasons, { missing_name: 1 });
});

test('top-level card without an image remains rejected as missing_image', () => {
  const result = extractProductCards(category, documentWithSelectedCards([createProductCard({ id: 'missing-image', image: null })]));

  assert.equal(result.products.length, 0);
  assert.equal(result.rejectedCards, 1);
  assert.deepEqual(result.rejectedReasons, { missing_image: 1 });
});

test('nesting is scoped to the selected card selector', () => {
  const unrelatedParent = { closest: selector => selector === '.product-item' ? unrelatedParent : null };
  const product = createProductCard({ id: 'scoped', parentElement: unrelatedParent });
  const result = extractProductCards(category, documentWithSelectedCards([product]));

  assert.equal(result.selector, '.product-list__item');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].sourceProductId, 'scoped');
});

test('nested matches use the same fingerprint as extractor and allow the expected pagination click', async () => {
  const first = createProductCard({ id: 'first' });
  const second = createProductCard({ id: 'second' });
  const nested = createNestedAction(first);
  let clicks = 0;
  const control = {
    innerText: 'Další stránka',
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    click: () => { clicks += 1; },
  };
  const documentRef = {
    querySelectorAll(candidate) {
      if (candidate === '.product-list__item') return [first, nested, second];
      if (candidate === 'a, button') return [control];
      return [];
    },
  };
  const extraction = extractProductCards(category, documentRef);
  const fingerprint = productCardDomFingerprint(documentRef);
  const page = { evaluate: (fn, argument) => evaluateWithFakePage(fn, argument, documentRef, control) };
  const result = await clickNextIfExpectedState(page, {
    canonicalUrl: 'https://www.superzoo.cz/test-category/',
    domFingerprint: extraction.domFingerprint,
  });

  assert.equal(extraction.products.length, 2);
  assert.equal(extraction.domFingerprint, 'first\nsecond');
  assert.equal(fingerprint, extraction.domFingerprint);
  assert.doesNotMatch(fingerprint, /unidentified/);
  assert.equal(result.status, 'clicked');
  assert.equal(clicks, 1);
});
