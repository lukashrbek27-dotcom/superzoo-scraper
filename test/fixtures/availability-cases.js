'use strict';

module.exports = {
  documentedSelector: '.product-box__availability-cta p.mb-0.text-sm > a.text-green-500.ajax.js-modal > strong > span.text-green-500',
  cases: {
    inStock: 'Skladem',
    containsStock: 'Pouze skladem online',
    storeStock: 'Skladem na prodejnÄ›',
    unknown: 'Na objednávku',
    negated: 'Není skladem',
  },
};
