'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertSafeOutputPath, parseCliArgs, writeJsonAtomic } = require('./safety');

const CONTRACT = 'superzoo-scheduled-producer-provenance-v1';
const EXPECTED_COUNTS = Object.freeze({ approved: 981, exactSafe: 933, unresolved: 48 });
const NO_REMOTE_ACTIONS = Object.freeze({ publish: false, upload: false, deploy: false, scheduler: false, gcs: false });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8')) };
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function assertSha(value, name) {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${name} must be a lowercase 40-character Git SHA`);
}

function assertNoRemoteActions(value, name) {
  if (JSON.stringify(value) !== JSON.stringify(NO_REMOTE_ACTIONS)) throw new Error(`${name} remoteActions contract is unsafe`);
}

function buildProvenance(options) {
  const raw = readJson(options.rawPath);
  const sidecar = readJson(options.sidecarPath);
  const candidate = readJson(options.candidatePath);
  const validation = readJson(options.validationPath);
  const baseline = readJson(options.baselinePath);
  const catalog = readJson(options.catalogPath);
  const runId = required(options.runId, 'runId');
  const runAttempt = required(options.runAttempt, 'runAttempt');
  const repository = required(options.repository, 'repository');
  const workflowRef = required(options.workflowRef, 'workflowRef');
  const scraperCommit = required(options.scraperCommit, 'scraperCommit');
  const catalogCommit = required(options.catalogCommit, 'catalogCommit');
  if (!/^\d+$/u.test(runId) || !/^[1-9]\d*$/u.test(runAttempt)) throw new Error('run identity must be numeric');
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('repository must be owner/name');
  assertSha(scraperCommit, 'scraperCommit');
  assertSha(catalogCommit, 'catalogCommit');

  if (raw.value?.schemaVersion !== 2 || raw.value?.source !== 'superzoo.cz' || raw.value?.reviewOnly !== true) throw new Error('raw artifact contract failed');
  if (sidecar.value?.schemaVersion !== 2 || sidecar.value?.source !== 'superzoo.cz' || sidecar.value?.reviewOnly !== true) throw new Error('sidecar artifact contract failed');
  if (raw.value.scrapedAt !== sidecar.value.scrapedAt) throw new Error('raw/sidecar scrapedAt mismatch');
  if (candidate.value?.schemaVersion !== 2 || candidate.value?.source !== 'superzoo-scraper' || candidate.value?.partner !== 'SuperZoo') throw new Error('candidate artifact contract failed');
  if (candidate.value?.reviewOnly !== true || candidate.value?.generatorReady !== true) throw new Error('candidate is not PASS review evidence');
  if (validation.value?.verdict !== 'SUPERZOO_MANAGED_PRICE_PASS' || validation.value?.passed !== true) throw new Error('managed-price validation did not PASS');
  if (candidate.value.generatedAt !== raw.value.scrapedAt || validation.value.generatedAt !== raw.value.scrapedAt) throw new Error('generatedAt provenance mismatch');
  if (validation.value.rawSha256 !== raw.sha256 || validation.value.sidecarSha256 !== sidecar.sha256) throw new Error('raw/sidecar SHA binding mismatch');
  if (candidate.value.catalogSha256 !== catalog.sha256 || validation.value.catalogSha256 !== catalog.sha256) throw new Error('catalog SHA binding mismatch');
  if (candidate.value.scopeSha256 !== baseline.sha256 || validation.value.scopeSha256 !== baseline.sha256) throw new Error('automation baseline SHA binding mismatch');
  if (validation.value.approvedTotal !== EXPECTED_COUNTS.approved
      || validation.value.managedSetEntries !== EXPECTED_COUNTS.exactSafe
      || validation.value.unresolvedApproved !== EXPECTED_COUNTS.unresolved) throw new Error('managed-set count contract changed');
  if (validation.value.managedCoverage?.observed !== EXPECTED_COUNTS.exactSafe
      || validation.value.managedCoverage?.required !== EXPECTED_COUNTS.exactSafe
      || validation.value.managedCoverage?.ratio !== 1) throw new Error('managed coverage is incomplete');
  if (baseline.value?.counts?.approved !== EXPECTED_COUNTS.approved
      || baseline.value?.counts?.exactSafeApproved !== EXPECTED_COUNTS.exactSafe
      || baseline.value?.counts?.unresolvedApproved !== EXPECTED_COUNTS.unresolved) throw new Error('automation baseline count contract changed');
  assertNoRemoteActions(candidate.value.remoteActions, 'candidate');
  assertNoRemoteActions(validation.value.remoteActions, 'validation');

  const artifacts = [
    ['raw', options.rawPath, raw],
    ['reviewSidecar', options.sidecarPath, sidecar],
    ['managedPriceCandidate', options.candidatePath, candidate],
    ['managedPriceValidation', options.validationPath, validation],
    ['automationBaseline', options.baselinePath, baseline],
    ['catalog', options.catalogPath, catalog],
  ].map(([role, filePath, artifact]) => ({ role, fileName: path.basename(filePath), sha256: artifact.sha256 }));

  return {
    schemaVersion: 1,
    contract: CONTRACT,
    verdict: 'SUPERZOO_SCHEDULED_PRODUCER_PASS',
    generatedAt: raw.value.scrapedAt,
    run: { id: runId, attempt: Number(runAttempt), repository, workflowRef },
    commits: { scraper: scraperCommit, catalog: catalogCommit },
    managedContract: {
      approved: EXPECTED_COUNTS.approved,
      exactSafe: EXPECTED_COUNTS.exactSafe,
      unresolved: EXPECTED_COUNTS.unresolved,
      coverage: validation.value.managedCoverage,
    },
    artifacts,
    remoteActions: { commit: false, push: false, publish: false, upload: false, deploy: false, gcs: false, catalogImport: false, autoAdd: false },
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const outputPath = required(args.output, 'output');
  assertSafeOutputPath(outputPath);
  const provenance = buildProvenance({
    rawPath: required(args.raw, 'raw'),
    sidecarPath: required(args.sidecar, 'sidecar'),
    candidatePath: required(args.candidate, 'candidate'),
    validationPath: required(args.validation, 'validation'),
    baselinePath: required(args.baseline, 'baseline'),
    catalogPath: required(args.catalog, 'catalog'),
    runId: args['run-id'],
    runAttempt: args['run-attempt'],
    repository: args.repository,
    workflowRef: args['workflow-ref'],
    scraperCommit: args['scraper-commit'],
    catalogCommit: args['catalog-commit'],
  });
  writeJsonAtomic(outputPath, provenance);
  process.stdout.write(`${JSON.stringify({ verdict: provenance.verdict, run: provenance.run, commits: provenance.commits })}\n`);
  return provenance;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[superzoo-provenance] FAILED: ${error.message}`); process.exitCode = 1; }
}

module.exports = { CONTRACT, EXPECTED_COUNTS, buildProvenance, main };
