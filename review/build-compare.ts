// review/build-compare.ts — builds review/compare.html, a single self-contained
// phone-first page comparing two generations of artifacts:
//   v1 = artifacts/        (baseline pipeline)
//   v2 = artifacts-v2/     (novelty-mechanisms + adversarial critic)
//
// Layout: grouped by artifact type; within each type, v2 artifacts then v1
// artifacts, each card wearing a loud generation badge. If v2 produced nothing
// for a type, an honest empty-state card says so — that is signal, not absence.
//
// Run: bun review/build-compare.ts

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  ARTIFACT_TYPES,
  validateArtifact,
  type Artifact,
} from "../skills/_shared/lib/artifact.ts";

const ROOT = dirname(import.meta.dir); // repo root (review/..)
const OUT_PATH = join(import.meta.dir, "compare.html");
const IMAGE_EMBED_CAP = 3 * 1024 * 1024; // 3MB
const AUDIO_EMBED_CAP = 15 * 1024 * 1024; // 15MB post-compression

interface Generation {
  label: "v1" | "v2";
  dir: string;
  title: string;
}

const GENERATIONS: Generation[] = [
  { label: "v2", dir: join(ROOT, "artifacts-v2"), title: "novelty-mechanisms + adversarial critic" },
  { label: "v1", dir: join(ROOT, "artifacts"), title: "baseline pipeline" },
];

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
  type: string;
  gen: "v1" | "v2";
  errors?: string[];
}

interface BuildStats {
  embeddedImages: number;
  skippedImages: string[];
  bad: { path: string; errors: string[] }[];
}

// ---------------------------------------------------------------- scan

