'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildProvenance, EXPECTED_COUNTS } = require('../lib/superzoo-managed-price-provenance');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superzoo-provenance-test-'));
  const write = (name, value) => {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return { filePath, sha256: hash(fs.readFileSync(filePath)) };
  };
  const generatedAt = '2026-08-20T04:12:13.000Z';
  const raw = write('superzoo-raw.json', { schemaVersion: 2, source: 'superzoo.cz', reviewOnly: true, scrapedAt: generatedAt, products: [] });
  const sidecar = write('review-sidecar.json', { schemaVersion: 2, source: 'superzoo.cz', reviewOnly: true, scrapedAt: generatedAt });
  const baseline = write('superzoo-automation-baseline.json', { counts: { approved: EXPECTED_COUNTS.approved, exactSafeApproved: EXPECTED_COUNTS.exactSafe, unresolvedApproved: EXPECTED_COUNTS.unresolved } });
  const catalog = write('partner-foods.json', []);
  const remoteActions = { publish: false, upload: false, deploy: false, scheduler: false, gcs: false };
  const candidate = write('superzoo-managed-price-candidate.json', {
    schemaVersion: 2, source: 'superzoo-scraper', partner: 'SuperZoo', reviewOnly: true, generatorReady: true,
    generatedAt, catalogSha256: catalog.sha256, scopeSha256: baseline.sha256, remoteActions,
  });
  const validation = write('superzoo-managed-price-validation.json', {
    verdict: 'SUPERZOO_MANAGED_PRICE_PASS', passed: true, generatedAt,
    rawSha256: raw.sha256, sidecarSha256: sidecar.sha256, catalogSha256: catalog.sha256, scopeSha256: baseline.sha256,
    approvedTotal: EXPECTED_COUNTS.approved, managedSetEntries: EXPECTED_COUNTS.exactSafe, unresolvedApproved: EXPECTED_COUNTS.unresolved,
    managedCoverage: { observed: EXPECTED_COUNTS.exactSafe, required: EXPECTED_COUNTS.exactSafe, ratio: 1 }, remoteActions,
  });
  return {
    root,
    options: {
      rawPath: raw.filePath, sidecarPath: sidecar.filePath, candidatePath: candidate.filePath,
      validationPath: validation.filePath, baselinePath: baseline.filePath, catalogPath: catalog.filePath,
      runId: '12345', runAttempt: '2', repository: 'owner/superzoo-scraper',
      workflowRef: 'owner/superzoo-scraper/.github/workflows/superzoo-managed-price.yml@refs/heads/main',
      scraperCommit: 'a'.repeat(40), catalogCommit: 'b'.repeat(40),
    },
  };
}

test('PASS provenance binds run, commits, hashes, managed counts, and complete coverage', () => {
  const value = fixture();
  try {
    const provenance = buildProvenance(value.options);
    assert.equal(provenance.verdict, 'SUPERZOO_SCHEDULED_PRODUCER_PASS');
    assert.deepEqual(provenance.run, { id: '12345', attempt: 2, repository: 'owner/superzoo-scraper', workflowRef: value.options.workflowRef });
    assert.deepEqual(provenance.managedContract, { approved: 981, exactSafe: 917, unresolved: 64, coverage: { observed: 917, required: 917, ratio: 1 } });
    assert.equal(provenance.artifacts.length, 6);
    assert.equal(Object.values(provenance.remoteActions).every(action => action === false), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('tampered SHA, unsafe remote action, incomplete coverage, and managed count drift fail closed', () => {
  for (const mutate of [
    value => { const report = JSON.parse(fs.readFileSync(value.options.validationPath, 'utf8')); report.rawSha256 = '0'.repeat(64); fs.writeFileSync(value.options.validationPath, JSON.stringify(report)); },
    value => { const candidate = JSON.parse(fs.readFileSync(value.options.candidatePath, 'utf8')); candidate.remoteActions.publish = true; fs.writeFileSync(value.options.candidatePath, JSON.stringify(candidate)); },
    value => { const report = JSON.parse(fs.readFileSync(value.options.validationPath, 'utf8')); report.managedCoverage.observed -= 1; fs.writeFileSync(value.options.validationPath, JSON.stringify(report)); },
    value => { const baseline = JSON.parse(fs.readFileSync(value.options.baselinePath, 'utf8')); baseline.counts.unresolvedApproved -= 1; fs.writeFileSync(value.options.baselinePath, JSON.stringify(baseline)); },
  ]) {
    const value = fixture();
    try {
      mutate(value);
      assert.throws(() => buildProvenance(value.options));
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
  }
});
