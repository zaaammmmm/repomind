import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { TsResolver, packageNameOf, type ResolverFs } from '../src/resolver/resolver.js';

/** FS virtual: uji cepat, deterministik, tanpa disk. */
function vfs(files: Record<string, string>) {
  const root = '/repo';
  const abs = new Map(Object.entries(files).map(([k, v]) => [join(root, k), v]));
  const dirs = new Set<string>();
  for (const a of abs.keys()) { let d = dirname(a); while (d !== '/' && !dirs.has(d)) { dirs.add(d); d = dirname(d); } }
  const fs: ResolverFs = {
    fileExists: (p) => abs.has(p), directoryExists: (p) => dirs.has(p), readFile: (p) => abs.get(p),
  };
  const indexed = new Set(Object.keys(files).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')));
  const configs = Object.keys(files).filter((f) => f.endsWith('tsconfig.json'));
  return { root, fs, indexed, configs, make: () => new TsResolver(root, configs, (p) => indexed.has(p), fs) };
}
const F = 'export {}';

describe('TsResolver (FR-ANA-04, FR-SCN-05)', () => {
  it('relatif, ekstensi implisit, ekstensi .js ke .ts, dan direktori index', () => {
    const v = vfs({ 'src/a.ts': F, 'src/token.ts': F, 'src/ui/index.tsx': F, 'src/esm.ts': F });
    const r = v.make();
    expect(r.resolve('src/a.ts', './token')).toMatchObject({ status: 'resolved', resolvedPath: 'src/token.ts' });
    expect(r.resolve('src/a.ts', './token.js')).toMatchObject({ status: 'resolved', resolvedPath: 'src/token.ts' });
    expect(r.resolve('src/a.ts', './ui')).toMatchObject({ status: 'resolved', resolvedPath: 'src/ui/index.tsx' });
    expect(r.resolve('src/ui/index.tsx', '../token')).toMatchObject({ status: 'resolved', resolvedPath: 'src/token.ts' });
  });

  it('alias tsconfig paths dan baseUrl', () => {
    const v = vfs({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/auth/login.ts': F, 'src/a.ts': F, 'src/util/hash.ts': F,
    });
    const r = v.make();
    expect(r.resolve('src/a.ts', '@/auth/login')).toMatchObject({ status: 'resolved', resolvedPath: 'src/auth/login.ts' });
    expect(r.resolve('src/a.ts', 'src/util/hash')).toMatchObject({ status: 'resolved', resolvedPath: 'src/util/hash.ts' });
  });

  it('extends tsconfig', () => {
    const v = vfs({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['lib/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'lib/x.ts': F, 'src/a.ts': F,
    });
    expect(v.make().resolve('src/a.ts', '~/x')).toMatchObject({ status: 'resolved', resolvedPath: 'lib/x.ts' });
  });

  it('monorepo: memakai tsconfig terdekat', () => {
    const v = vfs({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['root-src/*'] } } }),
      'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/a/src/x.ts': F, 'packages/a/src/main.ts': F, 'root-src/x.ts': F, 'top.ts': F,
    });
    const r = v.make();
    expect(r.resolve('packages/a/src/main.ts', '@/x')).toMatchObject({ resolvedPath: 'packages/a/src/x.ts' });
    expect(r.resolve('top.ts', '@/x')).toMatchObject({ resolvedPath: 'root-src/x.ts' });
  });

  it('paket eksternal, scoped, subpath, dan built-in node:', () => {
    const r = vfs({ 'a.ts': F }).make();
    expect(r.resolve('a.ts', 'react')).toMatchObject({ status: 'external', externalPackage: 'react' });
    expect(r.resolve('a.ts', '@scope/pkg/sub/deep')).toMatchObject({ status: 'external', externalPackage: '@scope/pkg' });
    expect(r.resolve('a.ts', 'lodash/fp')).toMatchObject({ externalPackage: 'lodash' });
    expect(r.resolve('a.ts', 'node:fs')).toMatchObject({ status: 'external', externalPackage: 'node:fs' });
  });

  it('unresolved: relatif hilang dan alias tanpa target; triedPaths dicatat', () => {
    const v = vfs({ 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }), 'src/a.ts': F });
    const r = v.make();
    const miss = r.resolve('src/a.ts', './missing');
    expect(miss.status).toBe('unresolved');
    expect(miss.triedPaths).toContain('src/missing.ts');
    expect(miss.triedPaths).toContain('src/missing.tsx');
    expect(r.resolve('src/a.ts', '@/nope').status).toBe('unresolved');
  });

  it('file ada tetapi tidak diindeks (.d.ts) dianggap unresolved', () => {
    const v = vfs({ 'a.ts': F, 'types.d.ts': 'export type T = 1;' });
    expect(v.make().resolve('a.ts', './types').status).toBe('unresolved');
  });

  it('file baru yang cocok dengan triedPaths membuat import terselesaikan setelah resolve ulang', () => {
    const files: Record<string, string> = { 'a.ts': F };
    const v1 = vfs(files);
    const before = v1.make().resolve('a.ts', './late');
    expect(before.status).toBe('unresolved');
    const v2 = vfs({ ...files, 'late.ts': F });
    expect(before.triedPaths).toContain('late.ts');
    expect(v2.make().resolve('a.ts', './late')).toMatchObject({ status: 'resolved', resolvedPath: 'late.ts' });
  });

  it('reloadConfig membaca perubahan tsconfig', () => {
    const files: Record<string, string> = { 'tsconfig.json': JSON.stringify({}), 'src/x.ts': F, 'a.ts': F };
    const v = vfs(files);
    const r = v.make();
    expect(r.resolve('a.ts', '@/x').status).toBe('external'); // belum ada alias, dianggap paket
    files['tsconfig.json'] = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });
    const v2 = vfs(files);
    const r2 = v2.make(); r2.reloadConfig();
    expect(r2.resolve('a.ts', '@/x')).toMatchObject({ status: 'resolved', resolvedPath: 'src/x.ts' });
  });

  it('tsconfig rusak dilaporkan, resolusi tetap jalan dengan bawaan', () => {
    const v = vfs({ 'tsconfig.json': '{ bukan json', 'a.ts': F, 'b.ts': F });
    const r = v.make();
    expect(r.configErrors.length).toBe(1);
    expect(r.resolve('a.ts', './b')).toMatchObject({ status: 'resolved' });
  });
});

describe('packageNameOf', () => {
  it.each([['react', 'react'], ['react/jsx-runtime', 'react'], ['@a/b/c', '@a/b'], ['node:path', 'node:path']])('%s -> %s', (i, o) => {
    expect(packageNameOf(i)).toBe(o);
  });
});
