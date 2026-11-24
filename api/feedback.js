// Candidate job feedback API.
// Data lives in the private Blob store, never in this repo:
//   feedback/c/<candidateToken>/search.json            jobs + candidate info (full, internal)
//   feedback/c/<candidateToken>/answers/<listingId>.json one answer per job
//   feedback/a/<adminToken>.json                        { candidateToken }
// role=c → candidate link (sees only safe job fields); role=a → admin link (sees everything).
import { get, put, list, del } from '@vercel/blob';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const ID_RE = /^[0-9a-f-]{36}$/;
const SAFE_FIELDS = ['listingId', 'title', 'company', 'location', 'workArrangement', 'level', 'fundingStage', 'companySize', 'payMin', 'payMax', 'posted', 'applyUrl'];

async function readJson(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r) return null;
  return JSON.parse(await new Response(r.stream).text());
}

async function readAnswers(candidateToken) {
  const prefix = `feedback/c/${candidateToken}/answers/`;
  const answers = {};
  let cursor;
  do {
    const page = await list({ prefix, cursor });
    await Promise.all(page.blobs.map(async (b) => {
      const a = await readJson(b.pathname);
      if (a) answers[b.pathname.slice(prefix.length, -5)] = a;
    }));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return answers;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let b = '';
  for await (const c of req) { b += c; if (b.length > 1e5) throw new Error('body too large'); }
  return b ? JSON.parse(b) : {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const { role, t } = req.query;
  if (!['c', 'a'].includes(role) || !TOKEN_RE.test(t || '')) return res.status(404).json({ error: 'Link not found' });

  try {
    let candidateToken = t;
    if (role === 'a') {
      const link = await readJson(`feedback/a/${t}.json`);
      if (!link || !TOKEN_RE.test(link.candidateToken || '')) return res.status(404).json({ error: 'Link not found' });
      candidateToken = link.candidateToken;
    }
    const search = await readJson(`feedback/c/${candidateToken}/search.json`);
    if (!search) return res.status(404).json({ error: 'Link not found' });

    if (req.method === 'GET') {
      const answers = await readAnswers(candidateToken);
      if (role === 'a') return res.status(200).json({ search, answers, candidateToken });
      return res.status(200).json({
        firstName: (search.candidate?.name || '').split(' ')[0],
        jobs: search.jobs.map((j) => Object.fromEntries(SAFE_FIELDS.map((k) => [k, j[k] ?? null]))),
        answers,
      });
    }

    if (req.method === 'POST' && role === 'c') {
      const { listingId, decision, reasons = [], note = '' } = await readBody(req);
      if (!ID_RE.test(listingId || '') || !search.jobs.some((j) => j.listingId === listingId)) return res.status(400).json({ error: 'Unknown job' });
      if (!['apply', 'skip'].includes(decision)) return res.status(400).json({ error: 'decision must be apply or skip' });
      const answer = {
        decision,
        reasons: decision === 'skip' && Array.isArray(reasons) ? reasons.slice(0, 12).map((r) => String(r).slice(0, 80)) : [],
        note: decision === 'skip' ? String(note).slice(0, 1000) : '',
        answeredAt: new Date().toISOString(),
      };
      await put(`feedback/c/${candidateToken}/answers/${listingId}.json`, JSON.stringify(answer), {
        access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true,
      });
      return res.status(200).json({ ok: true, listingId, answer });
    }

    if (req.method === 'DELETE' && role === 'a') {
      const { blobs } = await list({ prefix: `feedback/c/${candidateToken}/answers/` });
      if (blobs.length) await del(blobs.map((b) => b.url));
      return res.status(200).json({ ok: true, cleared: blobs.length });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
}
