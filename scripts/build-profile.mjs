#!/usr/bin/env node
// Builds the profile README and its dithered SVGs from profile.config.json.
// Data comes from the GitHub API. Token: GITHUB_TOKEN env, else `gh auth token`.
// No dependencies; needs Node 20+ (global fetch).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "profile");
const cfg = JSON.parse(readFileSync(join(ROOT, "profile.config.json"), "utf8"));
const TODAY = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

// ---------- GitHub API ----------
const token =
  process.env.GITHUB_TOKEN ||
  (() => {
    try { return execSync("gh auth token", { encoding: "utf8" }).trim(); } catch { return ""; }
  })();
const headers = { Accept: "application/vnd.github+json", "User-Agent": "profile-builder", ...(token && { Authorization: `Bearer ${token}` }) };

async function rest(path) {
  const r = await fetch(`https://api.github.com/${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return { body: await r.json(), link: r.headers.get("link") || "" };
}
async function restAll(path) {
  let out = [], page = 1;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const { body, link } = await rest(`${path}${sep}per_page=100&page=${page}`);
    out = out.concat(body);
    if (!link.includes('rel="next"')) return out;
    page++;
  }
}
async function graphql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const dayKey = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtMonthYear = (d) => d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

async function repoData(full) {
  const [{ body: meta }, commits] = await Promise.all([rest(`repos/${full}`), restAll(`repos/${full}/commits`)]);
  const counts = new Map();
  for (const c of commits) {
    const k = (c.commit.author?.date || c.commit.committer.date).slice(0, 10);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keys = [...counts.keys()].sort();
  const first = new Date(keys[0] + "T00:00:00Z");
  // Dormant repos (no commits in 60 days) chart only their active span.
  const lastCommit = new Date(keys[keys.length - 1] + "T00:00:00Z");
  const dormant = (TODAY - lastCommit) / 864e5 > 60;
  const end = dormant ? addDays(lastCommit, 3) : TODAY;
  const days = [];
  for (let d = first; d <= end; d = addDays(d, 1)) days.push(counts.get(dayKey(d)) || 0);
  return { meta, days, first, end, dormant, total: commits.length, peak: Math.max(...days) };
}

async function contributionData(user, since) {
  const q = `query($u:String!,$f:DateTime!,$t:DateTime!){user(login:$u){contributionsCollection(from:$f,to:$t){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
  const days = new Map();
  for (let from = new Date(since + "T00:00:00Z"); from <= TODAY; from = addDays(from, 365)) {
    const to = addDays(from, 364) > TODAY ? addDays(TODAY, 1) : addDays(from, 364);
    const d = await graphql(q, { u: user, f: from.toISOString(), t: to.toISOString() });
    for (const w of d.user.contributionsCollection.contributionCalendar.weeks)
      for (const c of w.contributionDays) days.set(c.date, c.contributionCount);
  }
  let keys = [...days.keys()].sort();
  const firstActive = keys.findIndex((k) => days.get(k) > 0);
  keys = keys.slice(Math.max(0, firstActive));
  const series = keys.map((k) => days.get(k));
  return { keys, series, total: series.reduce((a, b) => a + b, 0) };
}

// ---------- drawing ----------
const THEMES = {
  dark: { bg: "#0a0c10", panel: "#0d1117", line: "#21262d", text: "#e6edf3", muted: "#7d8590", dots: ["#262c34", "#4b535d", "#9198a1", "#e6edf3"], accent: "#3fb950" },
  light: { bg: "#ffffff", panel: "#f6f8fa", line: "#d0d7de", text: "#1f2328", muted: "#656d76", dots: ["#e6e9ed", "#bcc3cb", "#6e7781", "#1f2328"], accent: "#1a7f37" },
};
const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
const CELL = 4, DOT = 3;
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function rng(seedStr) {
  let s = parseInt(createHash("md5").update(seedStr).digest("hex").slice(0, 8), 16) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Dot grid. value(col,row) returns 0..1 intensity, {accent:true}, or {noise:v} (background, twinkles).
// Dots are grouped into vertical bands so each band can animate in with its own delay.
function ditherField(x0, y0, cols, rows, value, t, { band = 10, anim = "rise", delay = 0, step = 0.04 } = {}) {
  const nb = Math.ceil(cols / band);
  const bands = Array.from({ length: nb }, () => [[], [], [], []]), accent = [], noise = [[], [], []];
  const sq = (c, r) => `M${x0 + c * CELL} ${y0 + r * CELL}h${DOT}v${DOT}h-${DOT}z`;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let v = value(c, r);
      if (v && v.accent) { accent.push(sq(c, r)); continue; }
      if (v && v.noise !== undefined) { noise[(c * 7 + r * 13) % 3].push(sq(c, r)); continue; }
      if (!(v > 0)) continue;
      const paths = bands[Math.floor(c / band)];
      const th = (BAYER[r % 4][c % 4] + 0.5) / 16;
      if (v < th * 0.999 && v < 0.97) {
        if (v > 0.35 && v > th * 0.55) paths[0].push(sq(c, r));
        continue;
      }
      paths[v > 0.85 ? 3 : v > 0.55 ? 2 : v > 0.25 ? 1 : 0].push(sq(c, r));
    }
  const body = bands.map((paths, b) => {
    const inner = paths.map((p, i) => (p.length ? `<path fill="${t.dots[i]}" d="${p.join("")}"/>` : "")).join("");
    return inner ? `<g class="${anim}" style="animation-delay:${(delay + b * step).toFixed(2)}s">${inner}</g>` : "";
  }).join("");
  const tw = noise.map((p, i) => (p.length ? `<path class="tw" style="animation-delay:-${(i * 1.3).toFixed(1)}s;animation-duration:${(3 + i * 0.7).toFixed(1)}s" fill="${t.dots[1]}" d="${p.join("")}"/>` : "")).join("");
  return tw + body + (accent.length ? `<path class="pulse" fill="${t.accent}" d="${accent.join("")}"/>` : "");
}

// Number that counts up from 0. fmt(p) renders the text at progress p (0..1).
function counter(attrs, fmt, delay, dur = 1.1, frames = 16) {
  const dt = dur / frames, ease = (x) => 1 - Math.pow(1 - x, 3);
  const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1];
  attrs = attrs.replace(/class="[^"]*"\s*/, "");
  let out = "";
  for (let k = 0; k < frames; k++)
    out += `<text class="${cls} cf" ${attrs} style="animation-duration:${dt.toFixed(3)}s;animation-delay:${(delay + k * dt).toFixed(3)}s">${fmt(ease(k / frames))}</text>`;
  return out + `<text class="${cls} cfin" ${attrs} style="animation-duration:${(delay + dur).toFixed(3)}s">${fmt(1)}</text>`;
}

// Resample a daily series to n columns (max within bins, linear interp when stretched), then smooth.
function resample(series, n, smooth = 1.2) {
  const out = new Array(n).fill(0), len = series.length;
  for (let i = 0; i < n; i++) {
    if (len >= n) {
      const a = Math.floor((i * len) / n), b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
      for (let k = a; k < b; k++) out[i] = Math.max(out[i], series[k]);
    } else {
      const p = (i / (n - 1)) * (len - 1), a = Math.floor(p), f = p - a;
      out[i] = series[a] * (1 - f) + (series[Math.min(a + 1, len - 1)] || 0) * f;
    }
  }
  if (!smooth) return out;
  const r = Math.ceil(smooth * 2), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * smooth * smooth)));
  return out.map((_, i) => {
    let s = 0, ws = 0;
    w.forEach((wk, j) => { const idx = i + j - r; if (idx >= 0 && idx < n) { s += out[idx] * wk; ws += wk; } });
    return s / ws;
  });
}

