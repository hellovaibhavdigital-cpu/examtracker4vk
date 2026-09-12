import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { diffWords } from 'diff';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function extractVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function extractDateTokens(text) {
  return [...new Set(
    text.match(/\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:20\d{2})\b/g) || []
  )];
}

function previewDiff(oldText, newText) {
  const parts = diffWords(oldText, newText);

  const changed = parts
    .filter(p => p.added || p.removed)
    .map(p => p.value)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return changed.slice(0, 500) || 'Page content changed';
}

async function logSync(examId, message, level = 'info') {
  const { error } = await supabase
    .from('sync_log')
    .insert({
      exam_id: examId || null,
      message,
      level
    });

  if (error) {
    console.error('Could not write sync_log:', error.message);
  }
}

async function fetchWithRetry(url) {
  const requestOptions = {
    timeout: 45000,
    headers: {
      'User-Agent': 'EXAM//OS official-source monitor'
    },
    maxRedirects: 5
  };

  try {
    return await axios.get(url, requestOptions);
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.log(`RETRYING after timeout: ${url}`);
      return await axios.get(url, requestOptions);
    }
    throw err;
  }
}

async function main() {
  console.log(`SYNC RUN STARTED: ${new Date().toISOString()}`);

  const { data: exams, error: examError } = await supabase
    .from('exams')
    .select('*')
    .not('source_url', 'is', null);

  if (examError) {
    throw examError;
  }

  let checked = 0;
  let changed = 0;
  let errors = 0;

  for (const exam of exams || []) {
    checked++;

    console.log(`CHECKING: ${exam.name}`);

    try {
      const response = await fetchWithRetry(exam.source_url);

      const visibleText = extractVisibleText(response.data);
      const newHash = hashText(visibleText);
      const now = new Date().toISOString();

      // FIRST CHECK — create baseline
      if (!exam.content_hash) {
        await supabase
          .from('exams')
          .update({
            content_hash: newHash,
            content_snapshot: visibleText.slice(0, 50000),
            last_checked: now
          })
          .eq('id', exam.id);

        await logSync(
          exam.id,
          `${exam.name}: baseline created — source checked`,
          'success'
        );

        continue;
      }

      // NO CHANGE
      if (exam.content_hash === newHash) {
        await supabase
          .from('exams')
          .update({
            last_checked: now
          })
          .eq('id', exam.id);

        await logSync(
          exam.id,
          `${exam.name}: checked, no change`,
          'success'
        );

        continue;
      }

      // CHANGE DETECTED
      changed++;

      const diffPreview = previewDiff(
        exam.content_snapshot || '',
        visibleText
      );

      await supabase
        .from('exams')
        .update({
          content_hash: newHash,
          content_snapshot: visibleText.slice(0, 50000),
          last_checked: now
        })
        .eq('id', exam.id);

      await logSync(
        exam.id,
        `${exam.name}: CHANGE DETECTED — ${diffPreview}`,
        'change'
      );

      // Possible dates are NOT automatically trusted
      const dateTokens = extractDateTokens(visibleText);

      if (dateTokens.length) {
        await logSync(
          exam.id,
          `${exam.name}: possible date token(s) detected — ${dateTokens.join(', ')}; manual verification required`,
          'warning'
        );
      }

    } catch (err) {
      errors++;

      const message = err?.response?.status
        ? `HTTP ${err.response.status}`
        : (err?.message || 'Unknown error');

      await logSync(
        exam.id,
        `${exam.name}: sync error — ${message}`,
        'error'
      );

      console.error(`ERROR: ${exam.name}: ${message}`);
    }
  }

  // ALWAYS create a final run entry
  await logSync(
    null,
    `SYNC RUN COMPLETE — checked ${checked}, changes ${changed}, errors ${errors}`,
    errors ? 'warning' : 'success'
  );

  console.log(
    `SYNC RUN COMPLETE — checked ${checked}, changes ${changed}, errors ${errors}`
  );
}

main().catch(err => {
  console.error('SYNC RUN FAILED:', err);
  process.exit(1);
});
