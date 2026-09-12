import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOURCES = [
  { org: 'SSC', url: 'https://ssc.gov.in/' },
  { org: 'UPSC', url: 'https://upsc.gov.in/recruitment/recruitment-advertisements' },
  { org: 'IBPS', url: 'https://www.ibps.in/' },
  { org: 'MHA (IB)', url: 'https://mha.gov.in/' },
  { org: 'PFRDA', url: 'https://www.pfrda.org.in/' }
];

const KEYWORDS = [
  'recruitment', 'vacanc', 'notification', 'advertisement',
  'graduate', 'officer', 'assistant', 'group b', 'group c',
  'apfc', 'clerk', 'probationary', 'grade a', 'grade b'
];

function looksRelevant(text) {
  const t = text.toLowerCase();
  return KEYWORDS.some(k => t.includes(k)) && /20(2[5-9]|3[0-9])/.test(t);
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function main() {
  console.log(`DISCOVERY RUN STARTED: ${new Date().toISOString()}`);

  const { data: existingDiscovered } = await supabase
    .from('discovered_exams')
    .select('source_url');

  const { data: trackedExams } = await supabase
    .from('exams')
    .select('name');

  const knownUrls = new Set((existingDiscovered || []).map(r => r.source_url));
  const knownNames = new Set((trackedExams || []).map(r => (r.name || '').toLowerCase()));

  let found = 0;

  for (const source of SOURCES) {
    console.log(`SCANNING: ${source.org} — ${source.url}`);

    try {
      const response = await axios.get(source.url, {
        timeout: 30000,
        headers: { 'User-Agent': 'EXAM//OS discovery bot' },
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);
      const seenThisRun = new Set();

      const linkPromises = [];

      $('a').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const href = $(el).attr('href');
        if (!text || !href) return;
        if (!looksRelevant(text)) return;

        const fullUrl = resolveUrl(href, source.url);
        if (!fullUrl) return;
        if (seenThisRun.has(fullUrl)) return;
        seenThisRun.add(fullUrl);

        if (knownUrls.has(fullUrl)) return;
        if (knownNames.has(text.toLowerCase())) return;

        linkPromises.push(
          supabase
            .from('discovered_exams')
            .insert({
              name: text.slice(0, 200),
              org: source.org,
              event: 'Notification Detected',
              event_date: null,
              source_url: fullUrl
            })
            .then(({ error }) => {
              if (error) {
                console.error(`Could not insert discovered_exam: ${error.message}`);
              } else {
                found++;
                console.log(`NEW CANDIDATE: [${source.org}] ${text}`);
              }
            })
        );
      });

      await Promise.all(linkPromises);

    } catch (err) {
      const message = err?.response?.status
        ? `HTTP ${err.response.status}`
        : (err?.message || 'Unknown error');
      console.error(`ERROR scanning ${source.org}: ${message}`);
    }
  }

  console.log(`DISCOVERY RUN COMPLETE — new candidates found: ${found}`);
}

main().catch(err => {
  console.error('DISCOVERY RUN FAILED:', err);
  process.exit(1);
});
