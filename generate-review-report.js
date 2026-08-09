'use strict';

const fs = require('node:fs');
const { assertSafeOutputPath, parseCliArgs, readJson, redactDiagnosticText, writeTextAtomic } = require('./lib/safety');
function readOptional(filePath) { return filePath && fs.existsSync(filePath) ? readJson(filePath) : null; }
function resultLine(label, report) {
  if (!report) return `- ${label}: NOT PRODUCED`;
  const errors = Array.isArray(report.errors) ? report.errors.length : '?'; const warnings = Array.isArray(report.warnings) ? report.warnings.length : '?';
  return `- ${label}: ${report.passed ? 'PASS' : 'FAIL'} (${errors} errors, ${warnings} warnings)`;
}
function main() {
  const args = parseCliArgs(process.argv.slice(2)); if (!args.output) throw new Error('Use --output=<summary.md>.');
  assertSafeOutputPath(args.output);
  const baseline = readOptional(args.baseline); const raw = readOptional(args.raw); const converted = readOptional(args.converted); const failure = readOptional(args.failure);
  const overall = failure || !baseline || !raw || !converted || !baseline.passed || !raw.passed || !converted.passed ? 'FAIL' : 'PASS';
  const lines = ['# SuperZoo review diagnostics', '', `Overall: ${overall}`, `Generated: ${new Date().toISOString()}`, '', resultLine('Immutable baseline preflight', baseline), resultLine('Raw validation', raw), resultLine('Converted validation', converted), `- Scrape failure report: ${failure ? 'FAIL' : 'NOT PRODUCED'}`, '', 'Review-only diagnostics. No catalog update, commit, push, apply, or deploy is performed.', ''];
  writeTextAtomic(args.output, lines.join('\n'));
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[report] FAILED: ${redactDiagnosticText(error)}`); process.exitCode = 1; } }
module.exports = { resultLine };
