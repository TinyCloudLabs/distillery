# DESIGN_PLAN — Folio (Variant A) becomes the real feed UI

> Hunter: A chosen as direction for now, further refinement expected — iterate, don't re-explore.

## Summary

Winner of the 2026-06-11 design lab: **Variant A — "Folio"**, an editorial treatment.

- Serif display type for headlines and masthead (editorial, not app-chrome).
- **Hairline rules instead of boxes** — cards are separated by 1px rules, no card backgrounds, no borders-as-containers.
- Quiet glyph + label action footer: a 6-up hairline-topped row, glyphs with tiny labels, no buttony chrome.
- Signal-red novelty kicker (`#ff4f3d` pip + mono uppercase label) is the single accent color.
- Dark, refined / premium feel; comfortable density (generous 26px vertical rhythm).
- Pocket-operator traces as seasoning only — mono metadata, tiny pips, dot separators — never a theme.

Reference copies of the winning lab files live at `/tmp/folio-reference/` (VariantA.tsx, VariantA.css, shared.tsx, design-brief.json). Treat them as the design source of truth while implementing; the lab itself has been deleted from the repo.

## Files to change (`feed/web/src/*`)

- `feed/web/src/styles.css` — replace current styles with Folio tokens and component styles (see DESIGN_MEMORY.md for the token set). Port the `.va-*` patterns from VariantA.css, renamed to app-level classes.
- `feed/web/src/App.tsx` — restructure feed layout to the Folio card anatomy: kicker row (type · source · novelty), serif headline, optional hero image, pull-quote with red left rule, body excerpt, audio row (circular play + hairline scrubber + mono timestamps), action footer.
- `feed/web/src/main.tsx` — stays minimal (lab conditional already reverted).
- New components as needed under `feed/web/src/` (e.g. `Card.tsx`, `Actions.tsx`, `AudioRow.tsx`, `PreferencesPanel.tsx`) — extract from App.tsx rather than inventing new structure.
- `feed/web/index.html` — fonts (system serif stack is fine: Iowan Old Style / New York / Palatino / Georgia), theme-color meta, PWA manifest link.

## Six-action semantics to preserve

The action footer carries exactly six actions, as **direct taps — no dropdown, no overflow menu**:

1. `more` — more like this
2. `less` — less like this (**must offer undo** — destructive-ish signal)
3. `save` — keep for later
4. `already_knew` — novelty feedback: not new to me
5. `wrong` — factual/quality flag
6. `promote` — strongest positive signal

Visual rules: glyph + 9.5px label, default ink-3 gray, active state goes accent red with slight glyph scale (1.08). Each target ≥44px tall (the lab used 54px min-height). State must round-trip to the feed backend the same way it does today — this is a reskin of the action row, not a semantics change.

## PWA requirements

- `manifest.webmanifest`: name, short_name, `display: standalone`, `background_color`/`theme_color` = `#0d0d0e`, icons.
- Icons: 192px + 512px (plus maskable variants), Apple touch icon.
- Service worker: precache the app shell (HTML/CSS/JS); runtime cache for feed JSON and `/media/*` so the last-loaded feed works offline.
- Installable: passes Lighthouse installability check on iOS Safari + Chrome.
- Offline shell: opening the app with no network shows the shell + last cached feed (or the empty/offline state), never a browser error page.

## Preferences panel

Renders `PREFERENCES.md`:

- **Human lines**: serif, full-ink, 16px — these read as the user's own words.
- **[learned] bullets**: sans, ink-2, smaller, each with a mono evidence line beneath (`evidence: …` in 9.5px letterspaced mono).
- Sections separated by mono uppercase hairline-ruled headers.
- **Editable**: human lines can be edited/added/removed in place and persisted back to PREFERENCES.md; learned lines can be deleted (which should feed back as a signal).
- Layout treatment: collapsed preview (first few human lines) with a quiet "Edit preferences" hairline-underline toggle, expanding to the full panel. Note: Variant D's preferences-pane treatment is the richer reference for the expanded editing view — borrow its structure, restyled in Folio's language.

## Required states

- **Loading**: skeleton in Folio language — hairline-separated blocks, shimmering text bars at headline/body proportions. No spinners-in-boxes.
- **Empty**: serif one-liner ("Nothing new yet."), mono sub-caption, quiet refresh affordance.
- **Error**: same quiet treatment + retry; offline variant when the SW detects no network.

## Accessibility checklist

- [ ] All tap targets ≥44×44px (actions, play button, scrubber hit area, prefs toggle).
- [ ] `:focus-visible` on every interactive element — 2px accent outline, offset, never removed.
- [ ] Contrast: ink `#ebeae6` on `#0d0d0e` passes AAA; verify ink-3 `#7e7d78` is only used for non-essential metadata (it's ~4.5:1 — keep it ≥12px or pair with redundancy); accent red on dark passes for large/bold use only — don't set body text in accent.
- [ ] `prefers-reduced-motion: reduce` kills all transitions (lab already ships this rule — keep it).
- [ ] Semantic landmarks: feed as a list, cards as articles, actions as labelled buttons (`aria-pressed` for toggled states), audio scrubber as a real `input[type=range]` with label.
- [ ] Undo for `less` is reachable by keyboard and announced (live region).
