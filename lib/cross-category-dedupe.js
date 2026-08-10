'use strict';

const { normalizeRawProduct } = require('./safety');

const COMMERCIAL_FIELDS = [
  'sourceIdentity', 'canonicalIdentity', 'canonicalUrl', 'targetUrl', 'name',
  'price', 'salePrice', 'originalPrice', 'image', 'animalType', 'size', 'sizeKg',
];

function comparableAvailability(product) {
  return {
    status: product?.availability?.status === 'in_stock' ? 'in_stock' : 'unknown',
    rawText: product?.availability?.rawText ?? null,
  };
}

function differingCommercialFields(first, current) {
  const differing = COMMERCIAL_FIELDS.filter(field => first[field] !== current[field]);
  if (JSON.stringify(comparableAvailability(first)) !== JSON.stringify(comparableAvailability(current))) differing.push('availability');
  return differing;
}

function duplicateError(code, identity, categories, differingFields) {
  const error = new Error(`${code}: ${identity}; categories=${categories.join(', ')}; differingFields=${differingFields.join(', ') || 'none'}.`);
  error.code = code;
  error.identity = identity;
  error.categories = categories;
  error.differingFields = differingFields;
  return error;
}

function classifyNormalizedProducts(products) {
  const sourceGroups = new Map();
  const canonicalOwners = new Map();
  for (const [index, product] of products.entries()) {
    const sourceEntries = sourceGroups.get(product.sourceIdentity) || [];
    sourceEntries.push({ index, product });
    sourceGroups.set(product.sourceIdentity, sourceEntries);
    const owners = canonicalOwners.get(product.canonicalIdentity) || [];
    owners.push({ index, product });
    canonicalOwners.set(product.canonicalIdentity, owners);
  }

  const conflicts = [];
  for (const [canonicalIdentity, entries] of canonicalOwners) {
    if (new Set(entries.map(entry => entry.product.sourceIdentity)).size > 1) {
      conflicts.push({
        code: 'identity_collision', identity: canonicalIdentity,
        categories: [...new Set(entries.map(entry => entry.product.category))].sort(),
        indexes: entries.map(entry => entry.index), differingFields: ['sourceIdentity'],
      });
    }
  }

  const legitimateClusters = [];
  const groups = [];
  for (const [sourceIdentity, entries] of sourceGroups) {
    const categories = [...new Set(entries.map(entry => entry.product.category))].sort();
    if (entries.length === 1) {
      groups.push({ identity: sourceIdentity, categories, entries, legitimate: false });
      continue;
    }
    const differingFields = entries.slice(1).flatMap(entry => differingCommercialFields(entries[0].product, entry.product));
    const uniqueDifferingFields = [...new Set(differingFields)].sort();
    if (categories.length === 1) {
      conflicts.push({ code: 'duplicate_within_category', identity: sourceIdentity, categories, indexes: entries.map(entry => entry.index), differingFields: uniqueDifferingFields });
      continue;
    }
    if (uniqueDifferingFields.length) {
      const code = uniqueDifferingFields.some(field => ['canonicalIdentity', 'canonicalUrl', 'targetUrl'].includes(field))
        ? 'identity_collision'
        : 'cross_category_commercial_conflict';
      conflicts.push({ code, identity: sourceIdentity, categories, indexes: entries.map(entry => entry.index), differingFields: uniqueDifferingFields });
      continue;
    }
    const group = { identity: sourceIdentity, categories, entries, legitimate: true };
    legitimateClusters.push(group);
    groups.push(group);
  }

  return { groups, legitimateClusters, conflicts };
}

function canonicalizeCrossCategoryProducts(products, config) {
  const normalized = products.map(product => normalizeRawProduct(product, config));
  const classification = classifyNormalizedProducts(normalized);
  if (classification.conflicts.length) {
    const conflict = classification.conflicts[0];
    throw duplicateError(conflict.code, conflict.identity, conflict.categories, conflict.differingFields);
  }
  return classification.groups
    .map(group => ({ product: group.entries[0].product, sourceCategories: group.categories, sourceIndexes: group.entries.map(entry => entry.index) }))
    .sort((left, right) => left.product.sourceIdentity.localeCompare(right.product.sourceIdentity));
}

module.exports = { canonicalizeCrossCategoryProducts, classifyNormalizedProducts, differingCommercialFields };
