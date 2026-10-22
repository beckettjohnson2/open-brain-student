// enrich-thought — runs automatically every time a new thought is saved.
// Asks the AI (through YOUR gateway, call-llm) for tags, a category and a
// one-sentence summary, then writes them back onto the thought.
//
// It never talks to Claude directly. Swap providers in Supabase secrets,
// and this file doesn't change.

import { createClient } from "npm:@supabase/supabase-js@2";

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];
const MIN_LENGTH = 20;        // skip tiny notes like "test" or "ok"
const MAX_CHARS = 12_000;     // long captures get trimmed for enrichment — keeps each call cheap

const SYSTEM_PROMPT = `You label notes for a personal knowledge base.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"tags": ["tag1", "tag2", "tag3"], "category": "learning", "summary": "One sentence."}
Rules:
- tags: 3 to 5 short lowercase tags (1-3 words each) about the topic
- category: exactly one of: ${CATEGORIES.join(", ")}
- summary: one sentence, under 30 words, plain language`;

function ok(message: string) {
  // Webhook functions always answer 200, even when they skip or fail.
  // Saving the thought already worked — enrichment is a bonus, never a blocker.
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Pull the JSON object out of the AI's reply, even if it wrapped it in ```json fences.
function parseEnrichment(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in reply: ${text.slice(0, 200)}`);
  const raw = JSON.parse(match[0]);

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t: unknown) => typeof t === "string" && t.trim() !== "")
        .map((t: string) => t.trim().toLowerCase())
        .slice(0, 5)
    : [];

  const category = typeof raw.category === "string" && CATEGORIES.includes(raw.category.toLowerCase())
    ? raw.category.toLowerCase()
    : null;

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : null;

  return { tags, category, summary };
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload?.record;

    if (payload?.type !== "INSERT" || !record?.id) {
      return ok("Not an insert with a record — nothing to do");
    }

    // Already has a category (for example, a weekly digest) — leave it alone.
    if (record.category || record.enriched_at) {
      return ok(`Thought ${record.id} already categorised — skipped`);
    }

    const content: string = record.content ?? record.text ?? "";
    if (content.trim().length < MIN_LENGTH) {
      return ok(`Thought ${record.id} too short to enrich — skipped`);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Call YOUR gateway — never the AI provider directly.
    // The Authorization header is required, or call-llm turns us away with a 401.
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Note:\n"""\n${content.slice(0, MAX_CHARS)}\n"""`,
        maxTokens: 1024,
        userId: record.user_id,      // bill this call to the thought's owner
        source: "enrich-thought",
      }),
    });

    if (!llmRes.ok) {
      return ok(`call-llm failed (${llmRes.status}): ${await llmRes.text()}`);
    }

    const { text } = await llmRes.json();
    const { tags, category, summary } = parseEnrichment(text);

    const supabase = createClient(supabaseUrl, serviceKey);
    const { error } = await supabase
      .from("thoughts")
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq("id", record.id);

    if (error) return ok(`Could not save enrichment for ${record.id}: ${error.message}`);

    return ok(`Enriched ${record.id}: [${category}] ${tags.join(", ")}`);
  } catch (e) {
    return ok(`enrich-thought error: ${e instanceof Error ? e.message : String(e)}`);
  }
});