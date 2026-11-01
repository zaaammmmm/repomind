/**
 * RepoMind: kontrak antarmuka (packages/core/src/contracts.ts).
 * Tidak boleh mengimpor 'vscode'. Semua tipe di sini murni data (serializable).
 */

// ------------------------------------------------------------------ dasar
export type Mode = 'local' | 'ollama' | 'cloud';
export type PosixPath = string; // relatif terhadap root workspace, pemisah '/'
export interface LineRange { startLine: number; endLine: number } // 1-based, inklusif
export interface Citation extends LineRange { path: PosixPath; verified?: boolean }

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'property' | 'interface' | 'type'
  | 'enum' | 'namespace' | 'variable' | 'component';

// ------------------------------------------------------------------ Analyzer
export interface SymbolFact {
  localId: number;                 // id lokal dalam FileFacts, bukan id DB
  parentLocalId?: number;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  signature?: string;
  isExported: boolean; isDefault: boolean; isAsync: boolean;
  jsdoc?: string;
}
export interface ImportBindingFact { importedName: string; localName: string; isType: boolean }
export interface ImportFact {
  specifier: string; line: number;
  isTypeOnly: boolean; isDynamic: boolean; isSideEffect: boolean;
  bindings: ImportBindingFact[];
}
export interface ExportFact {
  exportName: string;
  kind: 'named' | 'default' | 'reexport' | 'reexport_all' | 'namespace';
  symbolLocalId?: number; sourceSpecifier?: string;
  sourceName?: string;             // untuk reexport: nama asli di modul sumber (export {a as b} from -> a)
  line: number;
}
export interface RefFact {
  name: string;                    // nama lokal di sumber
  kind: 'call' | 'ref' | 'type' | 'extends' | 'implements' | 'jsx';
  line: number; col: number;
  enclosingLocalId?: number;
  bindingLocal?: string;           // local_name import bila terikat
}
export interface ChunkFact {
  ordinal: number; symbolLocalId?: number;
  startLine: number; endLine: number; text: string; tokenEst: number;
  ftsName: string; ftsBody: string; // sudah termasuk pecahan camelCase
}
export interface FileFacts {
  path: PosixPath; contentHash: string; exportSurfaceHash: string;
  loc: number; parseError: boolean; analyzerVersion: number;
  symbols: SymbolFact[]; imports: ImportFact[]; exports: ExportFact[];
  refs: RefFact[]; chunks: ChunkFact[];
}
export interface Analyzer {
  /** Murni dan deterministik: input sama menghasilkan FileFacts identik. */
  analyze(path: PosixPath, source: string, isTsx: boolean): FileFacts;
}

// ------------------------------------------------------------------ Resolver
export interface ResolveResult {
  status: 'resolved' | 'external' | 'unresolved';
  resolvedPath?: PosixPath; externalPackage?: string;
  triedPaths: PosixPath[];         // untuk pencocokan unresolved saat file baru muncul
}
export interface Resolver {
  resolve(fromPath: PosixPath, specifier: string): ResolveResult;
  reloadConfig(): void;            // setelah tsconfig berubah
}

// ------------------------------------------------------------------ IndexStore
export interface FileRow {
  id: number; path: PosixPath; dir: string; contentHash: string;
  exportSurfaceHash: string; sizeBytes: number; mtimeMs: number; loc: number; parseError: boolean;
}
export interface SymbolRow extends Citation {
  id: number; name: string; qualifiedName: string; kind: SymbolKind;
  signature?: string; isExported: boolean; refCount: number;
}
export interface IndexStore {
  open(): Promise<{ recovered: boolean; reason?: 'corrupt' | 'schema' | 'analyzer' }>;
  getFile(path: PosixPath): FileRow | undefined;
  listFiles(): FileRow[];
  /** Satu transaksi atomik. */
  transaction<T>(fn: () => T): T;
  replaceFile(facts: FileFacts, stat: { sizeBytes: number; mtimeMs: number }): void;
  renameFile(oldPath: PosixPath, newPath: PosixPath): void;
  deleteFile(path: PosixPath): void;
  importersOf(path: PosixPath): PosixPath[];
  unresolvedMatching(path: PosixPath): number[]; // id file yang punya import unresolved cocok
  rebindImports(fileId: number, resolver: Resolver): void; // tanpa parse ulang
  canonicalDump(): string;                       // JSON stabil, untuk uji kesetaraan
  integrityCheck(): boolean;
  close(): void;
}

