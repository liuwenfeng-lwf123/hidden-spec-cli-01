// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, the four patch formats (unified diff, SEARCH/REPLACE, V4A, JSON
// edits), matching lines at three tiers, and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** Per-run context shared by the edits: strict matching, and the moves that succeeded. */
interface Ctx {
  strict: boolean;
  moves: [string, string][];
}

type Edit = (tree: Tree, ctx: Ctx) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3) and matching lines (section 5)  */
/* ------------------------------------------------------------------ */

interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinParts(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** A line as a tier sees it: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** All 0-based positions where O occurs in the file's lines at one tier. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  const want = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(fileLines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`, and for an end-of-file
 *  chunk only occurrences that end at the file's last line. */
function findTierFrom(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, o, t).filter((p) => p >= from && (!eof || p + o.length === fileLines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first
 *  tier where one is; -1 when there is none. */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = norm(anchor, t);
    for (let i = from; i < fileLines.length; i++) {
      if (norm(fileLines[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** One line of N: `text`, and for a context line the index of its line in O. */
interface NewLine {
  text: string;
  ctx: number | null;
  body: number;
}

/** The lines N writes in place of the matched lines: context lines are the file's
 *  own matched lines; at tier 2 every other line is re-indented from O's first
 *  line's leading whitespace to the file's first matched line's. */
function buildNew(fileLines: string[], pos: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const f = oldLines.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  return newLines.map((nl) => {
    if (nl.ctx !== null) return fileLines[pos + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  lastNewNoEol: boolean;
  lastPlusNoEol: boolean | null;
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string | null;
  renNew?: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first
 *  tab, surrounding spaces removed; `/dev/null` is null; a leading a/ or b/ is out. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** `diff --git a/<X> b/<Y>` as [X, Y], or null when the line is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length).trimEnd();
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?=$|\s)/;

/** A hunk at lines[i]: its header must match, its body runs to the next line that
 *  is not a body line. Returns the hunk and the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  let j = i + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  const bsAfter = new Set<number>();
  let lastPlus: number | null = null;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('\\')) {
      if (k > 0) bsAfter.add(k - 1);
      continue;
    }
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      oldLines.push(t);
      newLines.push({ text: t, ctx: oldLines.length - 1, body: k });
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newLines.push({ text: l.slice(1), ctx: null, body: k });
      lastPlus = k;
    } else {
      oldLines.push('');
      newLines.push({ text: '', ctx: oldLines.length - 1, body: k });
    }
  }
  return {
    hunk: {
      a,
      oldLines,
      newLines,
      lastNewNoEol: newLines.length > 0 && bsAfter.has(newLines[newLines.length - 1]!.body),
      lastPlusNoEol: lastPlus === null ? null : bsAfter.has(lastPlus),
    },
    next: j,
  };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHunks = false;
  const start = (): UniSection => {
    const s: UniSection = { gitOld: null, gitNew: null, creation: false, deletion: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHunks = false;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = start();
      s.gitOld = g[0];
      s.gitNew = g[1];
      i += 1;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = start();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        inHunks = true;
        i = r.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.pairNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = start();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** The section's old path: the ---/+++ pair names it, else rename, else diff --git. */
function uniOld(s: UniSection): string | null {
  if (s.pairOld !== undefined) return s.pairOld;
  if (s.renOld !== undefined) return s.renOld;
  return s.gitOld;
}

function uniNew(s: UniSection): string | null {
  if (s.pairNew !== undefined) return s.pairNew;
  if (s.renNew !== undefined) return s.renNew;
  return s.gitNew;
}

/** A section's hunks applied in order to a file's text. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, ends } = fileParts(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length > 0) {
      const found = findTier(lines, h.oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildNew(lines, best, h.oldLines, h.newLines, found.tier);
      const runsToEnd = best + h.oldLines.length === lines.length;
      const newEnds = runsToEnd ? !h.lastNewNoEol : ends;
      lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + h.oldLines.length)];
      ends = newEnds;
      d += h.newLines.length - h.oldLines.length;
    } else {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const repl = h.newLines.map((nl) => nl.text);
      const newEnds = pos === lines.length ? !h.lastNewNoEol : ends;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
      ends = newEnds;
      d += h.newLines.length;
    }
  }
  return joinParts(lines, br, ends);
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => (tree: Tree) => {
    const oldP = uniOld(sec);
    const newP = uniNew(sec);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if ((sec.pairOld === null || sec.creation) && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol: boolean | null = null;
      for (const h of sec.hunks) {
        for (const nl of h.newLines) if (nl.ctx === null) plus.push(nl.text);
        if (h.lastPlusNoEol !== null) noEol = h.lastPlusNoEol;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol === true ? '' : '\n'));
      return;
    }
    if ((sec.pairNew === null || sec.deletion) && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(before, sec.hunks, ctx.strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      ctx.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, sec.hunks, ctx.strict, p));
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end;
  }
  return blocks;
}

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  const blocks = parseSR(lines);
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const { lines: fl, br, ends } = fileParts(before);
    const found = findTier(fl, b.oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const repl = buildNew(fl, pos, b.oldLines, b.newLines.map((t, k) => ({ text: t, ctx: null, body: k })), found.tier);
    tree.now.set(b.path, joinParts([...fl.slice(0, pos), ...repl, ...fl.slice(pos + b.oldLines.length)], br, ends));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** An Update File section's raw lines (blank lines at its end already dropped):
 *  an optional Move to first, then chunks. */
function parseVUpdate(raw: string[], base0: number, path: string, updateLineNo: number): VSection {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let idx = 0;
  const lineNo = (k: number): number => base0 + k + 1;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  for (let k = idx; k < raw.length; k++) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldLines: [], newLines: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo(k)}`);
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, oldLines: [], newLines: [] };
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      if (l.startsWith(' ')) {
        const t = l.slice(1);
        cur.oldLines.push(t);
        cur.newLines.push({ text: t, ctx: cur.oldLines.length - 1, body: k });
      } else if (l.startsWith('-')) {
        cur.oldLines.push(l.slice(1));
      } else if (l.startsWith('+')) {
        cur.newLines.push({ text: l.slice(1), ctx: null, body: k });
      } else {
        cur.oldLines.push('');
        cur.newLines.push({ text: '', ctx: cur.oldLines.length - 1, body: k });
      }
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(k)}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return { kind: 'update', path, moveTo, lines: [], chunks };
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, lines: fileLines, chunks: [] });
      i = j;
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
      i = j;
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const updateLineNo = i + 1;
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      sections.push(parseVUpdate(raw, i + 1, path, updateLineNo));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let { lines: fl, br, ends } = fileParts(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(fl, ch.anchor, cursor, ctx.strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      if (ch.oldLines.length > 0) {
        const found = findTierFrom(fl, ch.oldLines, cursor, ctx.strict, ch.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const repl = buildNew(fl, found.pos, ch.oldLines, ch.newLines, found.tier);
        fl = [...fl.slice(0, found.pos), ...repl, ...fl.slice(found.pos + ch.oldLines.length)];
        cursor = found.pos + repl.length;
      } else {
        const pos = ch.eof ? fl.length : cursor;
        const repl = ch.newLines.map((nl) => nl.text);
        fl = [...fl.slice(0, pos), ...repl, ...fl.slice(pos)];
        cursor = pos + repl.length;
      }
    }
    const out = joinParts(fl, br, ends);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      ctx.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, ctx)
          : kind === 'search-replace'
            ? srEdits(lines, ctx)
            : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const seenR = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      const k = `${oldP}\0${newP}`;
      if (seenR.has(k)) continue;
      seenR.add(k);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const moved = new Set<string>();
  for (const e of entries) {
    const m = /^R (.+) -> (.+)$/.exec(e.line);
    if (m !== null) {
      moved.add(m[1]!);
      moved.add(m[2]!);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
