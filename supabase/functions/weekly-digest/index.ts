// weekly-digest — reads the last 7 days of thoughts and writes you a report
// on your own mind. Called automatically every week by pg_cron.
// Every AI call goes through YOUR gateway (call-llm), never a provider directly.

import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

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

    // Don't summarise old digests inside new digests
    const thoughts = (data ?? []).filter((t) => t.category !== "digest");

    // 2. Not enough to say anything useful? Stop here.
    if (thoughts.length < MIN_THOUGHTS) {
      const msg = `Only ${thoughts.length} thoughts in the last ${DAYS} days — need ${MIN_THOUGHTS}. No digest this week.`;
      console.log(msg);
      return reply({ ok: true, skipped: true, message: msg });
    }

    // Who to bill the AI call to, and who owns the digest
    const userId = thoughts.find((t) => t.user_id)?.user_id ?? null;

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
        const tags = Array.isArray(t.tags) && t.tags.length ? `  {tags: ${t.tags.join(", ")}}` : "";
        notes += `- ${body.replace(/\s+/g, " ").trim()}${tags}\n`;
      }
    }
    notes = notes.slice(0, MAX_TOTAL_CHARS);

    // 4. Ask the AI — through YOUR gateway, with the Authorization header
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Here are my notes from ${fmt(since)} to ${fmt(now)}, grouped by category:\n${notes}`,
        maxTokens: 4096,
        userId,
        source: "weekly-digest",
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
});