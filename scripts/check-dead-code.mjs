#!/usr/bin/env node
// Find imports, module-level bindings and exports that nothing uses.
//
// Not a linter. It answers one question a reviewer keeps having to ask by hand:
// is any of this shipped code unreachable? A dead export in browser code is
// bytes on somebody's phone, and a dead import is usually the fossil of a
// design that changed and did not get cleaned up.
//
// Usage:  node scripts/check-dead-code.mjs           report
//         node scripts/check-dead-code.mjs --strict  exit 1 on any finding

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'docs', 'scratch']);

// Files copied verbatim from another repo, where an unused export is the point.
// scripts/guards.mjs is EnesYilmazcode/Finder's file byte for byte except one
// constant, so that the next port is a diff rather than a merge by hand.
// termListRefusal and subjectResidueRefusal are Finder's and Vacant does not
// call them; deleting them here would cost more than the two lines save.
const VERBATIM = new Set(['scripts/guards.mjs']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(p))) out.push(p);
  }
  return out;
}

// Occurrences of an identifier as a whole word, ignoring COMMENTS ONLY.
//
// Two things this deliberately does not do, both learned by getting them wrong:
//
// It does not strip template literals. `${BASE}data/...` and `${requests()}`
// are real uses, and blanking them reported seven identifiers as dead that the
// app calls on every run.
//
// It does not strip ordinary strings either. A regex cannot tokenise
// JavaScript: a quote character inside a regex literal, which this file and
// scripts/lib/hours.mjs both contain, opens a phantom string that swallows
// everything up to the next quote. That produced false positives in the very
// files doing the checking.
//
// The cost is that a name appearing inside a string counts as a use, so the
// tool under-reports. That is the right direction to be wrong in: a checker
// that cries wolf gets ignored, and then it finds nothing at all.
// Line comments go first, and the order is load-bearing. Stripping block
// comments first lets a `/*` sitting inside a `//` line open a comment that
// never closes until the next `*/` anywhere in the file. scripts/shoot.mjs
// documents its own output as `docs/media/*.webp` on line 4, which swallowed
// the next 173 lines and reported seventeen live identifiers as dead, spawn and
// createServer among them, in a script that demonstrably runs.
function countUses(src, name) {
  const code = src.replace(/^\s*\/\/.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // \b does not fire next to $, which is a legal identifier character in JS.
  const esc = name.replace(/[$]/g, '\\$');
  return (code.match(new RegExp(`(?<![\\w$])${esc}(?![\\w$])`, 'g')) ?? []).length;
}

const files = walk(ROOT);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const findings = [];

for (const [file, src] of sources) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (VERBATIM.has(rel)) continue;
  const isTest = rel.includes('/test/');

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (!name) continue;
      if (countUses(src, name) < 2) findings.push({ rel, kind: 'unused import', name });
    }
  }

  // Default and namespace imports, which the braces pattern above never sees.
  for (const m of src.matchAll(/import\s+(?:(\w+)|\*\s+as\s+(\w+))\s+from/g)) {
    const name = m[1] ?? m[2];
    if (name && countUses(src, name) < 2) findings.push({ rel, kind: 'unused import', name });
  }

  // `async` must be in the pattern. Without it 17 top-level declarations in
  // this repo were invisible, including the exported fetchWith and mapLimit,
  // while the tool still printed "no dead code" -- a stronger claim than it
  // could support.
  const DECL = /^(export\s+)?(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(DECL)) {
    const exported = Boolean(m[1]);
    const name = m[2];
    if (exported) {
      if (isTest) continue;
      // An export is dead only if nothing outside its own file mentions it.
      const usedOutside = [...sources].some(([f, s]) => f !== file && countUses(s, name) > 0);
      if (!usedOutside && countUses(src, name) < 2) {
        findings.push({ rel, kind: 'export used nowhere', name });
      }
      continue;
    }
    if (countUses(src, name) < 2) findings.push({ rel, kind: 'unused local', name });
  }
}

// A module nothing imports is how a whole file goes stale unnoticed. Entry
// points are exempt: they are run, not imported.
const allSource = [...sources.values()].join('\n');
for (const file of sources.keys()) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.includes('/test/')) continue;
  const base = rel.split('/').pop();
  const isEntry = rel.startsWith('scripts/') && !rel.startsWith('scripts/lib/');
  if (isEntry || rel === 'js/app.js') continue;
  // Every metacharacter, not just the first dot. `replace('.', ...)` with a
  // string pattern rewrites one occurrence, so `hours.vendor.js` went in as
  // `hours\.vendor.js` and the second dot stayed a wildcard.
  const literal = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`['"\`][^'"\`]*${literal}['"\`]`).test(allSource)) {
    findings.push({ rel, kind: 'module imported by nothing', name: base });
  }
}

if (!findings.length) {
  console.log(`${files.length} files, no dead code.`);
  process.exit(0);
}

const byFile = {};
for (const f of findings) (byFile[f.rel] ??= []).push(f);
for (const [rel, list] of Object.entries(byFile)) {
  console.log(rel);
  for (const f of list) console.log(`  ${f.kind}: ${f.name}`);
}
console.log(`\n${findings.length} finding(s) across ${Object.keys(byFile).length} file(s).`);
process.exit(process.argv.includes('--strict') ? 1 : 0);
