'use strict';

const fs = require('node:fs');
const { buildErrorNotification, buildReviewNotification, runUrlFromEnv, sendResend } = require('./lib/superzoo-automation-alerts');

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => {
  const [key, ...rest] = arg.slice(2).split('=');
  return [key, rest.join('=') || true];
}));
const reportPath = args.report ? String(args.report) : null;
const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
const runUrl = args['run-url'] || runUrlFromEnv();
const notification = report
  ? (report.verdict === 'SUPERZOO_WEEKLY_REVIEW_PASS'
    ? buildReviewNotification(report, { runUrl })
    : buildErrorNotification({ verdict: report.verdict, blockers: report.blockers, reason: 'weekly review validation failed', runUrl }))
  : buildErrorNotification({ verdict: 'SUPERZOO_WEEKLY_REVIEW_BLOCKED', reason: args.reason || 'workflow failed before report generation', runUrl });

if (!notification.shouldNotify) {
  console.log(JSON.stringify({ sent: false, skipped: true, reason: notification.reason || 'not_required' }));
} else if (!process.env.RESEND_API_KEY || !process.env.SUPERZOO_AUTOMATION_ALERT_TO || !process.env.SUPERZOO_AUTOMATION_FROM) {
  console.log(JSON.stringify({ sent: false, skipped: true, reason: 'missing_resend_configuration', subject: notification.subject }));
} else {
  sendResend({
    notification,
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.SUPERZOO_AUTOMATION_FROM,
    to: process.env.SUPERZOO_AUTOMATION_ALERT_TO,
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`[superzoo-alert] ${error.message}`);
    process.exitCode = 1;
  });
}
