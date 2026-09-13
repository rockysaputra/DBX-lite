import { strict as assert } from "node:assert";
import { test } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import { reactive } from "vue";
import { buildTabResultSnapshot, decodeTabResultSnapshot, encodeTabResultSnapshot } from "../../apps/desktop/src/lib/tabs/tabResultCache.ts";
import type { QueryResult, QueryTab } from "../../apps/desktop/src/types/database.ts";

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "select * from users",
    isExecuting: false,
    mode: "query",
    ...overrides,
  };
}

function sharedResultTab(): QueryTab {
  const result: QueryResult = {
    columns: ["id", "body"],
    rows: Array.from({ length: 100 }, (_, index) => [index, "payload".repeat(100)]),
    affected_rows: 0,
    execution_time_ms: 1,
    session_id: "live-session",
  };
  return queryTab({
    result,
    results: [reactive(result)],
    resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result, results: [result], resultSessionId: "live-session" }],
  });
}

test("snapshot detaches each raw result once across tab and run aliases", () => {
  const tab = sharedResultTab();
  const snapshot = buildTabResultSnapshot(tab)!;
  assert.notEqual(snapshot.result, tab.result);
  assert.equal(snapshot.result, snapshot.results![0]);
  assert.equal(snapshot.result, snapshot.resultRuns![0]!.result);
  assert.equal(snapshot.result, snapshot.resultRuns![0]!.results![0]);
  assert.equal(snapshot.result!.session_id, undefined);
  assert.equal(snapshot.resultRuns![0]!.resultSessionId, undefined);
  tab.result!.rows[0]![1] = "edited";
  assert.equal(snapshot.result!.rows[0]![1], "payload".repeat(100));
  const later = buildTabResultSnapshot(tab)!;
  assert.notEqual(later.result, snapshot.result);
  assert.equal(later.result!.rows[0]![1], "edited");
});

test("wire format stores shared results once and restores their identity", () => {
  const snapshot = buildTabResultSnapshot(sharedResultTab())!;
  const bytes = encodeTabResultSnapshot(snapshot);
  const singleBytes = encodeTabResultSnapshot({ result: snapshot.result, cachedAt: snapshot.cachedAt });
  assert.ok(bytes.byteLength < singleBytes.byteLength * 1.05, `${bytes.byteLength} vs ${singleBytes.byteLength}`);
  const restored = decodeTabResultSnapshot(bytes)!;
  assert.equal(restored.result, restored.results![0]);
  assert.equal(restored.result, restored.resultRuns![0]!.result);
  assert.equal(restored.result, restored.resultRuns![0]!.results![0]);
  assert.deepEqual(restored.result!.rows, snapshot.result!.rows);
});

test("equal but independent results remain independent after snapshot round trip", () => {
  const tab = sharedResultTab();
  tab.results = [structuredClone(tab.result!)];
  const snapshot = buildTabResultSnapshot(tab)!;
  assert.notEqual(snapshot.result, snapshot.results![0]);
  const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot))!;
  assert.notEqual(restored.result, restored.results![0]);
  restored.results![0]!.rows[0]![1] = "edited";
  assert.equal(restored.result!.rows[0]![1], "payload".repeat(100));
});

test("version 1 columnar snapshots remain readable", () => {
  const result = { columns: ["id"], columnValues: [[7]], rowCount: 1, affected_rows: 0, execution_time_ms: 2, sourceLabel: "legacy" };
  const bytes = encode({ magic: "DBX_TAB_RESULT_CACHE", version: 1, codec: "msgpack-columnar", payload: { result, results: [result], cachedAt: 123 } });
  const restored = decodeTabResultSnapshot(bytes)!;
  assert.deepEqual(restored.result!.rows, [[7]]);
  assert.deepEqual(restored.results![0]!.rows, [[7]]);
  assert.equal(restored.result!.sourceLabel, "legacy");
  assert.equal(restored.cachedAt, 123);
});

