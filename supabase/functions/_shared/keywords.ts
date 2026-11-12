// The keyword half of hybrid search requires EVERY word of the query to
// appear (websearch_to_tsquery joins words with AND). Words that describe
// the kind of thing ("the video about…") or are filler ("actually",
// "something") appear in almost every long transcript, so they made long
// captures win on keywords alone (test #15: "the video about getting good
// at something fast"; #7: "what does an industrial engineer actually do").
//
// keywordQuery() removes those words for the KEYWORD half only. The meaning
// half (the embedding) still uses the question exactly as typed.
// Postgres' own English stop words (the, what, does, about…) are already
// ignored there, so they don't need listing here.

const FILLER = new Set([
  // what kind of thing it is
  "video", "videos", "clip", "youtube", "article", "articles", "pdf", "post",
  "note", "notes", "thought", "thoughts", "voice", "memo", "link", "page",
  // vague words
  "thing", "things", "stuff", "something", "anything", "someone", "somebody",
  "actually", "really", "basically", "kind", "sort", "type",
  // talking about saving / remembering
  "saved", "save", "remember", "said", "say", "mentioned", "wrote", "written",
]);

export function keywordQuery(query: string): string {
  const words = query.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase().replace(/[^a-z0-9-]/g, "")));
  // Quoted phrases and -exclusions are kept as typed (websearch syntax).
  return kept.join(" ");
}
