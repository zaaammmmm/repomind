import { describe, it, expect } from 'vitest';
import { validateCitations } from '../src/context/citations.js';

const idMap = { F1: { path: 'src/auth/login.ts', startLine: 24, endLine: 31 } };

describe('validateCitations (FR-LLM-06)', () => {
  it('menerima sitasi di dalam rentang', () => {
    const r = validateCitations('login() memanggil signToken [F1:29-29].', idMap);
    expect(r.citations).toEqual([{ path: 'src/auth/login.ts', startLine: 29, endLine: 29, verified: true }]);
    expect(r.text).not.toContain('tidak terverifikasi');
  });
  it('menandai id yang tidak ada di konteks', () => {
    const r = validateCitations('lihat [F9:1-2]', idMap);
    expect(r.citations).toHaveLength(0);
    expect(r.text).toContain('tidak terverifikasi');
  });
  it('menandai rentang di luar yang dikirim', () => {
    expect(validateCitations('[F1:20-30]', idMap).citations).toHaveLength(0);
    expect(validateCitations('[F1:24-40]', idMap).citations).toHaveLength(0);
  });
  it('menolak rentang terbalik', () => {
    expect(validateCitations('[F1:30-25]', idMap).citations).toHaveLength(0);
  });
});
