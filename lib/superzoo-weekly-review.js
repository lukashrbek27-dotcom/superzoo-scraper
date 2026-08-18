'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildWeeklyDiff, identityFingerprint, validateAutomationBaseline } = require('./superzoo-automation-baseline');

const REPORT_CONTRACT = 'superzoo-weekly-review-v1';
const PARTNER = 'SuperZoo';
const PRICE_FIELDS = new Set(['price', 'salePrice', 'originalPrice']);

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const compare = (a, b) => String(a || '').localeCompare(String(b || ''));
const canonicalJson = value => `${JSON.stringify(value, null, 2)}\n`;

function safeProductUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'www.superzoo.cz' ? url.toString() : null;
  } catch {
    return null;
  }
}

function packingLabel(packing) {
  if (packing?.size) return packing.size;
  if (packing?.sizeKg) return `${packing.sizeKg} kg`;
  return 'unknown';
}

function productPrice(product) {
  return {
    price: product?.price ?? null,
    salePrice: product?.salePrice ?? null,
    originalPrice: product?.originalPrice ?? null,
  };
}

function buildWeeklyReport({ baseline, raw, catalog = [], baselineSha256 = null, rawSha256 = null, generatedAt, runUrl = null }) {
  const errors = validateAutomationBaseline(baseline);
  if (!baselineSha256 || !/^[a-f0-9]{64}$/u.test(String(baselineSha256))) errors.push('missing_baseline_sha256');
  if (rawSha256 !== null && !/^[a-f0-9]{64}$/u.test(String(rawSha256))) errors.push('invalid_raw_sha256');
  const diff = buildWeeklyDiff({ baseline, raw });
  const identityChangedProductIds = new Set(diff.identityChanges.map(item => item.productId));
  const missing = diff.missing.filter(item => !identityChangedProductIds.has(item.productId));
  const rawByIdentity = new Map();
  for (const product of raw?.products || []) {
    const canonical = String(product?.canonicalIdentity || '');
    const separator = canonical.lastIndexOf('|');
    const source = separator > 0 ? canonical.slice(0, separator) : product?.sourceIdentity;
    const sizeKg = Number(product?.sizeKg);
    const key = source && Number.isFinite(sizeKg) && sizeKg > 0 ? `${source}|kg:${sizeKg}` : canonical;
    rawByIdentity.set(key, product);
  }
  const catalogNames = new Map((catalog || []).map(product => [product?.id, product?.name || null]));
  const report = {
    schemaVersion: 1,
    contract: REPORT_CONTRACT,
    partner: PARTNER,
    generatedAt: generatedAt || null,
    runUrl: runUrl || null,
    verdict: errors.length || diff.blockers.length ? 'SUPERZOO_WEEKLY_REVIEW_BLOCKED' : 'SUPERZOO_WEEKLY_REVIEW_PASS',
    evidence: { baselineSha256, rawSha256 },
    counts: {
      new: diff.new.length,
      missing: missing.length,
      identityChange: diff.identityChanges.length,
      newMissing: missing.length,
      newIdentityChange: diff.identityChanges.length,
      knownBaselineUnresolved: diff.knownBaselineUnresolved.length,
      known: 0,
      unchanged: 0,
      blockers: errors.length + diff.blockers.length,
    },
    new: diff.new.map(item => ({
      partner: PARTNER,
      name: item.name,
      sourceIdentity: safeProductUrl(item.sourceIdentity),
      packing: item.packing,
      packingLabel: packingLabel(item.packing),
      identityKey: item.identityKey,
      identityFingerprint: item.identityFingerprint || null,
      price: productPrice(rawByIdentity.get(item.identityKey)),
    })),
    missing: missing.map(item => ({ ...item, name: catalogNames.get(item.productId) || null, state: 'approved' })),
    identityChanges: diff.identityChanges.map(item => ({
      ...item,
      reason: 'same source identity with changed packing/variant; automatic remap is forbidden',
    })),
    knownBaselineUnresolved: diff.knownBaselineUnresolved,
    blockers: [...errors.map(code => ({ code, count: 1 })), ...diff.blockers],
    remoteActions: { autoAdd: false, autoDelete: false, publish: false, email: false },
  };
  report.newMissing = report.missing;
  report.newIdentityChange = report.identityChanges;
  const knownKeys = new Set([
    ...(baseline?.approved || []),
    ...(baseline?.baselineIgnored || []),
    ...(baseline?.rejected || []),
  ].map(entry => entry.identityKey));
  const rawKeys = new Set();
  for (const product of raw?.products || []) {
    const canonical = String(product?.canonicalIdentity || '');
    const separator = canonical.lastIndexOf('|');
    const source = separator > 0 ? canonical.slice(0, separator) : product?.sourceIdentity;
    const sizeKg = Number(product?.sizeKg);
    rawKeys.add(source && Number.isFinite(sizeKg) && sizeKg > 0 ? `${source}|kg:${sizeKg}` : canonical);
  }
  report.counts.known = [...rawKeys].filter(key => knownKeys.has(key)).length;
  report.counts.unchanged = Math.max(0, report.counts.known - report.counts.missing - report.counts.identityChange);
  report.new.sort((a, b) => compare(a.identityKey, b.identityKey));
  report.missing.sort((a, b) => compare(a.productId, b.productId));
  report.identityChanges.sort((a, b) => compare(a.productId, b.productId));
  return report;
}

