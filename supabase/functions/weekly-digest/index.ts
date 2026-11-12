// weekly-digest — reads the last 7 days of thoughts and writes you a report
// on your own mind. Called automatically every week by pg_cron.
// Every AI call goes through YOUR gateway (call-llm), never a provider directly.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { internalHeaders, rejectUnlessInternal } from "../_shared/internal-auth.ts";
import { finishRun, startRun } from "../_shared/runs.ts";

const DAYS = 7;
const MIN_THOUGHTS = 5;
const PER_THOUGHT_CHARS = 1_500;   // long captures (videos, PDFs) get trimmed
const MAX_TOTAL_CHARS = 40_000;    // keeps one digest call cheap no matter how busy your week was

const SYSTEM_PROMPT = `You write a weekly digest for one person, built only from their own notes.
Write to them in second person ("you"). Plain text with short headings, no markdown symbols like ** or #.
Use exactly these three sections:

WHAT YOU WERE LEARNING
Group related notes into topics. Name the actual subjects from the notes, specifically.

KEY THEMES
2 to 4 short bullet points (use "- ") about patterns across the week.

A QUESTION YOU SEEM TO BE EXPLORING
One question, then one sentence on why you think so.

Some notes are saved sources marked [source: research / expert / opinion / unknown].
If a point comes only from opinion-level sources, say so ("an opinion-level video claims…").
When sources disagree, prefer research- and expert-level ones and mention the disagreement.

Never invent anything that isn't in the notes. Keep it under 400 words.`;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fmt(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

Deno.serve(async (req) => {
  // Only pg_cron (or you, with the secret) may start a digest — it spends AI credit.
  const denied = rejectUnlessInternal(req);
  if (denied) return denied;

  // The run log: the digest is a Scout job (agent_runs).
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const runId = await startRun(supabase, {
    userId: Deno.env.get("OWNER_USER_ID") || null, agent: "Scout", job: "weekly-digest",
    task: `Write the weekly digest of the last ${DAYS} days`,
  });
  const res = await digest(supabase, runId);
  const out = await res.clone().json().catch(() => ({}));
  await finishRun(supabase, runId, out.ok
    ? { output: out.skipped ? String(out.message) : `Digest saved (${out.thoughts} thoughts). ${String(out.preview ?? "").slice(0, 300)}` }
    : { status: "failed", error: String(out.error ?? `HTTP ${res.status}`) });
  return res;
});

async function digest(supabase: SupabaseClient, runId: string | null): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    const now = new Date();
    const since = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);

    // 1. Grab the week's thoughts
    const { data, error } = await supabase
      .from("thoughts")
      .select("*")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Could not read thoughts:", error.message);
      return reply({ ok: false, error: error.message }, 500);
    }

    // Don't summarise old digests inside new digests, and leave out the
    // course build prompts (kind = course_setup) — they aren't your thinking.
    const thoughts = (data ?? []).filter(
      (t) => t.category !== "digest" && t.kind !== "course_setup" && t.kind !== "report" && t.status !== "archived",
    );

    // 2. Not enough to say anything useful? Stop here.
    if (thoughts.length < MIN_THOUGHTS) {
      const msg = `Only ${thoughts.length} thoughts in the last ${DAYS} days — need ${MIN_THOUGHTS}. No digest this week.`;
      console.log(msg);
      return reply({ ok: true, skipped: true, message: msg });
    }

    // Who to bill the AI call to, and who owns the digest
    // Falls back to the owner so a digest is never saved without one.
    const userId = thoughts.find((t) => t.user_id)?.user_id ?? (Deno.env.get("OWNER_USER_ID") || null);
    if (!userId) return reply({ ok: false, error: "No owner for this digest (OWNER_USER_ID is not set)." }, 500);

    // 3. Group by category
    const groups: Record<string, typeof thoughts> = {};
    for (const t of thoughts) {
      const key = t.category ?? "uncategorised";
      (groups[key] ??= []).push(t);
    }

    let notes = "";
    for (const [category, items] of Object.entries(groups)) {
      notes += `\n[${category.toUpperCase()} — ${items.length}]\n`;
      for (const t of items) {
        const content: string = t.content ?? t.text ?? "";
        // For long captures, the one-line summary says more per character
        const body = content.length > PER_THOUGHT_CHARS && t.summary
          ? `${t.summary} (long capture, summarised)`
          : content.slice(0, PER_THOUGHT_CHARS);
        const tags = (Array.isArray(t.tags) && t.tags.length ? `  {tags: ${t.tags.join(", ")}}` : "") +
          (t.kind === "source" ? `  [source: ${t.reliability ?? "unknown"}]` : "");
        notes += `- ${body.replace(/\s+/g, " ").trim()}${tags}\n`;
      }
    }
    notes = notes.slice(0, MAX_TOTAL_CHARS);

    // 4. Ask the AI — through YOUR gateway, with the internal secret
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Here are my notes from ${fmt(since)} to ${fmt(now)}, grouped by category:\n${notes}`,
        maxTokens: 4096,
        userId,
        source: "weekly-digest",
        ...(runId ? { runId } : {}),
      }),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      console.error(`call-llm failed (${llmRes.status}):`, errText);
      return reply({ ok: false, error: `call-llm failed (${llmRes.status}): ${errText}` }, 502);
    }

    const { text } = await llmRes.json();

    // 5. Save the digest as a thought of its own
    const header = `Weekly digest: ${fmt(since)} to ${fmt(now)} (${thoughts.length} thoughts)`;
    const { error: insertError } = await supabase.from("thoughts").insert({
      content: `${header}\n\n${String(text).trim()}`,
      user_id: userId,
      category: "digest",
      tags: ["weekly-digest"],
      summary: header,
      enriched_at: now.toISOString(),
    });

    if (insertError) {
      console.error("Could not save digest:", insertError.message);
      return reply({ ok: false, error: insertError.message, digest: text }, 500);
    }

    console.log(header);
    return reply({ ok: true, thoughts: thoughts.length, preview: String(text).slice(0, 300) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("weekly-digest error:", message);
    return reply({ ok: false, error: message }, 500);
  }
}