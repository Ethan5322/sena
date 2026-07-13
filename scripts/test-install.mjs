/* Sena — prove the copy-paste install is safe in a SHARED Supabase.
 *
 * Sena lives in the same free Supabase project as the MuleSoo website. So the
 * question is not "does the SQL run" — it is "does it run WITHOUT damaging the
 * app already in there, and can it be removed again cleanly".
 *
 * This test stands up a fake MuleSoo (a corp_* table with a row in it), runs
 * sena-all-in-one.sql exactly as it will be pasted into the SQL editor, checks
 * Sena works, then runs sena-uninstall.sql and checks MuleSoo is still standing.
 *
 * Run: npm run test:install
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (f) => fs.readFileSync(path.join(SQL, f), 'utf8');

const db = new PGlite({ extensions: { pgcrypto } });
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.error(`  FAIL  ${m}`); process.exitCode = 1; };

await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
`);

// ── A stand-in for the MuleSoo app already living in this database ──────────
await db.exec(`
  create table corp_departments (id serial primary key, name text not null);
  insert into corp_departments (name) values ('Engineering'), ('Sales');
  create index corp_departments_name_idx on corp_departments(name);
`);
pass('a co-tenant MuleSoo table exists in the database (corp_departments, 2 rows)');

// ── Run the install EXACTLY as it will be pasted ────────────────────────────
try {
  await db.exec(read('sena-all-in-one.sql'));
  pass('sena-all-in-one.sql ran clean in a database that already had another app');
} catch (e) {
  fail(`sena-all-in-one.sql — ${e.message}`);
  process.exit(1);
}

// MuleSoo must be exactly as we left it.
const { rows: corp } = await db.query(`select name from corp_departments order by id`);
if (corp.length === 2 && corp[0].name === 'Engineering') pass('MuleSoo\'s table is untouched by the install');
else fail(`MuleSoo's data changed during Sena's install: ${JSON.stringify(corp)}`);

// Sena must actually work.
const { rows: [hotel] } = await db.query(`select id, name from sena_hotels where is_demo`);
if (!hotel) fail('demo hotel missing after install');
else pass(`Sena installed — ${hotel.name}`);

const { rows: avail } = await db.query(
  `select name, free_units from sena_check_availability($1, current_date + 7, current_date + 9, 2)`,
  [hotel.id]);
if (avail.length) pass(`availability answers — ${avail.length} room types sellable`);
else fail('availability returned nothing after install');

// No name Sena created may collide with a name MuleSoo uses.
//
// Functions installed BY AN EXTENSION (pgcrypto brings gen_random_uuid, digest,
// hmac, …) are excluded via pg_depend deptype='e' — they belong to the
// extension, not to Sena, and both apps share them happily. Without that filter
// this check screams about names Sena never created.
const { rows: objs } = await db.query(`
  select tablename as n from pg_tables  where schemaname = 'public'
  union all
  select indexname     from pg_indexes  where schemaname = 'public'
  union all
  select p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
`);
const senaOwned = objs.map((o) => o.n).filter((n) => n.startsWith('sena_'));
const strays = objs.map((o) => o.n).filter((n) => !n.startsWith('sena_') && !n.startsWith('corp_'));
if (strays.length === 0) pass(`every object Sena created is namespaced sena_* (${senaOwned.length} of them)`);
else fail(`Sena created un-namespaced objects that could collide: ${strays.join(', ')}`);

// ── Uninstall must remove Sena and ONLY Sena ────────────────────────────────
try {
  await db.exec(read('sena-uninstall.sql'));
  pass('sena-uninstall.sql ran clean');
} catch (e) {
  fail(`sena-uninstall.sql — ${e.message}`);
}

const { rows: left } = await db.query(
  `select tablename from pg_tables where schemaname = 'public' and tablename like 'sena_%'`);
if (left.length === 0) pass('nothing of Sena is left behind');
else fail(`sena tables survived the uninstall: ${left.map((r) => r.tablename).join(', ')}`);

const { rows: corpAfter } = await db.query(`select name from corp_departments order by id`);
if (corpAfter.length === 2) pass('MuleSoo is still standing after Sena is uninstalled');
else fail('the uninstall damaged the co-tenant app');

if (process.exitCode) console.error('\n  ── FAILURES ABOVE ──');
else console.log('\n  ── the install is safe to paste into the shared Supabase ──');
