from pathlib import Path
import importlib.util

if importlib.util.find_spec("docx") is None:
    raise SystemExit("python-docx belum terpasang")

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

out = Path(r"D:\firda\SISTER\ClimaGrid_Dokumen_Perbaikan.docx")
doc = Document()
section = doc.sections[0]
section.top_margin = Inches(0.7)
section.bottom_margin = Inches(0.7)
section.left_margin = Inches(0.75)
section.right_margin = Inches(0.75)

styles = doc.styles
styles["Normal"].font.name = "Aptos"
styles["Normal"].font.size = Pt(10)
for name in ("Title", "Heading 1", "Heading 2"):
    styles[name].font.name = "Aptos Display"

title = doc.add_paragraph()
title.style = "Title"
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run("ClimaGrid v1.0")
run.bold = True
subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
subtitle.add_run("Dokumen Hasil Perbaikan dan Evaluasi Implementasi").bold = True

meta = doc.add_paragraph()
meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
meta.add_run("Tanggal: 24 November 2026\n")
meta.add_run("Acuan: PRD ClimaGrid v1.0 dan Pemetaan_Slide_ClimaGrid.xlsx")

doc.add_heading("1. Ringkasan", level=1)
doc.add_paragraph(
    "Dokumen ini mencatat perbaikan yang telah dilakukan pada aplikasi ClimaGrid "
    "berdasarkan evaluasi awal terhadap PRD dan checklist Excel. Perbaikan difokuskan "
    "pada penambahan backend REST lokal, sumber data melalui API, persistensi hasil "
    "pembacaan dan job, deduplikasi, cache, pembentukan kerangka DHT, serta dokumentasi "
    "database dan MPI."
)

doc.add_heading("2. Perbaikan yang Sudah Diimplementasikan", level=1)
implemented = [
    ("REST API", "server.js", "Delapan endpoint PRD, validasi, status HTTP, ETag, Conditional GET, autentikasi token opsional, dan rate limit."),
    ("Data stasiun", "data/stations.json", "20 stasiun dipindahkan ke dataset JSON terpusat dan digunakan oleh API serta frontend."),
    ("Frontend-backend", "app.js", "Frontend sinkron dengan GET /api/v1/stations dan GET /api/v1/health; status backend ditampilkan."),
    ("Ingest dan deduplikasi", "server.js; tests/api.test.js", "Idempotency key dan SHA-256, payload duplikat disimpan sekali, dan duplikasi dihitung."),
    ("Job analitik", "server.js", "POST/GET/DELETE analytics job; status 202 Accepted dan status job dapat dipantau."),
    ("Peta dan peringatan", "server.js", "Endpoint map dengan grid 95 x 56 serta endpoint alert berdasarkan wilayah."),
    ("Cache", "server.js", "LRU in-memory untuk peta dan histori, lease peta 30 detik, serta ETag."),
    ("DHT dasar", "server.js", "Tiga node Chord in-memory, hashing SHA-256, penentuan successor, dan replikasi RF=3."),
    ("Skema database", "db/schema.sql", "DDL stations, station_attributes, ingest_batches, readings, jobs, job_results, maps, alerts, hypertable, BRIN/B-tree, dan agregat jam."),
    ("IDL RPC", "proto/climagrid.proto", "IDL protobuf untuk WeatherService, JobService, ResultService, dan AlertService."),
    ("Kerangka MPI", "analytics/mpi_idw.py", "Implementasi IDW serial dan kerangka MPI Bcast/Gather untuk beberapa rank."),
    ("Dokumentasi", "README.md", "Panduan menjalankan API, token, dan pengujian."),
    ("Evaluasi workbook", "Pemetaan_Slide_ClimaGrid.xlsx", "Sheet Evaluasi Terbaru berisi status, lokasi kode, bukti, dan hasil pengujian.")
]
table = doc.add_table(rows=1, cols=3)
table.alignment = WD_TABLE_ALIGNMENT.CENTER
table.style = "Table Grid"
headers = table.rows[0].cells
headers[0].text = "Komponen"
headers[1].text = "Lokasi"
headers[2].text = "Bukti implementasi"
for comp, loc, evidence in implemented:
    row = table.add_row().cells
    row[0].text = comp
    row[1].text = loc
    row[2].text = evidence