function renderWeeklyMarkdown(report) {
  const lines = [
    `# SuperZoo weekly review — ${report.verdict}`,
    '',
    `- Generated: ${report.generatedAt || 'unknown'}`,
    `- Run: ${report.runUrl || 'not available'}`,
    `- NEW: ${report.counts.new}`,
    `- MISSING: ${report.counts.missing}`,
    `- IDENTITY_CHANGE: ${report.counts.identityChange}`,
    `- Known baseline unresolved: ${report.counts.knownBaselineUnresolved || 0}`,
    `- Known/unchanged: ${report.counts.known}/${report.counts.unchanged}`,
    '',
    '## NEW',
  ];
  if (!report.new.length) lines.push('- none');
  for (const item of report.new) lines.push(`- ${item.name || 'unnamed'} | ${item.packingLabel} | ${item.sourceIdentity || 'invalid URL'} | ${JSON.stringify(item.price)}`);
  lines.push('', '## MISSING');
  if (!report.missing.length) lines.push('- none');
  for (const item of report.missing) lines.push(`- ${item.productId} | ${item.sourceIdentity || 'unknown'} | ${packingLabel(item.packing)}`);
  lines.push('', '## IDENTITY_CHANGE');
  if (!report.identityChanges.length) lines.push('- none');
  for (const item of report.identityChanges) lines.push(`- ${item.productId} | ${item.sourceIdentity || 'unknown'} | ${item.reason}`);
  lines.push('', '## KNOWN_BASELINE_UNRESOLVED');
  if (!(report.knownBaselineUnresolved || []).length) lines.push('- none');
  for (const item of report.knownBaselineUnresolved || []) lines.push(`- ${item.productId || 'unknown'} | ${item.unresolvedReason}`);
  if (report.blockers.length) {
    lines.push('', '## BLOCKERS');
    for (const blocker of report.blockers) lines.push(`- ${blocker.code}: ${blocker.count}`);
  }
  return `${lines.join('\n')}\n`;
}

function applyExplicitDecision({ baseline, identityKey, decision, name = null, productId = null }) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  if (decision === 'approved' && (!productId || typeof productId !== 'string')) throw new Error('approved decision requires explicit productId');
  const all = [...(baseline?.approved || []), ...(baseline?.baselineIgnored || []), ...(baseline?.rejected || []), ...(baseline?.pendingReview || [])];
  if (all.some(entry => entry.identityKey === identityKey)) throw new Error('identity already has a durable decision');
  if (!identityKey || typeof identityKey !== 'string') throw new Error('identityKey is required');
  const entry = {
    state: decision,
    partner: PARTNER,
    productId: decision === 'approved' ? productId : null,
    sourceIdentity: identityKey.split('|')[0],
    identityKey,
    packing: { key: identityKey.split('|').slice(1).join('|'), size: null, sizeKg: null },
    name,
    decisionSource: 'explicit-manual-action',
  };
  if (decision === 'approved') entry.dailyEligibility = 'unresolved';
  entry.identityFingerprint = identityFingerprint(entry);
  const target = decision === 'approved' ? 'approved' : 'rejected';
  return { ...baseline, [target]: [...(baseline[target] || []), entry] };
}

function writeReportFiles(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'superzoo-weekly-review.json');
  const mdPath = path.join(outputDir, 'superzoo-weekly-review.md');
  for (const target of [jsonPath, mdPath]) {
    if (fs.existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
  }
  fs.writeFileSync(jsonPath, canonicalJson(report), { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(mdPath, renderWeeklyMarkdown(report), { encoding: 'utf8', flag: 'wx' });
  return { jsonPath, mdPath };
}

module.exports = {
  PARTNER,
  PRICE_FIELDS,
  REPORT_CONTRACT,
  applyExplicitDecision,
  buildWeeklyReport,
  canonicalJson,
  renderWeeklyMarkdown,
  safeProductUrl,
  sha256File,
  writeReportFiles,
};
