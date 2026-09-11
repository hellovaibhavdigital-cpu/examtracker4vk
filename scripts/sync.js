/**
 * EXAM//OS — daily sync job
 *
 * Run by the GitHub Actions workflow (.github/workflows/exam-sync.yml) on a
 * schedule, three times a day. It does NOT need the website to be open —
 * that's the whole point.
 *
 * WHAT IT ACTUALLY DOES (and doesn't):
 * - For every tracked exam with a source_url, it fetches the official page,
 *   strips it down to plain visible text, and hashes it.
 * - If the hash differs from last time, something on that page changed —
 *   it logs a CHANGE DETECTED entry with a short diff snippet so you can
 *   go look at what moved.
 * - It does NOT claim to know the new deadline automatically. Government
 *   notification pages are inconsistent HTML and change layout without
 *   warning, so confidently auto-parsing "the new date is 22 Oct" would be
 *   guessing dressed up as certainty. Instead it flags "this page changed,
 *   here's a snippet, go verify" — which matches the spec's own rule:
 *   never treat an unverified source as confirmed.
 * - It DOES try to surface date-shaped strings that are new since last
 *   check, as a hint, clearly labeled as unverified.
 *
 * To make this fully hands-off later, the natural upgrade is a per-source
 * extractor (a small function that knows exam X's page structure) — this
 * file is written so you can drop one in per exam without touching the
 * scheduling or logging plumbing.
 */

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { diffLines } = require('diff');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SNAPSHOT_LIMIT = 6000; // chars kept for next-run diffing, keeps DB rows small
const FETCH_TIMEOUT_MS = 20000;

// Loose date-shaped token matcher: "25 June 2026", "21-05-2026", "22/06/2026" etc.
const DATE_PATTERN = /\b(\d{1,2}[\/\-\s](?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|\d{1,2})[\/\-\s]\d{2,4})\b/gi;

function extractVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const text = $('body').text();
  return text.replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function log(exam_id, level, message) {
  console.log(`[${level.toUpperCase()}]`, exam_id || '-', message);
  const { error } = await supabase.from('sync_log').insert({ exam_id, level, message });
  if (error) console.error('Failed to write sync_log:', error.message);
}

function newDateTokens(oldText, newText) {
  const oldDates = new Set((oldText.match(DATE_PATTERN) || []).map(s => s.toLowerCase()));
  const newDates = (newText.match(DATE_PATTERN) || []);
  const fresh = newDates.filter(d => !oldDates.has(d.toLowerCase()));
  return [...new Set(fresh)];
}

function diffSnippet(oldText, newText, maxLines = 4) {
  const parts = diffLines(oldText, newText);
  const changed = parts.filter(p => p.added || p.removed);
  return changed
    .slice(0, maxLines)
    .map(p => `${p.added ? '+ ' : '- '}${p.value.trim().slice(0, 160)}`)
    .join('\n');
}

async function checkExam(exam) {
  if (!exam.source_url) {
    await log(exam.id, 'info', `${exam.name}: no source_url set, skipped`);
    return;
  }

  let html;
  try {
    const res = await axios.get(exam.source_url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExamOS-Sync/1.0; personal exam tracker)' },
      validateStatus: (s) => s < 500,
    });
    html = res.data;
  } catch (err) {
    await log(exam.id, 'error', `${exam.name}: fetch failed — ${err.message}`);
    return;
  }

  const text = extractVisibleText(String(html));
  const hash = hashText(text);
  const now = new Date().toISOString();

  if (!exam.last_hash) {
    // first time checking this exam — establish baseline, nothing to compare yet
    await supabase.from('exams').update({
      last_hash: hash,
      last_snapshot: text.slice(0, SNAPSHOT_LIMIT),
      last_checked: now,
    }).eq('id', exam.id);
    await log(exam.id, 'info', `${exam.name}: baseline snapshot recorded`);
    return;
  }

  if (hash === exam.last_hash) {
    await supabase.from('exams').update({ last_checked: now }).eq('id', exam.id);
    await log(exam.id, 'info', `${exam.name}: checked, no change`);
    return;
  }

  // Something changed.
  const oldText = exam.last_snapshot || '';
  const snippet = diffSnippet(oldText, text);
  const freshDates = newDateTokens(oldText, text);

  let message = `${exam.name}: page content changed at ${exam.source_url}`;
  if (freshDates.length) {
    message += `\nPossible new date(s) mentioned (unverified): ${freshDates.slice(0, 5).join(', ')}`;
  }
  if (snippet) {
    message += `\n${snippet}`;
  }

  await supabase.from('exams').update({
    last_hash: hash,
    last_snapshot: text.slice(0, SNAPSHOT_LIMIT),
    last_checked: now,
  }).eq('id', exam.id);

  await log(exam.id, 'change', message);
}

async function run() {
  const { data: exams, error } = await supabase.from('exams').select('*');
  if (error) {
    console.error('Failed to load exams:', error.message);
    process.exit(1);
  }

  console.log(`EXAM//OS sync starting — ${exams.length} tracked exam(s), ${new Date().toISOString()}`);

  for (const exam of exams) {
    await checkExam(exam);
  }

  console.log('EXAM//OS sync complete.');
}

run().catch(async (err) => {
  console.error('Sync job crashed:', err);
  await log(null, 'error', `Sync job crashed: ${err.message}`);
  process.exit(1);
});
