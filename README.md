# RepoMind (nama kerja)

Monorepo: `packages/core` (engine, tanpa import vscode), `packages/extension` (shell VS Code), `packages/eval` (harness evaluasi).

    npm install
    npm run lint && npm run typecheck && npm test
    npm run spike:sqlite     # spike ADR-02

Spesifikasi lengkap: dokumen Spesifikasi Teknis + schema.sql + contracts.ts (sudah disalin ke packages/core).
