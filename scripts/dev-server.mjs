// ============================================================================
// The Node side of Sena, on your laptop. `npm run dev`.
//
// In production these handlers are Vercel functions and there is no server —
// Vercel is the server. That is fine until you want to run the whole system
// locally, which is now the normal case: the voice agent, LiveKit and Piper all
// run in docker on your machine, and they need something to POST their tool
// calls at. Deploying to Vercel to test a sentence Sena says is not a workflow.
//
// So this is the smallest thing that makes api/sena/*.mjs runnable off Vercel:
// it gives each handler the four bits of `req` and the four bits of `res` that
// Vercel gives it, and nothing else. It is a development shim. It does not
// belong in front of a real guest — no TLS, no rate limiting, no concurrency
// story. Vercel does all of that, which is why production still runs there.
//
// NOTE the body handling: /api/sena/paystack-webhook reads the raw request
// stream itself, because an HMAC over a re-serialised JSON object is an HMAC
// over the wrong bytes. So we must NOT consume the body for that route. Only
// the routes that ask for req.body get one.
// ============================================================================

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.PORT || 3000);

// Load .env.local the way Vercel loads its dashboard vars. No dotenv dependency:
// it is twelve lines and one fewer thing in the lockfile.
async function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) {
    console.warn('[dev] no .env.local — copy .env.example and fill it in');
    return;
  }
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/** Give the handler the `res` shape Vercel gives it. */
function vercelRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    res.end(body);
    return res;
  };
  return res;
}

const ROUTES = {
  '/api/sena/tool': { module: '../api/sena/tool.mjs', parseBody: true },
  '/api/sena/hotel': { module: '../api/sena/hotel.mjs', parseBody: false },
  '/api/sena/card': { module: '../api/sena/card.mjs', parseBody: false },
  '/api/sena/desk': { module: '../api/sena/desk.mjs', parseBody: false },
  '/api/sena/cron': { module: '../api/sena/cron.mjs', parseBody: false },
  // Raw stream only — see the note at the top of this file.
  '/api/sena/paystack-webhook': { module: '../api/sena/paystack-webhook.mjs', parseBody: false },
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

await loadEnv();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];

  vercelRes(res);

  if (!route) {
    res.statusCode = 404;
    return res.end(`no route: ${url.pathname}\n\nsena dev server knows:\n  ${Object.keys(ROUTES).join('\n  ')}\n`);
  }

  req.query = Object.fromEntries(url.searchParams);
  if (route.parseBody) req.body = await readJson(req);

  try {
    const { default: handler } = await import(route.module);
    await handler(req, res);
  } catch (err) {
    console.error(`[dev] ${url.pathname} threw:`, err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[dev] sena api on http://localhost:${PORT}`);
  for (const p of Object.keys(ROUTES)) console.log(`[dev]   ${p}`);
  if (!process.env.SENA_WEBHOOK_SECRET) {
    console.warn('[dev] SENA_WEBHOOK_SECRET is empty — /api/sena/tool will 401 every call');
  }
});
