// =====================================================================
// open-brain-mcp — an MCP server for your Open Brain
//
// What this file does, in plain language:
//   An AI (like Claude Desktop) sends this function a request such as
//   "list your tools" or "run search_thoughts with the word 'physics'".
//   This function checks the password, talks to your Supabase database,
//   and sends the answer back in the format MCP expects (JSON-RPC 2.0).
//
//   The AI never touches your database directly. Only this code does.
// =====================================================================
 
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { askBrain, renderAnswer } from "../_shared/ask.ts";
import { INTERNAL_HEADER, internalHeaders, internalSecret, safeEqual } from "../_shared/internal-auth.ts";
import { KIND_LABEL, SECTION_LABEL, sectionOf } from "../_shared/kinds.ts";
import { keywordQuery } from "../_shared/keywords.ts";

// ---------------------------------------------------------------------
// 1. SETUP — read settings that Supabase provides to the function
// ---------------------------------------------------------------------
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are given to every Edge
// Function automatically. You never add them yourself.
// MCP_ACCESS_KEY is the password you created in Step 2.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");
const CHATGPT_ACCESS_KEY = (Deno.env.get("CHATGPT_ACCESS_KEY") ?? "").trim();
// Whose brain this is (the same secret the Telegram bot uses). Search only
// looks at this person's thoughts, and new thoughts are saved to them.
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";

// Levels 6 + 7: Supabase's free built-in model that turns text into meaning.
const embedder = new Supabase.ai.Session("gte-small");
const MIN_SIMILARITY = 0.78;

// The database connection. It uses the service_role key, which can read
// and write everything — that is why the password check below matters.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
 
// How this server introduces itself to the AI.
const SERVER_INFO = { name: "open-brain", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
 
// Long items (like a full YouTube transcript) are shortened in search
// results so ten of them don't overflow the AI's memory for one reply.
const MAX_CHARS_PER_THOUGHT = 3000;
 
// CORS headers: rules that tell web browsers this server may be called
// from other websites. Claude Desktop doesn't need them, but browser-based
// MCP tools do, and they do no harm.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
 
// Small helper: send back a JSON response.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
 
// ---------------------------------------------------------------------
// 2. TOOL MENU — what the AI is told it can do
// ---------------------------------------------------------------------
// When the AI asks "tools/list", it gets this list. The descriptions
// matter: they are how the AI decides when to use each tool.
const TOOLS = [
  {
    name: "ask_brain",
    description:
      "Answer a question from the user's Open Brain in plain language, with " +
      "numbered citations to the exact thoughts it used (ids included). " +
      "Weights the user's own writing above videos and articles they saved, " +
      "says so when an answer comes only from a saved source, and replies " +
      "'Nothing in your brain on this' (with the 3 closest thoughts) instead " +
      "of guessing. Best for questions like 'what did I decide about X and " +
      "why', 'what have I saved about X', 'when did I last think about X', " +
      "and 'what's changed in how I think about X'. Use search_thoughts " +
      "instead when you want the raw matching notes.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in plain words" },
        section: {
          type: "string",
          enum: ["personal", "library"],
          description:
            "Optional. 'personal' = the user and what they know (their notes, class notes, AI write-ups they kept); " +
            "'library' = things they found or made (saved videos, articles, PDFs, project docs). Leave out to use both.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "search_thoughts",
    description:
      "Search the user's Open Brain — their personal collection of notes, " +
      "split into two sections (each result is labelled): Personal and Library. " +
      "YouTube transcripts, articles, PDFs, voice notes, and Telegram " +
      "messages. Searches by MEANING and by keyword together, so a plain " +
      "description works even if the user never used those exact words " +
      "(e.g. 'how atoms get bigger'). Also finds details buried deep inside " +
      "long transcripts and PDFs. Returns up to 10 matches, best first, " +
      "each with its id (use it with related_thoughts).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in plain words, e.g. 'calculus' or 'ways I study best'",
        },
        section: {
          type: "string",
          enum: ["personal", "library"],
          description:
            "Optional. 'personal' = the user and what they know (their notes, class notes, AI write-ups they kept); " +
            "'library' = things they found or made (saved videos, articles, PDFs, project docs). Leave out to use both.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "related_thoughts",
    description:
      "Given a thought's id (from search_thoughts or list_recent), list the " +
      "thoughts the brain has linked to it because they mean similar things.",
    inputSchema: {
      type: "object",
      properties: {
        thought_id: { type: "string", description: "The id of the thought" },
        limit: {
          type: "integer",
          description: "How many related thoughts to return (1–10). Defaults to 5.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["thought_id"],
    },
  },
  {
    name: "list_recent",
    description:
      "List the most recent thoughts saved in the user's Open Brain, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many thoughts to return (1–50). Defaults to 10.",
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  {
    name: "king_order",
    description:
      "Give an order to the user's agent crew. The King breaks it into steps for workers " +
      "(Librarian searches the brain, Tutor makes study plans and quizzes from class notes, " +
      "Reviewer checks a piece of the user's writing, Writer drafts, Critic checks every claim is " +
      "cited, Fixer does safe housekeeping). The plan is sent to the user's Telegram with " +
      "Approve / Edit / Cancel: NOTHING runs until the user taps Approve there, and the result " +
      "comes back in Telegram with citations and the cost. Works only inside the brain (no " +
      "messages to anyone, no posting or buying). Pass `order` to place a new order, or " +
      "`order_id` to check an order's steps and result.",
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "string", description: "The order, in plain words" },
        order_id: { type: "string", description: "An order's id (or its first 8 characters) to check on" },
      },
    },
  },
  {
    name: "add_thought",
    description:
      "Save a new thought to the user's Open Brain. Only use this when the " +
      "user asks you to save, remember, or capture something.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text to save" },
      },
      required: ["content"],
    },
  },
];
 
