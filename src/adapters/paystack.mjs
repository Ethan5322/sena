// ============================================================================
// Sena — Paystack (ZAR). CLAUDE.md §0.0: South Africa first.
//
// The card never touches us. Sena refuses card details by voice, Paystack hosts
// the payment page, and all we ever store is a reference (§9). Swapping in Chapa
// for Ethiopia means writing another module with these two methods — nothing in
// the router changes.
// ============================================================================

const API = 'https://api.paystack.co';

export function createPaystack({ secretKey, callbackUrl }) {
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  return {
    /** Start a transaction and get the hosted page the guest will pay on. */
    async initialize({ reference, amount_cents, currency, email, metadata }) {
      const res = await fetch(`${API}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference,
          // Paystack takes the minor unit — cents. Our column is already cents,
          // so this must NOT be divided. Dividing here bills the guest 1/100th
          // of the room and nobody notices until the month-end reconciliation.
          amount: amount_cents,
          currency,
          email,
          metadata,
          callback_url: callbackUrl,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.status) {
        throw new Error(`paystack initialize failed: ${body.message || res.status}`);
      }

      return {
        authorization_url: body.data.authorization_url,
        access_code: body.data.access_code,
        reference: body.data.reference,
      };
    },

    /** Ask Paystack directly. The webhook is the source of truth; this is the fallback. */
    async verify(reference) {
      const res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.status) {
        throw new Error(`paystack verify failed: ${body.message || res.status}`);
      }
      return {
        paid: body.data.status === 'success',
        amount_cents: body.data.amount,
        currency: body.data.currency,
        raw: body.data,
      };
    },
  };
}
