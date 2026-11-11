// _shared/internal-auth.ts — "is this caller my own system?"
//
// Every internal call (database trigger, pg_cron, one edge function calling
// another, the backfill scripts) sends the INTERNAL_SECRET in the
// x-internal-secret header. Functions that spend money or change data reject
// anything without it.
//
// Where the secret lives:
//   - Supabase secret INTERNAL_SECRET  → edge functions read it here
//   - Vault secret 'internal_secret'   → the database trigger and pg_cron
//   - .env INTERNAL_SECRET (git-ignored) → the PowerShell backfill scripts
// It is never written in the repo or in SQL.

export const INTERNAL_HEADER = "x-internal-secret";

export function internalSecret(): string {
  return (Deno.env.get("INTERNAL_SECRET") ?? "").trim();
}

// Headers for calling another of our own functions.
export function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", [INTERNAL_HEADER]: internalSecret(), ...extra };
}

// Compare without leaking how many characters matched.
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Returns a 401/500 Response to send back, or null when the caller is allowed.
// Fails closed: if the secret isn't configured, nobody gets in.
export function rejectUnlessInternal(req: Request): Response | null {
  const expected = internalSecret();
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!expected) {
    console.error("INTERNAL_SECRET is not set — refusing every call");
    return json({ error: "Server is missing the INTERNAL_SECRET secret." }, 500);
  }
  const given = (req.headers.get(INTERNAL_HEADER) ?? "").trim();
  if (!given || !safeEqual(given, expected)) return json({ error: "Unauthorized" }, 401);
  return null;
}
