import ts from 'typescript';
import { createHash } from 'node:crypto';
import type {
  Analyzer, FileFacts, SymbolFact, ImportFact, ExportFact, RefFact, ChunkFact, SymbolKind,
} from '../contracts.js';

export const ANALYZER_VERSION = 1;
export const MAX_CHUNK_TOKENS = 512;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokenEst = (s: string) => Math.ceil(s.length / 4);

/** fooBarBaz, foo_bar -> ['foo','bar','baz'] */
export function splitIdentifier(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

function splitLines(text: string, startLine: number, maxTokens: number) {
  const maxChars = maxTokens * 4;
  const lines = text.split('\n');
  const out: { text: string; startLine: number; endLine: number }[] = [];
  let acc: string[] = [];
  let accStart = startLine;
  const flush = (upto: number) => {
    const part = acc.slice(0, upto);
    out.push({ text: part.join('\n'), startLine: accStart, endLine: accStart + part.length - 1 });
    acc = acc.slice(upto);
    accStart += part.length;
  };
  for (const line of lines) {
    const len = acc.reduce((n, l) => n + l.length + 1, 0) + line.length + 1;
    if (len > maxChars && acc.length > 0) {
      let cut = acc.length;
      for (let i = acc.length - 1; i > 0; i--) if (acc[i]!.trim() === '') { cut = i + 1; break; }
      flush(cut);
    }
    acc.push(line);
  }
  if (acc.length) flush(acc.length);
  return out;
}

const hasMod = (n: ts.Node, k: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === k);

function containsJsx(n: ts.Node): boolean {
  let found = false;
  const v = (x: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) { found = true; return; }
    ts.forEachChild(x, v);
  };
  v(n);
  return found;
}

const isPascal = (s: string) => /^[A-Z]/.test(s);