// ---------------------------------------------------------------------
// 3. TOOL LOGIC — what actually happens when a tool runs
// ---------------------------------------------------------------------
type Thought = { id: string | number; content: string; created_at: string; kind?: string | null };

function sectionArg(args: Record<string, unknown>): "personal" | "library" | null {
  const v = String(args.section ?? "").toLowerCase();
  return v === "personal" || v === "library" ? v : null;
}

// "Personal · my thought" — shown on every result.
function whereLabel(kind: string | null | undefined): string {
  const section = sectionOf(kind);
  if (!section) return "Unsorted";
  return SECTION_LABEL[section] + " · " + (KIND_LABEL[kind as string] ?? kind);
}
 
// Turn database rows into readable text for the AI.
function formatThoughts(rows: Thought[], emptyMessage: string): string {
  if (!rows || rows.length === 0) return emptyMessage;
  return rows
    .map((t) => {
      let text = t.content ?? "";
      if (text.length > MAX_CHARS_PER_THOUGHT) {
        const extra = text.length - MAX_CHARS_PER_THOUGHT;
        text = text.slice(0, MAX_CHARS_PER_THOUGHT) +
          ` … [shortened — ${extra} more characters]`;
      }
      const label = t.kind !== undefined ? ` · ${whereLabel(t.kind)}` : "";
      return `[${t.created_at}] (id: ${t.id})${label}\n${text}`;
    })
    .join("\n\n---\n\n");
}
 
