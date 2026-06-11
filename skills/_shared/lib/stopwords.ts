// Shared stopword list + term regex for transcript term mining.
//
// Used by write-article's recurringTerms digest and the novelty analyzers.
// Small by design: common English glue + meeting filler + conversational
// noise (contractions, hedges, generic nouns like "data"/"stuff" that
// dominate any work conversation without saying anything). Deliberately a
// simple wordlist, deliberately modest — term mining produces HINTS for the
// agent's judgment, not analysis products; false negatives cost nothing
// because the agent reads the full transcript chunks anyway.

export const STOPWORDS = new Set([
  // Conversational filler + hedges
  "alright", "anyway", "anyways", "cool", "definitely", "exactly", "guess",
  "gotta", "honestly", "kinda", "literally", "obviously", "sorta", "totally",
  "wanna",
  // Generic nouns that recur in any meeting without carrying signal
  "data",
  // Standard contractions (4+ chars; shorter ones never match TERM_RE)
  "ain't", "aren't", "can't", "couldn't", "hadn't", "hasn't", "he'd", "he'll",
  "he's", "i'll", "i've", "it'll", "she'd", "she'll", "she's", "shouldn't",
  "that'll", "they'd", "they'll", "they've", "we'd", "weren't", "what'll",
  "who's", "wouldn't", "you'd", "you'll", "you've",
  "about", "actually", "after", "again", "agree", "agreed", "all", "also",
  "always", "and", "anything", "around", "back", "basically", "because",
  "been", "before", "being", "between", "both", "but", "can", "cannot",
  "could", "did", "didn't", "does", "doesn't", "doing", "don't", "down",
  "each", "either", "else", "even", "every", "everyone", "everything",
  "feel", "first", "for", "from", "get", "gets", "getting", "going",
  "gonna", "good", "got", "great", "had", "has", "have", "haven't", "here",
  "how", "into", "isn't", "it's", "just", "kind", "know", "let's", "like",
  "little", "look", "looking", "lot", "make", "makes", "making", "maybe",
  "mean", "means", "more", "most", "much", "need", "needs", "never", "next",
  "not", "nothing", "now", "off", "okay", "once", "one", "only", "other",
  "our", "out", "over", "people", "probably", "put", "really", "right",
  "said", "same", "say", "saying", "see", "should", "since", "some",
  "something", "sort", "still", "stuff", "sure", "take", "talk", "talked",
  "talking", "than", "that", "that's", "the", "their", "them", "then",
  "there", "there's", "these", "they", "they're", "thing", "things",
  "think", "this", "those", "though", "thought", "through", "time", "today",
  "too", "try", "trying", "use", "using", "very", "want", "wanted", "was",
  "wasn't", "way", "we'll", "we're", "we've", "well", "went", "were",
  "what", "what's", "when", "where", "which", "while", "who", "why", "will",
  "with", "won't", "work", "working", "would", "yeah", "yes", "you",
  "you're", "your",
]);

/** Lowercase word of 4+ chars (apostrophes/hyphens allowed inside). */
export const TERM_RE = /[a-z][a-z'-]{3,}/g;

/** True when the lowercased word carries no signal for term mining. */
export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}
