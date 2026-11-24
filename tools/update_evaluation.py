import openpyxl
from pathlib import Path


WORKBOOK = Path(r"D:\firda\SISTER\Pemetaan_Slide_ClimaGrid.xlsx")
UPDATES = {
    (1, "Identitas proyek"): ("Terpenuhi", "README.md; index.html", "Nama dan tujuan proyek tersedia.", "Dokumentasi diperiksa."),
    (2, "Volume data"): ("Sebagian", "backend/ingest.js; tests/load-failover.test.js", "Ingest berjalan lokal; uji beban memakai 20 pembacaan, bukan 5.000 stasiun.", "node tests/load-failover.test.js — p95 ingest 43,94 ms."),
    (2, "Komputasi berat"): ("Sebagian", "backend/master.js; backend/worker.js; analytics/mpi_idw.py", "Job dijalankan worker lokal; MPI multi-rank tidak dapat diuji karena mpi4py/mpiexec tidak tersedia.", "node tests/mpi.test.js — serial-fallback; MPI runtime available: false."),
    (2, "Data ganda"): ("Sebagian", "backend/ingest.js; backend/store.js; tests/load-failover.test.js", "Idempotensi dan satu pembacaan setelah failover terbukti di satu proses lokal; belum diuji lintas cluster.", "node tests/load-failover.test.js — failover duplicate check passed."),
    (2, "Visi: ringkasan, peta, peringatan"): ("Terpenuhi", "app.js: viewDashboard(), viewMap(), viewAlerts()", "Tiga tampilan produk tersedia.", "Pemeriksaan browser lokal."),
    (3, "Arsitektur hibrida"): ("Sebagian", "backend/gateway.js; backend/ingest.js; backend/master.js; backend/worker.js; backend/dht.js", "Komponen dipisah sebagai modul, tetapi masih berjalan dalam satu proses Node.js.", "node tests/api.test.js; node tests/dht.test.js — lulus."),
    (3, "Penamaan (Chord DHT)"): ("Sebagian", "backend/dht.js", "Finger table, lookup, quorum, repair, dan handoff berjalan in-process; deployment cluster belum diuji.", "node tests/dht.test.js — quorum, repair, handoff, lookup passed."),
    (3, "RESTful API"): ("Terpenuhi", "server.js; tests/api.test.js", "Endpoint API yang ada dan endpoint tambahan diuji.", "node tests/api.test.js — API tests passed."),
    (3, "RPC"): ("Terpenuhi", "backend/rpc.js; proto/climagrid.proto; tests/rpc.test.js", "Transport gRPC Node.js aktif untuk layanan lokal; bukan transport antar-host.", "node tests/rpc.test.js — gRPC ingest/read/job/result/alert tests passed."),
    (3, "MPI"): ("Sebagian", "analytics/mpi_idw.py; backend/worker.js", "Bcast/Scatter/Gather dan studi statistik tersedia; hasil yang bisa dijalankan di lingkungan ini memakai fallback serial.", "node tests/mpi.test.js — serial-fallback; MPI runtime available: false."),
    (3, "Caching"): ("Sebagian", "backend/edge-cache.js; tests/cache.test.js", "LRU, lease, invalidasi, dan fallback tersedia; Redis server tidak tersedia untuk uji integrasi.", "node tests/cache.test.js — Edge cache LRU and lease tests passed."),
    (4, "Tier 1 Presentation"): ("Terpenuhi", "index.html; app.js; styles.css", "PWA tetap berupa HTML/CSS/JS tanpa frontend build step.", "Pemeriksaan browser lokal."),
    (4, "API Gateway"): ("Sebagian", "backend/gateway.js; server.js", "Gateway lokal menangani auth, rate limit, ETag, dan trace; belum deployment gateway terpisah.", "node tests/api.test.js — lulus."),
    (4, "Tier 2 RPC middleware"): ("Sebagian", "backend/rpc.js; proto/climagrid.proto", "gRPC Node.js nyata diuji lokal; belum komunikasi lintas host atau mTLS.", "node tests/rpc.test.js — lulus."),
    (4, "Tier 3 Master, Worker Ingest, Worker MPI"): ("Sebagian", "backend/master.js; backend/worker.js; backend/ingest.js", "Antrean dan worker berfungsi dalam proses yang sama; worker dapat dipause untuk uji antrean.", "node tests/load-failover.test.js — worker failover passed."),
    (4, "Tier 4 Chord DHT A/B/C"): ("Sebagian", "backend/dht.js; tests/dht-api.test.js", "Tiga node Chord in-process diuji; belum node lintas mesin.", "node tests/dht-api.test.js — DHT endpoint failover test passed."),
    (5, "Structured naming"): ("Sebagian", "server.js; proto/climagrid.proto", "Rute REST dan nama operasi RPC tersedia; interoperabilitas dengan sistem eksternal belum diuji.", "node tests/api.test.js; node tests/rpc.test.js — lulus."),
    (5, "Flat naming (Chord)"): ("Sebagian", "backend/dht.js; tests/dht.test.js", "Lookup Chord dan finger table diuji dalam ring lokal; skalabilitas ring produksi belum diuji.", "node tests/dht.test.js — lookup hops assertion passed."),
    (5, "Attribute-based naming"): ("Terpenuhi", "backend/attribute-index.js; app.js; tests/api.test.js", "Filter provinsi/sensor/tipe/operator tersedia melalui API dan pencarian frontend.", "node tests/api.test.js — station filters and search passed."),
    (6, "POST/GET readings"): ("Terpenuhi", "server.js; backend/ingest.js; tests/api.test.js", "Validasi, ingest, histori, deduplikasi, dan invalidasi cache diuji.", "node tests/api.test.js — API tests passed."),
    (6, "GET stations?provinsi=&sensor="): ("Terpenuhi", "server.js; backend/attribute-index.js; tests/api.test.js", "Filter atribut dan query teks teruji.", "node tests/api.test.js — station filters and search passed."),
    (6, "POST/GET/DELETE analytics/jobs"): ("Terpenuhi", "server.js; backend/master.js; tests/api.test.js", "Submit dan status diuji; DELETE mengembalikan 204 untuk job selesai.", "node tests/api.test.js — job lifecycle passed."),
    (6, "GET maps/{variable}?time="): ("Terpenuhi", "server.js; backend/edge-cache.js; tests/api.test.js", "Peta API, ETag, cache hit, dan invalidasi setelah ingest diuji.", "node tests/api.test.js — map ETag and cache invalidation passed."),
    (6, "GET alerts?wilayah="): ("Terpenuhi", "server.js; backend/rpc.js; tests/api.test.js", "Peringatan API dan operasi Publish idempotent diuji.", "node tests/api.test.js; node tests/rpc.test.js — lulus."),
    (6, "Respons 202 dan idempotensi"): ("Terpenuhi", "backend/rpc.js; tests/api.test.js; tests/rpc.test.js", "Job memberi 202; ingest, job, hasil, dan alert memakai deduplikasi lokal.", "node tests/api.test.js; node tests/rpc.test.js — lulus."),
    (7, "IDL WeatherService"): ("Terpenuhi", "proto/climagrid.proto; backend/rpc.js; tests/rpc.test.js", "Proto dimuat oleh server dan client gRPC Node.js.", "node tests/rpc.test.js — gRPC service tests passed."),
    (8, "At-least-once / at-most-once"): ("Terpenuhi", "backend/rpc.js; tests/rpc.test.js", "Ingest/read idempotent dan job/store/alert duplicate-filter diuji pada transport lokal.", "node tests/rpc.test.js — duplicate filtering passed."),
    (9, "Studi kasus 2: IDW"): ("Sebagian", "analytics/mpi_idw.py; backend/worker.js", "IDW serial checksum cocok; jalur MPI tersedia tetapi multi-rank tidak bisa dijalankan.", "node tests/mpi.test.js — serial checksum passed; MPI unavailable."),
    (9, "Studi kasus 1: statistik deret waktu"): ("Sebagian", "analytics/mpi_idw.py; backend/worker.js", "Statistik dan moving average serial teruji; MPI multi-rank tidak teruji.", "node tests/mpi.test.js — serial-fallback passed."),
    (9, "Bcast, Scatter, Gather, Reduce, Isend/Irecv"): ("Sebagian", "analytics/mpi_idw.py", "Primitif MPI diimplementasikan; tidak ada bukti eksekusi multi-rank di lingkungan ini.", "node tests/mpi.test.js — MPI runtime available: false."),
    (10, "Cache klien/aset"): ("Terpenuhi", "sw.js; server.js", "Cache aplikasi PWA dan endpoint statis tetap tersedia; UI browser diuji.", "Pemeriksaan browser lokal."),
    (10, "Lease peta 30 detik"): ("Sebagian", "server.js; backend/edge-cache.js; app.js", "Lease SSE dan callback invalidasi lokal tersedia; Redis Pub/Sub lintas proses belum diuji.", "node tests/cache.test.js; node tests/api.test.js — lulus."),
    (10, "LRU, Conditional GET, Check-on-Use, Edge Server"): ("Sebagian", "backend/edge-cache.js; server.js; tests/cache.test.js", "LRU, ETag/304, invalidasi, dan fallback memory teruji; Redis server tidak tersedia.", "node tests/cache.test.js; node tests/api.test.js — lulus."),
    (11, "Gateway, Master, Worker, Chord, Edge Cache"): ("Sebagian", "backend/*.js", "Komponen tersedia sebagai modul satu proses; belum service deployment terpisah.", "node tests/api.test.js; node tests/dht.test.js — lulus."),
    (11, "Observability"): ("Sebagian", "backend/metrics.js; backend/trace.js; server.js", "Endpoint Prometheus dan trace gateway→ingest→DHT berfungsi; OpenTelemetry/Grafana tidak dipasang.", "node tests/observability.test.js — metrics and trace tests passed."),
    (12, "stations dan station_attributes"): ("Sebagian", "data/stations.json; backend/attribute-index.js; db/schema.sql", "Data dan indeks lokal aktif; PostgreSQL belum dikonfigurasi.", "node tests/api.test.js — filter stasiun passed."),
    (12, "readings"): ("Sebagian", "backend/store.js; server.js; db/schema.sql", "Pembacaan persisten JSON, unik station/timestamp, dan SHA-256 diuji; TimescaleDB tidak aktif.", "node tests/persistence.test.js — restart test passed."),
    (12, "ingest_batches, jobs, job_results"): ("Sebagian", "backend/store.js; backend/master.js; db/schema.sql", "State JSON bertahan saat restart; backend belum menggunakan PostgreSQL.", "node tests/persistence.test.js — persistence and restart tests passed."),
    (13, "Tabel, indeks, retensi"): ("Sebagian", "backend/store.js; db/schema.sql", "Pembersihan retensi lokal berjalan dan DDL tersedia; retensi TimescaleDB belum dijalankan.", "node tests/persistence.test.js — restart/aggregate check passed."),
    (13, "Agregat per jam"): ("Sebagian", "backend/store.js; db/schema.sql", "Agregat jam lokal terisi; continuous aggregate database belum dijalankan.", "node tests/persistence.test.js — hourly aggregate present after restart."),
    (14, "Alur tulis idempoten, W=2/R=2, anti-entropy"): ("Sebagian", "backend/dht.js; tests/dht.test.js; tests/dht-api.test.js", "Quorum, read repair, handoff, anti-entropy, dan endpoint failover diuji pada ring in-process.", "node tests/dht.test.js; node tests/dht-api.test.js — passed."),
    (14, "Anggaran kapasitas 5.000 stasiun"): ("Sebagian", "tests/load-failover.test.js; backend/attribute-index.js", "5.000 stasiun sintetis digunakan untuk uji indeks lokal, bukan cluster/backend 5.000 ingest.", "node tests/load-failover.test.js — 5,000 generated; 1,667 matched; 64.25 ms."),
    (14, "Lease peta 30 detik"): ("Sebagian", "server.js; backend/edge-cache.js; app.js", "Lease dan invalidasi lokal diimplementasikan; produksi multi-node belum dibuktikan.", "node tests/cache.test.js — lease callback passed."),
    (15, "VLAN, DMZ, firewall, TLS"): ("Sebagian", "server.js; tools/create-self-signed-cert.ps1; README.md", "HTTPS opsional berhasil diuji dengan sertifikat self-signed; VLAN/DMZ/firewall produksi belum dibuat.", "HTTPS health check — passed; no Docker/VLAN deployment."),
    (16, "mTLS, gRPC, port, token, rate limit"): ("Sebagian", "server.js; backend/gateway.js; backend/rpc.js", "gRPC lokal, token/rate limit, dan HTTPS opsional ada; gRPC TLS/mTLS dan port PRD end-to-end belum.", "node tests/rpc.test.js; HTTPS health check — passed."),
    (16, "Latensi p95"): ("Sebagian", "tests/load-failover.test.js", "Pengukuran lokal memenuhi target sampel; bukan benchmark produksi/cluster.", "p95 ingest 43.94 ms; map warm 13.38 ms; submit 65.88 ms; Chord 14.82 ms."),
    (16, "Ketahanan stasiun/klien offline"): ("Sebagian", "app.js; sw.js", "PWA memiliki fallback simulasi berlabel; node worker/DHT diuji hanya dalam proses lokal.", "Pemeriksaan browser; node tests/load-failover.test.js — failover passed."),
    (17, "FR-01 REST API"): ("Terpenuhi", "server.js; tests/api.test.js", "Operasi REST dipertahankan dan diuji setelah perubahan.", "node tests/api.test.js — API tests passed."),
    (17, "FR-02 RPC dan IDL"): ("Terpenuhi", "proto/climagrid.proto; backend/rpc.js; tests/rpc.test.js", "gRPC Node.js aktif lokal dengan deadline, deduplikasi, dan layanan inti.", "node tests/rpc.test.js — passed."),
    (17, "FR-03 MPI"): ("Sebagian", "analytics/mpi_idw.py; backend/worker.js", "Serial fallback teruji dan checksum cocok; MPI multi-rank tidak tersedia.", "node tests/mpi.test.js — serial-fallback; MPI runtime available: false."),
    (17, "FR-04 Chord DHT"): ("Sebagian", "backend/dht.js; tests/dht.test.js; tests/dht-api.test.js", "Algoritma dan failover in-process teruji; belum cluster lintas mesin.", "node tests/dht.test.js; node tests/dht-api.test.js — passed."),
    (17, "FR-05 Attribute-based naming (AVTree)"): ("Terpenuhi", "backend/attribute-index.js; app.js; tests/api.test.js", "Indeks atribut ekuivalen dan frontend query/filter API aktif.", "node tests/api.test.js — station filter/search passed."),
    (17, "NFR-01 Cache <100 ms"): ("Terpenuhi", "backend/edge-cache.js; tests/load-failover.test.js", "Warm map endpoint p95 13.38 ms pada uji lokal; Redis/multi-node belum diukur.", "node tests/load-failover.test.js — p95 13.38 ms < 100 ms."),
    (17, "NFR-02 Tanpa data ganda/job ganda"): ("Sebagian", "backend/master.js; backend/ingest.js; tests/load-failover.test.js", "Satu reading dan satu eksekusi job setelah failover worker/DHT terbukti lokal; belum cluster multi-proses.", "node tests/load-failover.test.js — failover/duplicate-execution checks passed."),
    (17, "NFR-03 Skalabilitas"): ("Sebagian", "tests/load-failover.test.js", "Indeks 5.000 stasiun sintetis diukur; kapasitas end-to-end 5.000 ingest belum dibuktikan.", "node tests/load-failover.test.js — synthetic-only index result recorded."),
    (17, "NFR-04 Little-endian, IEEE 754"): ("Sebagian", "proto/climagrid.proto; backend/rpc.js", "Tipe protobuf fixed/float digunakan; pertukaran biner lintas runtime belum diuji.", "node tests/rpc.test.js — local gRPC serialization passed."),
    (18, "Penutup"): ("Terpenuhi", "PRD ClimaGrid v1.0", "Slide penutup adalah konten presentasi, bukan kriteria implementasi teknis.", "Tidak berlaku sebagai pengujian perangkat lunak."),
}