// ------------------------------------------------------------------ Update
export type ChangeKind = 'add' | 'edit' | 'delete' | 'move';
export interface FsEvent { path: PosixPath; type: 'create' | 'change' | 'delete'; atMs: number }
export interface UpdatePlan {
  add: PosixPath[]; edit: PosixPath[]; delete: PosixPath[];
  move: { from: PosixPath; to: PosixPath }[];
}
export interface UpdateReport {
  changed: number; affected: number; skipped: number; // sesuai mockup 7
  reparsed: number; rebound: number; entriesUpdated: number;
  durationMs: number; kind: 'incremental' | 'reconcile' | 'full';
}
export interface ReconcileResult { matching: number; changed: PosixPath[]; added: PosixPath[]; missing: PosixPath[] }
export interface UpdateOrchestrator {
  onEvents(events: FsEvent[]): Promise<UpdateReport>;
  reconcile(): Promise<ReconcileResult>;
  apply(result: ReconcileResult): Promise<UpdateReport>;
  fullRebuild(signal?: AbortSignal): Promise<UpdateReport>;
  reindexFile(path: PosixPath): Promise<UpdateReport>;
}

// ------------------------------------------------------------------ Retrieval
export interface Candidate extends LineRange {
  chunkId: number; path: PosixPath; symbol?: string; text: string; tokenEst: number;
  score: number; sources: ('text' | 'symbol' | 'graph')[]; reason: string;
}
export interface RetrievalOptions {
  topK: number; tokenBudget: number; maxChunksPerFile: number;
  testPenalty?: number;            // pengali skor untuk berkas uji (default 1 = nonaktif); diuji sebagai ablasi di Eval B
}
export interface RetrievalResult {
  chunks: Candidate[]; tokenEstimate: number;
  timingsMs: { text: number; symbol: number; graph: number; fuse: number; pack: number; total: number };
  perSourceCounts: Record<'text' | 'symbol' | 'graph', number>;
}
export interface Retriever { retrieve(query: string, opt: RetrievalOptions): Promise<RetrievalResult> }

// ------------------------------------------------------------------ Local QA (Mode 1)
export type Intent =
  | 'DEFINITION' | 'USAGES' | 'FILE_DEPENDENTS' | 'MODULE_EXPORTS'
  | 'DIR_FUNCTIONS' | 'COMPONENT_USES' | 'IMPACT';
export type LocalAnswer =
  | { type: 'answer'; intent: Intent; sections: { title: string; citations: Citation[]; text?: string }[] }
  | { type: 'disambiguation'; options: Citation[] }
  | { type: 'refusal'; reason: 'NEEDS_LLM' | 'UNSUPPORTED' | 'NOT_FOUND';
      partialEvidence: Citation[]; supportedIntents: Intent[]; suggestion?: string };
export interface LocalQa { ask(question: string): Promise<LocalAnswer> }

// ------------------------------------------------------------------ Summary
export interface SummarySection {
  key: string; title: string; stale: boolean;
  items: { text: string; citation?: Citation }[];
  refinedText?: string; // dari LLM bila diminta
}
export interface SummaryService {
  get(): Promise<SummarySection[]>;
  refine(sectionKey: string, signal?: AbortSignal): Promise<SummarySection>; // memanggil LLM
}

// ------------------------------------------------------------------ Context + privasi
export interface ContextPreviewItem extends Citation { tokenEst: number; redactions: number }
export interface ContextPreview { items: ContextPreviewItem[]; totalTokens: number; repoFileCount: number }
export interface ContextBuilder {
  preview(result: RetrievalResult): ContextPreview;
  buildPrompt(question: string, approved: ContextPreview): { system: string; user: string; idMap: Record<string, Citation> };
}
export type ValidateCitations = (answer: string, idMap: Record<string, Citation>) => { text: string; citations: Citation[] };

// ------------------------------------------------------------------ LLM
export type LlmErrorCode =
  | 'OFFLINE' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'CONTEXT_TOO_LONG' | 'PROVIDER_ERROR' | 'CANCELLED';