const STYLE = (t) => `<style>
.s{font-family:${SANS}}.m{font-family:${MONO}}
.rise{animation:rise .9s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{clip-path:inset(100% 0 0 0)}to{clip-path:inset(0 0 0 0)}}
.open{animation:open 1s cubic-bezier(.2,.8,.2,1) both}
@keyframes open{from{clip-path:inset(50% 0 50% 0)}to{clip-path:inset(0 0 0 0)}}
.fade{animation:fade .6s ease-out both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.tw{animation:tw 3s ease-in-out infinite alternate}
@keyframes tw{from{opacity:1}to{opacity:.08}}
.cf{opacity:0;animation-name:show;animation-timing-function:linear}
@keyframes show{from,to{opacity:1}}
.cfin{animation-name:hide;animation-timing-function:step-end}
@keyframes hide{from,to{opacity:0}}
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.rise,.open,.fade,.tw,.pulse,.cfin{animation:none}.cf{display:none}}
</style>`;

function wrap(text, maxChars, maxLines) {
  const words = text.split(/\s+/), lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + " …"; }
  return lines;
}
const svgOpen = (w, h, t, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${STYLE(t)}`;

// ---------- header ----------
function headerSVG(t, contrib) {
  const W = 1200, H = cfg.stackGroups ? 452 : 488, cols = W / CELL, rows = 50, y0 = 16, mid = rows / 2;
  const weekly = [];
  for (let i = 0; i < contrib.series.length; i += 7) weekly.push(contrib.series.slice(i, i + 7).reduce((a, b) => a + b, 0));
  const peak = Math.max(...weekly, 1);
  const amp = resample(weekly.map((v) => (v ? 0.12 + 0.88 * (Math.log1p(v) / Math.log1p(peak)) : 0)), cols, 1.2);
  const rand = rng("header" + t.bg);
  const lastIdx = contrib.series.length - 1;
  const today = contrib.series[lastIdx] > 0;
  const field = ditherField(0, y0, cols, rows, (c, r) => {
    const d = Math.abs(r - mid + 0.5) / (rows / 2 - 2);
    const a = amp[c];
    if (Math.abs(r - mid + 0.5) < 1) return c % 2 ? 0.6 : 1;
    if (today && c >= cols - 2 && Math.abs(r - mid + 0.5) < 2.5) return { accent: true };
    if (d < a) return 0.95 - 0.75 * (d / Math.max(a, 0.01)) + (rand() - 0.5) * 0.25;
    return rand() < 0.035 * (1 - d) ? { noise: 1 } : 0;
  }, t, { band: 10, anim: "open", delay: 0, step: 0.025 });

  // year ticks
  const start = new Date(contrib.keys[0] + "T00:00:00Z"), span = contrib.keys.length;
  let ticks = "";
  for (let y = start.getUTCFullYear() + 1; y <= TODAY.getUTCFullYear(); y++) {
    const idx = (Date.UTC(y, 0, 1) - start.getTime()) / 864e5;
    const x = Math.round((idx / span) * W);
    if (x < 40 || x > W - 40) continue;
    ticks += `<text class="m" x="${x}" y="24" font-size="11" fill="${t.muted}" text-anchor="middle">${y}</text>`;
  }
  let lastActive = "";
  for (let i = lastIdx; i >= 0; i--) if (contrib.series[i] > 0) { lastActive = contrib.keys[i]; break; }
  const rightLabel = today ? "contributed today" : `last contribution ${fmtDate(new Date(lastActive + "T00:00:00Z"))}`;

  const ty = 236, statusW = cfg.status.length * 7.8 + 34;
  return svgOpen(W, H, t, `${cfg.name} (@${cfg.user}). ${cfg.headline}`) +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="6" fill="${t.bg}" stroke="${t.line}"/>` +
    field + ticks +
    counter(`class="m" x="20" y="${ty - 14}" font-size="12" fill="${t.muted}"`, (p) => `${Math.round(contrib.total * p).toLocaleString("en-US")} contributions since ${fmtMonthYear(start)}`, 0.3, 1.4) +
    `<text class="m" x="${W - 20}" y="${ty - 14}" font-size="12" fill="${t.text}" text-anchor="end">${rightLabel}</text>` +
    `<line x1="0" y1="${ty}" x2="${W}" y2="${ty}" stroke="${t.line}"/>` +
    `<text class="s" x="40" y="${ty + 84}" font-size="64" font-weight="600" letter-spacing="-1.5" fill="${t.text}">${esc(cfg.name)}</text>` +
    `<text class="m" x="42" y="${ty + 114}" font-size="14" fill="${t.muted}">@${esc(cfg.user)}</text>` +
    `<g transform="translate(${W - 40 - statusW},${ty + 40})"><rect width="${statusW}" height="28" rx="14" fill="none" stroke="${t.line}"/>` +
    `<circle class="pulse" cx="16" cy="14" r="4" fill="${t.accent}"/><text class="m" x="28" y="18.5" font-size="12" fill="${t.text}">${esc(cfg.status)}</text></g>` +
    `<text class="s" x="40" y="${ty + 160}" font-size="24" fill="${t.text}">${esc(cfg.headline)}</text>` +
    `<text class="s" x="40" y="${ty + 194}" font-size="19" fill="${t.muted}">${esc(cfg.tagline)}</text>` +
    (cfg.stackGroups ? "" : `<text class="m" x="40" y="${ty + 228}" font-size="12.5" fill="${t.muted}">${esc(cfg.stack)}</text>`) +
    `</svg>`;
}