test("malformed columnar snapshots are rejected without throwing", () => {
  const bytes = encode({ magic: "DBX_TAB_RESULT_CACHE", version: 1, codec: "msgpack-columnar", payload: { result: { rowCount: 1 }, cachedAt: 123 } });
  assert.equal(decodeTabResultSnapshot(bytes), undefined);
});

test("invalid result pool references reject the whole snapshot without throwing", () => {
  const bytes = encodeTabResultSnapshot(buildTabResultSnapshot(sharedResultTab())!);
  for (const reference of [-1, 100, 0.5, "0", null]) {
    for (const location of ["tab", "results", "run", "runResults"]) {
      const envelope = decode(bytes) as { payload: { result: unknown; results: unknown[]; resultRuns: { result: unknown; results: unknown[] }[] } };
      if (location === "tab") envelope.payload.result = reference;
      if (location === "results") envelope.payload.results[0] = reference;
      if (location === "run") envelope.payload.resultRuns[0]!.result = reference;
      if (location === "runResults") envelope.payload.resultRuns[0]!.results[0] = reference;
      assert.equal(decodeTabResultSnapshot(encode(envelope)), undefined);
    }
  }
});

test("corrupt columnar dimensions reject snapshots before allocating rows", () => {
  for (const dimensions of [{ rowCount: -1 }, { rowCount: 0.5 }, { rowCount: 2 }, { columns: ["id", "extra"] }]) {
    const result = { columns: ["id"], columnValues: [[7]], rowCount: 1, affected_rows: 0, execution_time_ms: 1, ...dimensions };
    for (const version of [1, 2]) {
      const payload = version === 1 ? { result, cachedAt: 123 } : { result: 0, resultPool: [result], cachedAt: 123 };
      const bytes = encode({ magic: "DBX_TAB_RESULT_CACHE", version, codec: "msgpack-columnar", payload });
      assert.equal(decodeTabResultSnapshot(bytes), undefined);
    }
  }
});

test("binary and date Mongo values survive encoding while undefined fields are omitted", () => {
  const tab = sharedResultTab();
  tab.result!.mongo_documents = [{ bytes: new Uint8Array([1, 2, 255]), createdAt: new Date("2026-07-24T00:00:00Z"), omitted: undefined, values: [undefined, null] }];
  const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(buildTabResultSnapshot(tab)!))!;
  assert.deepEqual(restored.result!.mongo_documents, [{ bytes: new Uint8Array([1, 2, 255]), createdAt: new Date("2026-07-24T00:00:00Z"), values: [null, null] }]);
});

test("tab original large-value cells survive snapshot creation and round trip", () => {
  const tab = sharedResultTab();
  tab.resultLocalSortOriginalLargeValueCells = [{ row_index: 0, column_index: 1, original_bytes: 4096 }];
  const snapshot = buildTabResultSnapshot(tab)!;
  assert.deepEqual(snapshot.resultLocalSortOriginalLargeValueCells, tab.resultLocalSortOriginalLargeValueCells);
  assert.notEqual(snapshot.resultLocalSortOriginalLargeValueCells, tab.resultLocalSortOriginalLargeValueCells);
  const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot))!;
  assert.deepEqual(restored.resultLocalSortOriginalLargeValueCells, tab.resultLocalSortOriginalLargeValueCells);
});

