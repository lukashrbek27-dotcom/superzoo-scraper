#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCliArgs } = require('./lib/safety');
const {
  buildAutomationBaseline,
  canonicalJson,
  sha256,
  validateAutomationBaseline,
} = require('./lib/superzoo-automation-baseline');

function required(args, name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return path.resolve(args[name]);
}

function readJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

function assertBaselineOutput(outputPath) {
  const allowed = path.resolve(process.cwd(), 'config', 'superzoo-automation-baseline.json');
  if (path.resolve(outputPath) !== allowed) throw new Error(`Baseline output must be exactly ${allowed}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const catalog = readJson(required(args, 'catalog'));
  const publicCatalog = readJson(required(args, 'public-catalog'));
  const raw = readJson(required(args, 'raw'));
  const sidecar = readJson(required(args, 'sidecar'));
  const outputPath = required(args, 'output');
  assertBaselineOutput(outputPath);
  const { baseline, blockers } = buildAutomationBaseline({
    catalog: catalog.value,
    publicCatalog: publicCatalog.value,
    raw: raw.value,
    sidecar: sidecar.value,
    catalogSha256: catalog.sha256,
    publicCatalogSha256: publicCatalog.sha256,
    rawSha256: raw.sha256,
    sidecarSha256: sidecar.sha256,
  });
  const validation = validateAutomationBaseline(baseline, {
    catalogSha256: catalog.sha256,
    publicCatalogSha256: publicCatalog.sha256,
    rawSha256: raw.sha256,
    sidecarSha256: sidecar.sha256,
  });
  if (blockers.length || validation.length) throw new Error(`Baseline blocked: ${[...blockers.map(item => item.code), ...validation].join(', ')}`);
  const serialized = canonicalJson(baseline);
  if (args.check === true || args.check === 'true') {
    const existing = fs.readFileSync(outputPath, 'utf8');
    if (existing !== serialized) throw new Error('Deterministic baseline regeneration mismatch');
  } else {
    fs.writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ verdict: 'SUPERZOO_AUTOMATION_BASELINE_PASS', output: outputPath, sha256: sha256(Buffer.from(serialized)), counts: baseline.counts }, null, 2)}\n`);
  return baseline;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[superzoo-automation-baseline] FAILED: ${error.message}`); process.exitCode = 1; }
}

module.exports = { main };
