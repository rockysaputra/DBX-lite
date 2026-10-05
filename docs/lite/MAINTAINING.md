# Panduan maintainer DBX Lite

DBX Lite adalah fork pribadi dari klien database `t8y2/dbx` (remote fork: `rockysaputra/DBX-lite`). Aplikasinya Tauri 2 (host Rust) dengan antarmuka Vue 3 di dalam WebView. "Lite" bukan fork kode, melainkan konfigurasi build: identitas app sendiri, updater mati, dan beberapa fitur berat tidak ikut dikompilasi.

Dokumen ini menjelaskan cara menjalankan, mem-build, mengetes, dan di mana harus mengubah kode. Ditulis 2026-10-05 dari isi repo saat itu.

## Mulai cepat

Prasyarat:

| Alat | Versi | Sumber |
| --- | --- | --- |
| Rust | 1.94.1 | `rust-toolchain.toml` (rustup memasangnya otomatis) |
| Node | >= 22.13 | `package.json` `engines` |
| pnpm | 10.27.0 | `package.json` `packageManager` |
| JDK 21 + Gradle wrapper | hanya untuk `agents/` | tidak perlu untuk build Lite biasa |

```bash
pnpm install          # sekali, atau setelah pnpm-lock.yaml berubah
pnpm lite:dev         # jalankan app dengan hot reload
pnpm lite:build       # bundle rilis -> target/release/bundle/macos/DBX Lite.app
pnpm lite:start       # jalankan bundle rilis yang sudah di-build
```

`pnpm lite:build` dari cache kosong butuh sekitar 11 menit di mesin ini (profil rilis memakai LTO dan `codegen-units = 1`).

## Menjalankan dan mem-build

Semua perintah `lite:*` lewat `scripts/lite/run.mjs`. Skrip itu memanggil Tauri CLI dengan `--config src-tauri/tauri.lite.conf.json --features lite -- --no-default-features`, dan mengatur `DBX_DATA_DIR`.

| Perintah | Hasil |
| --- | --- |
| `pnpm lite:dev` | `tauri dev`: Vite mode `lite` + host Rust profil dev |
| `pnpm lite:build` | Bundle rilis di `target/release/bundle/macos/DBX Lite.app` |
| `pnpm lite:build:debug` | Bundle debug di `target/debug/bundle/macos/` |
| `pnpm lite:start` | Menjalankan bundle rilis (tambah `:debug` untuk bundle debug) |

### Folder data: dua perilaku berbeda

- Lewat `pnpm lite:dev` / `lite:start`: data disimpan di `<checkout>/.dbx-lite-data` (atau nilai `DBX_DATA_DIR` kalau kamu set). Koneksi tersimpan milik app terpasang tidak ikut.
- App dibuka langsung (Spotlight, Finder, `/Applications`): `DBX_DATA_DIR` tidak di-set, jadi app memakai folder data bawaan untuk identitas `com.dbx.lite` (`~/Library/Application Support/com.dbx.lite`).

Logika pemilihannya ada di `src-tauri/src/data_dir.rs`.

### Memasang build baru ke /Applications

`lite:build` tidak menyentuh `/Applications`. Untuk memasang:

```bash
# tutup DBX Lite dulu
rm -rf "/Applications/DBX Lite.app"
ditto "target/release/bundle/macos/DBX Lite.app" "/Applications/DBX Lite.app"
```

Catatan:

- App memakai plugin single-instance. Kalau salinan lama masih jalan, membuka salinan baru hanya memunculkan jendela yang lama.
- Selama bundle di `target/` ada, Spotlight menampilkan dua "DBX Lite". Hapus bundle di `target/release/bundle/macos/` setelah dipasang.
- Build lokal bertanda tangan ad-hoc, jadi macOS bisa meminta izin Keychain lagi.
- Untuk memastikan binary mana yang terpasang: `dwarfdump --uuid "/Applications/DBX Lite.app/Contents/MacOS/dbx"`, lalu bandingkan dengan UUID di laporan crash.

