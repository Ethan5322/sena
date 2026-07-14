// ============================================================================
// Runs the Python side of the test suite from `npm test`.
//
// The voice agent is Python and everything else is Node, so without this the
// agent is the one component nobody's test run ever touches — which is exactly
// how it ended up written against a Pipecat API that was four versions stale.
//
// It SKIPS, loudly, if the agent's dependencies are not installed. That is
// deliberate: someone working on the booking gates should not be forced to
// install Torch to run `npm test`. But if the venv IS there, the agent is
// checked, every time, with no way to forget.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --voice runs the real-audio round trip (Piper → Whisper) instead of the import
// check. Opt-in, because it needs the voice file on disk and runs Whisper over
// real audio — see scripts/test-voice-roundtrip.py.
const voiceMode = process.argv.includes('--voice');
const SCRIPT = path.join(
  ROOT,
  voiceMode ? 'scripts/test-voice-roundtrip.py' : 'scripts/test-agent-imports.py'
);

// The project venv first — that is the one with the pinned Pipecat in it.
const candidates = [
  path.join(ROOT, '.venv/Scripts/python.exe'), // Windows
  path.join(ROOT, '.venv/bin/python'), // macOS / Linux
  'python3',
  'python',
];

const python = candidates.find(
  (p) => (p.includes('.venv') ? existsSync(p) : spawnSync(p, ['--version']).status === 0)
);

const skip = (why) => {
  console.log(`\n  SKIP  the voice agent — ${why}`);
  console.log('        set it up:  python -m venv .venv');
  console.log('                    .venv/Scripts/pip install -r voice-agent/agent/requirements.txt');
  console.log('        (macOS/Linux: .venv/bin/pip)\n');
  process.exit(0);
};

if (!python) skip('no Python on this machine');

// Are the agent's dependencies actually there? Importing pipecat is the cheapest
// honest test of that.
const has = spawnSync(python, ['-c', 'import pipecat'], { stdio: 'ignore' });
if (has.status !== 0) skip('pipecat is not installed');

const run = spawnSync(python, [SCRIPT], { stdio: 'inherit', cwd: ROOT });
process.exit(run.status ?? 1);