test("result snapshots strip live session handles and clone result rows", () => {
  const tab = queryTab({
    result: {
      columns: ["id"],
      rows: [[1]],
      mongo_documents: [{ _id: "1", profile: { role: "admin" } }],
      mongo_copy_documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "live-session",
      sourceLabel: "public.users",
      sourceStatement: "select * from public.users",
    },
    results: [
      {
        columns: ["id"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
        session_id: "live-session",
      },
    ],
    activeResultIndex: 0,
    resultLocalSortOriginalRows: [[2]],
    resultLocalSortOriginalMongoDocuments: [{ _id: "2", profile: { role: "maintainer" } }],
    resultLocalSortOriginalMongoCopyDocuments: [{ _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } }],
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.result?.session_id, undefined);
  assert.equal(snapshot?.result?.sourceLabel, "public.users");
  assert.equal(snapshot?.result?.sourceStatement, "select * from public.users");
  assert.equal(snapshot?.results?.[0]?.session_id, undefined);
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.result?.mongo_documents, [{ _id: "1", profile: { role: "admin" } }]);
  assert.deepEqual(snapshot?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", profile: { role: "maintainer" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalMongoCopyDocuments, [{ _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } }]);
  tab.result!.rows[0]![0] = 2;
  (tab.result!.mongo_copy_documents![0] as { createdAt: { $date: string } }).createdAt.$date = "changed";
  tab.resultLocalSortOriginalRows![0]![0] = 3;
  assert.deepEqual(snapshot?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } }]);
  assert.deepEqual(snapshot?.resultLocalSortOriginalRows, [[2]]);
});

test("result snapshots strip session handles from result runs", () => {
  const tab = queryTab({
    resultRuns: [
      {
        id: "run-1",
        title: "Run 1",
        sequence: 1,
        sql: "select 1",
        createdAt: 1,
        result: {
          columns: ["id"],
          rows: [[1]],
          mongo_copy_documents: [{ _id: { $oid: "507f1f77bcf86cd799439011" } }],
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: "live-run-session",
          sourceLabel: "users",
          sourceStatement: "select * from users",
        },
        resultLocalSortOriginalRows: [[2]],
        resultLocalSortOriginalMongoDocuments: [{ _id: "2", role: "maintainer" }],
        resultLocalSortOriginalMongoCopyDocuments: [{ _id: { $oid: "507f1f77bcf86cd799439012" } }],
      },
    ],
  });

  const snapshot = buildTabResultSnapshot(tab);

  assert.equal(snapshot?.resultRuns?.[0]?.result?.session_id, undefined);
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceLabel, "users");
  assert.equal(snapshot?.resultRuns?.[0]?.result?.sourceStatement, "select * from users");
  assert.deepEqual(snapshot?.resultRuns?.[0]?.result?.rows, [[1]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.result?.mongo_copy_documents, [{ _id: { $oid: "507f1f77bcf86cd799439011" } }]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalRows, [[2]]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalMongoDocuments, [{ _id: "2", role: "maintainer" }]);
  assert.deepEqual(snapshot?.resultRuns?.[0]?.resultLocalSortOriginalMongoCopyDocuments, [{ _id: { $oid: "507f1f77bcf86cd799439012" } }]);
});

test("result snapshots preserve local column filters for all result windows", () => {
  const result = (filters?: Record<string, string[]>): QueryResult => ({
    columns: ["id", "status"],
    rows: [[1, "active"]],
    affected_rows: 0,
    execution_time_ms: 1,
    local_column_filters: filters,
  });
  const tab = queryTab({
    result: result({ "1": ["str:root"] }),
    results: [result({ "1": ["str:first"] }), result({ "1": ["str:second"] })],
    activeResultIndex: 0,
    resultRuns: [
      {
        id: "run-a",
        title: "Run A",
        sequence: 1,
        sql: "select 1",
        createdAt: 1,
        result: result({ "1": ["str:run-a"] }),
        results: [result({ "1": ["str:run-a-first"] }), result()],
        activeResultIndex: 0,
      },
      {
        id: "run-b",
        title: "Run B",
        sequence: 2,
        sql: "select 2",
        createdAt: 2,
        result: result({ "1": ["str:run-b"] }),
        results: [result({ "1": ["str:run-b-first"] })],
        activeResultIndex: 0,
      },
    ],
    activeResultRunId: "run-a",
  });

  const snapshot = buildTabResultSnapshot(tab);
  assert.deepEqual(snapshot?.result?.local_column_filters, { "1": ["str:root"] });
  assert.deepEqual(
    snapshot?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:first"] }, { "1": ["str:second"] }],
  );
  assert.deepEqual(
    snapshot?.resultRuns?.map((run) => run.result?.local_column_filters),
    [{ "1": ["str:run-a"] }, { "1": ["str:run-b"] }],
  );
  assert.deepEqual(
    snapshot?.resultRuns?.[0]?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:run-a-first"] }, undefined],
  );

  const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(snapshot!));
  assert.deepEqual(restored?.result?.local_column_filters, { "1": ["str:root"] });
  assert.deepEqual(
    restored?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:first"] }, { "1": ["str:second"] }],
  );
  assert.deepEqual(
    restored?.resultRuns?.map((run) => run.result?.local_column_filters),
    [{ "1": ["str:run-a"] }, { "1": ["str:run-b"] }],
  );
  assert.deepEqual(
    restored?.resultRuns?.[0]?.results?.map((item) => item.local_column_filters),
    [{ "1": ["str:run-a-first"] }, undefined],
  );
});

