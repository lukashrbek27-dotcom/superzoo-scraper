'use strict';

function productCardDomFingerprint(documentRef = document) {
  const selectors = ['.product-item', '.product-list__item', '[data-testid="product-card"]', '[data-product-id]'];
  let elements = [];
  for (const selector of selectors) {
    elements = Array.from(documentRef.querySelectorAll(selector));
    if (elements.length) break;
  }
  return elements.map((element, index) => {
    try { return String(element.dataset?.productId || element.querySelector?.('a')?.href || `unidentified-${index}`); }
    catch { return `unparseable-${index}`; }
  }).sort().join('\n');
}

function extractProductCards(category, documentRef = document) {
  const selectors = ['.product-item', '.product-list__item', '[data-testid="product-card"]', '[data-product-id]'];
  const directText = node => {
    if (!node) return '';
    const direct = Array.from(node.childNodes || [])
      .filter(child => child.nodeType === 3)
      .map(child => child.textContent || '')
      .join(' ')
      .trim();
    return direct || String(node.innerText || node.textContent || '').trim();
  };
  let selector = null;
  let elements = [];
  for (const candidate of selectors) {
    const matches = Array.from(documentRef.querySelectorAll(candidate));
    if (matches.length > 0) { selector = candidate; elements = matches; break; }
  }
  if (!selector) return { selector: null, selectorMissing: true, domFingerprint: '', products: [], rejectedCards: 0, unparseableCards: 0, rejectedReasons: {} };

  const products = [];
  const rejectedReasons = {};
  let rejectedCards = 0;
  let unparseableCards = 0;
  const reject = reason => { rejectedCards += 1; rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1; };

  for (const element of elements) {
    try {
      const identityElement = element.matches?.('[data-product-id]') ? element : element.querySelector('[data-product-id]');
      const sourceProductId = String(element.dataset?.productId || element.getAttribute?.('data-product-id') || identityElement?.dataset?.productId || identityElement?.getAttribute?.('data-product-id') || '').trim();
      const nameElement = element.querySelector('[data-testid="product-name"], .product-item__name, .product-list__name, h2, h3');
      const linkElement = element.querySelector('a[href*="superzoo.cz"], a[href^="/"]');
      const imageElement = element.querySelector('img');
      const currentElement = element.querySelector('[data-testid="current-price"], .product-item__price-current, [class*="grid-area-[current]"], [class*="sale-price"]');
      const originalElement = element.querySelector('del, [data-testid="original-price"], .product-item__price-original, [class*="grid-area-[original]"]');
      const regularElement = element.querySelector('[data-testid="price"], .product-item__price, .product-box__price, [class*="product-price"]');
      const name = String(nameElement?.innerText || nameElement?.textContent || '').trim();
      const url = String(linkElement?.href || linkElement?.getAttribute?.('href') || '').trim();
      const image = String(imageElement?.dataset?.src || imageElement?.dataset?.lazySrc || imageElement?.src || imageElement?.getAttribute?.('src') || '').trim();
      const currentPriceText = directText(currentElement || regularElement);
      const originalPriceText = directText(originalElement);
      if (!name) { reject('missing_name'); continue; }
      if (!url) { reject('missing_url'); continue; }
      if (!currentPriceText) { reject('missing_current_price'); continue; }
      if (!image || image.startsWith('data:') || /placeholder/i.test(image)) { reject('missing_image'); continue; }
      products.push({ sourceProductId: sourceProductId || null, name, price: currentPriceText, salePrice: originalPriceText ? currentPriceText : null, originalPrice: originalPriceText || null, url, image, category: category.name, animalType: category.animalType });
    } catch {
      unparseableCards += 1;
      rejectedReasons.unparseable_card = (rejectedReasons.unparseable_card || 0) + 1;
    }
  }
  // Keep this self-contained because Playwright serializes extractProductCards without module closures.
  const domFingerprint = elements.map((element, index) => {
    try { return String(element.dataset?.productId || element.querySelector?.('a')?.href || `unidentified-${index}`); }
    catch { return `unparseable-${index}`; }
  }).sort().join('\n');
  return { selector, selectorMissing: false, domFingerprint, products, rejectedCards, unparseableCards, rejectedReasons };
}

module.exports = { extractProductCards, productCardDomFingerprint };
