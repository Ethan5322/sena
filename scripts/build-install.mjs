/* Sena — assemble supabase/sena-all-in-one.sql.
 *
 * The three SQL files are the sources of truth. This concatenates them, in the
 * only order that works, into one thing that can be pasted into the Supabase SQL
 * editor in a single go.
 *
 * It is generated rather than hand-maintained because a hand-copied bundle drifts
 * from its sources silently, and the first you hear of it is a hotel with a
 * half-installed database.
 *
 * Run: npm run build:install   (then npm run test:install)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (f) => fs.readFileSync(path.join(SQL, f), 'utf8');

const HEADER = `-- ############################################################################
-- #  SENA — AI FRONT DESK RECEPTIONIST                                        #
-- #  ONE-SHOT INSTALL — paste this whole file into the Supabase SQL editor.   #
-- ############################################################################
--
-- GENERATED FILE — do not edit. Edit schema.sql / policies.sql /
-- seed-demo-hotel.sql, then run: npm run build:install
--
-- SAFE TO RUN IN A SUPABASE PROJECT THAT ALREADY HOLDS ANOTHER APP.
--
-- This database is shared with the MuleSoo website. Nothing here can touch it:
--
--   * Every table, type, function, index and trigger Sena creates is named
--     sena_*  (MuleSoo's own objects are corp_* and friends). No name in this
--     file is one MuleSoo also uses, so nothing can be overwritten or collide.
--   * This script only ever CREATEs. Its single DELETE is scoped to Sena's own
--     demo hotel row. It never drops, alters or reads a MuleSoo table.
--   * To remove Sena later, run sena-uninstall.sql — it drops only sena_*
--     objects and leaves MuleSoo standing.
--
-- Both of those claims are TESTED, not asserted: scripts/test-install.mjs stands
-- up a fake MuleSoo table, runs this exact file against it, and checks MuleSoo
-- survives both the install and the uninstall.
--
-- WHAT YOU GET
--   1. The tables behind the guest journey (CLAUDE.md §2/§6)
--   2. The availability engine + the anti-double-booking lock
--   3. The single-use QR guest ID knock-out
--   4. Row Level Security — the public key gets NOTHING; staff see only their
--      own hotel. These tables hold guest names, phones and nationalities: that
--      is personal information under POPIA.
--   5. A fictional demo hotel, so Sena is callable before a real client signs.
--
-- Just run the whole file, top to bottom, once. The order is already correct.
-- ############################################################################

`;

const FOOTER = `

-- ############################################################################
-- #  DONE.
-- #
-- #  Check it worked — you should see the demo hotel and its five rooms:
-- #
-- #     select name, currency, hold_minutes from sena_hotels;
-- #     select name, rate_cents / 100 as rand_per_night, inventory
-- #       from sena_rooms order by rate_cents;
-- #
-- #  And prove availability answers (2 guests, 2 nights, next week):
-- #
-- #     select r.name, r.free_units, r.total_cents / 100 as rand_total
-- #       from sena_hotels h,
-- #            sena_check_availability(h.id, current_date + 7,
-- #                                    current_date + 9, 2) r
-- #      where h.is_demo;
-- #
-- #  Designed & built by MuleSoo Digital Services — mulesoo.com
-- ############################################################################
`;

const PARTS = [
  ['1 of 3 — TABLES, AVAILABILITY, HOLD LOCK, QR KNOCK-OUT', 'schema.sql'],
  ['2 of 3 — ROW LEVEL SECURITY (POPIA)', 'policies.sql'],
  ['3 of 3 — DEMO HOTEL (fictional — replace when a real hotel is loaded)', 'seed-demo-hotel.sql'],
];

const body = PARTS.map(([title, file]) => `

-- ============================================================================
-- ==  PART ${title}
-- ==  (source: supabase/${file})
-- ============================================================================

${read(file)}`).join('');

const out = path.join(SQL, 'sena-all-in-one.sql');
fs.writeFileSync(out, HEADER + body + FOOTER);

const text = fs.readFileSync(out, 'utf8');
// A stray unprefixed CREATE TABLE is the one mistake that could hit MuleSoo.
const bad = [...text.matchAll(/create table (?:if not exists )?(\w+)/gi)]
  .map((m) => m[1])
  .filter((n) => !n.startsWith('sena_'));
if (bad.length) {
  console.error(`  REFUSING TO SHIP: un-namespaced table(s): ${bad.join(', ')}`);
  process.exit(1);
}

console.log(`  supabase/sena-all-in-one.sql  ${(text.length / 1024).toFixed(0)} KB  ${text.split('\n').length} lines`);
console.log(`  every table is sena_* — safe to paste into the shared Supabase`);
