// _shared/kinds.ts — what sort of thing a thought is, and which section it's in.
//
// Sections are DERIVED from kind and never stored by hand. The database
// function public.section_of() is the source of truth (it fills the
// computed thoughts.section column). SECTION_OF below must match it.

export const KINDS = ["my_thought", "source", "course_setup", "project_doc", "class_note", "report"];

export type Section = "personal" | "library" | "hidden";

export const SECTION_OF: Record<string, Section> = {
  my_thought: "personal",
  class_note: "personal",
  report: "personal",
  source: "library",
  project_doc: "library",
  course_setup: "hidden",
};

// The kind a one-tap "move to" button picks in each section.
export const DEFAULT_KIND: Record<"personal" | "library", string> = {
  personal: "my_thought",
  library: "source",
};

// Kinds the owner can pick by hand (course_setup stays out of the menus).
export const PICKABLE: Record<"personal" | "library", string[]> = {
  personal: ["my_thought", "class_note", "report"],
  library: ["source", "project_doc"],
};

export const KIND_LABEL: Record<string, string> = {
  my_thought: "my thought",
  class_note: "class note",
  report: "AI write-up",
  source: "saved source",
  project_doc: "project doc",
  course_setup: "course setup",
};

export const SECTION_LABEL: Record<Section, string> = {
  personal: "Personal",
  library: "Library",
  hidden: "Hidden",
};

export function sectionOf(kind: string | null | undefined): Section | null {
  return kind ? SECTION_OF[kind] ?? null : null;
}

export type KindInput = {
  content?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown> | null;
};

// Free, instant rules. Returns null when the rules can't tell.
export function kindByRules(t: KindInput): string | null {
  const content = (t.content ?? "").trim();
  const source = typeof t.metadata?.source === "string" ? t.metadata.source : "";

  if (t.metadata?.takeaway_of) return "my_thought";                // a takeaway
  if (t.category === "digest" || /^Weekly digest:/i.test(content)) return "report";
  if (/^(Level \d+ on how I made this brain|The overview for this brain)/i.test(content)) return "course_setup";
  if (source === "url" || source === "youtube") return "source";
  if (/^(\u{1F4F9} YouTube:|\u{1F517} URL:)/u.test(content)) return "source";
  if (/^https?:\/\/\S+$/.test(content)) return "source";          // a bare link
  if (/^\u{1F3A4} Voice:/u.test(content)) return "my_thought";    // the owner speaking
  if (/^\u{1F4A1} Takeaway/u.test(content)) return "my_thought";
  if (source === "telegram") return "my_thought";
  if (content.length <= 600 && !/^\u{1F4C4} PDF:/u.test(content)) return "my_thought";
  return null; // PDFs and long unlabelled writing: ask the AI
}
