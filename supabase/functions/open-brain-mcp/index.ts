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
 
import { createClient } from "jsr:@supabase/supabase-js@2";
 
// ---------------------------------------------------------------------
// 1. SETUP — read settings that Supabase provides to the function
// ---------------------------------------------------------------------
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are given to every Edge
// Function automatically. You never add them yourself.
// MCP_ACCESS_KEY is the password you created in Step 2.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");
 
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
    name: "search_thoughts",
    description:
      "Search the user's Open Brain — their personal collection of notes, " +
      "YouTube transcripts, articles, PDFs, voice notes, and Telegram " +
      "messages — for thoughts containing the given words. This is a plain " +
      "text match, not semantic search, so use one to three short keywords " +
      "(every word must appear). If nothing comes back, try simpler or " +
      "different words. Returns up to 10 matches, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "One to three keywords to look for, e.g. 'calculus' or 'study habits'",
        },
      },
      required: ["query"],
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
type Thought = { id: string | number; content: string; created_at: string };
 
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
      return `[${t.created_at}] (id: ${t.id})\n${text}`;
    })
    .join("\n\n---\n\n");
}
 
// search_thoughts: find thoughts whose content contains every word.
// "ilike" is a database search that ignores upper/lower case.
async function searchThoughts(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("Please provide a search query.");
 
  const words = query.split(/\s+/).filter(Boolean).slice(0, 5);
  let request = supabase.from("thoughts").select("id, content, created_at");
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
    .order("created_at", { ascending: false })
    .limit(limit);
 
  if (error) throw new Error(`Database error: ${error.message}`);
  return formatThoughts(data as Thought[], "The brain is empty — no thoughts saved yet.");
}
 
// add_thought: save a new row in the thoughts table.
async function addThought(args: Record<string, unknown>): Promise<string> {
  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("Cannot save an empty thought.");
 
  const { data, error } = await supabase
    .from("thoughts")
    .insert({ content })
    .select("id, content, created_at")
    .single();
 
  if (error) throw new Error(`Database error: ${error.message}`);
  return `Saved.\n\n${formatThoughts([data as Thought], "")}`;
}
 
// Look up which function to run for each tool name.
const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  search_thoughts: searchThoughts,
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
  if (auth !== `Bearer ${MCP_ACCESS_KEY.trim()}`) {
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