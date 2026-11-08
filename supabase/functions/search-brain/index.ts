// search-brain — the web app's Search tab calls this.
//
// 1. Turns your search words into an embedding (Supabase's free gte-small).
// 2. Runs hybrid_search: meaning search + keyword search, fused.
// 3. Adds up to 3 related thoughts (from the graph) under each result.
//
// Deployed WITH login checking, and it queries the database AS YOU (your
// login token, not the service key), so row-level security guarantees it
// only ever sees your own thoughts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MATCH_COUNT = 20;
const RELATED_COUNT = 3;
// Below this meaning score a result only shows if its keywords match.
const MIN_SIMILARITY = 0.78;

const embedder = new Supabase.ai.Session("gte-small");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const { query } = await req.json();
    const text = String(query ?? "").trim().slice(0, 500);
    if (!text) return json({ error: "Type something to search for." }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const { data: userData } = await db.auth.getUser();
    if (!userData?.user) return json({ error: "Please sign in again." }, 401);

    const vector = await embedder.run(text, { mean_pool: true, normalize: true });
    const { data, error } = await db.rpc("hybrid_search", {
      query_embedding: JSON.stringify(Array.from(vector as number[])),
      query_text: text,
      match_count: MATCH_COUNT,
      min_similarity: MIN_SIMILARITY,
    });
    if (error) throw error;

    const results = await Promise.all((data ?? []).map(async (row: { id: string }) => {
      const { data: related } = await db.rpc("related_thoughts", {
        p_thought_id: row.id,
        match_count: RELATED_COUNT,
      });
      return { ...row, related: related ?? [] };
    }));

    return json({ ok: true, results });
  } catch (e) {
    console.error("search-brain error:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
