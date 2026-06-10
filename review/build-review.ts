// review/build-review.ts — builds review/review.html, a single self-contained
// phone-first review page for everything under artifacts/<type>/<slug>/.
//
// Run: bun review/build-review.ts

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import {
  ARTIFACT_TYPES,
  validateArtifact,
  type Artifact,
} from "../skills/_shared/lib/artifact.ts";

const ROOT = dirname(import.meta.dir); // repo root (review/..)
const ARTIFACTS_DIR = join(ROOT, "artifacts");
const OUT_PATH = join(import.meta.dir, "review.html");
const IMAGE_EMBED_CAP = 3 * 1024 * 1024; // 3MB

// ---------------------------------------------------------------- helpers

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal markdown: escapes first, then **bold**, *italic*, > blockquote, \n\n paragraphs. */
function renderBody(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");

  return md
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      if (b.split("\n").every((l) => l.startsWith(">"))) {
        const inner = b
          .split("\n")
          .map((l) => l.replace(/^>\s?/, ""))
          .join("\n");
        return `<blockquote>${inline(inner).replace(/\n/g, "<br>")}</blockquote>`;
      }
      return `<p>${inline(b).replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

interface Loaded {
  artifact: Artifact;
  dir: string;
  slug: string;
  errors?: string[];
}

interface BuildStats {
  embeddedImages: number;
  skippedImages: string[]; // notes about skipped/missing images
  bad: { path: string; errors: string[] }[];
}

// ---------------------------------------------------------------- scan

async function scan(): Promise<{ loaded: Loaded[]; stats: BuildStats }> {
  const loaded: Loaded[] = [];
  const stats: BuildStats = { embeddedImages: 0, skippedImages: [], bad: [] };

  let typeDirs: string[] = [];
  try {
    typeDirs = (await readdir(ARTIFACTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { loaded, stats }; // no artifacts dir yet — render empty page
  }

  // Known types first (in contract order), then anything unexpected.
  typeDirs.sort(
    (a, b) =>
      ((ARTIFACT_TYPES as readonly string[]).indexOf(a) + 1 || 99) -
      ((ARTIFACT_TYPES as readonly string[]).indexOf(b) + 1 || 99),
  );

  for (const type of typeDirs) {
    let slugs: string[] = [];
    try {
      slugs = (await readdir(join(ARTIFACTS_DIR, type), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const dir = join(ARTIFACTS_DIR, type, slug);
      const jsonPath = join(dir, "artifact.json");
      let raw: string;
      try {
        raw = await readFile(jsonPath, "utf8");
      } catch {
        continue; // no artifact.json (in-progress folder) — skip gracefully
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        stats.bad.push({ path: jsonPath, errors: [`invalid JSON: ${e}`] });
        continue;
      }
      const result = validateArtifact(parsed);
      if (!result.ok) {
        stats.bad.push({ path: jsonPath, errors: result.errors });
        // Still try to render it if it has the basics — reviewer wants to see it.
        const a = parsed as Artifact;
        if (a && typeof a.headline === "string") {
          loaded.push({ artifact: a, dir, slug, errors: result.errors });
        }
        continue;
      }
      loaded.push({ artifact: result.artifact, dir, slug });
    }
  }
  return { loaded, stats };
}

// ---------------------------------------------------------------- render

async function heroImg(item: Loaded, stats: BuildStats): Promise<string> {
  const name = item.artifact.hero_image;
  if (!name) return "";
  const p = join(item.dir, name);
  let size: number;
  try {
    size = (await stat(p)).size;
  } catch {
    stats.skippedImages.push(`${item.slug}/${name} (missing)`);
    return `<div class="media-note">hero image listed but not found: ${esc(name)}</div>`;
  }
  if (size > IMAGE_EMBED_CAP) {
    stats.skippedImages.push(
      `${item.slug}/${name} (${(size / 1024 / 1024).toFixed(1)}MB > 3MB cap)`,
    );
    return `<div class="media-note">hero image ${esc(name)} is ${(size / 1024 / 1024).toFixed(1)}MB — too large to embed, view in repo</div>`;
  }
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const b64 = Buffer.from(await readFile(p)).toString("base64");
  stats.embeddedImages++;
  return `<img class="hero" alt="${esc(item.artifact.headline)}" src="data:${mime};base64,${b64}">`;
}

async function podcastExtras(item: Loaded): Promise<string> {
  if (item.artifact.type !== "podcast") return "";
  let html = "";
  if (item.artifact.audio) {
    html += `<div class="media-note">audio (${esc(item.artifact.audio)}) delivered separately — not embedded</div>`;
  }
  try {
    const script = await readFile(join(item.dir, "script.md"), "utf8");
    html += `<details class="script"><summary>script.md</summary><div class="body">${renderBody(script)}</div></details>`;
  } catch {
    /* no script.md */
  }
  return html;
}

function qualityBlock(a: Artifact): string {
  const q = a.quality ?? ({} as Artifact["quality"]);
  const flag = (ok: boolean | undefined, label: string) =>
    `<span class="flag ${ok ? "pass" : "fail"}">${ok ? "✓" : "✗"} ${label}</span>`;
  const notes = q?.notes
    ? `<p class="qnotes">${esc(q.notes).replace(/ \| /g, "<br><br>")}</p>`
    : "";
  const model = a.generation_model
    ? `<p class="qnotes">model: ${esc(a.generation_model)}</p>`
    : "";
  return `<details class="quality"><summary>quality ${q?.critic_pass && q?.quotes_verified ? "✓✓" : "⚠"}</summary>
    <div class="qflags">${flag(q?.critic_pass, "critic pass")} ${flag(q?.quotes_verified, "quotes verified")}</div>
    ${notes}${model}</details>`;
}

async function renderCard(item: Loaded, stats: BuildStats): Promise<string> {
  const a = item.artifact;
  const hero = await heroImg(item, stats);
  const tags = (a.tags ?? [])
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  const sources = (a.source_transcripts ?? [])
    .map((t) => `<li>${esc(basename(t))}</li>`)
    .join("");
  const when = a.generated_at
    ? new Date(a.generated_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const validationWarn = item.errors
    ? `<div class="invalid">schema issues: ${esc(item.errors.join("; "))}</div>`
    : "";

  return `<article class="card" id="${esc(a.id ?? item.slug)}">
  ${hero}
  <div class="card-body">
    <div class="meta-row"><span class="badge badge-${esc(a.type ?? "unknown")}">${esc(a.type ?? "?")}</span><span class="when">${esc(when)}</span></div>
    ${validationWarn}
    <h2>${esc(a.headline ?? "(no headline)")}</h2>
    ${a.quote ? `<figure class="pull"><blockquote>${esc(a.quote)}</blockquote>${a.attribution ? `<figcaption>— ${esc(a.attribution)}</figcaption>` : ""}</figure>` : ""}
    ${a.body ? `<div class="body">${renderBody(a.body)}</div>` : ""}
    ${await podcastExtras(item)}
    ${tags ? `<div class="tags">${tags}</div>` : ""}
    ${sources ? `<details class="sources"><summary>sources (${a.source_transcripts.length})</summary><ul>${sources}</ul></details>` : ""}
    ${qualityBlock(a)}
  </div>
</article>`;
}

function page(cards: string, loaded: Loaded[], stats: BuildStats): string {
  const counts = new Map<string, number>();
  for (const l of loaded) {
    const t = l.artifact.type ?? "unknown";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const summary =
    [...counts.entries()]
      .map(([t, n]) => `<span class="count"><b>${n}</b> ${esc(t)}</span>`)
      .join("") || `<span class="count">no artifacts yet</span>`;
  const built = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const skipNote = stats.skippedImages.length
    ? `<div class="build-note">images not embedded: ${esc(stats.skippedImages.join(", "))}</div>`
    : "";
  const badNote = stats.bad.length
    ? `<div class="build-note">⚠ ${stats.bad.length} artifact.json file(s) with schema issues (flagged inline)</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Distillery — Artifact Review</title>
<style>
:root{
  --bg:#0d0f14;--card:#161a22;--ink:#e8e6e1;--dim:#9a978f;--line:#262b36;
  --accent:#e0a458;--quote:#1c2230;
  --c-insight:#e0a458;--c-article:#7eb8da;--c-podcast:#c792ea;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:18px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;padding:16px 0 80px}
.wrap{max-width:640px;margin:0 auto;padding:0 16px}
header.top{padding:8px 0 20px}
header.top h1{font-size:26px;letter-spacing:-.02em}
.counts{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;color:var(--dim);font-size:15px}
.count b{color:var(--ink)}
.built{color:var(--dim);font-size:13px;margin-top:4px}
.build-note{color:var(--dim);font-size:13px;margin-top:8px;border-left:3px solid var(--line);padding-left:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 0 28px}
.hero{display:block;width:100%;height:auto}
.card-body{padding:18px 18px 14px}
.meta-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.badge{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
  padding:3px 10px;border-radius:999px;border:1px solid currentColor}
.badge-insight-card{color:var(--c-insight)}
.badge-article{color:var(--c-article)}
.badge-podcast{color:var(--c-podcast)}
.when{color:var(--dim);font-size:13px}
h2{font-size:22px;line-height:1.3;letter-spacing:-.01em;margin-bottom:14px}
.pull{background:var(--quote);border-left:4px solid var(--accent);border-radius:0 10px 10px 0;
  padding:14px 16px;margin:0 0 16px}
.pull blockquote{font-size:19px;font-style:italic;line-height:1.5}
.pull figcaption{margin-top:8px;color:var(--dim);font-size:14px}
.body p{margin:0 0 14px;color:#d6d3cc}
.body blockquote{border-left:3px solid var(--line);padding-left:12px;color:var(--dim);margin:0 0 14px;font-style:italic}
.body strong{color:var(--ink)}
.media-note{color:var(--dim);font-size:14px;font-style:italic;border:1px dashed var(--line);
  border-radius:8px;padding:8px 12px;margin:0 0 14px}
.invalid{color:#e07a7a;font-size:13px;border:1px dashed #5a2c2c;border-radius:8px;padding:6px 10px;margin-bottom:10px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px}
.tag{font-size:12px;color:var(--dim);background:var(--bg);border:1px solid var(--line);
  border-radius:999px;padding:2px 10px}
details{border-top:1px solid var(--line);padding:10px 0 4px;margin-top:2px}
details summary{cursor:pointer;color:var(--dim);font-size:14px;font-weight:600;
  -webkit-tap-highlight-color:transparent;list-style:none}
details summary::before{content:"▸ "}
details[open] summary::before{content:"▾ "}
details > *:not(summary){margin-top:8px}
.sources ul{list-style:none;font-size:14px;color:var(--dim)}
.sources li{padding:2px 0;word-break:break-all}
.qflags{display:flex;gap:10px;font-size:14px}
.flag.pass{color:#7ec98a}
.flag.fail{color:#e07a7a}
.qnotes{font-size:13px;color:var(--dim);line-height:1.5}
.script .body{font-size:15px}
footer{color:var(--dim);font-size:13px;text-align:center;margin-top:30px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Distillery review</h1>
    <div class="counts">${summary}</div>
    <div class="built">built ${esc(built)}</div>
    ${skipNote}${badNote}
  </header>
  ${cards}
  <footer>distillery · ${loaded.length} artifact${loaded.length === 1 ? "" : "s"} · regenerate with <code>bun review/build-review.ts</code></footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

const { loaded, stats } = await scan();
const cards = (await Promise.all(loaded.map((l) => renderCard(l, stats)))).join("\n");
const html = page(cards, loaded, stats);
await Bun.write(OUT_PATH, html);

// Report
const counts = new Map<string, number>();
for (const l of loaded) {
  const t = l.artifact.type ?? "unknown";
  counts.set(t, (counts.get(t) ?? 0) + 1);
}
const size = (await stat(OUT_PATH)).size;
console.log(`wrote ${OUT_PATH}`);
console.log(`  size: ${(size / 1024 / 1024).toFixed(2)}MB (${size.toLocaleString()} bytes)`);
console.log(
  `  artifacts: ${loaded.length} (${[...counts.entries()].map(([t, n]) => `${n} ${t}`).join(", ") || "none"})`,
);
console.log(`  images embedded: ${stats.embeddedImages}`);
if (stats.skippedImages.length)
  console.log(`  images skipped: ${stats.skippedImages.join("; ")}`);
if (stats.bad.length)
  for (const b of stats.bad)
    console.log(`  ⚠ schema issues in ${b.path}: ${b.errors.join("; ")}`);
