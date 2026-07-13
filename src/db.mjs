// ============================================================================
// Sena — database access
//
// One deliberate constraint: production and the test suite speak the SAME SQL.
// `pg` (against Supabase) and PGlite (in the tests) both expose
// query(sql, params) -> { rows }, so every statement the router issues is the
// statement the tests actually attacked. A router that only works against a
// mock is a router nobody has tested.
//
// Postgres returns `bigint` as a STRING, because it does not fit a JS number
// safely. Money here is in cents and will never come close to that limit, but
// the string still poisons arithmetic silently — 95000 * 2 becomes "9500095000"
// if you forget. Everything monetary goes through cents() below.
// ============================================================================

import pg from 'pg';

/** bigint arrives from the driver as a string. Never do maths on it raw. */
export const cents = (v) => (v === null || v === undefined ? null : Number(v));

/** Cents to whole currency units, for anything the guest will hear or read. */
export const toMajor = (v) => cents(v) / 100;

export function createPgDb(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({
    connectionString,
    // Supabase terminates TLS at the pooler with a cert Node does not ship a
    // root for. The connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    // Vercel gives each invocation its own process; a big pool per invocation
    // is how you exhaust Supabase's connection limit under call volume.
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    query: (sql, params) => pool.query(sql, params),
    end: () => pool.end(),
  };
}
