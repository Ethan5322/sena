// ============================================================================
// The two lists must be the same list.
//
// Sena's tools are declared in voice-agent/agent-config.json (what the model is
// allowed to call) and implemented in src/router.mjs (what actually happens).
// They are written in different languages, in different files, by different
// people, at different times. Nothing but this test makes them agree.
//
// WHY IT MATTERS MORE THAN IT LOOKS. If the config declares a tool the router
// does not implement, the model calls it, the router throws `unknown tool`, and
// Sena — under instruction never to explain an error — apologises and escalates.
// Annoying, survivable.
//
// The other direction is the dangerous one. Rename a tool in the router and
// forget the config, and Sena keeps calling the old name: every call fails at
// the same step, and the failure looks like a network problem rather than a
// typo. Worse, a model that gets a tool error on `send_confirmation_package`
// after the guest has PAID has taken money and delivered nothing.
//
// So: same names, same required arguments, both directions, every build.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRouter } from '../src/router.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  readFileSync(path.join(ROOT, 'voice-agent/agent-config.json'), 'utf8')
);

// The router only needs to be constructed, not run — we are asking it what tools
// it has, and that answer does not touch the database.
const router = createRouter({ db: null, paystack: null, notifier: null });

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

console.log('\ntools — the config and the router agree\n');

const declared = config.tools.map((t) => t.name).sort();
const implemented = [...router.toolNames].sort();

for (const name of declared) {
  check(
    `${name} is implemented`,
    implemented.includes(name),
    'declared in agent-config.json, absent from src/router.mjs — Sena would call it and get an error'
  );
}

for (const name of implemented) {
  check(
    `${name} is declared`,
    declared.includes(name),
    'implemented in src/router.mjs, absent from agent-config.json — Sena can never call it'
  );
}

// A tool the model may call without the arguments the router needs is a tool
// that fails at runtime, on a call, with a guest listening.
const REQUIRED_BY_ROUTER = {
  save_guest_details: ['booking_id', 'full_name', 'phone', 'double_confirmed'],
  send_payment_link: ['booking_id'],
  check_payment_status: ['booking_id'],
  send_confirmation_package: ['booking_id'],
  hold_room: ['room_id', 'check_in', 'check_out', 'guests_count'],
  check_availability: ['check_in', 'check_out'],
};

for (const [tool, needed] of Object.entries(REQUIRED_BY_ROUTER)) {
  const declaredTool = config.tools.find((t) => t.name === tool);
  const required = declaredTool?.input_schema?.required ?? [];
  const missing = needed.filter((f) => !required.includes(f));
  check(
    `${tool} requires ${needed.join(', ')}`,
    missing.length === 0,
    `not marked required in agent-config.json: ${missing.join(', ')}`
  );
}

// The gate that cannot be talked out of. If this argument is ever made optional
// in the config, the model will start omitting it, and the router will start
// refusing every save — silently, from Sena's point of view.
const saveGuest = config.tools.find((t) => t.name === 'save_guest_details');
check(
  'double_confirmed is still required',
  saveGuest?.input_schema?.required?.includes('double_confirmed'),
  'the double-confirmation gate is only as good as the argument that carries it'
);

// The disclosure. CLAUDE.md §0: Sena says she is an AI within ten seconds, and
// POPIA needs the recording consent in the same breath. It lives in the greeting
// so the model cannot paraphrase it away — but only if it is actually there.
const greeting = config.firstMessage.toLowerCase();
check(
  'the greeting discloses the AI',
  greeting.includes('ai'),
  'firstMessage no longer says Sena is an AI — this is a legal requirement, not a style choice'
);
check(
  'the greeting states consent to recording',
  greeting.includes('recorded'),
  'firstMessage no longer mentions recording, but recording_enabled is true — that is unlawful under POPIA'
);

console.log(
  failures.length
    ? `\n${failures.length} failed\n`
    : `\nall ${declared.length} tools agree, both directions\n`
);
process.exit(failures.length ? 1 : 0);