test("result snapshots encode as binary columnar payloads and decode back to rows", () => {
  const snapshot = buildTabResultSnapshot(
    queryTab({
      result: {
        columns: ["id", "name", "active"],
        rows: [
          [1, "Ada", true],
          [2, "Linus", false],
        ],
        mongo_documents: [
          { _id: "1", name: "Ada", tags: ["admin"] },
          { _id: "2", name: "Linus", tags: ["maintainer"] },
        ],
        mongo_copy_documents: [
          { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
          { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
        ],
        affected_rows: 0,
        execution_time_ms: 3,
        session_id: "live-session",
        has_more: true,
        sourceLabel: "public.users",
        sourceStatement: "select id, name, active from public.users",
      },
      resultLocalSortOriginalRows: [
        [2, "Linus", false],
        [1, "Ada", true],
      ],
      resultLocalSortOriginalMongoDocuments: [
        { _id: "2", name: "Linus", tags: ["maintainer"] },
        { _id: "1", name: "Ada", tags: ["admin"] },
      ],
      resultLocalSortOriginalMongoCopyDocuments: [
        { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
        { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
      ],
    }),
  );
  assert.ok(snapshot);

  const encoded = encodeTabResultSnapshot(snapshot);
  const decoded = decodeTabResultSnapshot(encoded);

  assert.ok(encoded instanceof Uint8Array);
  assert.deepEqual(decoded?.result?.columns, ["id", "name", "active"]);
  assert.deepEqual(decoded?.result?.rows, [
    [1, "Ada", true],
    [2, "Linus", false],
  ]);
  assert.deepEqual(decoded?.result?.mongo_documents, [
    { _id: "1", name: "Ada", tags: ["admin"] },
    { _id: "2", name: "Linus", tags: ["maintainer"] },
  ]);
  assert.deepEqual(decoded?.result?.mongo_copy_documents, [
    { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
    { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalRows, [
    [2, "Linus", false],
    [1, "Ada", true],
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalMongoDocuments, [
    { _id: "2", name: "Linus", tags: ["maintainer"] },
    { _id: "1", name: "Ada", tags: ["admin"] },
  ]);
  assert.deepEqual(decoded?.resultLocalSortOriginalMongoCopyDocuments, [
    { _id: { $oid: "507f1f77bcf86cd799439012" }, counter: { $numberLong: "9007199254740993" } },
    { _id: { $oid: "507f1f77bcf86cd799439011" }, createdAt: { $date: "2026-07-24T00:00:00Z" } },
  ]);
  assert.equal(decoded?.result?.session_id, undefined);
  assert.equal(decoded?.result?.has_more, true);
  assert.equal(decoded?.result?.sourceLabel, "public.users");
  assert.equal(decoded?.result?.sourceStatement, "select id, name, active from public.users");
  assert.equal(decoded?.cachedAt, snapshot.cachedAt);
});
