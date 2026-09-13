# Reproducible macOS profiling

Use commit/version, macOS version, machine architecture, window size, display scale, build profile, result width/value lengths and database versions in every report. Do not compare Activity Monitor's Memory directly with RSS or Node heap. **No remote/live DB tests.** Start with empty isolated data and only loopback services or a new SQLite file. Do not copy existing DBX storage.

## Build and launch

Install Rust 1.94.1 (`rustup toolchain install 1.94.1 --profile minimal`) and Node >=22.13. Install dependencies with `npx pnpm@10.27.0 install --frozen-lockfile`.

```
node scripts/lite/run.mjs build
DBX_DATA_DIR=/absolute/path/to/isolated-fixture node scripts/lite/run.mjs start
```

For a quicker development build, append `--debug` to both commands. This uses compiled frontend assets, with no Vite server needed. Development native builds omit debug symbols but are not release optimized; label measurements accordingly. Default launcher data is `.dbx-lite-data` inside this checkout. The installed app has its own `com.dbx.lite` identity. Standalone MCP must receive the same explicit `DBX_DATA_DIR` if sharing this fixture.

## Native A–J workload

Perform the same steps on upstream and Lite with fresh data directories, the same build profile and identical dimensions. Do three runs. Keep Inspector closed for normal memory samples; repeat a separate diagnostic run with Inspector when needed.

| Stage | Operation, then 15 seconds idle before sampling |
| --- | --- |
| A | Fresh launch; record time until usable and idle CPU/memory. |
| B | Connect PostgreSQL at 127.0.0.1:5432 (only local). |
| C | Expand database/schema/table tree; record schema/table counts. |
| D | Open query editor. |
| E | Set result page limit to 1,000 and run `SELECT i, repeat('x', 80) AS value FROM generate_series(1,1000) AS i`. |
| F | Repeat with limit and series 10,000. Record query-to-visible-render delay. |
| G | Close tab; idle 30 seconds; record memory again. |
| H | Open five query tabs and run F in each. |
| I | Close all five; idle 30 seconds. |
| J | Repeat H–I ten times; report every cycle, last-five trend, peak and final idle. |

Also repeat F with 20 string columns; row count alone is not a memory workload specification. Verify scroll responsiveness, DOM count, edit/save/revert on an owned SQLite table, selected-statement execution, invalid SQL, reconnect, import/export. SSH needs an explicitly local SSH fixture; do not reuse a production tunnel to satisfy coverage.

Use `scripts/lite/sample-macos.py --label A --pids NATIVE WEBKIT GPU NETWORK --output measurements.jsonl` after attributing PIDs. WebKit XPC processes can have launchd as parent, so PPID alone cannot identify ownership. Capture process inventory before/after isolated app launch and verify Activity Monitor grouping. Do not include other WebKit apps' processes. The script records selected per-process RSS/CPU and invokes Apple's `footprint` for physical footprint. The sum can include shared memory; preserve raw output and do not label it JS heap.

For attribution, inspect `footprint`/`vmmap -summary` for native and WebKit processes. Safari Develop > DBX Lite opens Web Inspector where available; use JS heap allocation snapshots around F/G and inspect retained result arrays, CodeMirror instances, detached DOM and closures. Instruments Allocations/VM Tracker is needed to distinguish Rust heap from other native allocations. WebKit graphics/JS/native heaps cannot be accurately separated from a single RSS figure.

## Offline cache benchmark

```
TSX_TSCONFIG_PATH=apps/desktop/tsconfig.json node --expose-gc --import tsx scripts/lite/benchmark-result-cache.ts 1000
TSX_TSCONFIG_PATH=apps/desktop/tsconfig.json node --expose-gc --import tsx scripts/lite/benchmark-result-cache.ts 10000
```

This fixture deliberately aliases one result in displayed/result-list/run state. It verifies snapshot and restored identity, encoded bytes, encode/decode time, retained Node heap delta and process peak RSS. It never opens a database. Retained delta includes the snapshot, buffer and restored value while the input fixture remains alive; it is not total DBX memory. Compare three fresh processes per revision, not multiple runs in one warmed process. The v2 format reads v1 snapshots; upstream older readers cannot read v2, which is why Lite storage is isolated.

## MCP local regression

`crates/dbx-mcp/examples/lite_local_smoke.rs` initializes the real MCP server/client over an in-memory transport, fresh storage, read-only PG/MySQL/SQL Server configs hardcoded to 127.0.0.1, and an owned temporary SQLite database. It exercises discovery, query limits, errors, schema and session/reconnect behavior. Supply the local SQL Server password in `DBX_LITE_SQLSERVER_PASSWORD`, never in source/command arguments or logs.

```
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo run -p dbx-mcp --no-default-features --features sqlite-bundled --example lite_local_smoke
```

No upstream live integration suite or environment URL should be used. Missing local credentials are a skipped coverage item, never a reason to fall back to a remote database.