export class LlmError extends Error {
  constructor(public code: LlmErrorCode, message: string, public suggestion?: string) { super(message); this.name = 'LlmError'; }
}
export interface LlmRequest { system: string; user: string; maxOutputTokens?: number; temperature?: number }
export interface LlmUsage {
  tokensIn: number; tokensOut: number; latencyMs: number; costEstimate?: number;
  /** 'provider' = dari respons penyedia (sah untuk Eval D); 'estimated' = taksiran karakter/4 karena penyedia tidak melaporkan usage (A-11). */
  usageSource?: 'provider' | 'estimated';
}
export interface LlmResponse { text: string; usage: LlmUsage; model: string }
export interface LlmProvider {
  readonly id: 'ollama' | 'cloud';
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  stream(req: LlmRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<LlmResponse>;
}

// ------------------------------------------------------------------ Metrik
export type MetricEvent =
  | { kind: 'index_full' | 'index_update' | 'reconcile'; report: UpdateReport }
  | { kind: 'retrieval'; result: Pick<RetrievalResult, 'timingsMs' | 'perSourceCounts' | 'tokenEstimate'> }
  | { kind: 'qa_local'; intent?: Intent; answered: boolean; latencyMs: number }
  | { kind: 'llm_call'; usage: LlmUsage; ok: boolean; errorCode?: LlmErrorCode; contextTokens: number };
export interface MetricsSink { record(e: MetricEvent): void; exportJsonl(): string }

// ------------------------------------------------------------------ Engine API (host <-> worker)
export type IndexStatus = 'none' | 'building' | 'synced' | 'updating' | 'out_of_sync' | 'error';
export interface IndexSnapshot {
  status: IndexStatus; fileCount: number; symbolCount: number; importCount: number;
  lastReport?: UpdateReport; lastChanges: { kind: ChangeKind; path: PosixPath; to?: PosixPath }[];
}
export interface ProgressEvent {
  phase: 'scan' | 'symbols' | 'graph' | 'summary';
  state: 'pending' | 'running' | 'done';
  filesDone: number; filesTotal: number; symbols: number; imports: number;
}
export interface EngineApi {
  start(opts: { mode: Mode }, signal?: AbortSignal): Promise<void>;
  snapshot(): IndexSnapshot;
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onSnapshot(cb: (s: IndexSnapshot) => void): () => void;
  searchSymbols(q: string, kinds?: SymbolKind[]): SymbolRow[];
  symbolDetail(id: number): { symbol: SymbolRow; importedBy: Citation[]; imports: string[]; usedInComponents: Citation[] };
  summary: SummaryService;
  qa: LocalQa;
  retriever: Retriever;
  update: UpdateOrchestrator;
}

// ------------------------------------------------------------------ Protokol webview
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'ask'; requestId: string; question: string }
  | { type: 'consent'; requestId: string; decision: 'send' | 'cancel' | 'use_local'; dontAskAgain?: boolean }
  | { type: 'openCitation'; path: PosixPath; startLine: number; endLine: number }
  | { type: 'searchSymbols'; requestId: string; query: string; kinds: SymbolKind[] }
  | { type: 'selectSymbol'; id: number }
  | { type: 'reindexAll' } | { type: 'reindexFile' }
  | { type: 'applyReconcile'; mode: 'update' | 'rebuild' }
  | { type: 'refineSummary'; sectionKey: string }
  | { type: 'saveSettings'; settings: Record<string, unknown>; apiKey?: string }
  | { type: 'resetConsent' } | { type: 'cancel'; requestId: string };

export type HostToWebview =
  | { type: 'state'; mode: Mode; snapshot: IndexSnapshot }
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'localAnswer'; requestId: string; answer: LocalAnswer }
  | { type: 'consentRequest'; requestId: string; preview: ContextPreview; provider: string }
  | { type: 'llmToken'; requestId: string; token: string }
  | { type: 'llmDone'; requestId: string; text: string; citations: Citation[]; usage: LlmUsage; contextFiles: number; repoFiles: number }
  | { type: 'error'; requestId?: string; code: LlmErrorCode | 'ENGINE'; message: string; suggestion?: string }
  | { type: 'symbols'; requestId: string; rows: SymbolRow[] }
  | { type: 'summary'; sections: SummarySection[] }
  | { type: 'reconcile'; result: ReconcileResult };
