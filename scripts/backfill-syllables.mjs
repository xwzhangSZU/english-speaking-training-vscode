#!/usr/bin/env node
// Backfill word_level_prosody.words[].syllables into existing lesson packages.
//
// The renderer has full syllable-stress rendering (media/practice.js
// splitSyllableSpec -> pw-syllabified) but it needs words[].syllables, e.g.
// "ac·COUNT·a·bil·i·ty". card-schema.ts hardRule already says this is MUST,
// yet every package shipped without it, so the syllable code path was dead.
//
// The specs come from a hand-vetted lexicon (scripts/syllable-lexicon.json),
// not a network model: deterministic, reviewable, no per-run cost, no extra
// failure mode. Every lexicon entry AND every spec actually written is
// validated MECHANICALLY against the exact rule the renderer enforces:
//   * split on "·" into >= 2 syllables
//   * the letters, lowercased, must equal the original token's letters
//     (a spec may never respell the word)
//   * EXACTLY one syllable is ALL-CAPS (the single primary stress the
//     renderer marks) — mirrors splitSyllableSpec stress detection
// The lexicon is self-checked at startup; if ANY entry is malformed the
// script prints them and refuses to touch a single file. Words with no
// lexicon entry are left unset (the renderer degrades to the whole word —
// no regression, no fabricated phonology written).
//
// Idempotent: words already carrying a valid spec are skipped.
//
// Usage:
//   node scripts/backfill-syllables.mjs [--dry-run]
//        [--dates 2026-05-01,2026-05-03] [--root reference]

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

const DRY_RUN = has("--dry-run");
const ROOT = val("--root", "reference");
const ONLY_DATES = (val("--dates", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT = join(ROOT, "prebuilt");
if (!existsSync(PREBUILT)) {
  console.error(`No prebuilt directory at ${PREBUILT}. Pass --root <materials root>.`);
  process.exit(2);
}

const CANONICAL_WORD_KEYS = ["text", "stress", "syllables", "pitch_role", "arrow", "group"];

function lettersOnly(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Mirrors media/practice.js splitSyllableSpec stress detection exactly.
function syllableStress(spec) {
  const parts = String(spec || "").split("·").filter((s) => s.length);
  let stressed = 0;
  for (const seg of parts) {
    const letters = seg.replace(/[^A-Za-z]/g, "");
    if (letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
      stressed += 1;
    }
  }
  return { parts: parts.length, stressed };
}

// Returns the validated spec, or null if it must be rejected.
function validateSpec(token, spec) {
  if (typeof spec !== "string" || !spec.includes("·")) return null;
  const s = spec.trim();
  if (lettersOnly(s) !== lettersOnly(token)) return null; // word respelled
  const { parts, stressed } = syllableStress(s);
  if (parts < 2) return null; // unusable / monosyllabic
  if (stressed !== 1) return null; // need exactly one primary-stress syllable
  return s;
}

function hasValidSpec(word) {
  return word && typeof word.syllables === "string" && validateSpec(word.text, word.syllables) !== null;
}

// Load + self-check the lexicon. Refuse to run on any malformed entry.
const LEXICON = JSON.parse(readFileSync(join(HERE, "syllable-lexicon.json"), "utf8"));
{
  const bad = [];
  for (const [key, spec] of Object.entries(LEXICON)) {
    if (key.startsWith("_")) continue;
    if (key !== key.trim() || key !== key.toLowerCase() || /[^a-z]/.test(key)) {
      bad.push(`${JSON.stringify(key)} -> key is not clean letters-only lowercase`);
      continue;
    }
    const { parts, stressed } = syllableStress(spec);
    if (lettersOnly(spec) !== key) bad.push(`${key} -> "${spec}" letters != key`);
    else if (parts < 2) bad.push(`${key} -> "${spec}" has < 2 syllables`);
    else if (stressed !== 1) bad.push(`${key} -> "${spec}" has ${stressed} ALL-CAPS syllables (need exactly 1)`);
  }
  if (bad.length) {
    console.error(`Lexicon self-check FAILED (${bad.length} bad entr${bad.length === 1 ? "y" : "ies"}); refusing to run:`);
    for (const b of bad) console.error("  " + b);
    process.exit(2);
  }
}

// Re-attach a token's leading/trailing punctuation to the base lexicon spec.
function specForToken(token) {
  const base = LEXICON[lettersOnly(token)];
  if (typeof base !== "string") return null;
  const lead = (String(token).match(/^[^A-Za-z]+/) || [""])[0];
  const trail = (String(token).match(/[^A-Za-z]+$/) || [""])[0];
  let spec = base;
  if (lead) spec = lead + spec;
  if (trail) spec = spec + trail;
  return validateSpec(token, spec);
}

function reorderWord(word) {
  const out = {};
  for (const k of CANONICAL_WORD_KEYS) if (word[k] !== undefined) out[k] = word[k];
  for (const k of Object.keys(word)) if (!(k in out)) out[k] = word[k];
  return out;
}

function listDates() {
  const all = readdirSync(PREBUILT)
    .filter((d) => existsSync(join(PREBUILT, d, "english-training.json")))
    .sort();
  return ONLY_DATES.length ? all.filter((d) => ONLY_DATES.includes(d)) : all;
}

function processPackage(date) {
  const file = join(PREBUILT, date, "english-training.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const wl = pkg.word_level_prosody;
  const words = wl && Array.isArray(wl.words) ? wl.words : [];
  const need = words.filter((w) => w && w.text && !hasValidSpec(w));
  if (!need.length) return { date, skipped: true, applied: 0, missing: [] };

  let applied = 0;
  const missing = [];
  for (const w of need) {
    const spec = specForToken(String(w.text));
    if (spec) {
      w.syllables = spec;
      applied += 1;
    } else if ((String(w.text).match(/[aeiouy]/gi) || []).length >= 2) {
      // only report words plausibly polysyllabic but absent from the lexicon
      missing.push(String(w.text));
    }
  }
  if (applied && wl) wl.words = words.map(reorderWord);
  if (applied && !DRY_RUN) writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  return { date, skipped: false, needed: need.length, applied, missing };
}

function main() {
  const dates = listDates();
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Backfilling syllables in ${dates.length} package(s) from hand-vetted lexicon (${Object.keys(LEXICON).filter((k) => !k.startsWith("_")).length} entries)`,
  );
  const results = dates.map(processPackage);
  const missingAll = new Set();
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.date}: already complete (skip)`);
    } else {
      (r.missing || []).forEach((m) => missingAll.add(lettersOnly(m)));
      console.log(`  ${r.date}: needed ${r.needed}, applied ${r.applied}, no-lexicon ${r.missing.length}`);
    }
  }
  const totApplied = results.reduce((s, r) => s + (r.applied || 0), 0);
  const touched = results.filter((r) => !r.skipped && r.applied).length;
  console.log(
    `\n${DRY_RUN ? "[DRY RUN] would apply" : "Applied"} ${totApplied} spec(s) across ${touched} package(s).`,
  );
  if (missingAll.size) {
    console.log(
      `\nPolysyllabic words with no lexicon entry (left whole — add to lexicon to cover): ${missingAll.size}`,
    );
    console.log("  " + [...missingAll].sort().join(" "));
  }
}

main();
