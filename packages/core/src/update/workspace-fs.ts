import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PosixPath } from '../contracts.js';
import { scanWorkspace, type ScanOptions, type ScannedFile } from '../scanner/scan.js';
import { nodeFs, type ResolverFs } from '../resolver/resolver.js';

/** Sumber kebenaran sistem berkas untuk engine. Implementasi: Node (produksi/CLI) dan memori (uji). */
export interface WorkspaceFs {
  readonly root: string;
  list(): ScannedFile[];                       // semua file yang boleh diindeks, terurut
  read(path: PosixPath): string;
  tsconfigs(): PosixPath[];
  readonly resolverFs: ResolverFs;
}

export class NodeWorkspaceFs implements WorkspaceFs {
  readonly resolverFs: ResolverFs = nodeFs;
  constructor(readonly root: string, private readonly opts: Partial<ScanOptions> = {}) {}
  list(): ScannedFile[] { return scanWorkspace(this.root, this.opts).files; }
  read(p: PosixPath): string { return fs.readFileSync(path.join(this.root, p), 'utf8'); }
  tsconfigs(): PosixPath[] { return scanWorkspace(this.root, this.opts).tsconfigs; }
}