## Pengecekan dan test

```bash
pnpm check                 # tipe koneksi + oxfmt + oxlint + vue-tsc + vitest, paralel
pnpm test                  # vitest (meregenerasi tipe koneksi dulu)
pnpm vitest run <path.spec.ts>
pnpm vitest run -t "nama test"
pnpm typecheck | pnpm lint | pnpm fmt

make cargo-check-fast      # cargo check --no-default-features --features sqlite-bundled
make cargo-test-fast       # sama, dengan RUST_MIN_STACK=8388608
cargo test -p dbx-core --no-default-features --features sqlite-bundled <nama_test>
```

Vitest mencakup `packages/app-tests/*.test.ts`, `apps/desktop/src/**/*.spec.ts`, dan `docs/lib/*.test.ts`.

Hal yang perlu diketahui tentang test Rust:

- `make cargo-test-fast` berhenti di crate pertama yang gagal. Crate `dbx` (src-tauri) jalan lebih dulu, jadi kalau ada yang gagal di sana, test `dbx-core` tidak dieksekusi. Jalankan `cargo test -p dbx-core ...` terpisah.
- Per 2026-10-05, test berikut gagal di mesin ini dan belum diselidiki (tidak terkait SQL Server; belum dicek apakah gagal juga di commit sebelumnya):
  - 6 test di `src-tauri/src/commands/mcp.rs` soal deteksi instalasi pnpm.
  - `query::tests::external_driver_preview_retry_preserves_marker_truncation` di `crates/dbx-core/src/query.rs` (plugin JDBC tiruan timeout 5 detik).
- Binary test memakan banyak disk: `target/debug` tumbuh sampai 45 GB setelah satu putaran `cargo-test-fast`. Cek ruang kosong sebelum menjalankan, dan hapus `target/debug` sesudahnya kalau perlu.

Hook pre-commit (`.husky/pre-commit`) menjalankan `lint-staged` (oxfmt untuk `apps/desktop/src`) dan `cargo fmt` pada file Rust yang di-stage di `src-tauri`, `crates/dbx-core`, `crates/dbx-web`.

## Peta repo

| Path | Isi |
| --- | --- |
| `crates/dbx-core` | Semua logika database. Tanpa dependensi Tauri. |
| `src-tauri` | Shell desktop: command Tauri, jendela, konfigurasi bundle. |
| `apps/desktop` | Frontend Vue 3 + Pinia + Vite. |
| `crates/dbx-web` | Backend HTTP (Axum) untuk mode web. |
| `crates/dbx-mcp` | Server MCP di atas `AppState` yang sama. |
| `crates/dbx-cli` | CLI. |
| `crates/dbx-sqlite-worker` | Proses worker SQLite. |
| `agents/` | Driver JDBC/sidecar on-demand (Gradle, JDK 21), satu folder per mesin di `agents/drivers/`. |
| `plugins/connection-types/*.yaml` | Sumber deskriptor tipe koneksi; file TS-nya digenerasi. |
| `vendor/` | Crate yang di-patch lewat `[patch.crates-io]`. |
| `packages/` | Paket npm (CLI, mcp-server, mongo-shell) dan `app-tests`. |
| `scripts/lite/` | Launcher Lite, benchmark cache hasil, sampler RAM macOS. |
| `docs/` | Situs dokumentasi (Next.js) plus catatan desain. |

`handoff.md` adalah peninggalan upstream dan tidak menggambarkan pekerjaan fork ini.

## Arsitektur

### Alur satu query

```
Komponen Vue
  -> store Pinia        apps/desktop/src/stores/queryStore.ts, connectionStore.ts
  -> lapisan backend    apps/desktop/src/lib/backend/api.ts  (memilih tauri.ts atau http.ts)
  -> command Tauri      src-tauri/src/commands/*.rs
  -> dbx-core           crates/dbx-core/src/query.rs -> crates/dbx-core/src/db/<mesin>.rs
```

