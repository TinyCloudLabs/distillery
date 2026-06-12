# Quarantine Log

Artifacts moved out of the live feed because they make a claim that fails a
trust-critical correctness rule. Each entry records what was wrong and why it
was pulled. Nothing here is deleted — quarantine is reversible; it only removes
the artifact from `artifacts/` so it stops shipping.

## The grounding rule (why this log exists)

distillery makes claims about REAL PEOPLE. Every claim about a person's
identity, role, title, affiliation, employer, location, or relationship MUST be
explicitly supported by the source transcript — never inferred, guessed, or
imported from outside context. `verify-quotes` proves the QUOTES are real;
`verify-attribution` proves the IDENTITY FRAMING around them is real too.

---

## Quarantined artifacts

### `a-cohort-founder-priced-every-salary-against-the-inference-it-wo`

- **Pulled by:** the incident that motivated this whole branch (pre-audit).
- **What was fabricated:** the card stated *"Odisea's Cush — a Shape Rotator
  cohort founder."* The source transcript
  (`Gemini-Transcripts/2026-03/2026-03-03-tinycloud-founders-between-tinycloud-and-cush.md`)
  contains ZERO mentions of "Shape Rotator" or "cohort." The agent inferred
  Cush's affiliation with the accelerator Hunter is in and stated it as fact.
  The QUOTES were verbatim-real (`quotes_verified=true`); the IDENTITY FRAMING
  was invented. A true quote does not make a true claim about who the speaker is.
- **Status:** quarantined at
  `.quarantine/a-cohort-founder-priced-every-salary-against-the-inference-it-wo/`.
  Untracked; left untouched by Phase 1 and this audit.

---

## Phase 2 audit — all 20 live artifacts

Ran `verify-attribution` over every live artifact under `artifacts/` (the
offending card was already quarantined), then MANUALLY VERIFIED every flagged
person-claim against its source transcript(s). The helper is deterministic and
over-flags on paraphrase and on title-case headline phrasing by design — each
flag was judged by reading the relevant source lines.

| artifact slug | flagged person-claim | truly ungrounded? | severity |
| --- | --- | --- | --- |
| `article/the-march-argument-where-tinycloud-s-founders-split-on-what-fund` | person="Founders Split", desc="Argument Where TinyCloud" [possessive] | **No** — false positive. Headline title-case "TinyCloud's Founders Split" parsed as `<Org>'s <Name>`. "Founders Split" is not a named person; no identity claim. | none |
| `insight-card/eigenlayer-s-founder-handed-the-cohort-a-clean-thesis-for-why-ti` | person="Eigen", desc="EigenLayer's founder, $10B in smart contracts behind him" [dash] | **No** — GROUNDED. Source names him "the founder of Ivilayer" (ASR misspelling of EigenLayer; "EigenLayer"/"Eigen Labs" appear 9+ times and are explicitly his company); "$10 billion in our smart contract" is his own line; he addresses the "Shape Rotators team"/"cohort." Helper missed only the literal substring "eigenlayer's" (possessive + ASR-misspelled inline mention) — a form false-positive, not a fabrication. | none |
| `insight-card/eigenlayer-s-founder-...` | person="That", desc="is the market-expansion story … TinyCloud's fundraising-tool" [relative] | **No** — false positive. "That is the market-expansion story …" is a sentence fragment; "That" is not a person. | none |
| `insight-card/pay-per-app-breaks-on-tinycloud-s-own-architecture-every-app-bil` | person="Chat", desc="was the trigger … Roman is currently building" [relative] | **No** — false positive. From "pay for TinyCloud Chat …"; "Chat" is the product, not a person. | none |
| `podcast/the-60-idle-bill-how-one-engineer-quietly-retired-tinycloud-s-cl` | person="Cloud Vendor", desc="quietly retired tinycloud" [possessive] | **No** — false positive. Headline "Retired TinyCloud's Cloud Vendor" parsed as possessive. "Cloud Vendor" is not a named person. | none |
| `podcast/the-shrinking-ask-how-tinycloud-s-bridge-walked-from-2m-to-100k-` | person="Bridge Walked From", desc="How TinyCloud" [possessive] | **No** — false positive. Headline "How TinyCloud's Bridge Walked From $2M" parsed as possessive. Not a person. | none |

The other 14 live artifacts produced no flags.

**Result: 0 additional artifacts quarantined.** No genuinely fabricated
identity/role/affiliation claim about a real person was found in the live feed.
Every flag was either a deterministic false positive (headline title-case parsed
as a possessive person-claim, or a sentence-fragment "person") or a real claim
that IS grounded in its source (the EigenLayer card — confirmed by reading the
transcript). The original incident does not recur elsewhere.
