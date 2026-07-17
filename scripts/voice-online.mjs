// ============================================================================
// Sena — put the voice line on the public internet. `npm run voice:online`
//
// The voice stack runs on this machine; the QR poster points at Vercel. This
// script is the bridge, and it costs nothing:
//
//   1. opens a free Cloudflare quick tunnel to the switchboard (localhost:8080)
//   2. registers the tunnel's https URL with the deployment
//      (POST /api/sena/voice, signed with SENA_WEBHOOK_SECRET)
//   3. heartbeats every 4 minutes so the "Call Sena" button knows the line is
//      still live, and signs off cleanly on Ctrl+C so the button flips to the
//      holding page immediately instead of 15 minutes later
//
// Run it NEXT TO the stack, not instead of it:
//
//   terminal 1   npm run dev            the router and the gates
//   terminal 2   npm run voice          LiveKit/switchboard/bot in docker
//   terminal 3   npm run voice:online   this — the world can now call
//
// Quick tunnels get a NEW random URL every start. That is fine: the deployment
// learns the new address within a second of this script starting, and nothing
// printed on a poster ever contains it.
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWITCHBOARD = process.env.SENA_SWITCHBOARD_LOCAL || 'http://localhost:8080';
const HEARTBEAT_MS = 4 * 60 * 1000;

// ── .env.local, the same twelve lines the dev server uses ────────────────────
for (const line of (existsSync(path.join(ROOT, '.env.local'))
  ? readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  : ''
).split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const API = (process.env.SENA_PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = process.env.SENA_WEBHOOK_SECRET || '';
if (!API || !SECRET) {
  console.error(
    '  SENA_PUBLIC_URL and SENA_WEBHOOK_SECRET must be in .env.local —\n' +
      '  the first is your Vercel URL, the second must match what Vercel holds.'
  );
  process.exit(1);
}

// ── Find cloudflared, wherever winget left it ─────────────────────────────────
const candidates = [
  path.join(ROOT, 'tools', 'cloudflared.exe'), // the portable copy, no admin needed
  'cloudflared',
  path.join(process.env['ProgramFiles'] || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
];
const cloudflared = candidates.find((c) =>
  c === 'cloudflared'
    ? spawnSync(c, ['--version'], { shell: false }).status === 0
    : existsSync(c)
);
if (!cloudflared) {
  console.error(
    '  cloudflared is not installed. Free, no account, no admin:\n\n' +
      '    curl -L -o tools/cloudflared.exe ' +
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe\n\n' +
      '  then run this again.'
  );
  process.exit(1);
}

// ── Register / heartbeat / sign off ──────────────────────────────────────────
async function register(url) {
  try {
    const r = await fetch(`${API}/api/sena/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sena-secret': SECRET },
      body: JSON.stringify({ url }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `http ${r.status}`);
    return true;
  } catch (err) {
    console.error(`  [register] failed: ${err.message}`);
    return false;
  }
}

// ── The tunnel — self-healing ─────────────────────────────────────────────────
// A quick tunnel can die while cloudflared keeps running: Cloudflare reaps the
// hostname server-side and the local process never notices. It happened — the
// heartbeat kept swearing a dead URL was fresh all night, and every guest who
// tapped "Call Sena" was 302'd into a DNS error. So the heartbeat now proves
// the tunnel END TO END (a GET through the public URL) before re-registering,
// and a tunnel that stops answering is killed and replaced with a fresh one.

let tunnel = null;
let publicUrl = null;
let beat = null;
let misses = 0;
let shuttingDown = false;

async function tunnelAnswers() {
  try {
    const r = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function heartbeat() {
  if (!publicUrl) return;
  if (await tunnelAnswers()) {
    misses = 0;
    await register(publicUrl);
    return;
  }
  misses++;
  console.error(`  [heartbeat] the tunnel did not answer (${misses}/2)`);
  if (misses >= 2) {
    console.error('  the tunnel is dead — replacing it …');
    if (beat) clearInterval(beat);
    beat = null;
    await register(''); // holding page NOW, not a dead 302 for the next guest
    try { tunnel.kill(); } catch {} // the exit handler brings up the successor
  }
}

function onOutput(chunk) {
  const text = String(chunk);
  const hit = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (hit && !publicUrl) {
    publicUrl = hit[0];
    console.log(`\n  the voice line is PUBLIC:  ${publicUrl}`);
    console.log(`  registering with ${API} …`);
    register(publicUrl).then((ok) => {
      if (ok) {
        console.log(
          `  done — "Call Sena" on the QR page now starts a real call.\n` +
            `  keep this window open; Ctrl+C takes the line offline cleanly.\n`
        );
      }
    });
    beat = setInterval(heartbeat, HEARTBEAT_MS);
  }
}

function startTunnel() {
  publicUrl = null;
  misses = 0;
  console.log(`  opening a free Cloudflare tunnel to ${SWITCHBOARD} …`);
  tunnel = spawn(cloudflared, ['tunnel', '--url', SWITCHBOARD, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput); // cloudflared prints the URL banner on stderr
  tunnel.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`  cloudflared exited (${code}) — a new tunnel in 15s …`);
    if (beat) clearInterval(beat);
    beat = null;
    register(''); // the button falls back to the holding page meanwhile
    setTimeout(startTunnel, 15_000);
  });
}

async function goodbye() {
  console.log('\n  signing the voice line off …');
  shuttingDown = true;
  if (beat) clearInterval(beat);
  await register(''); // immediate holding page, not a 15-minute ghost
  try { tunnel.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', goodbye);
process.on('SIGTERM', goodbye);

startTunnel();