workbook = openpyxl.load_workbook(WORKBOOK)
sheet = workbook["Pemetaan Slide"]
seen = set()
for row in range(5, sheet.max_row + 1):
    slide_value = sheet.cell(row, 1).value
    aspect = str(sheet.cell(row, 3).value or "").strip()
    if slide_value is None:
        continue
    key = (int(slide_value), aspect)
    if key not in UPDATES:
        continue
    status, location, note, test = UPDATES[key]
    sheet.cell(row, 4).value = status
    sheet.cell(row, 5).value = location
    sheet.cell(row, 6).value = f"{note} Bukti: {test}"
    seen.add(key)

missing = set(UPDATES) - seen
if missing:
    raise SystemExit(f"Aspek workbook tidak ditemukan: {sorted(missing)}")

if "Evaluasi Terbaru" in workbook.sheetnames:
    del workbook["Evaluasi Terbaru"]
evaluation = workbook.create_sheet("Evaluasi Terbaru")
evaluation.append(["Slide", "Aspek", "Status", "Lokasi kode", "Bukti dan batasan", "Perintah / ukuran uji"])
for (slide, aspect), (status, location, note, test) in UPDATES.items():
    evaluation.append([slide, aspect, status, location, note, test])
evaluation.freeze_panes = "A2"
evaluation.auto_filter.ref = evaluation.dimensions
for column, width in {"A": 10, "B": 42, "C": 18, "D": 48, "E": 90, "F": 88}.items():
    evaluation.column_dimensions[column].width = width
for cell in evaluation[1]:
    cell.font = openpyxl.styles.Font(bold=True)
    cell.alignment = openpyxl.styles.Alignment(wrap_text=True, vertical="top")
for row in evaluation.iter_rows(min_row=2):
    for cell in row:
        cell.alignment = openpyxl.styles.Alignment(wrap_text=True, vertical="top")

workbook.calculation.fullCalcOnLoad = True
workbook.calculation.forceFullCalc = True
workbook.calculation.calcMode = "auto"
workbook.save(WORKBOOK)
print(f"Updated {WORKBOOK}; {len(seen)} slide aspects reviewed.")
