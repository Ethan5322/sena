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
import { useServices, getServices } from '../src/services.mjs';
import { createDemoServices } from '../src/demo.mjs';
import { applyChargeSuccess } from '../src/payments.mjs';

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
  '/api/sena/confirmation': { module: '../api/sena/confirmation.mjs', parseBody: false },
  '/api/sena/dashboard': { module: '../api/sena/dashboard.mjs', parseBody: false },
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

// ── Demo mode ───────────────────────────────────────────────────────────────
// No DATABASE_URL means you have signed up for nothing, and you should still be
// able to take a booking end to end. src/demo.mjs stands up a real Postgres
// in-process with the real schema and the real demo hotel, plus a payment link
// that actually pays and a mail server that writes to disk.
//
// The router on top of it is the SAME router. Every gate you hit here is the
// gate a guest hits in production.
const DEMO = !process.env.DATABASE_URL;
let demo = null;

if (DEMO) {
  console.log('\n  no DATABASE_URL — starting in DEMO MODE');
  console.log('  a real Postgres, in-process. Fake money. Mail written to disk.\n');
  demo = await createDemoServices({ publicUrl: `http://localhost:${PORT}` });
  useServices(demo);
  process.env.SENA_DEFAULT_HOTEL_ID ||= demo.hotel.id;
  process.env.SENA_PUBLIC_URL ||= `http://localhost:${PORT}`;
  // The agent has to authenticate, and in demo mode there is nobody to keep a
  // secret from. Fixed, so the agent container can be given the same one.
  process.env.SENA_WEBHOOK_SECRET ||= 'demo-secret';
  // Same reasoning: in demo mode there is no owner to keep the dashboard from.
  process.env.SENA_OWNER_KEY ||= 'demo-owner';
  console.log(`  hotel:  ${demo.hotel.name}  (${demo.hotel.id})`);
  console.log(`  secret: ${process.env.SENA_WEBHOOK_SECRET}`);
  console.log(
    `  owner:  http://localhost:${PORT}/api/sena/dashboard?key=${process.env.SENA_OWNER_KEY}\n`
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];

  vercelRes(res);

  // The demo payment page. Not a Vercel function, and deliberately not one: this
  // route confirms a booking WITHOUT a signature, and it must be impossible for
  // it to exist anywhere a real guest could reach it. It lives here, in the dev
  // server, and nowhere else.
  if (DEMO && url.pathname === '/demo/pay') {
    const ref = url.searchParams.get('ref');
    const { rows } = await demo.db.query(
      `select p.*, b.reference as booking_ref
         from sena_payments p join sena_bookings b on b.id = p.booking_id
        where p.provider_reference = $1`,
      [ref]
    );
    if (!rows.length) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send('<h1>No such payment reference</h1>');
    }

    // The same function the real Paystack webhook calls, on the same row. The
    // only thing missing is the HMAC — which is the one thing we cannot fake and
    // would not want to.
    // Shaped exactly like Paystack's charge.success event, because that is what
    // applyChargeSuccess parses. Pay the full amount — the underpayment gate is
    // already attacked in scripts/test-router.mjs.
    const result = await applyChargeSuccess(demo.db, {
      event: 'charge.success',
      data: {
        reference: ref,
        amount: Number(rows[0].amount_cents),
        currency: rows[0].currency,
      },
    });

    console.log(`  [demo paystack] PAID ${ref} → ${JSON.stringify(result)}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(
      `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F7F5F2">
         <div style="text-align:center">
           <div style="font-size:3rem">✓</div>
           <h1 style="margin:.5rem 0">Payment received</h1>
           <p style="color:#6B7280">${rows[0].booking_ref} · ${rows[0].currency} ${(Number(rows[0].amount_cents) / 100).toFixed(2)}</p>
           <p style="color:#B45309;font-size:.85rem;margin-top:2rem">
             DEMO — no money moved. Tell Sena you have paid.
           </p>
         </div>
       </body>`
    );
  }

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
