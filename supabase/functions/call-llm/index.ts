// call-llm — the ONE door every AI call in Open Brain goes through.
//
// To switch providers, change LLM_PROVIDER in Supabase secrets.
// Add the new provider's API key. No other code changes needed.
//
// To switch models, change LLM_MODEL in Supabase secrets.
// (Also add the new model's price to PRICES below so your receipts stay accurate.)
//
// Notice what is NOT in this file: your API key. It is read from Supabase
// secrets at runtime, so this file is safe to push to GitHub.

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------- Prices (USD per 1 million tokens) ----------
// Used only to estimate cost for your llm_usage receipts.
// A model missing from this list still works — its cost is just logged as 0.
type Price = {
  input: number;
  output: number;
  longThreshold?: number; // prompts bigger than this many tokens...
  longInput?: number;     // ...are billed at these higher rates
  longOutput?: number;
};

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": {
    input: 0.10,
    output: 0.50,
    longThreshold: 100_000,
    longInput: 0.50,
    longOutput: 2.50,
  },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  const isLong = p.longThreshold !== undefined && promptTokens > p.longThreshold;
  const inRate = isLong && p.longInput !== undefined ? p.longInput : p.input;
  const outRate = isLong && p.longOutput !== undefined ? p.longOutput : p.output;
  return (promptTokens * inRate + completionTokens * outRate) / 1_000_000;
}

// ---------- Providers ----------
// Each provider is one small function with the same shape.
// Adding a new provider = adding one function and one line in PROVIDERS.
type LlmRequest = { prompt: string; systemPrompt?: string; model: string; maxTokens: number };
type LlmResult = { text: string; promptTokens: number; completionTokens: number };

async function callAnthropic(r: LlmRequest): Promise<LlmResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in Supabase secrets");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: r.model,
      max_tokens: r.maxTokens,
      system: r.systemPrompt || undefined,
      messages: [{ role: "user", content: r.prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  // The reply can contain several blocks; we only want the text ones.
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");

  return {
    text,
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(r: LlmRequest): Promise<LlmResult> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in Supabase secrets");

  const messages = [];
  if (r.systemPrompt) messages.push({ role: "system", content: r.systemPrompt });
  messages.push({ role: "user", content: r.prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: r.model, messages, max_completion_tokens: r.maxTokens }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

const PROVIDERS: Record<string, (r: LlmRequest) => Promise<LlmResult>> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
};

// ---------- Receipts ----------
// THE RULE: logging a receipt must NEVER break the real call.
// The AI has already answered by the time this runs. If logging fails,
// we write a warning to the logs and move on. Nothing is thrown.
function logUsage(entry: {
  userId?: string;
  source?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}) {
  try {
    if (!entry.userId) return; // no one to bill it to — skip quietly

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return;

    const supabase = createClient(url, serviceKey);

    const insert = supabase
      .from("llm_usage")
      .insert({
        user_id: entry.userId,
        kind: "chat",
        model: entry.model,
        source: entry.source ?? null,
        prompt_tokens: entry.promptTokens,
        completion_tokens: entry.completionTokens,
        cost_usd: estimateCost(entry.model, entry.promptTokens, entry.completionTokens),
      })
      .then(
        ({ error }) => {
          if (error) console.warn("llm_usage insert failed (ignored):", error.message);
        },
        (e) => console.warn("llm_usage insert failed (ignored):", e),
      );

    // Not awaited — the caller gets its answer right away.
    // waitUntil just keeps the function alive long enough for the receipt to land.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(insert);
  } catch (e) {
    console.warn("llm_usage logging crashed (ignored):", e);
  }
}

// ---------- The function itself ----------
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return json({ error: "Missing 'prompt' (must be a non-empty string)" }, 400);
  }

  const provider = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").toLowerCase();
  const model = (typeof body.model === "string" && body.model) || Deno.env.get("LLM_MODEL");
  if (!model) return json({ error: "LLM_MODEL is not set in Supabase secrets" }, 500);

  const callProvider = PROVIDERS[provider];
  if (!callProvider) {
    return json({ error: `Unknown LLM_PROVIDER '${provider}'. Options: ${Object.keys(PROVIDERS).join(", ")}` }, 500);
  }

  const maxTokens = typeof body.maxTokens === "number" ? body.maxTokens : 2048;
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : undefined;

  let result: LlmResult;
  try {
    result = await callProvider({ prompt, systemPrompt, model, maxTokens });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("call-llm failed:", message);
    return json({ error: message }, 502);
  }

  logUsage({
    userId: typeof body.userId === "string" ? body.userId : undefined,
    source: typeof body.source === "string" ? body.source : undefined,
    model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  });

  return json({ text: result.text });
});