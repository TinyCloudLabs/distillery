# DESIGN_MEMORY — distillery feed

Durable design decisions. Read this before any UI work; iterate within it, don't re-explore.

## Brand tone

- **Refined / premium.** Editorial restraint, not app exuberance. Nothing buttony, nothing boxy.
- **Traces, not theme** for the Teenage Engineering / pocket-operator heritage: mono metadata, tiny pips, dot separators, letterspaced uppercase micro-labels. It seasons the editorial frame; it never becomes the frame.
- **Tasteful-psychedelic allowed only as atmosphere** — never as literal motifs, never at the cost of legibility or restraint.
- **Density: comfortable.** Generous vertical rhythm (26px card padding, 18px element gaps). Not a scanner, not a wall.
- **Dark required.** `#0d0d0e` ground; no light mode commitment.

## Typography (real tokens from VariantA.css)

| Role | Stack | Sizes in use |
|---|---|---|
| Serif display (`--serif`) | "Iowan Old Style", "New York", "Palatino", Georgia, serif | masthead 30px/600/-0.01em; headline 27px/600, lh 1.16, -0.012em; pull-quote 17.5px italic, lh 1.4; prefs human lines 16px |
| Sans body (`--sans`) | -apple-system, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif | body 15px, lh 1.6; links/toggles 13.5px/500; action labels 9.5px, +0.04em |
| Mono metadata (`--mono`) | "SF Mono", "JetBrains Mono", Menlo, monospace | kicker/section headers 9.5px, +0.13–0.14em, uppercase; cites/evidence 9.5–10px, +0.08–0.12em |

Pairing rule: serif carries meaning, mono carries metadata, sans carries everything in between.

## Color tokens (from VariantA.css)

```css
--bg:       #0d0d0e;                    /* ground */
--ink:      #ebeae6;                    /* primary text */
--ink-2:    #b4b3ad;                    /* body / secondary */
--ink-3:    #7e7d78;                    /* metadata / idle actions */
--hairline: rgba(235, 234, 230, 0.14); /* all rules and dividers */
--accent:   #ff4f3d;                    /* signal red — novelty, active states, focus. The ONLY accent. */
```

Structure comes from 1px hairlines, never from boxes, fills, or shadows. Images get a 3px radius and a hairline border; everything else is square.

## Interaction rules

- **Reactions are direct taps, no dropdown.** Six actions (more / less / save / already_knew / wrong / promote) always visible in a hairline-topped footer row.
- **Quiet, not buttony.** Actions are bare glyph+label, ink-3 at rest, ink-2 on hover, accent when active (with 1.08 glyph scale). No backgrounds, no borders, no pills.
- **`less` needs undo.** It mutates the feed; surface an immediate undo affordance.
- Transitions 180ms ease-out, color/transform only; everything collapses to ~0 under `prefers-reduced-motion`.
- Focus: 2px accent `:focus-visible` outline everywhere; hover and focus share styling on links (color + border-color to accent).
- Tap targets ≥44px (actions 54px tall; play button 46px circle; scrubber 44px hit area on a 1px track).

## Decision log

- **2026-06-11 — design lab:** A "Folio" (editorial serif / hairlines / red kicker) won over B "Immersion", C "Scanner", D "Strip", E "Atmosphere". Hunter chose A as the direction for now with further refinement expected — iterate within Folio, don't re-explore the space.
- **2026-06-11:** D's preferences-pane treatment noted as the reference for the preferences panel (structure/editing affordances), restyled into A's visual language, even though A won overall.