doc.add_heading("3. Hasil Pengujian yang Dijalankan", level=1)
tests = [
    ("Pengujian API", "node tests/api.test.js", "Lulus", "GET stations, health, ingest, duplikasi, histori, job, dan peta."),
    ("Pengujian server", "curl /api/v1/stations", "200 OK", "Jumlah stasiun 20 dan ETag diterima."),
    ("Pengujian health", "curl /api/v1/health", "200 OK", "Status, hitungan ingest/duplikat, tiga node DHT, dan cache dilaporkan."),
    ("Pengujian deduplikasi", "Idempotency-Key berulang", "Lulus", "Permintaan duplikat mengembalikan duplicate=true."),
    ("Pengujian IDW", "python analytics/mpi_idw.py", "Lulus satu rank", "5.320 titik, checksum serial dan MPI cocok."),
]
test_table = doc.add_table(rows=1, cols=4)
test_table.style = "Table Grid"
test_headers = test_table.rows[0].cells
for i, text in enumerate(("Pengujian", "Perintah", "Hasil", "Bukti")):
    test_headers[i].text = text
for item in tests:
    row = test_table.add_row().cells
    for i, text in enumerate(item):
        row[i].text = text

doc.add_heading("4. Cara Menjalankan", level=1)
for text in (
    'Masuk ke folder: cd "D:\\firda\\SISTER\\climagrid-app"',
    "Jalankan backend/PWA: node server.js",
    "Buka: http://localhost:4173",
    "Health API: http://localhost:4173/api/v1/health",
    "Jalankan pengujian: node tests/api.test.js",
    "Jalankan IDW serial: python analytics/mpi_idw.py",
):
    doc.add_paragraph(text, style="List Bullet")

doc.add_heading("5. Bagian yang Masih Sebagian atau Belum Ada", level=1)
remaining = [
    "PostgreSQL 16 dan TimescaleDB hanya ditulis sebagai DDL; belum dijalankan dan belum menjadi penyimpanan aktif.",
    "Redis 7 belum dipasang; cache saat ini adalah LRU in-memory Node.js.",
    "Transport gRPC/Go belum dijalankan. File proto hanya menyediakan IDL.",
    "mpi4py belum terpasang sehingga pengujian multi-rank belum dapat dijalankan.",
    "Finger table, failure recovery, hinted handoff, read/write quorum, read repair, dan anti-entropy penuh belum lengkap.",
    "OpenTelemetry, Prometheus, dan Grafana belum diimplementasikan sebagai layanan aktif.",
    "TLS/mTLS, Docker/VLAN produksi, dan firewall antar-VLAN belum dikonfigurasi.",
    "Pengujian beban, p95, pengujian 5.000 stasiun, dan pengujian failover belum dijalankan.",
]
for item in remaining:
    doc.add_paragraph(item, style="List Bullet")

doc.add_heading("6. Kesimpulan Status", level=1)
doc.add_paragraph(
    "Tahap ini memperbaiki fondasi aplikasi dan mengubah sumber data stasiun serta "
    "beberapa operasi utama menjadi layanan REST yang dapat diuji. Namun aplikasi belum "
    "dapat dinyatakan memenuhi seluruh arsitektur PRD. Status final pada workbook harus "
    "tetap menggunakan Terpenuhi, Sebagian, atau Belum Ada berdasarkan bukti aktual."
)

doc.add_paragraph(
    "File evaluasi workbook: D:\\firda\\SISTER\\Pemetaan_Slide_ClimaGrid.xlsx"
)

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer.add_run("ClimaGrid v1.0 — Dokumentasi Perbaikan")

doc.save(out)
print(out)
