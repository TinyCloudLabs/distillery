// Preferences panel — renders PREFERENCES.md in the Folio idiom.
//
// Read view: human lines in full-ink serif (they read as the user's own
// words), [learned] bullets smaller in sans with their mono evidence line.
// Edit view: an honest raw-text editor over the file itself — PREFERENCES.md
// is the contract (skills read it directly), so the editor edits the file,
// conventions and all, and PUTs it back (10KB cap, enforced server-side too).

import { useCallback, useEffect, useState } from "react";
import { Glyph } from "./Card.tsx";

const MAX_BYTES = 10 * 1024;

interface PrefLine {
  kind: "human" | "learned";
  text: string;
  /** Evidence in trailing parens, for [learned] bullets. */
  evidence?: string;
}

interface PrefSection {
  title: string;
  lines: PrefLine[];
}

/** Strip markdown bold/italic/code markers for display. */
function plain(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

export function parsePreferences(mdText: string): PrefSection[] {
  const sections: PrefSection[] = [];
  let current: PrefSection = { title: "General", lines: [] };
  let inComment = false;
  // The file is hard-wrapped markdown: group physical lines into logical
  // blocks (bullet + its continuations, or a prose paragraph), then emit.
  let block: { kind: "human" | "learned"; parts: string[] } | null = null;

  const flush = () => {
    if (!block) return;
    const text = block.parts.join(" ");
    if (block.kind === "learned") {
      const m = /\(([^()]*)\)\s*$/.exec(text);
      current.lines.push({
        kind: "learned",
        text: plain(m ? text.slice(0, m.index).trim() : text),
        evidence: m ? m[1] : undefined,
      });
    } else {
      current.lines.push({ kind: "human", text: plain(text) });
    }
    block = null;
  };

  for (const raw of mdText.split("\n")) {
    const line = raw.trim();
    // skip HTML comments (the file uses them for inline examples)
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (!line || line.startsWith("# ")) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      if (current.lines.length) sections.push(current);
      current = { title: line.slice(3).trim(), lines: [] };
      continue;
    }
    if (line.startsWith("- [learned]")) {
      flush();
      block = { kind: "learned", parts: [line.slice("- [learned]".length).trim()] };
    } else if (line.startsWith("- ")) {
      flush();
      block = { kind: "human", parts: [line.slice(2).trim()] };
    } else if (block) {
      block.parts.push(line); // hard-wrap continuation of the open block
    } else {
      block = { kind: "human", parts: [line] };
    }
  }
  flush();
  if (current.lines.length) sections.push(current);
  return sections;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "view"; text: string; etag: string }
  | {
      kind: "editing";
      text: string;
      etag: string;
      draft: string;
      saving: boolean;
      saveError: string | null;
      /** PUT answered 409 — the file changed on disk since our GET. */
      conflict: boolean;
    };

export function PreferencesPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/preferences");
      if (!res.ok) throw new Error(`api ${res.status}`);
      const etag = res.headers.get("etag") ?? "";
      setState({ kind: "view", text: await res.text(), etag });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (state.kind !== "editing") return;
    setState({ ...state, saving: true, saveError: null });
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "If-Match": state.etag },
        body: state.draft,
      });
      if (res.status === 409) {
        // Someone (likely a distill agent) rewrote the file since we loaded
        // it. Don't clobber — surface a reload notice instead.
        setState({ ...state, saving: false, conflict: true });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `api ${res.status}`);
      }
      const etag = res.headers.get("etag") ?? state.etag;
      setState({ kind: "view", text: state.draft, etag });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) {
      setState({
        ...state,
        saving: false,
        saveError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="prefs">
        <p className="sr-only" role="status">
          Loading preferences
        </p>
        <div className="skel-card" aria-hidden="true" style={{ borderBottom: "none" }}>
          <div className="skel-bar kicker" />
          <div className="skel-bar headline" />
          <div className="skel-bar body" />
          <div className="skel-bar body2" />
          <div className="skel-bar body3" />
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="prefs">
        <div className="feed-status">
          <p className="feed-status-line">Couldn&rsquo;t load preferences.</p>
          <p className="feed-status-sub">{state.message}</p>
          <button type="button" className="quiet-link" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "editing") {
    const bytes = new TextEncoder().encode(state.draft).byteLength;
    const over = bytes > MAX_BYTES;
    return (
      <section className="prefs" aria-label="Edit preferences">
        <div className="kicker">
          <span className="kicker-type">Preferences</span>
          <span className="kicker-dot" aria-hidden="true" />
          <span>Editing PREFERENCES.md</span>
        </div>
        <div className="prefs-editor">
          <textarea
            value={state.draft}
            aria-label="PREFERENCES.md contents"
            spellCheck={false}
            onChange={(e) => setState({ ...state, draft: e.target.value })}
          />
          <div className={`prefs-editor-meta${over ? " over" : ""}`}>
            {bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
            {over && " — too large to save"}
          </div>
        </div>
        <p className="prefs-note">
          This edits the real file. Untagged lines are yours; [learned] bullets belong to the
          feed&rsquo;s agents — delete one to tell them it&rsquo;s wrong.
        </p>
        <div className="prefs-actions">
          <button
            type="button"
            className="quiet-link"
            disabled={state.saving || over || state.conflict}
            onClick={() => void save()}
          >
            {state.saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="quiet-link"
            disabled={state.saving}
            onClick={() => setState({ kind: "view", text: state.text, etag: state.etag })}
          >
            Cancel
          </button>
        </div>
        <div aria-live="polite">
          {state.conflict && (
            <div className="fb-status error">
              Preferences changed on disk — reload to get the latest, then reapply your edit.{" "}
              <button type="button" className="quiet-link" onClick={() => void load()}>
                Reload
              </button>
            </div>
          )}
          {state.saveError && <div className="fb-status error">Save failed ({state.saveError})</div>}
        </div>
      </section>
    );
  }

  // view
  const sections = parsePreferences(state.text);
  return (
    <section className="prefs" aria-label="Preferences">
      <div className="kicker">
        <span className="kicker-type">Preferences</span>
        <span className="kicker-dot" aria-hidden="true" />
        <span>What the feed has learned</span>
      </div>
      {sections.length === 0 ? (
        <div className="feed-status">
          <p className="feed-status-line">No preferences yet.</p>
          <p className="feed-status-sub">React to cards, or write some below</p>
        </div>
      ) : (
        sections.map((s) => (
          <div key={s.title} className="prefs-section">
            <h3>{s.title}</h3>
            <ul>
              {s.lines.map((l, i) => (
                <li key={i} className={l.kind}>
                  <span className="prefs-text">{l.text}</span>
                  {l.kind === "learned" && (
                    <span className="prefs-evidence">
                      [learned]{l.evidence ? ` evidence: ${l.evidence}` : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <p className="prefs-note">Plain lines are yours — the feed never edits them.</p>
      <div className="prefs-actions">
        <button
          type="button"
          className="quiet-link"
          onClick={() =>
            setState({
              kind: "editing",
              text: state.text,
              etag: state.etag,
              draft: state.text,
              saving: false,
              saveError: null,
              conflict: false,
            })
          }
        >
          Edit preferences <Glyph name="arrow" size={13} />
        </button>
      </div>
      <div aria-live="polite">{savedFlash && <div className="fb-status">✓ Saved</div>}</div>
    </section>
  );
}