- `queryStore` memegang tab, hasil query, eksekusi, dan pemulihan sesi. `connectionStore` memegang konfigurasi tersimpan dan status koneksi.
- Command Tauri bukan pembungkus murni. Contoh: `execute_query` juga mendaftarkan task yang sedang jalan supaya bisa dibatalkan.
- Command didaftarkan di `tauri::generate_handler![...]` dalam `src-tauri/src/lib.rs`. Command baru yang tidak didaftarkan di sana tidak bisa dipanggil dari frontend.

### dbx-core

`AppState` menyimpan registry koneksi, pool, query yang sedang jalan, tunnel, storage, dan manajer agent. Driver native ada di `crates/dbx-core/src/db/` (misalnya `mysql.rs`, `postgres.rs`, `sqlserver.rs`, `sqlite.rs`, `redis_driver.rs`, `mongo_driver.rs`). Mesin lain dijalankan lewat agent di `agents/`.

Perbaikan terkait database taruh di `dbx-core`, supaya desktop, web, MCP, dan CLI semuanya ikut dapat.

### Apa yang membuat build ini "Lite"

| Lapisan | Mekanisme | Efek |
| --- | --- | --- |
| Konfigurasi Tauri | `src-tauri/tauri.lite.conf.json` | Nama "DBX Lite", identitas `com.dbx.lite`, skema deep-link `dbx-lite`, endpoint updater kosong, target bundle hanya `app` |
| Fitur Cargo | `lite` di `src-tauri/Cargo.toml` | `dynamodb`, `sqlite-multiple-ciphers`, `system-fonts`. Tanpa `duckdb-sidecar` dan `mq-admin` |
| Frontend | Vite `--mode lite` -> `import.meta.env.VITE_DBX_LITE` (`apps/desktop/vite.config.ts`) | Menyaring pilihan di dialog koneksi baru (`components/connection/ConnectionDialog.vue`) |

Implementasi driver dan konfigurasi tersimpan tidak dihapus; hanya tidak ditawarkan atau tidak dikompilasi.

Residensi hasil query dibatasi untuk tab tidak aktif (5 hasil / 128 MiB) dengan cache disk MessagePack. Rinciannya di `docs/dbx-lite-design.md` dan `docs/dbx-lite-profiling.md`.

### Crate vendored

Alasan tiap patch tertulis sebagai komentar di `Cargo.toml` bagian `[patch.crates-io]`. Ringkasnya: `wry` (perbaikan WebView2 Windows), `tauri-plugin-updater`, `ctor`, `dirs-sys`, `pageant` (kompatibilitas Windows 7), `rumqttc` (MQTT 3.1), `tiberius` (SQL Server).

Patch lokal pada `vendor/tiberius`:

- Decode string yang toleran (surrogate UTF-16 tak berpasangan, byte tidak valid di collation).
- Decode `sql_variant` (`src/tds/codec/column_data/variant.rs`).
- Tipe kolom yang tidak didukung mengembalikan `Error::Protocol`, bukan `todo!()`/`unimplemented!()`.

Mengetes crate vendored: `cargo test -p tiberius` ditolak karena crate itu di-`exclude` dari workspace. Caranya, buat crate sementara di luar repo: salin `vendor/tiberius/Cargo.toml`, buang `[dev-dependencies.*]` selain `tokio`, `tokio-util`, `uuid`, tambahkan `[workspace]` kosong, symlink `src` ke `vendor/tiberius/src`, lalu:

```bash
cargo test --lib --no-default-features \
  --features tds73,chrono,rust_decimal,rustls,sql-browser-tokio
```

Itu set fitur yang sama dengan yang dipakai `dbx-core`.

## Pekerjaan umum

