/**
 * FR-PRV-04: redaksi rahasia pada isi chunk sebelum dikirim ke penyedia LLM.
 *
 * Prinsip:
 *  - Best-effort, BUKAN jaminan. Rahasia yang tidak cocok pola dan tidak berentropi tinggi akan lolos.
 *  - Jumlah baris dipertahankan (blok multi-baris diganti penanda + baris kosong) agar sitasi baris tetap selaras.
 *  - Murni dan deterministik (tanpa acak, tanpa jaringan).
 */
export const REDACTED = '[REDACTED]';

export type RedactionKind = 'private_key' | 'aws_key' | 'github_token' | 'slack_token' | 'google_api_key' | 'api_key_prefix' | 'jwt' | 'bearer' | 'assignment';
export interface RedactionResult { text: string; count: number; kinds: Partial<Record<RedactionKind, number>> }

const keepLines = (s: string) => REDACTED + '\n'.repeat((s.match(/\n/g) ?? []).length);

/** Pola berprefiks spesifik (presisi tinggi). Urutan penting: blok private key lebih dulu. */
const PATTERNS: { kind: RedactionKind; re: RegExp }[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'api_key_prefix', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
];

/** Nama yang mengisyaratkan rahasia: secret, password, token, apikey, private key, credential. */
const SECRET_NAME = String.raw`[A-Za-z0-9_$.\-]*(?:secret|passw(?:or)?d|passwd|token|api[_-]?key|apikey|private[_-]?key|credential|auth[_-]?key)[A-Za-z0-9_$.\-]*`;
/** name: "value" | name = 'value' | "name": "value" (nilai berupa literal string satu baris). */
const TYPE_ANNOTATION = String.raw`(?:\s*:\s*[A-Za-z_$][\w$.<>\[\]| ]*?)?`; // password: string = '...'
const ASSIGNMENT = new RegExp(String.raw`(\b${SECRET_NAME}["']?${TYPE_ANNOTATION}\s*[:=]\s*)(["'\`])([^"'\`\n]{8,})\2`, 'gi');

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Nilai dianggap rahasia bila panjang >= 8, entropi >= 3,0 bit/karakter, bukan template/placeholder, dan bercampur kelas karakter. */
export function looksSecret(v: string): boolean {
  if (v.length < 8 || v.includes('${') || /^https?:\/\//i.test(v) || /^[./@~]/.test(v) && v.includes('/')) return false;
  if (/^(?:x+|\*+|\.+|changeme|change[_-]?me|your[_-].*|<.*>|todo|example|placeholder|null|undefined|true|false)$/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 2 && shannonEntropy(v) >= 3.0;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input; let count = 0; const kinds: Partial<Record<RedactionKind, number>> = {};
  const hit = (k: RedactionKind) => { count++; kinds[k] = (kinds[k] ?? 0) + 1; };
  for (const { kind, re } of PATTERNS) text = text.replace(re, (m) => { hit(kind); return keepLines(m); });
  text = text.replace(ASSIGNMENT, (full, head: string, q: string, val: string) => {
    if (val.includes(REDACTED) || !looksSecret(val)) return full;
    hit('assignment'); return `${head}${q}${REDACTED}${q}`;
  });
  return { text, count, kinds };
}
