// ============================================================================
// Sena — the owner dashboard (CLAUDE.md §2's other half).
//
// The journey map promises the OWNER visibility at six stages — holds appearing
// mid-call, payment status, new bookings, approvals, check-ins, a daily picture
// — and until this file none of it existed anywhere but email. This is that
// promise as one page: what is happening at the hotel right now, rendered
// server-side from the same tables the router writes.
//
// It is a READ. Nothing on this page mutates anything — approving, cancelling
// and checking in all stay where the gates are (the router, the desk RPC). A
// dashboard that can edit bookings is a second front door to guard; a dashboard
// that can only look needs one secret and no framework.
//
// Auto-refreshes every 60s with a meta tag, because the owner leaves this open
// on the reception PC all day and a stale "LIVE" panel is a lie.
// ============================================================================

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents, currency) => `${currency} ${(Number(cents || 0) / 100).toFixed(2)}`;

const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

const chip = (status) => {
  const tone = {
    pending: ['#FEF3C7', '#92400E'],
    confirmed: ['#DCFCE7', '#15803D'],
    checked_in: ['#DBEAFE', '#1D4ED8'],
    completed: ['#F3F4F6', '#6B7280'],
    cancelled: ['#FEE2E2', '#B91C1C'],
    expired: ['#F3F4F6', '#9CA3AF'],
  }[status] || ['#F3F4F6', '#6B7280'];
  return `<span class="chip" style="background:${tone[0]};color:${tone[1]}">${esc(status).replace('_', ' ')}</span>`;
};

/**
 * Render the dashboard for one hotel. `db` is anything with
 * query(sql, params) -> { rows } — Supabase in production, PGlite in tests and
 * demo mode, which is what makes this page demoable with nothing signed up for.
 */
