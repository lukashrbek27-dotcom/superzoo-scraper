'use strict';

const REDACTED = '[redacted]';
const MAX_ITEMS = 25;
const MAX_TEXT = 6000;

function truncate(value, max = 500) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function runUrlFromEnv(env = process.env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function publicReason(value) {
  return truncate(String(value || '').replace(/(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/giu, (_match, key) => `${key}=${REDACTED}`));
}

function buildReviewNotification(report, { runUrl = report?.runUrl } = {}) {
  const shouldNotify = Number(report?.counts?.new || 0) + Number(report?.counts?.missing || 0) + Number(report?.counts?.identityChange || 0) > 0;
  if (!shouldNotify) return { shouldNotify: false, reason: 'no_review_changes' };
  const items = (report.new || []).slice(0, MAX_ITEMS).map(item => `NEW: ${truncate(item.name || 'unnamed', 180)} | ${truncate(item.packingLabel || 'unknown', 40)} | price=${truncate(JSON.stringify(item.price || {}), 120)} | ${truncate(item.sourceIdentity || 'invalid URL', 300)}`);
  return {
    shouldNotify: true,
    subject: `SuperZoo weekly review: NEW ${report.counts.new}, MISSING ${report.counts.missing}, IDENTITY_CHANGE ${report.counts.identityChange}`,
    text: [
      'SuperZoo weekly review',
      `NEW: ${report.counts.new}`,
      `MISSING: ${report.counts.missing}`,
      `IDENTITY_CHANGE: ${report.counts.identityChange}`,
      runUrl ? `GitHub Actions run: ${runUrl}` : null,
      ...items,
      report.new.length > MAX_ITEMS ? `Additional NEW items are in the workflow artifact (${report.new.length - MAX_ITEMS} more).` : null,
    ].filter(Boolean).join('\n'),
  };
}

function buildErrorNotification({ verdict, blockers = [], reason, coverage = null, runUrl = null, timestamp = new Date().toISOString() }) {
  const blockerText = blockers.map(item => `${item.code || 'unknown'}:${item.count || 1}`).join(', ') || 'unknown';
  return {
    shouldNotify: true,
    subject: 'Mazlíček scraper error: SuperZoo',
    text: [
      'Mazlíček+ scraper error',
      'Partner: SuperZoo',
      'Workflow: weekly managed review',
      `UTC timestamp: ${timestamp}`,
      `Verdict: ${publicReason(verdict)}`,
      `Blocker code(s): ${publicReason(blockerText)}`,
      `Reason: ${publicReason(reason)}`,
      coverage ? `Managed coverage: ${publicReason(`${coverage.observed}/${coverage.required}`)}` : null,
      runUrl ? `GitHub Actions run: ${runUrl}` : null,
      'Poslední validní produkční ceny zůstaly zachované.',
    ].filter(Boolean).join('\n'),
  };
}

async function sendResend({ notification, apiKey, from, to, fetchImpl = globalThis.fetch }) {
  if (!apiKey || !from || !to) return { sent: false, skipped: true, reason: 'missing_resend_configuration' };
  if (!notification?.shouldNotify) return { sent: false, skipped: true, reason: 'notification_not_required' };
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: notification.subject, text: truncate(notification.text, MAX_TEXT) }),
  });
  if (!response.ok) throw new Error(`Resend request failed with HTTP ${response.status}`);
  return { sent: true, skipped: false };
}

module.exports = { buildErrorNotification, buildReviewNotification, publicReason, runUrlFromEnv, sendResend, truncate };