**Mengubah perilaku satu mesin database.** Edit `crates/dbx-core/src/db/<mesin>.rs`, tambahkan test di modul `tests` file yang sama, jalankan `cargo test -p dbx-core --no-default-features --features sqlite-bundled <nama>`.

**Menambah command Tauri.** Tulis fungsinya di `src-tauri/src/commands/`, daftarkan di `generate_handler!` (`src-tauri/src/lib.rs`), tambahkan pemanggilnya di `apps/desktop/src/lib/backend/tauri.ts` dan `api.ts`. Kalau fitur itu harus jalan di mode web juga, tambahkan pasangan di `http.ts` dan `crates/dbx-web`.

**Mengubah tipe koneksi.** Edit `plugins/connection-types/*.yaml`, lalu `pnpm generate:connection-types`. File hasil generasi jangan diedit tangan; `pnpm check` memverifikasi keduanya sinkron.

**Backport dari upstream.** Catat di `docs/lite/upstream-backports-YYYY-MM-DD.md` apa yang benar-benar diverifikasi. Backport harus mempertahankan fitur build Lite, identitas app, isolasi updater, dan layout storage.

**Halaman dokumentasi baru** di `docs/content/docs/` harus didaftarkan di `meta.json` dan `meta.cn.json`.

## Kalau app force close

1. Ambil laporan crash di `~/Library/Logs/DiagnosticReports/dbx-*.ips`.
2. `Exception Type: EXC_CRASH (SIGABRT)` dengan `abort() called` di thread `tokio-rt-worker` berarti panic Rust. Profil rilis memakai `panic = "abort"` (`Cargo.toml`), jadi panic apa pun langsung mematikan proses. Akibatnya `catch_unwind` (misalnya `sqlserver_driver_result` di `db/sqlserver.rs`) tidak berpengaruh di build rilis.
3. Binary rilis di-`strip`, jadi stack di laporan tidak bersimbol. Untuk melihat pesan panic, reproduksi dengan `pnpm lite:dev` atau `pnpm lite:build:debug`; pesan panic muncul di terminal.
4. Cari `todo!(`, `unimplemented!(`, `unwrap()`, `expect(` di jalur yang dicurigai, termasuk di `vendor/`.
5. Cocokkan UUID binary di laporan dengan binary terpasang sebelum menyimpulkan sebuah fix gagal.

Panic yang diketahui masih mungkin: `Numeric::new_with_scale` di `vendor/tiberius/src/tds/numeric.rs` meng-`assert!(scale < 38)`, sehingga kolom `numeric(38,38)` bisa mematikan app.

## Memori

Pengukuran Activity Monitor 2026-10-04 (satu koneksi, satu hasil terbuka): total sekitar 477 MB, proses konten WebView sekitar 366 MB, host Rust sekitar 55 MB. Pekerjaan penghematan RAM sebaiknya menyasar sisi WebView (salinan hasil, editor, grid, cache), bukan backend Rust. Jangan mengklaim penghematan tanpa pengukuran di beban kerja yang sama pada kedua sisi.

Percobaan menulis ulang shell dengan Slint dihentikan dan dihapus 2026-10-04.

## Aturan yang berlaku di fork ini

- Test dan smoke run hanya boleh menyentuh database localhost (IP loopback literal) dengan fixture buatan sendiri. Jangan pernah database remote, profil tersimpan, keychain, atau environment `DBX_TEST_*` / `DBX_LIVE_*` / `DBX_REVIEW_*`.
- Jangan mengimpor konfigurasi DBX yang sudah ada ke data dir pengembangan.
- Tidak ada push, PR, atau rilis tanpa permintaan eksplisit.
- Subjek commit: `type(scope): ringkasan`, misalnya `fix(sqlserver): ...`.
- Test menguji fungsi produksi atau komponen yang di-mount dan memeriksa perilaku yang teramati, bukan mencocokkan string sumber.
- `target/` bisa mencapai puluhan GB. Cek ruang disk sebelum build besar.