// ---------- project card ----------
function cardSVG(t, card, d, base = 0) {
  const W = 600, H = 448, cols = W / CELL, rows = 44, y0 = 100;
  const title = card.title || d.meta.name, owner = d.meta.owner.login;
  const vals = resample(d.days, cols, d.days.length < cols ? 2.5 : 1.3);
  const vmax = Math.max(...vals, 1);
  const h = vals.map((v) => (Math.sqrt(v / vmax) * (rows - 6)));
  const rand = rng(card.repo + t.bg);
  const field = ditherField(0, y0, cols, rows, (c, r) => {
    const fromBottom = rows - 1 - r;
    if (fromBottom === 0) return c % 2 ? 0.55 : 0.95;
    const top = h[c];
    if (fromBottom <= top) {
      if (top - fromBottom < 1.6) return 1;
      return 0.4 + 0.45 * (fromBottom / Math.max(top, 1)) + (rand() - 0.5) * 0.2;
    }
    return rand() < 0.03 ? { noise: 1 } : 0;
  }, t, { band: 6, anim: "rise", delay: base, step: 0.03 });
  const desc = wrap(card.description || d.meta.description || "", 50, 3);
  const stars = d.meta.stargazers_count;
  const withYear = (x) => fmtDate(x) + (x.getUTCFullYear() !== TODAY.getUTCFullYear() ? ` ${x.getUTCFullYear()}` : "");
  const meta = `${stars ? `${stars} star${stars > 1 ? "s" : ""}, ` : ""}pushed ${withYear(new Date(d.meta.pushed_at))}`;
  const rangeLabel = `commits/day · ${withYear(d.first)} → ${d.dormant ? withYear(d.end) : "today"}`;
  return svgOpen(W, H, t, `${title}: ${card.description || ""}`) +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="${t.bg}" stroke="${t.line}"/>` +
    `<rect x="1" y="1" width="${W - 2}" height="56" fill="${t.panel}"/><line x1="0" y1="57" x2="${W}" y2="57" stroke="${t.line}"/>` +
    `<text class="m" x="20" y="36" font-size="20" font-weight="600" fill="${t.text}">${esc(title)}</text>` +
    `<text class="m" x="${W - 20}" y="35" font-size="15" fill="${t.muted}" text-anchor="end">${esc(owner)}</text>` +
    `<text class="m" x="20" y="86" font-size="14" fill="${t.muted}">${esc(rangeLabel)}</text>` +
    counter(`class="m" x="${W - 20}" y="86" font-size="14" fill="${t.muted}" text-anchor="end"`, (p) => `${Math.round(d.total * p)} total · peak ${Math.round(d.peak * p)}`, base + 0.1, 1.2) +
    field +
    `<line x1="0" y1="${y0 + rows * CELL + 8}" x2="${W}" y2="${y0 + rows * CELL + 8}" stroke="${t.line}"/>` +
    desc.map((l, i) => `<text class="s" x="20" y="${y0 + rows * CELL + 42 + i * 29}" font-size="21" fill="${t.text}">${esc(l)}</text>`).join("") +
    `<text class="m" x="20" y="${H - 18}" font-size="16" fill="${t.muted}">${esc(card.language || d.meta.language || "")}</text>` +
    `<text class="m" x="${W - 20}" y="${H - 18}" font-size="16" fill="${t.muted}" text-anchor="end">${esc(meta)}</text>` +
    `</svg>`;
}

// ---------- more repos ----------
function reposSVG(t) {
  const W = 1200, RH = 62, H = cfg.more.length * RH;
  const rows = cfg.more.map((r, i) => {
    const y = i * RH;
    return (i ? `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${t.line}"/>` : "") + `<g class="fade" style="animation-delay:${(1.5 + i * 0.12).toFixed(2)}s">` +
      `<text class="m" x="20" y="${y + 38}" font-size="18" font-weight="600" fill="${t.text}">${esc(r.name)}</text>` +
      `<text class="s" x="190" y="${y + 38}" font-size="18" fill="${t.text}">${esc(wrap(r.description, 80, 1)[0])}</text>` +
      `<text class="m" x="900" y="${y + 38}" font-size="15" fill="${t.muted}">${esc(r.language)}</text>` +
      `<text class="m" x="${W - 20}" y="${y + 38}" font-size="15" fill="${t.muted}" text-anchor="end">${esc(r.meta)}</text></g>`;
  });
  return svgOpen(W, H, t, "More projects: " + cfg.more.map((r) => r.name).join(", ")) +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="${t.bg}" stroke="${t.line}"/>${rows.join("")}</svg>`;
}

// ---------- stack ----------
async function loadIcons() {
  const slugs = [...new Set((cfg.stackGroups || []).flatMap((g) => g.items.map((i) => i[1])).filter(Boolean))];
  const icons = {};
  await Promise.all(slugs.map(async (slug) => {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`);
      if (r.ok) icons[slug] = (await r.text()).match(/ d="([^"]+)"/)?.[1];
    } catch {}
  }));
  return icons;
}
function stackSVG(t, icons) {
  const W = 1200, X0 = 180, XMAX = W - 20, CH = 40, GAP = 10, ICON = 18;
  let y = 82, body = "", n = 0;
  const rand = rng("stack" + t.bg);
  const tex = ditherField(0, 58, W / CELL, 3, (c, r) => (rand() < 0.5 - r * 0.15 - c / (W / CELL) * 0.35 ? 0.3 + rand() * 0.4 : 0), t);
  cfg.stackGroups.forEach((g, gi) => {
    if (gi) { body += `<line x1="20" y1="${y - 8}" x2="${W - 20}" y2="${y - 8}" stroke="${t.line}" stroke-dasharray="2 4"/>`; }
    body += `<text class="m" x="20" y="${y + 26}" font-size="16" fill="${t.muted}">${esc(g.label)}</text>`;
    let x = X0;
    for (const [name, slug] of g.items) {
      const d = icons[slug];
      const w = Math.round(name.length * 10.2 + 28 + (d ? ICON + 10 : 0));
      if (x + w > XMAX) { x = X0; y += CH + GAP; }
      body += `<g transform="translate(${x},${y})"><g class="fade" style="animation-delay:${(1.8 + n++ * 0.03).toFixed(2)}s"><rect x=".5" y=".5" width="${w - 1}" height="${CH - 1}" fill="${t.panel}" stroke="${t.line}"/>` +
        (d ? `<path transform="translate(14,${(CH - ICON) / 2}) scale(${ICON / 24})" fill="${t.dots[2]}" d="${d}"/>` : "") +
        `<text class="m" x="${d ? 14 + ICON + 10 : 14}" y="26" font-size="17" fill="${t.text}">${esc(name)}</text></g></g>`;
      x += w + GAP;
    }
    y += CH + 24;
  });
  const H = y - 4, count = cfg.stackGroups.reduce((a, g) => a + g.items.length, 0);
  return svgOpen(W, H, t, "Stack: " + cfg.stackGroups.map((g) => `${g.label}: ${g.items.map((i) => i[0]).join(", ")}`).join("; ")) +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="${t.bg}" stroke="${t.line}"/>` +
    `<rect x="1" y="1" width="${W - 2}" height="56" fill="${t.panel}"/><line x1="0" y1="57" x2="${W}" y2="57" stroke="${t.line}"/>` +
    `<text class="m" x="20" y="36" font-size="20" font-weight="600" fill="${t.text}">stack</text>` +
    `<text class="m" x="${W - 20}" y="35" font-size="15" fill="${t.muted}" text-anchor="end">${count} tools</text>` +
    tex + body + `</svg>`;
}

function linkSVG(t, label, delay = 0) {
  const W = Math.round(label.length * 8.6 + 56), H = 40;
  return svgOpen(W, H, t, label) + `<g class="fade" style="animation-delay:${delay.toFixed(2)}s">` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" fill="${t.bg}" stroke="${t.line}"/>` +
    `<text class="m" x="18" y="25" font-size="14" fill="${t.text}">${esc(label)}</text>` +
    `<path d="M${W - 28} ${27}l9 -9m-6 0h6v6" fill="none" stroke="${t.text}" stroke-width="1.4"/></g></svg>`;
}

