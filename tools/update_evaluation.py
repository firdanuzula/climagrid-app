import openpyxl
from pathlib import Path

source = Path(r"D:\firda\SISTER\Pemetaan_Slide_ClimaGrid.xlsx")
workbook = openpyxl.load_workbook(source)
sheet = workbook["Pemetaan Slide"]

updates = {
    ("2", "Tiga tantangan", "Data ganda"): ("Sebagian", "server.js; tests/api.test.js", "Idempotency key dan SHA-256 nyata; belum database/RPC retransmisi."),
    ("3", "Enam pilar", "RESTful API"): ("Terpenuhi", "server.js", "Delapan endpoint REST tersedia dan diuji."),
    ("3", "Enam pilar", "RPC"): ("Belum ada", "proto/climagrid.proto", "IDL ada, transport gRPC Go/Node belum dijalankan."),
    ("3", "Enam pilar", "MPI"): ("Sebagian", "analytics/mpi_idw.py", "IDW serial dan kerangka MPI tersedia; mpi4py belum terpasang."),
    ("3", "Enam pilar", "Caching"): ("Sebagian", "server.js; sw.js", "LRU dan lease di backend; Redis/conditional callback produksi belum ada."),
    ("4", "Arsitektur empat tier", "API Gateway"): ("Sebagian", "server.js", "Gateway lokal, autentikasi, rate limit, ETag; belum Go/chi/mTLS."),
    ("4", "Arsitektur empat tier", "Tier 2 RPC middleware"): ("Sebagian", "proto/climagrid.proto", "IDL dan format tipe tetap tersedia; gRPC stub belum berjalan."),
    ("4", "Arsitektur empat tier", "Tier 3 Master, Worker Ingest, Worker MPI"): ("Sebagian", "server.js; analytics/mpi_idw.py", "Job dan ingest lokal nyata; Master/Worker terpisah belum ada."),
    ("4", "Arsitektur empat tier", "Tier 4 Chord DHT A/B/C"): ("Sebagian", "server.js", "Tiga node in-memory, hash, successor dan RF=3; gagal node/W-R/finger table penuh belum ada."),
    ("6", "Delapan endpoint API", "POST/GET readings"): ("Terpenuhi", "server.js", "POST dan GET berhasil serta idempotency/divergen diuji."),
    ("6", "Delapan endpoint API", "GET stations?provinsi=&sensor="): ("Terpenuhi", "server.js", "Filter provinsi/sensor di API berhasil."),
    ("6", "Delapan endpoint API", "POST/GET/DELETE analytics/jobs"): ("Terpenuhi", "server.js", "Submit, status, dan cancel tersedia serta idempotency diuji."),
    ("6", "Delapan endpoint API", "GET maps/{variable}?time="): ("Terpenuhi", "server.js", "Endpoint peta dan cache LRU/lease tersedia."),
    ("6", "Delapan endpoint API", "GET alerts?wilayah="): ("Terpenuhi", "server.js", "Endpoint peringatan berwilayah tersedia."),
    ("6", "Delapan endpoint API", "Respons 202 dan idempotensi"): ("Terpenuhi", "server.js", "202 untuk job, idempotency untuk ingest/job."),
    ("7", "Client dan Server Stub", "IDL WeatherService"): ("Sebagian", "proto/climagrid.proto", "Proto tersedia; belum server/client gRPC."),
    ("9", "MPI paralel", "Studi kasus 2: IDW"): ("Sebagian", "analytics/mpi_idw.py", "Kerangka scatter/gather dan serialisasi hasil; mpi4py tidak terpasang."),
    ("9", "MPI paralel", "Studi kasus 1: statistik deret waktu"): ("Sebagian", "analytics/mpi_idw.py", "Kerangka IDW ada; statistik MPI belum lengkap."),
    ("10", "Caching dan konsistensi", "Lease peta 30 detik"): ("Sebagian", "server.js", "Lease 30 detik dan ETag; callback Redis belum ada."),
    ("10", "Caching dan konsistensi", "LRU, Conditional GET, Check-on-Use, Edge Server"): ("Sebagian", "server.js", "LRU dan ETag 200/304; Redis/check-on-use produksi belum ada."),
    ("11", "Tujuh layanan backend", "Gateway, Master, Worker, Chord, Edge Cache"): ("Sebagian", "server.js; proto; analytics; db", "Komponen lokal terwakili; Go/Redis/PostgreSQL/TimescaleDB terpisah belum ada."),
    ("11", "Tujuh layanan backend", "Observability"): ("Sebagian", "server.js", "Health dan metrik dasar aktual; Prometheus/Grafana/OpenTelemetry belum."),
    ("12", "Model data inti", "stations dan station_attributes"): ("Sebagian", "data/stations.json; db/schema.sql", "Data JSON aktual dan skema SQL; belum PostgreSQL aktif."),
    ("12", "Model data inti", "readings"): ("Sebagian", "server.js; db/schema.sql", "Pembacaan POST/GET dan payload SHA-256; penyimpanan JSON belum TimescaleDB."),
    ("12", "Model data inti", "ingest_batches, jobs, job_results"): ("Sebagian", "server.js; db/schema.sql", "State JSON dan skema SQL; belum database aktif."),
    ("13", "Kamus tabel dan indeks", "Tabel, indeks, retensi"): ("Sebagian", "db/schema.sql", "DDL lengkap dasar tersedia; migration/retensi aktif belum dijalankan."),
    ("13", "Kamus tabel dan indeks", "Agregat per jam"): ("Sebagian", "db/schema.sql; app.js: chartData()", "Agregat SQL dan grafik klien ada; continuous aggregate belum dijalankan."),
    ("14", "Partisi, replikasi, kapasitas", "Alur tulis idempoten, W=2/R=2, anti-entropy"): ("Sebagian", "server.js", "Deduplikasi dan tiga replika in-memory; quorum/failure/anti-entropy produksi belum diuji."),
    ("15", "Topologi jaringan", "VLAN, DMZ, firewall, TLS"): ("Belum ada", "-", "Belum ada Docker/VLAN/mTLS/TLS produksi."),
    ("16", "Port, latensi, kegagalan", "mTLS, gRPC, port, token, rate limit"): ("Sebagian", "server.js", "Bearer token/rate limit; gRPC/mTLS/port PRD belum."),
    ("16", "Port, latensi, kegagalan", "Latensi p95"): ("Belum ada", "tests/api.test.js", "Belum ada pengukuran beban dan p95."),
    ("17", "Kebutuhan FR/NFR", "FR-01 REST API"): ("Terpenuhi", "server.js; tests/api.test.js", "Delapan endpoint dan pengujian REST berhasil."),
    ("17", "Kebutuhan FR/NFR", "FR-02 RPC dan IDL"): ("Sebagian", "proto/climagrid.proto", "IDL tersedia; RPC transport/semantik runtime belum ada."),
    ("17", "Kebutuhan FR/NFR", "FR-03 MPI"): ("Sebagian", "analytics/mpi_idw.py", "Kerangka MPI; mpi4py dan pemeriksaan rank belum tersedia."),
    ("17", "Kebutuhan FR/NFR", "FR-04 Chord DHT"): ("Sebagian", "server.js", "Chord in-memory dasar; finger table/failure recovery belum lengkap."),
    ("17", "Kebutuhan FR/NFR", "NFR-01 Cache <100 ms"): ("Belum ada", "-", "Belum ada pengukuran p95 cache."),
    ("17", "Kebutuhan FR/NFR", "NFR-02 Tanpa data ganda/job ganda"): ("Sebagian", "server.js; tests/api.test.js", "Deduplikasi diuji; sifat end-to-end pada cluster belum."),
    ("17", "Kebutuhan FR/NFR", "NFR-03 Skalabilitas"): ("Belum ada", "-", "Belum ada pengujian 5.000 stasiun dan scaling worker."),
    ("17", "Kebutuhan FR/NFR", "NFR-04 Little-endian, IEEE 754"): ("Sebagian", "proto/climagrid.proto", "fixed32/fixed64/float digunakan; interoperabilitas belum diuji lintas runtime."),
}

for row in range(5, sheet.max_row + 1):
    slide = str(sheet.cell(row, 1).value or "").strip()
    topic = str(sheet.cell(row, 2).value or "").strip()
    aspect = str(sheet.cell(row, 3).value or "").strip()
    update = updates.get((slide, topic, aspect))
    if update:
        sheet.cell(row, 4).value = update[0]
        sheet.cell(row, 5).value = update[1]
        sheet.cell(row, 6).value = update[2]

if "Evaluasi Terbaru" in workbook.sheetnames:
    del workbook["Evaluasi Terbaru"]
evaluation = workbook.create_sheet("Evaluasi Terbaru")
evaluation.append(["Nomor slide", "Aspek kebutuhan", "Status implementasi terbaru", "Lokasi file kode", "Bukti implementasi", "Hasil pengujian"])
for key, update in updates.items():
    evaluation.append([key[0], f"{key[1]} — {key[2]}", update[0], update[1], update[2],
                       "Terbukti via pengujian lokal" if key[0] in {"3", "6", "17"} and update[0] == "Terpenuhi" else "Belum diuji penuh"])

workbook.save(source)
print("Updated", source)