async function scanGeneration(
  gen: Generation,
  stats: BuildStats,
): Promise<Loaded[]> {
  const loaded: Loaded[] = [];

  let typeDirs: string[] = [];
  try {
    typeDirs = (await readdir(gen.dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return loaded; // generation dir missing — render as empty
  }

  for (const type of typeDirs) {
    let slugs: string[] = [];
    try {
      slugs = (await readdir(join(gen.dir, type), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const dir = join(gen.dir, type, slug);
      const jsonPath = join(dir, "artifact.json");
      let raw: string;
      try {
        raw = await readFile(jsonPath, "utf8");
      } catch {
        continue; // no artifact.json (in-progress folder)
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
        const a = parsed as Artifact;
        if (a && typeof a.headline === "string") {
          loaded.push({ artifact: a, dir, slug, type, gen: gen.label, errors: result.errors });
        }
        continue;
      }
      loaded.push({ artifact: result.artifact, dir, slug, type, gen: gen.label });
    }
  }
  return loaded;
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
    stats.skippedImages.push(`${item.gen}/${item.slug}/${name} (missing)`);
    return `<div class="media-note">hero image listed but not found: ${esc(name)}</div>`;
  }
  if (size > IMAGE_EMBED_CAP) {
    stats.skippedImages.push(
      `${item.gen}/${item.slug}/${name} (${(size / 1024 / 1024).toFixed(1)}MB > 3MB cap)`,
    );
    return `<div class="media-note">hero image ${esc(name)} is ${(size / 1024 / 1024).toFixed(1)}MB — too large to embed, view in repo</div>`;
  }
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const b64 = Buffer.from(await readFile(p)).toString("base64");
  stats.embeddedImages++;
  return `<img class="hero" alt="${esc(item.artifact.headline)}" src="data:${mime};base64,${b64}">`;
}

/** Embed artifact audio. m4a/mp3 embed as-is (audio/mp4, audio/mpeg);
 * legacy WAV gets a one-off AAC transcode via afconvert so the page stays small. */
async function audioEmbed(item: Loaded): Promise<string> {
  const name = item.artifact.audio;
  if (!name) return "";
  const p = join(item.dir, name);
  try {
    await stat(p);
  } catch {
    return `<div class="media-note">audio listed but not found: ${esc(name)}</div>`;
  }
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  let bytes: Buffer;
  let mime: string;
  if (ext === ".wav") {
    try {
      const tmp = join(tmpdir(), `distillery-cmp-${item.gen}-${item.slug}.m4a`);
      execFileSync("afconvert", ["-f", "m4af", "-d", "aac", p, tmp]);
      bytes = Buffer.from(await readFile(tmp));
      mime = "audio/mp4";
    } catch {
      bytes = Buffer.from(await readFile(p)); // no afconvert — embed raw WAV
      mime = "audio/wav";
    }
  } else {
    bytes = Buffer.from(await readFile(p));
    mime = ext === ".m4a" ? "audio/mp4" : ext === ".mp3" ? "audio/mpeg" : "application/octet-stream";
  }
  if (bytes.length > AUDIO_EMBED_CAP) {
    return `<div class="media-note">audio ${esc(name)} is ${(bytes.length / 1024 / 1024).toFixed(1)}MB — too large to embed</div>`;
  }
  return `<audio class="player" controls preload="metadata" src="data:${mime};base64,${bytes.toString("base64")}"></audio>`;
}

async function podcastExtras(item: Loaded): Promise<string> {
  if (item.artifact.type !== "podcast") return "";
  let html = await audioEmbed(item);
  try {
    const script = await readFile(join(item.dir, "script.md"), "utf8");
    html += `<details class="script"><summary>script.md</summary><div class="body">${renderBody(script)}</div></details>`;
  } catch {
    /* no script.md */
  }
  return html;
}

/** Pull the "[novelty] lead=<kind>: ..." lead out of quality.notes. */
function noveltyLead(a: Artifact): { kind: string; text: string } | null {
  const notes = a.quality?.notes ?? "";
  const m = notes.match(/\[novelty\]\s*lead=([a-z0-9_-]+):\s*([\s\S]*?)(?=\s*\|\s|$)/i);
  if (!m) return null;
  return { kind: m[1], text: m[2].trim() };
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
  const lead = item.gen === "v2" ? noveltyLead(a) : null;
  const leadStrip = lead
    ? `<div class="lead-strip"><span class="lead-kind">novelty lead · ${esc(lead.kind)}</span></div>`
    : "";

  return `<article class="card gen-${item.gen}" id="${esc(item.gen)}-${esc(a.id ?? item.slug)}">
  <div class="gen-banner gen-banner-${item.gen}">${item.gen.toUpperCase()}</div>
  ${hero}
  <div class="card-body">
    <div class="meta-row"><span class="badge badge-${esc(a.type ?? "unknown")}">${esc(a.type ?? "?")}</span><span class="when">${esc(when)}</span></div>
    ${validationWarn}
    ${leadStrip}
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

function emptyStateCard(type: string): string {
  return `<article class="card gen-v2 empty-card">
  <div class="gen-banner gen-banner-v2">V2</div>
  <div class="card-body">
    <div class="meta-row"><span class="badge badge-${esc(type)}">${esc(type)}</span></div>
    <h2 class="empty-h">v2 adversarial critic produced nothing for this type</h2>
    <p class="empty-note">Zero artifacts survived. That is signal, not absence — the critic rejected every candidate lead for this type.</p>
  </div>
</article>`;
}

// ---------------------------------------------------------------- page

function comparisonHeader(v1: Loaded[], v2: Loaded[]): string {
  const countLine = (items: Loaded[]) => {
    const counts = new Map<string, number>();
    for (const l of items) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    return (
      [...counts.entries()]
        .sort(
          (a, b) =>
            ((ARTIFACT_TYPES as readonly string[]).indexOf(a[0]) + 1 || 99) -
            ((ARTIFACT_TYPES as readonly string[]).indexOf(b[0]) + 1 || 99),
        )
        .map(([t, n]) => `<span class="count"><b>${n}</b> ${esc(t)}</span>`)
        .join("") || `<span class="count">no artifacts</span>`
    );
  };

  const leadRows = v2
    .map((l) => {
      const lead = noveltyLead(l.artifact);
      const kind = lead ? lead.kind : "(no [novelty] lead in quality.notes)";
      return `<li><span class="lead-kind">${esc(kind)}</span> <span class="lead-headline">${esc(l.artifact.headline ?? l.slug)}</span></li>`;
    })
    .join("\n");

  return `<section class="compare-head">
  <div class="gen-row">
    <div class="gen-summary gen-summary-v2">
      <div class="gen-tag gen-banner-v2">V2</div>
      <div class="gen-total"><b>${v2.length}</b> artifact${v2.length === 1 ? "" : "s"}</div>
      <div class="counts">${countLine(v2)}</div>
      <div class="gen-sub">novelty-mechanisms + adversarial critic</div>
    </div>
    <div class="gen-summary gen-summary-v1">
      <div class="gen-tag gen-banner-v1">V1</div>
      <div class="gen-total"><b>${v1.length}</b> artifact${v1.length === 1 ? "" : "s"}</div>
      <div class="counts">${countLine(v1)}</div>
      <div class="gen-sub">baseline pipeline</div>
    </div>
  </div>
  ${v2.length ? `<div class="leads"><h3>v2 novelty leads</h3><ul>${leadRows}</ul></div>` : ""}
</section>`;
}

function page(
  header: string,
  sections: string,
  total: number,
  stats: BuildStats,
): string {
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
<title>Distillery — v1 vs v2 Compare</title>
<style>
:root{
  --bg:#0d0f14;--card:#161a22;--ink:#e8e6e1;--dim:#9a978f;--line:#262b36;
  --accent:#e0a458;--quote:#1c2230;
  --c-insight:#e0a458;--c-article:#7eb8da;--c-podcast:#c792ea;
  --v1:#7a8699;--v2:#5ad0a0;
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

/* comparison header */
.compare-head{margin:0 0 30px}
.gen-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.gen-summary{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.gen-summary-v2{border-color:var(--v2)}
.gen-summary-v1{border-color:var(--line)}
.gen-tag{display:inline-block;font-size:13px;font-weight:800;letter-spacing:.12em;
  padding:3px 12px;border-radius:6px;margin-bottom:8px}
.gen-total{font-size:17px}
.gen-total b{font-size:24px}
.gen-sub{color:var(--dim);font-size:12px;margin-top:8px;line-height:1.4}
.leads{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:12px}
.leads h3{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--v2);margin-bottom:10px}
.leads ul{list-style:none}
.leads li{padding:7px 0;border-top:1px solid var(--line);font-size:14px;line-height:1.45}
.leads li:first-child{border-top:0;padding-top:0}
.lead-kind{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
  color:#0d0f14;background:var(--v2);border-radius:4px;padding:1px 8px;margin-right:8px;vertical-align:1px}
.lead-headline{color:var(--ink)}
.lead-strip{margin:0 0 10px}

/* type sections */
.type-head{display:flex;align-items:baseline;gap:10px;margin:34px 0 14px;border-bottom:2px solid var(--line);padding-bottom:8px}
.type-head h2{font-size:20px;text-transform:uppercase;letter-spacing:.06em}
.type-head .vs{color:var(--dim);font-size:14px}

/* cards */
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 0 28px;position:relative}
.card.gen-v2{border-color:var(--v2)}
.card.gen-v1{border-color:#3a4254}
.gen-banner{font-size:14px;font-weight:800;letter-spacing:.18em;text-align:center;padding:7px 0}
.gen-banner-v2{background:var(--v2);color:#0d0f14}
.gen-banner-v1{background:var(--v1);color:#0d0f14}
.empty-card{border-style:dashed}
.empty-h{color:var(--dim);font-style:italic}
.empty-note{color:var(--dim);font-size:14px}
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
.player{display:block;width:100%;margin:0 0 14px}
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
@media (max-width:420px){.gen-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Distillery — v1 vs v2</h1>
    <div class="built">built ${esc(built)}</div>
    ${skipNote}${badNote}
  </header>
  ${header}
  ${sections}
  <footer>distillery · ${total} artifact${total === 1 ? "" : "s"} across both generations · regenerate with <code>bun review/build-compare.ts</code></footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

const stats: BuildStats = { embeddedImages: 0, skippedImages: [], bad: [] };
const [v2, v1] = await Promise.all([
  scanGeneration(GENERATIONS[0], stats),
  scanGeneration(GENERATIONS[1], stats),
]);

// Union of types across both generations, in contract order.
const types = [...new Set([...v2.map((l) => l.type), ...v1.map((l) => l.type)])].sort(
  (a, b) =>
    ((ARTIFACT_TYPES as readonly string[]).indexOf(a) + 1 || 99) -
    ((ARTIFACT_TYPES as readonly string[]).indexOf(b) + 1 || 99),
);

const sectionHtml: string[] = [];
for (const type of types) {
  const v2OfType = v2.filter((l) => l.type === type);
  const v1OfType = v1.filter((l) => l.type === type);
  const cards: string[] = [];
  if (v2OfType.length === 0) {
    cards.push(emptyStateCard(type));
  } else {
    for (const item of v2OfType) cards.push(await renderCard(item, stats));
  }
  for (const item of v1OfType) cards.push(await renderCard(item, stats));
  sectionHtml.push(`<section class="type-section">
  <div class="type-head"><h2>${esc(type)}</h2><span class="vs">v2: ${v2OfType.length} · v1: ${v1OfType.length}</span></div>
  ${cards.join("\n")}
</section>`);
}

const total = v1.length + v2.length;
const html = page(comparisonHeader(v1, v2), sectionHtml.join("\n"), total, stats);
await Bun.write(OUT_PATH, html);

// Report
const size = (await stat(OUT_PATH)).size;
console.log(`wrote ${OUT_PATH}`);
console.log(`  size: ${(size / 1024 / 1024).toFixed(2)}MB (${size.toLocaleString()} bytes)`);
for (const [label, items] of [["v2", v2], ["v1", v1]] as const) {
  const counts = new Map<string, number>();
  for (const l of items) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
  console.log(
    `  ${label}: ${items.length} (${[...counts.entries()].map(([t, n]) => `${n} ${t}`).join(", ") || "none"})`,
  );
}
console.log(`  images embedded: ${stats.embeddedImages}`);
if (stats.skippedImages.length)
  console.log(`  images skipped: ${stats.skippedImages.join("; ")}`);
if (stats.bad.length)
  for (const b of stats.bad)
    console.log(`  ⚠ schema issues in ${b.path}: ${b.errors.join("; ")}`);
