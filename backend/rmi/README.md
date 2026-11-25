# ClimaGrid Java RMI

Service RMI ini menambahkan method `getReadings(stationId, from, to)` tanpa
mengganti REST atau gRPC. Java RMI server menjaga remote interface dan registry;
implementasi mengambil data aktual dari endpoint REST Node.js agar semua
transport membaca sumber data yang sama. HTTP bridge hanya menjadi adapter
untuk browser, yang tidak dapat memanggil JRMP secara native.

## Prasyarat dan menjalankan

- Node.js 18+ dan dependensi project sudah terpasang.
- JDK 17+ (`java` dan `javac` tersedia pada `PATH`).

Terminal pertama, dari root repository:

```powershell
node server.js
```

Terminal kedua, compile dan jalankan service RMI:

```powershell
$sources = Get-ChildItem -Recurse backend\rmi\src -Filter *.java | ForEach-Object { $_.FullName }
New-Item -ItemType Directory -Force backend\rmi\build | Out-Null
javac -d backend\rmi\build $sources
java -cp backend\rmi\build climagrid.rmi.RmiServer
```

Buka `http://localhost:4173`, pilih **Uji komunikasi**, lalu **Uji ketiga
metode**. Menu **Laporan Perbandingan REST API, RPC, dan RMI** berada sesudah
menu pengujian.

Untuk memanggil remote method secara langsung dari Java client (terminal
ketiga):

```powershell
java -cp backend\rmi\build climagrid.rmi.RmiClient SBY-01
```

Rentang waktu ISO-8601 opsional:

```powershell
java -cp backend\rmi\build climagrid.rmi.RmiClient SBY-01 2026-01-01T00:00:00Z 2026-12-31T23:59:59Z
```

## Port dan konfigurasi

| Environment variable | Default | Fungsi |
| --- | ---: | --- |
| `CLIMAGRID_RMI_HOST` | `127.0.0.1` | Alamat bind/advertise registry dan object RMI |
| `CLIMAGRID_RMI_PORT` | `1099` | Java RMI registry |
| `CLIMAGRID_RMI_OBJECT_PORT` | `1100` | Port object remote RMI |
| `CLIMAGRID_RMI_BRIDGE_PORT` | `8765` | HTTP bridge loopback untuk gateway Node.js |
| `CLIMAGRID_RMI_BRIDGE_URL` | `http://127.0.0.1:8765` | URL bridge yang dipakai Node.js |
| `CLIMAGRID_API_URL` | `http://127.0.0.1:4173` | Backend REST sumber pembacaan |
| `CLIMAGRID_TOKEN` | kosong | Bearer token yang sama jika REST auth aktif |

Jika port dipindahkan, pastikan kedua service memakai nilai yang cocok dan
setel `CLIMAGRID_RMI_BRIDGE_URL` pada proses Node.js. Registry/object RMI dan
bridge disetel untuk penggunaan lokal; jangan membuka port RMI ke jaringan
publik tanpa autentikasi dan kebijakan firewall yang sesuai.

## Pengujian

Dengan kedua service berjalan, dari root repository:

```powershell
node tests\rmi.test.js
node tests\api.test.js
```

Tes membandingkan respons pembacaan REST, RPC langsung, dan RMI untuk stasiun
serta rentang waktu yang sama, lalu memeriksa status stasiun yang tidak dikenal.
