// _shared/refill.ts — fill an existing thought with content fetched later.
//
// Used by capture-url and capture-youtube in "refill" mode (internal calls
// only): a thought that was saved as a bare link gets the article text or
// video transcript, KEEPING its id, date and links. The original text is
// kept in metadata.original_content. Then enrich-thought REFRESH re-tags,
// re-embeds, chunks and relinks it.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { internalHeaders } from "./internal-auth.ts";

export const MIN_REAL_CONTENT = 200; // below this, a capture "has no real content"

export async function refillThought(
  admin: SupabaseClient,
  o: {
    thoughtId: string;
    content: string;
    metadata: Record<string, unknown>;
    sourceText: string;
    sourceKind: string;
    truncated: boolean;
  },
): Promise<{ id: string; user_id: string | null }> {
  const { data: before, error: readError } = await admin
    .from("thoughts")
    .select("id, user_id, content, metadata")
    .eq("id", o.thoughtId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!before) throw new Error(`Thought ${o.thoughtId} not found`);

  const oldMeta = (before.metadata ?? {}) as Record<string, unknown>;
  const { error } = await admin.from("thoughts").update({
    content: o.content,
    metadata: {
      ...oldMeta,
      ...o.metadata,
      original_content: oldMeta.original_content ?? before.content,
      refilled_at: new Date().toISOString(),
    },
    // Old tags/summary/embedding described the bare link; REFRESH redoes them.
    enriched_at: null,
    embedded_at: null,
    embedding: null,
  }).eq("id", o.thoughtId);
  if (error) throw new Error(`refill update: ${error.message}`);

  const { error: sourceError } = await admin.from("thought_sources").upsert({
    thought_id: o.thoughtId,
    user_id: before.user_id,
    source_text: o.sourceText,
    source_kind: o.sourceKind,
    char_count: o.sourceText.length,
    truncated: o.truncated,
  }, { onConflict: "thought_id" });
  if (sourceError) console.warn("thought_sources upsert failed:", sourceError.message);

  // Re-tag, re-embed, chunk and relink. Not awaited to the end: chunking a
  // long transcript continues in follow-up calls.
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/enrich-thought`;
  const call = fetch(url, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ type: "REFRESH", id: o.thoughtId }),
  }).then((r) => r.text()).catch((e) => console.log(`refresh failed for ${o.thoughtId}: ${e}`));
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(call);

  return { id: before.id, user_id: before.user_id };
}
