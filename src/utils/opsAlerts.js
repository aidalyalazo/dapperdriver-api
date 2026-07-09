const { notifyAdmins } = require('./adminAlerts');

/**
 * Multi-channel ops alert fan-out.
 *
 * Every alert ALWAYS lands in the in-app admin inbox (adminAlerts →
 * notifications rows the admin panel reads). Email and Slack are added
 * automatically when their env vars are configured — zero code changes:
 *
 *   RESEND_API_KEY     → email via api.resend.com (same fetch pattern as the
 *                        support-reply endpoint in routes/admin.js)
 *   SUPPORT_FROM_EMAIL → sender    (default 'DapperDriver Ops <support@dapperdriver.com>')
 *   OPS_ALERT_EMAIL    → recipient (default 'aidalyalazo@live.com')
 *   SLACK_OPS_WEBHOOK  → POST { text: title + '\n' + body } to the webhook
 *
 * Every channel is fire-and-forget: failures are console.error'd and never
 * throw, so an alerting hiccup can never break the job that raised the alert.
 *
 * @param {{ type: string, title: string, body: string, data?: object }} alert
 */
function sendOpsAlert({ type, title, body, data = {} }) {
  // (a) In-app admin inbox — always.
  Promise.resolve(notifyAdmins({ type, title, body, data })).catch((e) =>
    console.error('[OPS ALERT] notifyAdmins failed:', e.message)
  );

  // (b) Email via Resend — only when configured.
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    const from = process.env.SUPPORT_FROM_EMAIL || 'DapperDriver Ops <support@dapperdriver.com>';
    const to = process.env.OPS_ALERT_EMAIL || 'aidalyalazo@live.com';
    Promise.resolve(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [to],
          subject: title,
          text: body,
        }),
      })
    )
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          console.error('[OPS ALERT] Resend failed:', r.status, detail.slice(0, 300));
        }
      })
      .catch((e) => console.error('[OPS ALERT] Resend error:', e.message));
  }

  // (c) Slack incoming webhook — only when configured.
  const webhook = process.env.SLACK_OPS_WEBHOOK;
  if (webhook) {
    Promise.resolve(
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${title}\n${body}` }),
      })
    )
      .then((r) => {
        if (!r.ok) console.error('[OPS ALERT] Slack webhook failed:', r.status);
      })
      .catch((e) => console.error('[OPS ALERT] Slack error:', e.message));
  }
}

module.exports = { sendOpsAlert };
