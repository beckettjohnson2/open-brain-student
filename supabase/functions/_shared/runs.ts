// _shared/runs.ts — the run log (agent_runs) for every agent step and every
// background job. The 3D office will show ONLY this data, so every job that
// does work writes a row: started → done / failed, with its output.
//
// Tokens and cost are added by call-llm itself (pass `runId` in its body),
// through public.add_run_usage(), so they are always the real numbers.
//
// Logging must never break the job it describes: every function here
// catches its own errors and returns null / does nothing.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type RunStatus = "queued" | "working" | "waiting_on_me" | "done" | "failed";

export async function startRun(db: SupabaseClient, o: {
  userId: string | null | undefined;
  agent: string;
  task: string;
  job?: string;
  thoughtId?: string | null;
  orderId?: string | null;
  seq?: number;
  status?: RunStatus;
}): Promise<string | null> {
  try {
    const status = o.status ?? "working";
    const { data, error } = await db.from("agent_runs").insert({
      user_id: o.userId ?? null,
      agent: o.agent,
      task: o.task.slice(0, 2000),
      job: o.job ?? null,
      thought_id: o.thoughtId ?? null,
      order_id: o.orderId ?? null,
      seq: o.seq ?? 0,
      status,
      started_at: status === "working" ? new Date().toISOString() : null,
    }).select("id").single();
    if (error) {
      console.log(`run log (start ${o.agent}/${o.job ?? ""}) failed: ${error.message}`);
      return null;
    }
    return data.id as string;
  } catch (e) {
    console.log(`run log (start) crashed: ${e}`);
    return null;
  }
}

export async function finishRun(
  db: SupabaseClient,
  id: string | null | undefined,
  o: { status?: "done" | "failed"; output?: string; error?: string },
): Promise<void> {
  if (!id) return;
  try {
    const { error } = await db.from("agent_runs").update({
      status: o.status ?? "done",
      ...(o.output !== undefined ? { output: o.output.slice(0, 20_000) } : {}),
      ...(o.error !== undefined ? { error: o.error.slice(0, 2000) } : {}),
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) console.log(`run log (finish ${id}) failed: ${error.message}`);
  } catch (e) {
    console.log(`run log (finish) crashed: ${e}`);
  }
}
