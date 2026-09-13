/** Synthetic, offline cache benchmark. No database or network access. */
import { performance } from "node:perf_hooks";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "../../apps/desktop/src/lib/tabs/tabResultCache";
import type { QueryResult, QueryTab } from "../../apps/desktop/src/types/database";

const rowCount = Number(process.argv[2] ?? 10000);
if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 100000) throw new Error("rows must be 1..100000");
if (!global.gc) throw new Error("Run Node with --expose-gc");
const mib = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;
const result: QueryResult = {
  columns: Array.from({ length: 20 }, (_, i) => `column_${i}`),
  rows: Array.from({ length: rowCount }, (_, i) => Array.from({ length: 20 }, (_, j) => `${i}:${j}:` + "abcdefgh".repeat(10))),
  affected_rows: 0,
  execution_time_ms: 1,
};
const tab: QueryTab = {
  id: "offline-benchmark",
  title: "Offline",
  connectionId: "no-connection",
  database: "offline",
  sql: "select synthetic_fixture",
  isExecuting: false,
  mode: "query",
  result,
  results: [result],
  activeResultIndex: 0,
  activeResultRunId: "run-1",
  resultRuns: [{ id: "run-1", title: "Result 1", sequence: 1, sql: "select synthetic_fixture", createdAt: 1, result, results: [result] }],
};
global.gc();
const before = process.memoryUsage();
const start = performance.now();
const snapshot = buildTabResultSnapshot(tab)!;
const snapshotMs = performance.now() - start;
const encodeStart = performance.now();
const encoded = encodeTabResultSnapshot(snapshot);
const encodeMs = performance.now() - encodeStart;
const decodeStart = performance.now();
const restored = decodeTabResultSnapshot(encoded)!;
const decodeMs = performance.now() - decodeStart;
global.gc();
const after = process.memoryUsage();
console.log(
  JSON.stringify({
    rowCount,
    columns: 20,
    encodedBytes: encoded.byteLength,
    snapshotMs: +snapshotMs.toFixed(2),
    encodeMs: +encodeMs.toFixed(2),
    decodeMs: +decodeMs.toFixed(2),
    retainedHeapDeltaMiB: mib(after.heapUsed - before.heapUsed),
    rssMiB: mib(after.rss),
    processPeakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
    restoredRows: restored.result?.rows.length,
    snapshotUniqueResults: new Set([snapshot.result, ...snapshot.results!, snapshot.resultRuns![0]!.result, ...snapshot.resultRuns![0]!.results!]).size,
    restoredUniqueResults: new Set([restored.result, ...restored.results!, restored.resultRuns![0]!.result, ...restored.resultRuns![0]!.results!]).size,
  }),
);
