#!/usr/bin/env python3
"""
PROBE DIAGNOSTIK — kenapa 9router menolak PDF?

Bukan bagian dari aplikasi. Skrip ini menjawab satu pertanyaan:
bagaimana cara mengirim PDF ke gateway 9router sehingga model vision
menerimanya? Dijalankan manual, butuh gateway hidup.

Pemakaian:
  python3 scripts/probe-9router-pdf.py            # semua varian
  python3 scripts/probe-9router-pdf.py A          # varian tertentu

LATAR BELAKANG (bug yang ditemukan lewat skrip ini):
`lib/llm.ts` versi pertama mengirim SEMUA berkas — termasuk PDF — sebagai
part `image_url` berisi data URL `application/pdf`. Gateway menolaknya
dengan 400 `model_param_invalid`. Penyebabnya bukan kunci atau kuota,
tetapi BENTUK pesan yang salah: endpoint vision hanya menerima gambar.

Varian yang diuji di sini adalah cara-cara yang mungkin diterima:
  A  image_url  data:application/pdf;base64,...   (cara lama, DIDUGA gagal)
  B  file       { filename, file_data: data URL }  (gaya OpenAI Files)
  C  file_data  { mime_type, data: <base64 polos> } (gaya Gemini inline)
  D  file       { filename } + image_url ko-sisten
"""

from __future__ import annotations

import base64
import json
import re
import struct
import subprocess
import sys
import urllib.error
import urllib.request
import zlib
from pathlib import Path

GATEWAY = "http://localhost:20128/v1/chat/completions"
MODEL = "cbai/deepseek-v4.1-flash"


# ----------------------------------------------------------------------
# Konfigurasi: ambil kunci dari konfigurasi Hermes, tanpa pernah mencetaknya
# ----------------------------------------------------------------------
def hermes_api_key() -> str:
    cfg = Path.home() / ".hermes" / "config.yaml"
    for line in cfg.read_text().splitlines():
        m = re.match(r"\s*api_key:\s*(\S+)", line)
        if m:
            return m.group(1).strip()
    raise SystemExit("kunci 9router tidak ditemukan di ~/.hermes/config.yaml")


# ----------------------------------------------------------------------
# Berkas uji: PDF 1 halaman berisi kalimat yang mudah diperiksa
# ----------------------------------------------------------------------
SENTENCE = (
    "Fotosintesis adalah proses tumbuhan hijau mengubah energi cahaya "
    "menjadi energi kimia yang disimpan dalam bentuk glukosa."
)


def make_pdf(text: str) -> bytes:
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        None,  # diisi di bawah
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = f"BT /F1 14 Tf 72 720 Td ({text}) Tj ET".encode()

    # Bungkus jadi beberapa baris supaya PDF tetap terbaca.
    wrapped = []
    words, line = text.split(), ""
    for w in words:
        if len(line) + len(w) > 70:
            wrapped.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    wrapped.append(line)

    body = "BT /F1 14 Tf 72 720 Td 16 TL\n"
    for ln in wrapped:
        body += f"({ln}) Tj T*\n"
    body += "ET"
    stream = body.encode()
    objs[3] = (
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n"
        + stream + b"\nendstream"
    )

    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return out


def make_png(w: int = 96, h: int = 96) -> bytes:
    """PNG berisi tulisan besar 'BIRU' di latar putih — bahan uji OCR."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    # Bitmap sederhana: blok gelap menyerupai huruf, cukup untuk cek "terbaca".
    rows = []
    for y in range(h):
        row = b"\x00"
        for x in range(w):
            dark = (20 < x < 75 and 25 < y < 70) and ((x // 8 + y // 8) % 3 == 0)
            row += b"\x20\x40\xc0" if dark else b"\xff\xff\xff"
        rows.append(row)
    raw = b"".join(rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


# ----------------------------------------------------------------------
# Pemanggilan
# ----------------------------------------------------------------------
def post(payload: dict, key: str, timeout: int = 120) -> tuple[bool, str]:
    req = urllib.request.Request(
        GATEWAY,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
        content = body["choices"][0]["message"]["content"]
        return True, content
    except urllib.error.HTTPError as e:
        return False, e.read().decode(errors="replace")[:400]
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


PROMPT = (
    "Baca dokumen ini dan tulis ulang isinya sebagai kalimat mengalir "
    "dalam Bahasa Indonesia. Balas HANYA JSON: {\"teks\": \"...\"}"
)


def variants(pdf: bytes, png: bytes) -> dict[str, dict]:
    pdf_b64 = base64.b64encode(pdf).decode()
    png_b64 = base64.b64encode(png).decode()
    return {
        "A": {
            "label": "image_url + PDF  (cara lama lib/llm.ts)",
            "payload": {
                "model": MODEL,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {
                        "url": f"data:application/pdf;base64,{pdf_b64}"}},
                ]}],
                "temperature": 0.2, "max_tokens": 1024,
                "response_format": {"type": "json_object"},
            },
        },
        "B": {
            "label": "file {filename, file_data data-URL} + PDF",
            "payload": {
                "model": MODEL,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "file", "file": {
                        "filename": "modul.pdf",
                        "file_data": f"data:application/pdf;base64,{pdf_b64}"}},
                ]}],
                "temperature": 0.2, "max_tokens": 1024,
                "response_format": {"type": "json_object"},
            },
        },
        "C": {
            "label": "file_data {mime_type, data base64 polos} + PDF",
            "payload": {
                "model": MODEL,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "file_data", "file_data": {
                        "mime_type": "application/pdf", "data": pdf_b64}},
                ]}],
                "temperature": 0.2, "max_tokens": 1024,
                "response_format": {"type": "json_object"},
            },
        },
        "D": {
            "label": "image_url + PNG  (kontrol: jalur vision biasa)",
            "payload": {
                "model": MODEL,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text":
                        "Gambar ini berisi huruf besar. Sebutkan hurufnya. "
                        "Balas HANYA JSON: {\"teks\": \"...\"}"},
                    {"type": "image_url", "image_url": {
                        "url": f"data:image/png;base64,{png_b64}"}},
                ]}],
                "temperature": 0.2, "max_tokens": 512,
                "response_format": {"type": "json_object"},
            },
        },
    }


def main() -> int:
    only = {a.upper() for a in sys.argv[1:]}
    key = hermes_api_key()
    pdf, png = make_pdf(SENTENCE), make_png()
    print(f"PDF uji {len(pdf)} byte · PNG uji {len(png)} byte · model {MODEL}\n")

    all_ok = True
    for tag, spec in variants(pdf, png).items():
        if only and tag not in only:
            continue
        ok, out = post(spec["payload"], key)
        mark = "OK  " if ok else "GAGAL"
        print(f"[{tag}] {spec['label']}\n     {mark}: {out[:300]!r}\n")
        all_ok = all_ok and ok

    print("SEMUA varian lolos." if all_ok else "Ada varian yang gagal — lihat di atas.")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