export const analyze: Analyzer['analyze'] = (path, source, isTsx) => {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parseError = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0) > 0;

  const symbols: SymbolFact[] = [];
  const imports: ImportFact[] = [];
  const exportsOut: ExportFact[] = [];
  const refs: RefFact[] = [];
  const chunks: ChunkFact[] = [];
  const nodeSymbol = new Map<ts.Node, number>();
  const topByName = new Map<string, SymbolFact>();
  const importLocals = new Set<string>();
  const pendingLocal = new Map<ExportFact, string>(); // export {a as b} / export default a -> nama lokal

  const at = (p: number) => { const lc = sf.getLineAndCharacterOfPosition(p); return { line: lc.line + 1, col: lc.character + 1 }; };

  const jsdocOf = (node: ts.Node) => {
    const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
    const docs = ranges.filter((r) => source.startsWith('/**', r.pos));
    const last = docs[docs.length - 1];
    return last ? { text: source.slice(last.pos, last.end), start: last.pos } : { text: undefined, start: node.getStart(sf) };
  };

  const signatureOf = (node: ts.Node, start = node.getStart(sf)): string => {
    let end = node.getEnd();
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) end = node.body.getStart(sf);
    else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) end = node.members.pos;
    else if (ts.isModuleDeclaration(node) && node.body) end = node.body.getStart(sf);
    else if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (init && ts.isArrowFunction(init)) end = init.equalsGreaterThanToken.getEnd();
      else if (init && ts.isFunctionExpression(init)) end = init.body.getStart(sf);
      else end = (node.type ?? node.name).getEnd();
    }
    return norm(source.slice(start, end)).replace(/\{$/, '').trim().slice(0, 300);
  };

  const isComponentInit = (init: ts.Expression | undefined): boolean => {
    if (!init) return false;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return containsJsx(init);
    if (ts.isCallExpression(init) && /(^|\.)(memo|forwardRef)$/.test(init.expression.getText(sf))) {
      const a = init.arguments[0];
      return !!a && isComponentInit(a);
    }
    return false;
  };

  const addSymbol = (
    node: ts.Node, name: string, qualifiedName: string, kind: SymbolKind,
    o: { parent?: number; exported?: boolean; isDefault?: boolean; docNode?: ts.Node; sigNode?: ts.Node; rangeNode?: ts.Node } = {},
  ): SymbolFact => {
    const rn = o.rangeNode ?? node;
    const s = at(rn.getStart(sf)); const e = at(rn.getEnd());
    const doc = jsdocOf(o.docNode ?? node);
    const sym: SymbolFact = {
      localId: symbols.length + 1,
      ...(o.parent !== undefined ? { parentLocalId: o.parent } : {}),
      name, qualifiedName, kind,
      range: { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col },
      signature: signatureOf(o.sigNode ?? node, rn.getStart(sf)),
      isExported: !!o.exported, isDefault: !!o.isDefault,
      isAsync: hasMod(node, ts.SyntaxKind.AsyncKeyword) || ((ts.isVariableDeclaration(node) && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && hasMod(node.initializer, ts.SyntaxKind.AsyncKeyword))),
      ...(doc.text ? { jsdoc: doc.text } : {}),
    };
    symbols.push(sym);
    nodeSymbol.set(node, sym.localId);
    return sym;
  };

  // ---------------------------------------------------------- pass 1: deklarasi, import, ekspor
  type Unit = { stmt: ts.Statement; sym?: SymbolFact; members: { node: ts.Node; sym: SymbolFact }[] };
  const units: Unit[] = [];
  const otherStatements: ts.Statement[] = [];
  const withBody = new Set<string>();
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.body && st.name) withBody.add(st.name.text);

  for (const st of sf.statements) {
    const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasMod(st, ts.SyntaxKind.DefaultKeyword);

    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const bindings: ImportFact['bindings'] = [];
      if (clause?.name) bindings.push({ importedName: 'default', localName: clause.name.text, isType: clause.isTypeOnly });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ importedName: '*', localName: nb.name.text, isType: clause!.isTypeOnly });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements)
        bindings.push({ importedName: (el.propertyName ?? el.name).text, localName: el.name.text, isType: clause!.isTypeOnly || el.isTypeOnly });
      bindings.forEach((b) => importLocals.add(b.localName));
      imports.push({ specifier: st.moduleSpecifier.text, line: at(st.getStart(sf)).line, isTypeOnly: !!clause?.isTypeOnly, isDynamic: false, isSideEffect: !clause, bindings });
      otherStatements.push(st);
      continue;
    }
    if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
      importLocals.add(st.name.text);
      imports.push({ specifier: st.moduleReference.expression.text, line: at(st.getStart(sf)).line, isTypeOnly: st.isTypeOnly, isDynamic: false, isSideEffect: false,
        bindings: [{ importedName: '*', localName: st.name.text, isType: st.isTypeOnly }] });
      otherStatements.push(st);
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      const line = at(st.getStart(sf)).line;
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (!st.exportClause) { if (spec) exportsOut.push({ exportName: '*', kind: 'reexport_all', sourceSpecifier: spec, line }); }
      else if (ts.isNamespaceExport(st.exportClause)) { if (spec) exportsOut.push({ exportName: st.exportClause.name.text, kind: 'namespace', sourceSpecifier: spec, line }); }
      else for (const el of st.exportClause.elements) {
        const exportName = el.name.text; const local = (el.propertyName ?? el.name).text;
        if (spec) exportsOut.push({ exportName, kind: 'reexport', sourceSpecifier: spec, sourceName: local, line });
        else { exportsOut.push({ exportName, kind: exportName === 'default' ? 'default' : 'named', line }); pendingLocal.set(exportsOut[exportsOut.length - 1]!, local); }
      }
      otherStatements.push(st);
      continue;
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const e = st.expression;
      const ex: ExportFact = { exportName: 'default', kind: 'default', line: at(st.getStart(sf)).line };
      exportsOut.push(ex);
      if (ts.isIdentifier(e)) pendingLocal.set(ex, e.text);
      otherStatements.push(st);
      continue;
    }

    if (ts.isFunctionDeclaration(st) && st.name) {
      if (!st.body && withBody.has(st.name.text)) { continue; } // signature overload
      const name = st.name.text;
      const comp = hasJsxFile(isTsx) && isPascal(name) && !!st.body && containsJsx(st.body);
      const sym = addSymbol(st, name, name, comp ? 'component' : 'function', { exported, isDefault });
      topByName.set(name, topByName.get(name) ?? sym);
      units.push({ stmt: st, sym, members: [] });
      if (exported) exportsOut.push({ exportName: isDefault ? 'default' : name, kind: isDefault ? 'default' : 'named', symbolLocalId: sym.localId, line: sym.range.startLine });
    } else if (ts.isFunctionDeclaration(st) && isDefault) {
      const comp = hasJsxFile(isTsx) && !!st.body && containsJsx(st.body);
      const sym = addSymbol(st, 'default', 'default', comp ? 'component' : 'function', { exported: true, isDefault: true });
      units.push({ stmt: st, sym, members: [] });
      exportsOut.push({ exportName: 'default', kind: 'default', symbolLocalId: sym.localId, line: sym.range.startLine });
    } else if (ts.isClassDeclaration(st) && (st.name || isDefault)) {
      const name = st.name?.text ?? 'default';
      const extendsText = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText(sf) ?? '';
      const comp = hasJsxFile(isTsx) && isPascal(name) && /(^|\.)(Pure)?Component$/.test(extendsText);
      const sym = addSymbol(st, name, name, comp ? 'component' : 'class', { exported, isDefault });
      topByName.set(name, topByName.get(name) ?? sym);
      const members: Unit['members'] = [];
      for (const m of st.members) {
        const mName = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : ts.isConstructorDeclaration(m) ? 'constructor' : undefined;
        if (!mName) continue;
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
          if ((ts.isMethodDeclaration(m)) && !m.body && st.members.some((o) => o !== m && ts.isMethodDeclaration(o) && o.body && o.name.getText(sf) === m.name.getText(sf))) continue;
          members.push({ node: m, sym: addSymbol(m, mName, `${name}.${mName}`, 'method', { parent: sym.localId }) });
        } else if (ts.isPropertyDeclaration(m)) {
          members.push({ node: m, sym: addSymbol(m, mName, `${name}.${mName}`, 'property', { parent: sym.localId }) });
        }
      }
      units.push({ stmt: st, sym, members });
      if (exported) exportsOut.push({ exportName: isDefault ? 'default' : name, kind: isDefault ? 'default' : 'named', symbolLocalId: sym.localId, line: sym.range.startLine });
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      const kind: SymbolKind = ts.isInterfaceDeclaration(st) ? 'interface' : ts.isEnumDeclaration(st) ? 'enum' : 'type';
      const sym = addSymbol(st, st.name.text, st.name.text, kind, { exported, isDefault });
      topByName.set(st.name.text, topByName.get(st.name.text) ?? sym);
      units.push({ stmt: st, sym, members: [] });
      if (exported) exportsOut.push({ exportName: isDefault ? 'default' : st.name.text, kind: isDefault ? 'default' : 'named', symbolLocalId: sym.localId, line: sym.range.startLine });
    } else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) {
      const sym = addSymbol(st, st.name.text, st.name.text, 'namespace', { exported });
      topByName.set(st.name.text, topByName.get(st.name.text) ?? sym);
      units.push({ stmt: st, sym, members: [] });
      if (exported) exportsOut.push({ exportName: st.name.text, kind: 'named', symbolLocalId: sym.localId, line: sym.range.startLine });
    } else if (ts.isVariableStatement(st)) {
      const decls = st.declarationList.declarations;
      const single = decls.length === 1;
      let first: SymbolFact | undefined;
      for (const d of decls) {
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text; const init = d.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind: SymbolKind = isComponentInit(init) && hasJsxFile(isTsx) && isPascal(name) ? 'component' : isFn ? 'function' : 'variable';
        const sym = addSymbol(d, name, name, kind, { exported, docNode: st, ...(single ? { rangeNode: st } : {}) });
        topByName.set(name, topByName.get(name) ?? sym);
        first ??= sym;
        if (exported) exportsOut.push({ exportName: name, kind: 'named', symbolLocalId: sym.localId, line: sym.range.startLine });
      }
      if (first) units.push({ stmt: st, sym: first, members: [] });
      else otherStatements.push(st);
    } else {
      otherStatements.push(st);
    }
  }

  // resolusi `export { a as b }` dan `export default ident` ke simbol lokal
  for (const [ex, local] of pendingLocal) {
    const target = topByName.get(local);
    if (!target) continue;
    ex.symbolLocalId = target.localId;
    target.isExported = true;
    if (ex.exportName === 'default') target.isDefault = true;
  }

  // import dinamis dengan literal (seluruh pohon)
  const dyn = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteralLike(a)) imports.push({ specifier: a.text, line: at(n.getStart(sf)).line, isTypeOnly: false, isDynamic: true, isSideEffect: false, bindings: [] });
    }
    ts.forEachChild(n, dyn);
  };
  dyn(sf);

  // ---------------------------------------------------------- pass 2: referensi
  const declared = new Set(topByName.keys());
  const walk = (n: ts.Node, enclosing: number | undefined) => {
    const own = nodeSymbol.get(n);
    const enc = own ?? enclosing;
    if (ts.isIdentifier(n)) {
      const name = n.text;
      if (importLocals.has(name) || declared.has(name)) {
        const p = n.parent;
        const isDeclName = (p as { name?: ts.Node }).name === n && !ts.isShorthandPropertyAssignment(p);
        const isPropName = (ts.isBindingElement(p) && p.propertyName === n) || (ts.isQualifiedName(p) && p.right === n)
          || (ts.isJsxClosingElement(p));
        if (!isDeclName && !isPropName) {
          let kind: RefFact['kind'] = 'ref';
          if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === n) kind = 'jsx';
          else if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent))
            kind = p.parent.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
          else if (ts.isTypeReferenceNode(p) || (ts.isQualifiedName(p) && ts.isTypeReferenceNode(p.parent))) kind = 'type';
          else if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) kind = 'call';
          const pos = at(n.getStart(sf));
          refs.push({ name, kind, line: pos.line, col: pos.col, ...(enc !== undefined ? { enclosingLocalId: enc } : {}), ...(importLocals.has(name) ? { bindingLocal: name } : {}) });
        }
      }
    }
    ts.forEachChild(n, (c) => walk(c, enc));
  };
  for (const u of units) walk(u.stmt, undefined);

  // ---------------------------------------------------------- hash permukaan ekspor
  const symById = new Map(symbols.map((s) => [s.localId, s]));
  const surface = exportsOut
    .map((e) => [e.exportName, e.kind, `${e.sourceSpecifier ?? ''}|${e.sourceName ?? ''}`, e.symbolLocalId ? `${symById.get(e.symbolLocalId)!.kind}|${symById.get(e.symbolLocalId)!.signature ?? ''}` : ''])
    .sort((a, b) => (a[0]! + a[1]!).localeCompare(b[0]! + b[1]!));
  const exportSurfaceHash = sha256(JSON.stringify(surface));

  // ---------------------------------------------------------- chunk
  let ordinal = 0;
  const pushChunk = (text: string, startLine: number, endLine: number, symbolLocalId: number | undefined, names: string[]) => {
    const terms = new Set<string>();
    for (const id of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) { const parts = splitIdentifier(id); if (parts.length > 1) parts.forEach((p) => terms.add(p)); }
    const ftsName = [...new Set([...names, ...names.flatMap(splitIdentifier)])].join(' ');
    chunks.push({ ordinal: ordinal++, ...(symbolLocalId !== undefined ? { symbolLocalId } : {}), startLine, endLine, text, tokenEst: tokenEst(text), ftsName, ftsBody: `${text}\n${[...terms].join(' ')}` });
  };
  const emit = (text: string, startLine: number, sym: SymbolFact | undefined, names: string[]) => {
    if (tokenEst(text) <= MAX_CHUNK_TOKENS) { pushChunk(text, startLine, startLine + text.split('\n').length - 1, sym?.localId, names); return; }
    for (const part of splitLines(text, startLine, MAX_CHUNK_TOKENS)) pushChunk(part.text, part.startLine, part.endLine, sym?.localId, names);
  };

  if (otherStatements.length) {
    const text = otherStatements.map((s) => s.getText(sf)).join('\n');
    const cut = text.slice(0, MAX_CHUNK_TOKENS * 4);
    pushChunk(cut, at(otherStatements[0]!.getStart(sf)).line, at(otherStatements[otherStatements.length - 1]!.getEnd()).line, undefined, []); // ftsName tidak bergantung path agar perpindahan file tidak butuh parse ulang
  }
  for (const u of units) {
    const start = jsdocOf(u.stmt).start;
    const text = source.slice(start, u.stmt.getEnd());
    const startLine = at(start).line;
    const sym = u.sym;
    if (tokenEst(text) <= MAX_CHUNK_TOKENS || u.members.length === 0) { emit(text, startLine, sym, sym ? [sym.name, sym.qualifiedName] : []); continue; }
    // kelas besar: header + satu chunk per member
    const firstMemberStart = jsdocOf(u.members[0]!.node).start;
    emit(source.slice(start, firstMemberStart).trimEnd(), startLine, sym, [sym!.name, sym!.qualifiedName]);
    for (const m of u.members) {
      const ms = jsdocOf(m.node).start;
      emit(`// ${sym!.name}\n${source.slice(ms, m.node.getEnd())}`, at(ms).line - 1, m.sym, [m.sym.name, m.sym.qualifiedName]);
    }
  }

  const loc = source.split('\n').filter((l) => l.trim() !== '').length;
  return { path, contentHash: sha256(source), exportSurfaceHash, loc, parseError, analyzerVersion: ANALYZER_VERSION, symbols, imports, exports: exportsOut, refs, chunks } satisfies FileFacts;
};

function hasJsxFile(isTsx: boolean) { return isTsx; }
