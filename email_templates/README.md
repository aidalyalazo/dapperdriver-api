# DapperDriver auth emails — branding + deliverability

Supabase sends the account emails (password reset, signup confirm, magic link, email
change). Two things to fix: **how they look** and **why they land in spam**.

---

## 1. Make them on-brand (5 min, no DNS)

In **Supabase Dashboard → Authentication → Email Templates**, for each template:
paste the matching HTML below and set the Subject.

| Template | File | Subject |
|---|---|---|
| Reset Password | `reset_password.html` | `Reset your DapperDriver password` |
| Confirm signup | `confirm_signup.html` | `Confirm your DapperDriver email` |
| Magic Link | reuse `confirm_signup.html` (change heading to "Sign in to DapperDriver", button to "Sign In") | `Your DapperDriver sign-in link` |
| Change Email Address | reuse `confirm_signup.html` (heading "Confirm your new email") | `Confirm your new DapperDriver email` |

Keep the `{{ .ConfirmationURL }}` variable exactly as-is — Supabase fills it in.
The templates are plain tables + inline CSS (the only thing email clients render
reliably) and use the brand: charcoal #0C1A2E header, blue #1E66CA button, lime
#BFFF00 accent. They render in both light and dark mail apps.

> Tip: also set **Authentication → URL Configuration → Site URL + Redirect URLs** so the
> reset link opens your app's reset screen (deep link), not a blank page.

---

## 2. Fix the spam problem (the important one) — custom SMTP + domain auth

**Why it goes to spam:** Supabase's built-in email sender is **for development only**.
It sends from a generic `…supabase.io` address on a shared IP, *not* from
`dapperdriver.com`, so the sending domain doesn't match your brand and isn't
authenticated for your domain — spam filters flag exactly that. It's also rate-limited
(~3–4 emails/hour), which alone will break real signups.

**The fix is to send through your own domain via a transactional email provider:**

### Step 1 — Pick a provider
- **Resend** — easiest, has a native Supabase integration, generous free tier. Recommended.
- Alternatives: Postmark (best deliverability), SendGrid, Amazon SES, Mailgun.

### Step 2 — Verify `dapperdriver.com` in the provider
The provider gives you DNS records to add (typically a **DKIM** record + a sending/return-path
record, and they recommend **DMARC**). Many providers (incl. Resend) use a **subdomain**
like `send.dapperdriver.com` for sending — prefer that, it avoids any conflict with your
existing Google Workspace SPF.

### Step 3 — Add the DNS records on Vercel (where dapperdriver.com DNS lives)
- Add the provider's **DKIM** record(s) exactly as given.
- **SPF — do NOT create a second SPF record.** You already have
  `v=spf1 include:_spf.google.com ~all` for Google Workspace. If the provider sends from
  the **root** domain and needs SPF, *merge* into one record:
  `v=spf1 include:_spf.google.com include:<provider-spf-domain> ~all`.
  If it sends from a **subdomain** (e.g. `send.dapperdriver.com`), add that subdomain's
  SPF separately — no conflict.
- Add a **DMARC** record to start monitoring:
  `_dmarc.dapperdriver.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@dapperdriver.com"`
  (start at `p=none`; tighten to `quarantine`/`reject` later once SPF+DKIM pass).

### Step 4 — Point Supabase at it
**Supabase Dashboard → Project Settings → Authentication → SMTP Settings → Enable Custom SMTP:**
- Host / Port / Username / Password → from the provider
- **Sender email:** `no-reply@dapperdriver.com` (or `no-reply@send.dapperdriver.com`)
- **Sender name:** `DapperDriver`

### Step 5 — Verify
Send a test reset to a Gmail account → open it → **⋮ → Show original**. You want
**SPF: PASS, DKIM: PASS, DMARC: PASS** and "mailed-by / signed-by: dapperdriver.com".
That combination is what moves it from Spam to Inbox.

---

### What I can do for you
Once you pick a provider and it gives you the DNS values, paste them to me and I can add
them to Vercel DNS (same as the Google Workspace MX/SPF records). The Supabase dashboard
steps (pasting templates, enabling SMTP) you do yourself — they involve credentials I
shouldn't touch.