// search_thoughts: hybrid search (meaning + keywords), best first.
// If meaning search ever fails, it falls back to the old keyword search.
async function searchThoughts(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("Please provide a search query.");

  if (OWNER_USER_ID) {
    try {
      const vector = await embedder.run(query, { mean_pool: true, normalize: true });
      const { data, error } = await supabase.rpc("hybrid_search_v3", {
        query_embedding: JSON.stringify(Array.from(vector as number[])),
        query_text: keywordQuery(query),
        match_count: 10,
        p_user_id: OWNER_USER_ID,
        min_similarity: MIN_SIMILARITY,
        p_section: sectionArg(args),
      });
      if (error) throw error;
      return formatThoughts(data as Thought[], `No thoughts found about: ${query}`);
    } catch (e) {
      console.error("hybrid search failed, using keyword search:", e);
    }
  }

  // Old keyword search: "ilike" ignores upper/lower case.
  const words = query.split(/\s+/).filter(Boolean).slice(0, 5);
  const section = sectionArg(args);
  let request = supabase.from("thoughts").select("id, content, created_at, kind").eq("user_id", OWNER_USER_ID);
  request = section ? request.eq("section", section) : request.in("section", ["personal", "library"]);
  for (const word of words) {
    request = request.ilike("content", `%${word}%`);
  }
  const { data, error } = await request
    .order("created_at", { ascending: false })
    .limit(10);
 
  if (error) throw new Error(`Database error: ${error.message}`);
  return formatThoughts(data as Thought[], `No thoughts found containing: ${query}`);
}
 
// list_recent: the newest thoughts.
async function listRecent(args: Record<string, unknown>): Promise<string> {
  let limit = Number(args.limit ?? 10);
  if (!Number.isFinite(limit)) limit = 10;
  limit = Math.min(50, Math.max(1, Math.floor(limit)));
 
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, created_at")
    .eq("user_id", OWNER_USER_ID)
    .order("created_at", { ascending: false })
    .limit(limit);
 
  if (error) throw new Error(`Database error: ${error.message}`);
  return formatThoughts(data as Thought[], "The brain is empty — no thoughts saved yet.");
}
 
// add_thought: save a new row in the thoughts table.
async function addThought(args: Record<string, unknown>): Promise<string> {
  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("Cannot save an empty thought.");
  // Never save a thought without an owner: it would be invisible everywhere.
  if (!OWNER_USER_ID) throw new Error("Server is missing the OWNER_USER_ID secret, so nothing was saved.");
 
  const { data, error } = await supabase
    .from("thoughts")
    .insert({ content, user_id: OWNER_USER_ID, metadata: { source: "mcp" } })
    .select("id, content, created_at")
    .single();

  if (error) throw new Error(`Database error: ${error.message}`);
  return `Saved.\n\n${formatThoughts([data as Thought], "")}`;
}

// related_thoughts: read the graph — thoughts linked by similar meaning.
async function relatedThoughts(args: Record<string, unknown>): Promise<string> {
  const id = String(args.thought_id ?? "").trim();
  if (!id) throw new Error("Please provide a thought_id.");
  let limit = Number(args.limit ?? 5);
  if (!Number.isFinite(limit)) limit = 5;
  limit = Math.min(10, Math.max(1, Math.floor(limit)));

  const { data, error } = await supabase.rpc("related_thoughts", {
    p_thought_id: id,
    match_count: limit,
    p_user_id: OWNER_USER_ID || null,
  });
  if (error) throw new Error(`Database error: ${error.message}`);
  if (!data || data.length === 0) return `No linked thoughts for ${id} yet.`;
  return (data as { id: string; content_preview: string; summary: string | null; created_at: string; similarity: number }[])
    .map((t) =>
      `[${t.created_at}] (id: ${t.id}, similarity ${t.similarity.toFixed(3)})\n` +
      (t.summary ? `Summary: ${t.summary}\n` : "") + t.content_preview
    )
    .join("\n\n---\n\n");
}

// ask_brain: the same answer function the Telegram bot uses. No follow-up
// memory here — the AI app keeps its own conversation.
async function askBrainTool(args: Record<string, unknown>): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) throw new Error("Please provide a question.");
  if (!OWNER_USER_ID) throw new Error("Server is missing the OWNER_USER_ID secret.");
  const res = await askBrain({
    db: supabase,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    userId: OWNER_USER_ID,
    question,
    channel: "mcp",
    chatId: "mcp",
    useHistory: false,
    section: sectionArg(args),
  });
  return renderAnswer(res, "mcp");
}

