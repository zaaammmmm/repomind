import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { PosixPath } from '../contracts.js';

export interface ScanOptions {
  exclude: string[];              // sintaks .gitignore
  respectGitignore: boolean;
  maxFileSizeKb: number;
  includeDeclarationFiles: boolean;
}
export const DEFAULT_EXCLUDE = ['node_modules/', 'dist/', '.next/', 'build/', '*.env', '*.pem', '**/secrets/**'];
export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  exclude: DEFAULT_EXCLUDE, respectGitignore: true, maxFileSizeKb: 1024, includeDeclarationFiles: false,
};

export interface ScannedFile { path: PosixPath; sizeBytes: number; mtimeMs: number }
export interface ScanResult {
  files: ScannedFile[];                 // terurut menurut path
  tsconfigs: PosixPath[];               // tsconfig.json / jsconfig.json yang tidak terkecualikan
  skipped: { ignored: number; tooLarge: number; generated: number; declaration: number; binary: number };
}

const GENERATED_MARKERS = /@generated|do not edit|auto-?generated/i;

/** FR-SCN-01..05. Murni Node (tanpa vscode) agar dapat dipakai worker dan CLI evaluasi. Tidak mengikuti symlink. */
export function scanWorkspace(root: string, options: Partial<ScanOptions> = {}): ScanResult {
  const opt = { ...DEFAULT_SCAN_OPTIONS, ...options };
  const rootIg = ignore().add(opt.exclude);
  const scopes: { base: string; ig: Ignore }[] = [];
  const result: ScanResult = { files: [], tsconfigs: [], skipped: { ignored: 0, tooLarge: 0, generated: 0, declaration: 0, binary: 0 } };

  const isIgnored = (rel: string, isDir: boolean): boolean => {
    const probe = isDir ? rel + '/' : rel;
    if (rootIg.ignores(probe)) return true;
    for (const s of scopes) {
      if (rel === s.base || !rel.startsWith(s.base === '' ? '' : s.base + '/')) continue;
      const inner = s.base === '' ? rel : rel.slice(s.base.length + 1);
      if (s.ig.ignores(isDir ? inner + '/' : inner)) return true;
    }
    return false;
  };

  const head = (abs: string): Buffer => {
    const fd = fs.openSync(abs, 'r');
    try { const b = Buffer.alloc(512); const n = fs.readSync(fd, b, 0, 512, 0); return b.subarray(0, n); } finally { fs.closeSync(fd); }
  };

  const walk = (relDir: string): void => {
    const absDir = path.join(root, relDir);
    let pushed = false;
    if (opt.respectGitignore) {
      const gi = path.join(absDir, '.gitignore');
      if (fs.existsSync(gi)) { scopes.push({ base: relDir, ig: ignore().add(fs.readFileSync(gi, 'utf8')) }); pushed = true; }
    }
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === '.git') continue;
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (isIgnored(rel, true)) { result.skipped.ignored++; continue; }
        walk(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (isIgnored(rel, false)) { result.skipped.ignored++; continue; }
      if (e.name === 'tsconfig.json' || e.name === 'jsconfig.json') { result.tsconfigs.push(rel); continue; }
      const isDts = e.name.endsWith('.d.ts');
      if (!(e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) continue;
      if (isDts && !opt.includeDeclarationFiles) { result.skipped.declaration++; continue; }
      if (/\.min\.(ts|tsx)$/.test(e.name)) { result.skipped.generated++; continue; }
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (st.size > opt.maxFileSizeKb * 1024) { result.skipped.tooLarge++; continue; }
      const h = head(abs);
      if (h.includes(0)) { result.skipped.binary++; continue; }
      if (GENERATED_MARKERS.test(h.toString('utf8'))) { result.skipped.generated++; continue; }
      result.files.push({ path: rel, sizeBytes: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
    }
    if (pushed) scopes.pop();
  };

  walk('');
  return result;
}