export async function renderDashboard({ db, hotelId = null }) {
  // to_char, not ::date — the pg driver hands a bare `date` back as a JS Date
  // object, and "today" must stay the hotel's calendar day as text.
  const { rows: hotels } = await db.query(
    hotelId
      ? `select *, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today
           from sena_hotels where id = $1`
      : `select *, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today
           from sena_hotels order by created_at limit 1`,
    hotelId ? [hotelId] : []
  );
  if (!hotels.length) throw new Error('no hotel found for dashboard');
  const hotel = hotels[0];
  const today = hotel.today;

  const [arrivals, departures, inHouse, holds, approvals, occupancy, revenue, bookings, calls] =
    await Promise.all([
      db.query(
        `select b.reference, b.arrival_time, b.guests_count, b.needs_approval,
                g.full_name, r.name as room_name
           from sena_bookings b
           left join sena_guests g on g.id = b.guest_id
           join sena_rooms r on r.id = b.room_id
          where b.hotel_id = $1 and b.check_in = $2 and b.status in ('confirmed','checked_in')
          order by b.arrival_time nulls last`,
        [hotel.id, today]
      ),
      db.query(
        `select b.reference, b.departure_time, g.full_name, r.name as room_name, b.status
           from sena_bookings b
           left join sena_guests g on g.id = b.guest_id
           join sena_rooms r on r.id = b.room_id
          where b.hotel_id = $1 and b.check_out = $2 and b.status in ('confirmed','checked_in')
          order by b.departure_time nulls last`,
        [hotel.id, today]
      ),
      db.query(
        `select count(*)::int as n from sena_bookings where hotel_id = $1 and status = 'checked_in'`,
        [hotel.id]
      ),
      // §2 stage 4: the provisional hold, "flagged in progress". These rows exist
      // while a guest is on the phone (or paying) and vanish on their own.
      db.query(
        `select b.reference, b.total_cents,
                to_char(b.check_in, 'YYYY-MM-DD') as check_in,
                to_char(b.check_out, 'YYYY-MM-DD') as check_out,
                greatest(0, ceil(extract(epoch from (b.hold_expires_at - now())) / 60))::int as mins_left,
                g.full_name, r.name as room_name,
                exists (select 1 from sena_payments p
                         where p.booking_id = b.id and p.status = 'paid') as paid
           from sena_bookings b
           left join sena_guests g on g.id = b.guest_id
           join sena_rooms r on r.id = b.room_id
          where b.hotel_id = $1 and b.status = 'pending' and b.hold_expires_at > now()
          order by b.hold_expires_at`,
        [hotel.id]
      ),
      // §2 stage 5: early/late requests the owner must decide on.
      db.query(
        `select b.reference, b.arrival_time, b.departure_time, b.special_requests,
                to_char(b.check_in, 'YYYY-MM-DD') as check_in,
                g.full_name, r.name as room_name
           from sena_bookings b
           left join sena_guests g on g.id = b.guest_id
           join sena_rooms r on r.id = b.room_id
          where b.hotel_id = $1 and b.needs_approval and b.status in ('pending','confirmed')
          order by b.check_in`,
        [hotel.id]
      ),
      db.query(
        `select
           (select coalesce(sum(inventory), 0)::int from sena_rooms
             where hotel_id = $1 and is_active) as total,
           (select count(*)::int from sena_bookings b
             where b.hotel_id = $1 and b.check_in <= $2 and b.check_out > $2
               and (b.status in ('confirmed','checked_in')
                    or (b.status = 'pending' and b.hold_expires_at > now()))) as occupied`,
        [hotel.id, today]
      ),
      db.query(
        `select coalesce(sum(p.amount_cents), 0) as total_cents, count(*)::int as n
           from sena_payments p
           join sena_bookings b on b.id = p.booking_id
          where b.hotel_id = $1 and p.status = 'paid'
            and p.paid_at >= date_trunc('month', now())`,
        [hotel.id]
      ),
      db.query(
        `select b.reference, b.status, b.total_cents,
                to_char(b.check_in, 'YYYY-MM-DD') as check_in,
                to_char(b.check_out, 'YYYY-MM-DD') as check_out,
                g.full_name, r.name as room_name,
                exists (select 1 from sena_payments p
                         where p.booking_id = b.id and p.status = 'paid') as paid
           from sena_bookings b
           left join sena_guests g on g.id = b.guest_id
           join sena_rooms r on r.id = b.room_id
          where b.hotel_id = $1
          order by b.created_at desc
          limit 10`,
        [hotel.id]
      ),
      db.query(
        `select intent, outcome, escalated, escalation_reason, started_at, ended_at
           from sena_calls
          where hotel_id = $1
          order by started_at desc
          limit 10`,
        [hotel.id]
      ),
    ]);

  const kpis = [
    ['Arriving today', arrivals.rows.length],
    ['Leaving today', departures.rows.length],
    ['In house', inHouse.rows[0].n],
    ['Tonight', `${occupancy.rows[0].occupied}/${occupancy.rows[0].total} rooms`],
    ['Paid this month', money(revenue.rows[0].total_cents, hotel.currency)],
  ];

  const empty = (msg) => `<p class="empty">${esc(msg)}</p>`;

  const holdRows = holds.rows.length
    ? `<table>
        <tr><th>Guest</th><th>Room</th><th>Stay</th><th>Amount</th><th>Payment</th><th>Hold</th></tr>
        ${holds.rows
          .map(
            (h) => `<tr>
          <td>${esc(h.full_name || 'on the call now')}</td>
          <td>${esc(h.room_name)}</td>
          <td>${esc(h.check_in)} → ${esc(h.check_out)}</td>
          <td>${esc(money(h.total_cents, hotel.currency))}</td>
          <td>${h.paid ? '<span class="chip" style="background:#DCFCE7;color:#15803D">paid</span>' : '<span class="chip" style="background:#FEF3C7;color:#92400E">awaiting payment</span>'}</td>
          <td>${esc(h.mins_left)} min left</td>
        </tr>`
          )
          .join('')}
      </table>`
    : empty('No calls in progress. Holds appear here the moment Sena offers a room.');

  const approvalRows = approvals.rows.length
    ? `<table>
        <tr><th>Guest</th><th>Booking</th><th>Requested</th></tr>
        ${approvals.rows
          .map(
            (a) => `<tr>
          <td>${esc(a.full_name || '—')}</td>
          <td>${esc(a.reference)} · ${esc(a.room_name)} · ${esc(a.check_in)}</td>
          <td>${esc(
            [
              a.arrival_time ? `arrive ${hhmm(a.arrival_time)}` : '',
              a.departure_time ? `leave ${hhmm(a.departure_time)}` : '',
              a.special_requests || '',
            ]
              .filter(Boolean)
              .join(' · ')
          )}</td>
        </tr>`
          )
          .join('')}
      </table>`
    : empty('Nothing waiting on you.');

  const moveRows = (list, timeKey, emptyMsg) =>
    list.length
      ? `<table>
          <tr><th>Guest</th><th>Room</th><th>Booking</th><th>Time</th></tr>
          ${list
            .map(
              (b) => `<tr>
            <td>${esc(b.full_name || '—')}${b.needs_approval ? ' <span class="chip" style="background:#FEF3C7;color:#92400E">approval</span>' : ''}</td>
            <td>${esc(b.room_name)}</td>
            <td>${esc(b.reference)}</td>
            <td>${esc(hhmm(b[timeKey]) || '—')}</td>
          </tr>`
            )
            .join('')}
        </table>`
      : empty(emptyMsg);

  const bookingRows = bookings.rows.length
    ? `<table>
        <tr><th>Ref</th><th>Guest</th><th>Room</th><th>Stay</th><th>Total</th><th>Status</th></tr>
        ${bookings.rows
          .map(
            (b) => `<tr>
          <td>${esc(b.reference)}</td>
          <td>${esc(b.full_name || '—')}</td>
          <td>${esc(b.room_name)}</td>
          <td>${esc(b.check_in)} → ${esc(b.check_out)}</td>
          <td>${esc(money(b.total_cents, hotel.currency))}${b.paid ? '' : ' <span class="chip" style="background:#FEF3C7;color:#92400E">unpaid</span>'}</td>
          <td>${chip(b.status)}</td>
        </tr>`
          )
          .join('')}
      </table>`
    : empty('No bookings yet. They appear here the moment Sena takes one.');

  const callRows = calls.rows.length
    ? `<table>
        <tr><th>When</th><th>Intent</th><th>Outcome</th></tr>
        ${calls.rows
          .map(
            (c) => `<tr${c.escalated ? ' class="alert"' : ''}>
          <td>${esc(new Date(c.started_at).toLocaleString('en-ZA', { timeZone: hotel.timezone }))}</td>
          <td>${esc(String(c.intent).replace('_', ' '))}</td>
          <td>${
            c.escalated
              ? `<strong>ESCALATED</strong> — ${esc(c.escalation_reason || 'needs a person')}`
              : esc(c.outcome || (c.ended_at ? '—' : 'in progress'))
          }</td>
        </tr>`
          )
          .join('')}
      </table>`
    : empty('No calls yet.');

  const accent = esc(hotel.brand_accent || '#C8A24B');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(hotel.name)} — Owner Dashboard</title>