// king_order: the same crew as /king in Telegram. Approval only in Telegram.
async function kingOrder(args: Record<string, unknown>): Promise<string> {
  const order = String(args.order ?? "").trim();
  const orderId = String(args.order_id ?? "").trim();
  if (!order && !orderId) throw new Error("Pass `order` (a new order) or `order_id` (to check one).");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/crew`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(order
      ? { action: "plan", text: order, source: "mcp" }
      : { action: "show", order: orderId, style: "mcp" }),
  });
  const body = await res.json().catch(() => ({}));
  if (order) {
    if (!body.ok) throw new Error(`The King could not plan it: ${body.error ?? `HTTP ${res.status}`}`);
    return `${body.plan_text ?? ""}\n\nOrder id: ${body.order_id}. The plan is in the user's Telegram; it runs only ` +
      `after they tap Approve there, and the result arrives in Telegram. Check it later with king_order {order_id}.`;
  }
  return String(body.text ?? body.error ?? "Order not found.");
}

// Look up which function to run for each tool name.
const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  ask_brain: askBrainTool,
  king_order: kingOrder,
  search_thoughts: searchThoughts,
  related_thoughts: relatedThoughts,
  list_recent: listRecent,
  add_thought: addThought,
};
 
// ---------------------------------------------------------------------
// 4. JSON-RPC — the message format MCP uses
// ---------------------------------------------------------------------
// Every request looks like: { jsonrpc: "2.0", id: 1, method: "...", params: {...} }
// Every answer looks like:  { jsonrpc: "2.0", id: 1, result: {...} }  or  { ..., error: {...} }
// Messages with no id are "notifications" — the sender expects no answer.
 
function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
 
function fail(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
 
// Handle one message. Returns the answer, or null when no answer is needed.
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return fail(msg?.id, -32600, "Invalid request");
  }
 
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
 
  // Notifications (like "notifications/initialized") need no reply.
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
 
  switch (method) {
    // The handshake: the AI says hello, we say what we support.
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
 
    // A simple "are you there?" check.
    case "ping":
      return ok(id, {});
 
    // The AI asks what tools exist.
    case "tools/list":
      return ok(id, { tools: TOOLS });
 
    // The AI runs a tool.
    case "tools/call": {
      const name = params?.name;
      const handler = TOOL_HANDLERS[name];
      if (!handler) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const text = await handler(params?.arguments ?? {});
        return ok(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Tool problems are reported to the AI as a readable error,
        // so it can tell you what went wrong instead of crashing.
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
 
    default:
      if (isNotification) return null;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
 
// ---------------------------------------------------------------------
// 5. THE FRONT DOOR — every request arrives here first
// ---------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // Browsers send an OPTIONS "pre-check" before the real request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
 
  // Password check. No correct password, no access — nothing else runs.
  if (!MCP_ACCESS_KEY) {
    return json({ error: "Server is missing the MCP_ACCESS_KEY secret." }, 500);
  }
  const auth = (req.headers.get("authorization") ?? "").trim();
  const headerOk = auth === `Bearer ${MCP_ACCESS_KEY.trim()}`;
  // ChatGPT can't send headers, so it passes its own password as ?key=
  const urlKey = new URL(req.url).searchParams.get("key");
  const keyOk = CHATGPT_ACCESS_KEY !== "" && urlKey === CHATGPT_ACCESS_KEY;
  // Your own scripts (the retrieval test) use the internal secret instead.
  const internal = internalSecret();
  const givenInternal = (req.headers.get(INTERNAL_HEADER) ?? "").trim();
  const internalOk = internal !== "" && givenInternal !== "" && safeEqual(givenInternal, internal);
  if (!headerOk && !keyOk && !internalOk) {
    return json({ error: "Unauthorized" }, 401);
  }
 
  // MCP messages always arrive as POST. Anything else is politely refused.
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
    });
  }
 
  // Read the message body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(fail(null, -32700, "Could not read the request (invalid JSON)."), 400);
  }
 
  // Answer one message, or a list of messages.
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(handleMessage))).filter((a) => a !== null);
    if (answers.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(answers);
  }
 
  const answer = await handleMessage(body);
  if (answer === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(answer);
});