// ---------- main ----------
const STATIC = process.env.STATIC === "1";
mkdirSync(OUT, { recursive: true });
const written = {};
function emit(name, svg) {
  if (STATIC) svg = svg.replace(/<style>[\s\S]*?<\/style>/, (s) => s.replace(/animation:[^;}]+/g, "animation:none").replace(".cf{opacity:0", ".cf{display:none;opacity:0"));
  writeFileSync(join(OUT, name), svg);
  written[name] = createHash("sha1").update(svg).digest("hex").slice(0, 10);
}

const [icons, contrib, ...repos] = await Promise.all([loadIcons(), contributionData(cfg.user, cfg.since), ...cfg.cards.map((c) => repoData(c.repo))]);
for (const [mode, t] of Object.entries(THEMES)) {
  emit(`header-${mode}.svg`, headerSVG(t, contrib));
  cfg.cards.forEach((c, i) => emit(`card-${i + 1}-${mode}.svg`, cardSVG(t, c, repos[i], 0.5 + i * 0.2)));
  emit(`repos-${mode}.svg`, reposSVG(t));
  if (cfg.stackGroups) emit(`stack-${mode}.svg`, stackSVG(t, icons));
  cfg.links.forEach((l, i) => emit(`link-${i + 1}-${mode}.svg`, linkSVG(t, l.label, 2.6 + i * 0.12)));
}

