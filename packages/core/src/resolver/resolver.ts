import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PosixPath, ResolveResult, Resolver } from '../contracts.js';

export interface ResolverFs {
  fileExists(abs: string): boolean;
  directoryExists(abs: string): boolean;
  readFile(abs: string): string | undefined;
}
export const nodeFs: ResolverFs = {
  fileExists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  directoryExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
};

interface ConfigEntry { dir: string; options: ts.CompilerOptions; aliasKeys: string[] }

const toPosix = (p: string) => p.split(path.sep).join('/');

export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * FR-ANA-04, FR-SCN-05. Resolusi spesifier lewat ts.resolveModuleName dengan tsconfig terdekat (monorepo).
 * Catatan (spec-amendments A-03): paket workspace yang tertaut lewat node_modules tercatat external; aset (.css, .svg) tercatat unresolved.
 */
export class TsResolver implements Resolver {
  private configs: ConfigEntry[] = [];
  readonly configErrors: string[] = [];

  constructor(
    private readonly root: string,
    private readonly tsconfigs: PosixPath[],
    private readonly isIndexed: (p: PosixPath) => boolean,
    private readonly vfs: ResolverFs = nodeFs,
  ) { this.reloadConfig(); }

  reloadConfig(): void {
    this.configs = []; this.configErrors.length = 0;
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (f) => this.vfs.fileExists(f),
      readFile: (f) => this.vfs.readFile(f),
    };
    for (const rel of this.tsconfigs) {
      const abs = path.join(this.root, rel);
      const read = ts.readConfigFile(abs, (f) => this.vfs.readFile(f));
      if (read.error) { this.configErrors.push(`${rel}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`); continue; }
      const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(abs), undefined, abs);
      this.configs.push({
        dir: toPosix(path.dirname(rel)) === '.' ? '' : toPosix(path.dirname(rel)),
        options: parsed.options,
        aliasKeys: Object.keys(parsed.options.paths ?? {}),
      });
    }
    this.configs.sort((a, b) => b.dir.length - a.dir.length);
  }

  private configFor(fromPath: PosixPath): ConfigEntry {
    for (const c of this.configs) if (c.dir === '' || fromPath.startsWith(c.dir + '/')) return c;
    return { dir: '', aliasKeys: [], options: { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } };
  }

  private rel(abs: string): string | undefined {
    const r = toPosix(path.relative(this.root, abs));
    return r.startsWith('..') || path.isAbsolute(r) ? undefined : r;
  }

  private matchesAlias(spec: string, keys: string[]): boolean {
    return keys.some((k) => (k.endsWith('*') ? spec.startsWith(k.slice(0, -1)) : spec === k));
  }

  resolve(fromPath: PosixPath, specifier: string): ResolveResult {
    const tried = new Set<string>();
    const host: ts.ModuleResolutionHost = {
      fileExists: (f) => { const r = this.rel(f); if (r !== undefined) tried.add(r); return this.vfs.fileExists(f); },
      directoryExists: (d) => this.vfs.directoryExists(d),
      readFile: (f) => this.vfs.readFile(f),
      realpath: (p) => p,
      getCurrentDirectory: () => this.root,
    };
    const cfg = this.configFor(fromPath);
    const out = (r: Omit<ResolveResult, 'triedPaths'>): ResolveResult => ({ ...r, triedPaths: [...tried] });

    const m = ts.resolveModuleName(specifier, path.join(this.root, fromPath), cfg.options, host).resolvedModule;
    if (m) {
      const rel = this.rel(m.resolvedFileName);
      const inRepo = rel !== undefined && !m.isExternalLibraryImport && !rel.split('/').includes('node_modules');
      if (!inRepo) return out({ status: 'external', externalPackage: packageNameOf(specifier) });
      return this.isIndexed(rel) ? out({ status: 'resolved', resolvedPath: rel }) : out({ status: 'unresolved' });
    }
    const bare = !specifier.startsWith('.') && !path.isAbsolute(specifier);
    if (bare && !this.matchesAlias(specifier, cfg.aliasKeys)) return out({ status: 'external', externalPackage: packageNameOf(specifier) });
    return out({ status: 'unresolved' });
  }
}