<style>
  :root { --ink:#0B1220; --line:#E3E6EC; --muted:#6B7280; --accent:${accent}; }
  * { box-sizing:border-box; margin:0; }
  body { font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:#F6F7F9; }
  main { max-width:64rem; margin:0 auto; padding:1.25rem; }
  header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:.5rem;
           border-bottom:3px solid var(--accent); padding-bottom:.8rem; margin-bottom:1.25rem; }
  h1 { font-size:1.25rem; }
  h1 small { display:block; font-size:.75rem; font-weight:400; color:var(--muted);
             text-transform:uppercase; letter-spacing:.1em; margin-top:.15rem; }
  .stamp { font-size:.75rem; color:var(--muted); text-align:right; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.8rem; margin-bottom:1.25rem; }
  .kpi { background:#fff; border:1px solid var(--line); border-radius:12px; padding:.8rem 1rem; }
  .kpi .n { font-size:1.4rem; font-weight:700; }
  .kpi .l { font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
  section { background:#fff; border:1px solid var(--line); border-radius:14px; padding:1rem 1.1rem; margin-bottom:1rem; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin-bottom:.6rem; }
  h2 .live { color:#15803D; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; }
  th { text-align:left; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
       padding:.35rem .5rem .35rem 0; border-bottom:1px solid var(--line); }
  td { padding:.45rem .5rem .45rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  tr.alert td { background:#FEF2F2; }
  .chip { display:inline-block; padding:.1rem .55rem; border-radius:999px; font-size:.72rem; font-weight:600; }
  .empty { color:#9CA3AF; font-size:.88rem; }
  footer { text-align:center; color:#9CA3AF; font-size:.75rem; padding:1rem 0 2rem; }
  @media (max-width:640px) { table, th, td { font-size:.8rem; } }
</style>
<main>
  <header>
    <h1>${esc(hotel.name)}<small>Owner dashboard</small></h1>
    <div class="stamp">${esc(
      new Date().toLocaleString('en-ZA', { timeZone: hotel.timezone, dateStyle: 'full', timeStyle: 'short' })
    )}<br>refreshes every minute</div>
  </header>

  <div class="kpis">
    ${kpis.map(([l, n]) => `<div class="kpi"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}
  </div>

  <section><h2><span class="live">●</span> On the phone right now — rooms on hold</h2>${holdRows}</section>
  <section><h2>Needs your approval</h2>${approvalRows}</section>
  <section><h2>Arriving today</h2>${moveRows(arrivals.rows, 'arrival_time', 'Nobody arriving today.')}</section>
  <section><h2>Leaving today</h2>${moveRows(departures.rows, 'departure_time', 'Nobody leaving today.')}</section>
  <section><h2>Latest bookings</h2>${bookingRows}</section>
  <section><h2>Latest calls</h2>${callRows}</section>

  <footer>Sena · built by MuleSoo Digital Services</footer>
</main>
</html>`;
}
