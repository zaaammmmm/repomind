import { splitIdentifier } from '../analyzer/analyze.js';

const STOP = new Set(('di mana yang apa siapa saja dari ke untuk dengan pada dan atau ini itu adalah akan sebuah dalam oleh bagaimana mengapa kenapa jelaskan bisa dapat sudah belum ada tidak juga ' +
  'where is are the a an of in on to who what which how why does do did explain can could should would be been being has have had it its this that these those for from with and or not as at by into about please me my show tell give work works working use used uses using').split(' '));

export interface QueryAnalysis {
  terms: string[];            // istilah huruf kecil untuk FTS (identifier asli + pecahan camelCase)
  tokens: string[];           // token bukan stopword dengan huruf asli (untuk pencocokan simbol)
  identifiers: string[];      // token yang tampak seperti identifier (camelCase, PascalCase, snake_case, backtick)
  pathHints: string[];        // token yang tampak seperti path
}

const MAX_TERMS = 24;

export function analyzeQuery(query: string): QueryAnalysis {
  const quoted = [...query.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const rest = query.replace(/`[^`]*`/g, ' ');
  const raw = [...quoted, ...rest.split(/[\s,;:!?()[\]{}"'“”]+/)]
    .map((t) => t.replace(/(\.|'s)$/g, '').replace(/^\.\//, ''))
    .filter((t) => t.length >= 2);
  const tokens: string[] = []; const identifiers: string[] = []; const pathHints: string[] = [];
  const terms = new Set<string>();
  for (const t of raw) {
    const isPath = /\//.test(t) || /\.(tsx?|jsx?)$/.test(t);
    const idLike = quoted.includes(t) || /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]/.test(t);
    if (!isPath && STOP.has(t.toLowerCase())) continue;
    if (isPath) { pathHints.push(t); for (const seg of t.split(/[/.\\-]+/)) for (const p of splitIdentifier(seg)) if (p.length >= 2 && !STOP.has(p)) terms.add(p); continue; }
    tokens.push(t);
    if (idLike) identifiers.push(t);
    const clean = t.replace(/[^A-Za-z0-9_$]/g, '');
    if (clean.length >= 2) terms.add(clean.toLowerCase());
    for (const p of splitIdentifier(clean)) if (p.length >= 2 && !STOP.has(p)) terms.add(p);
  }
  return { terms: [...terms].slice(0, MAX_TERMS), tokens, identifiers, pathHints };
}

/** Bangun ekspresi MATCH FTS5 yang aman (semua istilah dikutip; tanpa operator dari pengguna). */
export function ftsMatchExpr(terms: string[]): string | undefined {
  const safe = terms.map((t) => t.replace(/[^A-Za-z0-9_]/g, '')).filter((t) => t.length >= 2);
  return safe.length ? safe.map((t) => `"${t}"`).join(' OR ') : undefined;
}