const pic = (base, alt, attrs) =>
  `<picture><source media="(prefers-color-scheme: light)" srcset="./profile/${base}-light.svg?v=${written[`${base}-light.svg`]}"><img src="./profile/${base}-dark.svg?v=${written[`${base}-dark.svg`]}" ${attrs} alt="${esc(alt)}"></picture>`;

const cardsMd = cfg.cards.map((c, i) => {
  const url = `https://github.com/${c.repo}`;
  return `<a href="${url}">${pic(`card-${i + 1}`, `${c.title || c.repo.split("/")[1]}: ${c.description}`, 'width="50%"')}</a>`;
});
const readme = `<!-- Generated by scripts/build-profile.mjs from profile.config.json. Edit those, not this file. -->
<p align="center">${pic("header", `${cfg.name} (@${cfg.user}). ${cfg.headline} ${cfg.tagline}`, 'width="100%"')}</p>

${cardsMd[0]}${cardsMd[1]}
${cardsMd[2]}${cardsMd[3]}

<a href="https://github.com/${cfg.user}?tab=repositories">${pic("repos", "More projects: " + cfg.more.map((r) => `${r.name} (${r.description})`).join("; "), 'width="100%"')}</a>

${cfg.stackGroups ? pic("stack", "Stack: " + cfg.stackGroups.map((g) => `${g.label}: ${g.items.map((i) => i[0]).join(", ")}`).join("; "), 'width="100%"') + "\n\n" : ""}<p align="center">${cfg.links.map((l, i) => `<a href="${l.url}">${pic(`link-${i + 1}`, l.label, 'height="40"')}</a>`).join(" ")}</p>
`;
writeFileSync(join(ROOT, "README.md"), readme);
console.log(`Wrote README.md and ${Object.keys(written).length} SVGs. Contributions: ${contrib.total}. Repos: ${repos.map((r, i) => `${cfg.cards[i].repo}=${r.total}`).join(", ")}`);
