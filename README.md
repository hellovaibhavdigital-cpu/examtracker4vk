# EXAM//OS — daily internet verification

This upgrades the frontend from local-only mock data to a real system: a
free scheduled job (GitHub Actions) fetches your tracked exams' official
pages every day — even if you never open the app — and logs anything that
changed. Data lives in Supabase (free tier), which both the sync job and
the website read/write.

No server to keep running, no hosting bill. Three pieces:

```
GitHub Actions (cron, 3x/day)  →  checks official exam pages
        ↓ writes to
Supabase (free Postgres)       →  exams, sync_log, discovered_exams
        ↑ reads/writes from
web/index.html (Netlify)       →  the EXAM//OS UI you already saw
```

## 1. Create the Supabase project

1. Go to supabase.com → New project (free tier is enough).
2. Once it's up, open **SQL Editor → New query**, paste the contents of
   `supabase/schema.sql`, and run it. This creates the tables, sets row
   security, and seeds two real exams (SSC CGL 2026, IBPS PO 2026) so the
   app isn't empty.
3. Go to **Project Settings → API**. You need three values:
   - **Project URL** → used everywhere
   - **anon public** key → goes in the frontend (safe to expose — it can
     only do what the RLS policies in schema.sql allow)
   - **service_role** key → goes ONLY in GitHub Actions secrets, never in
     the frontend. It bypasses RLS, which is exactly why the sync job
     needs it and the browser must not have it.

## 2. Wire up the frontend

Open `web/index.html`, find near the bottom:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Fill in your Project URL and anon key. Deploy `web/index.html` the same
way you deployed the last version (Netlify Drop, or drag the whole `web/`
folder in).

## 3. Wire up the daily sync job

1. Push this whole folder to a GitHub repo (public or private — a private
   repo gets 2,000 free Actions minutes/month, more than enough for a job
   that runs 3x/day for under a minute each).
2. In the repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Add two:
   - `SUPABASE_URL` — same Project URL as above
   - `SUPABASE_SERVICE_KEY` — the service_role key (not the anon key)
3. That's it — `.github/workflows/exam-sync.yml` is already set to run at
   08:00, 14:00, and 20:00 IST daily. You can also trigger it by hand any
   time from the repo's **Actions** tab → EXAM//OS daily sync → **Run
   workflow**, which is the fastest way to confirm it's working.

## 4. What "verify daily with internet" actually does here

For every tracked exam that has a `source_url`, the job:
- fetches the official page,
- strips it to plain text and hashes it,
- compares that hash to the one from the last run,
- if it changed, writes a `CHANGE DETECTED` entry to the system log with a
  short diff snippet and any new date-shaped text it noticed.

It does **not** silently overwrite your countdown with a guessed new date.
Government notification pages don't have a stable structure to parse
automatically without watching the real page first, and confidently
auto-editing a deadline from a guess is worse than flagging it for you to
check — which is also literally what your original spec asked for
("never treat an unverified source as confirmed"). When you see a CHANGE
DETECTED entry, open the source link, confirm the real date, and edit the
exam's date yourself (edit support in the UI is the natural next add —
today you'd update it via the Supabase table editor, or ask me to wire up
an edit button).

### Making a specific exam's checking sharper

`scripts/sync.js` is written so you can drop in a **per-source extractor**
later — a small function that knows one exam's page well enough to pull
the exact date instead of just flagging "something changed." Worth doing
first for whichever 2–3 exams matter most to you, rather than all of them
at once.

## Local testing (optional)

```bash
npm install
SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_SERVICE_KEY=your_service_role_key npm run sync
```

Watch the console output, then check the `sync_log` table in Supabase.

## Notifications beyond the in-app log

Right now "reminders" live in the system log and the daily brief inside
the app itself. Email/WhatsApp/Telegram push (spec section 20) would
plug into `scripts/sync.js` right where it currently just logs a
`change` row — ask if you want that wired up next; it needs one more
secret (an SMTP login, or a Telegram bot token) either way.
