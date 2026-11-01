import type { Citation, ValidateCitations } from '../contracts.js';

const ANY = /\[(?:F\d+|[A-Za-z][\w.\-/]*:\d+)[^\]\n]{0,40}\]/g; // [F6], [F1:3], dan bentuk berawalan lain: [K1:8-9], [Ky.ts:3-4]
const STRICT = /^\[F(\d+):(\d+)-(\d+)\]$/;
export const UNVERIFIED = '(tidak terverifikasi)';
export const BAD_FORMAT = '(format sitasi tidak valid)';

/**
 * FR-LLM-06: sitasi [F{id}:{a}-{b}] valid hanya bila id ada di konteks terkirim
 * dan rentangnya berada di dalam rentang yang dikirim (toleransi 0).
 * Sitasi tidak valid dibiarkan di teks tetapi ditandai (tidak dikembalikan sebagai Citation).
 * Bentuk yang menyerupai sitasi tetapi menyimpang dari format (mis. [F1:29], [F1:2-4, F2:5-6]) ditandai
 * BAD_FORMAT dan tidak dihitung sebagai sitasi (A-12): format sitasi yang sah hanya satu.
 */
export const validateCitations: ValidateCitations = (answer, idMap) => {
  const citations: Citation[] = [];
  const text = answer.replace(ANY, (full) => {
    const m = STRICT.exec(full);
    if (!m) return `${full}${BAD_FORMAT}`;
    const src = idMap[`F${m[1]}`];
    const start = Number(m[2]), end = Number(m[3]);
    if (src && start <= end && start >= src.startLine && end <= src.endLine) {
      citations.push({ path: src.path, startLine: start, endLine: end, verified: true });
      return full;
    }
    return `${full}${UNVERIFIED}`;
  });
  return { text, citations };
};
