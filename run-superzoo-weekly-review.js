'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildWeeklyReport, sha256File, writeReportFiles } = require('./lib/superzoo-weekly-review');

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, ...rest] = arg.slice(2).split('=');
  return [key, rest.join('=') || true];
}));
const required = name => { if (!args[name]) throw new Error(`missing --${name}`); return String(args[name]); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const rawPath = required('raw');
const baselinePath = required('baseline');
const outputDir = required('output-dir');
const catalog = args.catalog ? readJson(String(args.catalog)) : [];
const report = buildWeeklyReport({
  baseline: readJson(baselinePath),
  raw: readJson(rawPath),
  catalog,
  baselineSha256: sha256File(baselinePath),
  rawSha256: sha256File(rawPath),
  generatedAt: args['generated-at'] || new Date().toISOString(),
  runUrl: args['run-url'] || null,
});
const paths = writeReportFiles(report, path.resolve(outputDir));
console.log(JSON.stringify({ verdict: report.verdict, counts: report.counts, output: paths }, null, 2));
if (report.verdict !== 'SUPERZOO_WEEKLY_REVIEW_PASS') process.exitCode = 1;
