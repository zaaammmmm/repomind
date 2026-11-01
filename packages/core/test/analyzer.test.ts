import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer/analyze.js';

const ts = (src: string, p = 'src/a.ts') => analyze(p, src, false);
const tsx = (src: string, p = 'src/a.tsx') => analyze(p, src, true);
const names = (f: ReturnType<typeof ts>) => f.symbols.map((s) => `${s.kind}:${s.qualifiedName}`);

describe('simbol (FR-ANA-01, 02)', () => {
  it('mengekstrak semua jenis deklarasi tingkat atas', () => {
    const f = ts(`
      export function a(x: number): string { return ''; }
      export async function b() {}
      const c = (n: number) => n;
      export const d = 5;
      export class K { m(): void {} p = 1; constructor() {} }
      export interface I { x: number }
      export type T = string | number;
      export enum E { A, B }
      export namespace N { export const z = 1; }
    `);
    expect(names(f)).toEqual([
      'function:a', 'function:b', 'function:c', 'variable:d',
      'class:K', 'method:K.m', 'property:K.p', 'method:K.constructor',
      'interface:I', 'type:T', 'enum:E', 'namespace:N',
    ]);
    expect(f.symbols.find((s) => s.name === 'b')!.isAsync).toBe(true);
    expect(f.symbols.find((s) => s.name === 'c')!.isExported).toBe(false);
  });

  it('posisi 1-based dan signature tanpa tubuh', () => {
    const f = ts(`\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    const s = f.symbols[0]!;
    expect(s.range).toMatchObject({ startLine: 3, endLine: 5, startCol: 1 });
    expect(s.signature).toBe('export function add(a: number, b: number): number');
  });

  it('menangkap JSDoc', () => {
    const f = ts(`/** Menjumlahkan. */\nexport function add() {}\n`);
    expect(f.symbols[0]!.jsdoc).toContain('Menjumlahkan');
  });

  it('overload hanya menghasilkan satu simbol', () => {
    const f = ts(`export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any) {}\n`);
    expect(f.symbols.filter((s) => s.name === 'f')).toHaveLength(1);
  });
});

describe('komponen React (FR-ANA-01)', () => {
  it('mengenali function, arrow, memo, dan class component hanya di .tsx', () => {
    const src = `
      import React from 'react';
      export function A() { return <div/>; }
      export const B = () => <span/>;
      export const C = React.memo(() => <i/>);
      export class D extends React.Component { render() { return <p/>; } }
      export function helper() { return 1; }
      export function lower() { return <b/>; }
    `;
    const f = tsx(src);
    const kinds = Object.fromEntries(f.symbols.filter((s) => !s.parentLocalId).map((s) => [s.name, s.kind]));
    expect(kinds).toMatchObject({ A: 'component', B: 'component', C: 'component', D: 'component', helper: 'function', lower: 'function' });
    expect(ts(`export function A() { return 1; }`).symbols[0]!.kind).toBe('function');
  });
});

describe('import dan ekspor (FR-ANA-03)', () => {
  it('mengekstrak semua bentuk import', () => {
    const f = ts(`
      import d from './d';
      import * as ns from './ns';
      import { a, b as bb, type T } from './m';
      import type { Only } from './types';
      import './side';
      const x = import('./lazy');
    `);
    const by = Object.fromEntries(f.imports.map((i) => [i.specifier, i]));
    expect(by['./d']!.bindings).toEqual([{ importedName: 'default', localName: 'd', isType: false }]);
    expect(by['./ns']!.bindings[0]).toMatchObject({ importedName: '*', localName: 'ns' });
    expect(by['./m']!.bindings).toEqual([
      { importedName: 'a', localName: 'a', isType: false },
      { importedName: 'b', localName: 'bb', isType: false },
      { importedName: 'T', localName: 'T', isType: true },
    ]);
    expect(by['./types']!.isTypeOnly).toBe(true);
    expect(by['./side']!.isSideEffect).toBe(true);
    expect(by['./lazy']!.isDynamic).toBe(true);
  });

  it('mengekstrak ekspor named, default, daftar, re-export, dan export *', () => {
    const f = ts(`
      function local() {}
      const k = 1;
      export { local, k as kk };
      export default local;
      export { x } from './x';
      export * from './all';
      export * as ns from './nsmod';
    `);
    const ex = f.exports.map((e) => `${e.kind}:${e.exportName}${e.sourceSpecifier ? '<' + e.sourceSpecifier : ''}${e.symbolLocalId ? '#' : ''}`);
    expect(ex).toEqual(['named:local#', 'named:kk#', 'default:default#', 'reexport:x<./x', 'reexport_all:*<./all', 'namespace:ns<./nsmod']);
    expect(f.symbols.find((s) => s.name === 'local')!.isExported).toBe(true);
  });
});

describe('referensi (FR-ANA-05, 06)', () => {
  it('mencatat call, type, extends, implements, jsx yang terikat ke import', () => {
    const f = tsx(`
      import { signToken } from './token';
      import { Base, Shape } from './base';
      import { Button } from './ui';
      export class Child extends Base implements Shape {}
      export function login(): Shape { return signToken(); }
      export const View = () => <Button/>;
    `);
    const kinds = f.refs.filter((r) => r.bindingLocal).map((r) => `${r.name}:${r.kind}`);
    expect(kinds).toEqual(['Base:extends', 'Shape:implements', 'Shape:type', 'signToken:call', 'Button:jsx']);
    const call = f.refs.find((r) => r.name === 'signToken')!;
    expect(f.symbols.find((s) => s.localId === call.enclosingLocalId)!.name).toBe('login');
  });

  it('tidak menghitung nama properti atau deklarasi sebagai referensi', () => {
    const f = ts(`
      import { foo } from './foo';
      export const o = { foo: 1 };
      export function f(foo2: number) { return o.foo + foo2; }
    `);
    expect(f.refs.filter((r) => r.name === 'foo')).toHaveLength(0);
  });

  it('mencatat referensi ke deklarasi lokal (tanpa bindingLocal)', () => {
    const f = ts(`function h() {}\nexport function g() { h(); }\n`);
    const r = f.refs.find((x) => x.name === 'h')!;
    expect(r.kind).toBe('call');
    expect(r.bindingLocal).toBeUndefined();
  });
});

describe('export_surface_hash (FR-UPD-04, T-06)', () => {
  const base = `export function f(a: number): number { return a + 1; }\n`;
  it('tidak berubah bila hanya isi fungsi berubah', () => {
    const a = ts(base), b = ts(`export function f(a: number): number {\n  // komentar\n  return a * 2;\n}\n`);
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(b.exportSurfaceHash).toBe(a.exportSurfaceHash);
  });
  it('berubah bila signature berubah', () => {
    expect(ts(`export function f(a: string): number { return 1; }`).exportSurfaceHash).not.toBe(ts(base).exportSurfaceHash);
  });
  it('berubah bila ekspor ditambah, dan tidak bila simbol non-ekspor ditambah', () => {
    expect(ts(base + `export const z = 1;`).exportSurfaceHash).not.toBe(ts(base).exportSurfaceHash);
    expect(ts(base + `const hidden = 1;`).exportSurfaceHash).toBe(ts(base).exportSurfaceHash);
  });
});

describe('chunk (bagian 3.4)', () => {
  it('satu chunk per deklarasi + chunk header untuk import', () => {
    const f = ts(`import { x } from './x';\nexport function a() { return x; }\nexport function b() {}\n`);
    expect(f.chunks.map((c) => c.symbolLocalId === undefined ? 'header' : f.symbols.find((s) => s.localId === c.symbolLocalId)!.name)).toEqual(['header', 'a', 'b']);
    expect(f.chunks[1]!.startLine).toBe(2);
  });
  it('memecah kelas besar per member dan tidak melewati anggaran token', () => {
    const body = Array.from({ length: 40 }, (_, i) => `  m${i}() {\n    return '${'x'.repeat(60)}${i}';\n  }`).join('\n');
    const f = ts(`export class Big {\n${body}\n}\n`);
    expect(f.chunks.length).toBeGreaterThan(10);
    for (const c of f.chunks) expect(c.tokenEst).toBeLessThanOrEqual(520);
    expect(f.chunks.some((c) => c.ftsName.includes('big') && c.ftsName.includes('m3'))).toBe(true);
  });
  it('FTS memuat pecahan camelCase', () => {
    const f = ts(`export function getUserToken() {}`);
    expect(f.chunks[0]!.ftsName).toContain('user');
    expect(f.chunks[0]!.ftsName).toContain('token');
  });
});

describe('ketahanan dan determinisme', () => {
  it('syntax error tetap menghasilkan fakta parsial dan flag parseError', () => {
    const f = ts(`export function ok() {}\nexport function broken( {\n`);
    expect(f.parseError).toBe(true);
    expect(f.symbols.some((s) => s.name === 'ok')).toBe(true);
  });
  it('input sama menghasilkan hasil identik (NFR-R-01)', () => {
    const src = `import { a } from './a';\nexport class C { m() { return a(); } }\n`;
    expect(ts(src)).toEqual(ts(src));
  });
  it('file kosong tidak error', () => {
    const f = ts('');
    expect(f.symbols).toEqual([]);
    expect(f.chunks).toEqual([]);
  });
});
