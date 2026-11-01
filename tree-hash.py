#!/usr/bin/env python3
"""Sidik jari isi folder `source/` milik ky: identik di Linux dan Windows bila berkasnya identik byte per byte
(CRLF vs LF akan terdeteksi). Pakai: python tree-hash.py <folder ky>"""
import hashlib, os, sys
root = os.path.join(sys.argv[1] if len(sys.argv) > 1 else ".", "source")
if not os.path.isdir(root): sys.exit(f"tidak ada folder: {root}")
lines = []
for d, _, files in os.walk(root):
    for f in files:
        p = os.path.join(d, f)
        rel = os.path.relpath(p, os.path.dirname(root)).replace(os.sep, "/")
        lines.append(f"{hashlib.sha256(open(p, 'rb').read()).hexdigest()}  {rel}\n")
lines.sort(key=lambda l: l.split("  ", 1)[1])
print(f"{hashlib.sha256(''.join(lines).encode()).hexdigest()}  ({len(lines)} berkas)")
