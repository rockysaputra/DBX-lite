// @vitest-environment happy-dom

import { createApp, h, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { completionStatus, currentCompletions, setSelectedCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseType } from "@/types/database";
import QueryEditor from "../QueryEditor.vue";

// Mounted QueryEditor with its real SQL completion provider, keymaps,
// autocompletion popup and batch checkbox UI. Only the connection metadata
// boundary is faked (synthetic catalogs); every backend, Tauri and network
// entry point is replaced with a recorder that rejects, and the test asserts
// that none of them is reached.
const boundary = vi.hoisted(() => {
  type Engine = "postgres" | "mysql";
  // `unique`: organization_user exists only in public. `ambiguous`: audit has one too.
  // `truncated`: unique, but the fuzzy table listing comes back full (limit-sized).
  type Fixture = "unique" | "ambiguous" | "truncated";
  const state = {
    engine: "postgres" as Engine,
    fixture: "unique" as Fixture,
    reversed: false,
    blocked: [] as string[],
    storeCalls: [] as Array<{ method: string; args: unknown[] }>,
  };
  // PostgreSQL: schema.table. MySQL: database.table.
  const allCatalogs: Record<Engine, Record<string, string[]>> = {
    postgres: {
      "public.organization_user": ["organization_id", "user_id", "role"],
      "public.users": ["id", "email"],
      "public.Order Details": ["User Name", "qty"],
      "audit.organization_user": ["audit_id", "changed_at"],
      "audit.audit_log": ["log_id", "payload"],
    },
    mysql: {
      "app.organization_user": ["organization_id", "user_id", "role"],
      "app.users": ["id", "email"],
      "shop.order details": ["user name", "qty"],
    },
  };
  const visibleCatalog = () => Object.fromEntries(Object.entries(allCatalogs[state.engine]).filter(([key]) => state.fixture === "ambiguous" || key !== "audit.organization_user"));
  const scopeFor = (database: string, schema: string | undefined) => (state.engine === "postgres" ? schema : schema?.trim() || database);
  const columnsFor = (database: string, table: string, schema?: string) => {
    // connectionStore.listCompletionColumns returns [] for schema-aware
    // databases when no schema is known (connectionStore.ts:8100).
    const scope = scopeFor(database, schema);
    if (!scope) return [];
    return (visibleCatalog()[`${scope}.${table}`] ?? []).map((name) => ({ name, table, schema, dataType: "text" }));
  };
  const tablesFor = (database: string, filter = "", schema?: string, limit?: number) => {
    const scope = state.engine === "postgres" ? schema : schema || database;
    const found = Object.keys(visibleCatalog())
      .map((key) => ({ scope: key.slice(0, key.indexOf(".")), name: key.slice(key.indexOf(".") + 1) }))
      .filter((entry) => (!scope || entry.scope === scope) && entry.name.toLowerCase().includes(filter.toLowerCase()))
      .map((entry) => ({ name: entry.name, schema: state.engine === "postgres" ? entry.scope : undefined, type: "table" as const }));
    // Metadata order is not search_path order: the test can reverse it.
    if (state.reversed) found.reverse();
    if (state.fixture === "truncated" && limit && filter) {
      // A fuzzy listing that hit its limit may hide further exact matches.
      for (let index = 1; found.length < limit; index += 1) found.push({ name: `${filter}_${index}`, schema: "public", type: "table" as const });
    }
    return found;
  };
  const record =
    <T>(method: string, run: (...args: any[]) => T) =>
    (...args: any[]) => {
      state.storeCalls.push({ method, args });
      return run(...args);
    };
  // Like the real store: the local column index starts cold and is filled by a
  // successful remote column listing (connectionStore.ts:8159).
  const columnIndex = new Map<string, ReturnType<typeof columnsFor>>();
  const indexKey = (database: string, table: string, schema?: string) => `${database}|${schema ?? ""}|${table}`;
  const listColumns = async (_id: string, database: string, table: string, schema?: string) => {
    const columns = columnsFor(database, table, schema);
    if (columns.length > 0) columnIndex.set(indexKey(database, table, schema), columns);
    return columns;
  };
  const fakeStore: Record<string, unknown> = {
    getConfig: (id: string) => ({ id, name: "synthetic", db_type: state.engine, host: "", port: 0, username: "", password: "" }),
    connectionIdentifierQuote: () => (state.engine === "mysql" ? "`" : '"'),
    completionCacheRevision: () => 0,
    listCompletionColumns: record("listCompletionColumns", listColumns),
    refreshCompletionColumns: record("refreshCompletionColumns", listColumns),
    listCompletionColumnsByPrefix: record("listCompletionColumnsByPrefix", async (_id: string, database: string, table: string, schema: string | undefined, prefix: string) => columnsFor(database, table, schema).filter((column) => column.name.toLowerCase().startsWith(prefix.toLowerCase()))),
    lookupLocalCompletionColumns: record("lookupLocalCompletionColumns", (_id: string, database: string, table: string, schema?: string) => columnIndex.get(indexKey(database, table, schema)) ?? []),
    lookupLocalCompletionColumnsByPrefix: record("lookupLocalCompletionColumnsByPrefix", (_id: string, database: string, table: string, schema: string | undefined, prefix: string) =>
      (columnIndex.get(indexKey(database, table, schema)) ?? []).filter((column) => column.name.toLowerCase().startsWith(prefix.toLowerCase())),
    ),
    lookupLocalCompletionTables: record("lookupLocalCompletionTables", (_id: string, database: string, filter?: string, _limit?: number, schema?: string) => tablesFor(database, filter, schema)),
    listCompletionTables: record("listCompletionTables", async (_id: string, database: string, filter?: string, limit?: number, schema?: string) => tablesFor(database, filter, schema, limit)),
    lookupLocalCompletionDatabases: record("lookupLocalCompletionDatabases", () => (state.engine === "mysql" ? ["app", "shop"] : ["app"])),
    listCompletionDatabases: record("listCompletionDatabases", async () => (state.engine === "mysql" ? ["app", "shop"] : ["app"])),
    lookupLocalCompletionSchemas: record("lookupLocalCompletionSchemas", () => (state.engine === "postgres" ? ["public", "audit"] : [])),
    listCompletionSchemas: record("listCompletionSchemas", async () => (state.engine === "postgres" ? ["public", "audit"] : [])),
    lookupLocalCompletionObjects: record("lookupLocalCompletionObjects", () => []),
    listCompletionObjects: record("listCompletionObjects", async () => []),
    lookupLocalCompletionForeignKeys: record("lookupLocalCompletionForeignKeys", () => []),
    listCompletionForeignKeys: record("listCompletionForeignKeys", async () => []),
    refreshCompletionTables: record("refreshCompletionTables", async () => []),
    refreshCompletionSchemas: record("refreshCompletionSchemas", async () => []),
    refreshCompletionDatabases: record("refreshCompletionDatabases", async () => []),
  };
  const store = new Proxy(fakeStore, {
    get(target, key) {
      if (typeof key !== "string" || key in target) return Reflect.get(target, key);
      if (key === "then" || key.startsWith("__v_") || key === "toJSON") return undefined;
      return (...args: unknown[]) => {
        state.blocked.push(`connectionStore.${key}`);
        throw new Error(`unexpected connectionStore.${key}(${args.length} args)`);
      };
    },
  });
  return {
    state,
    store,
    reset: () => {
      columnIndex.clear();
      state.fixture = "unique";
      state.reversed = false;
    },
  };
});

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => boundary.store, COMPLETION_METADATA_CONCURRENCY: 2 }));
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (..._args: unknown[]) => {
            boundary.state.blocked.push(`api.${name}`);
            return Promise.reject(new Error(`blocked backend call api.${name}`));
          }
        : value,
    ]),
  );
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    boundary.state.blocked.push(`tauri.invoke:${command}`);
    return Promise.reject(new Error(`blocked tauri invoke ${command}`));
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  boundary.state.blocked.length = 0;
  boundary.state.storeCalls.length = 0;
  boundary.reset();
  vi.stubGlobal("fetch", (input: unknown) => {
    boundary.state.blocked.push(`fetch:${String(input)}`);
    return Promise.reject(new Error("blocked network"));
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        boundary.state.blocked.push(`websocket:${url}`);
        throw new Error("blocked network");
      }
    },
  );
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  // Zero backend, Tauri, network or unfaked connectionStore access.
  expect(boundary.state.blocked).toEqual([]);
});

interface MountOptions {
  databaseType: Extract<DatabaseType, "postgres" | "mysql">;
  database: string;
  schema?: string;
  fixture?: "unique" | "ambiguous" | "truncated";
  reversed?: boolean;
}

async function mountAt(marked: string, options: MountOptions) {
  boundary.state.engine = options.databaseType;
  boundary.state.fixture = options.fixture ?? "unique";
  boundary.state.reversed = options.reversed ?? false;
  const cursor = marked.indexOf("|");
  const sql = marked.slice(0, cursor) + marked.slice(cursor + 1);
  const pinia = createPinia();
  setActivePinia(pinia);
  const state = reactive({ sql });
  const host = document.createElement("div");
  document.body.append(host);
  const app: App = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: state.sql,
        tabId: `insert-columns-${Math.random()}`,
        connectionId: "synthetic-connection",
        database: options.database,
        schema: options.schema,
        databaseType: options.databaseType,
        dialect: options.databaseType,
        autoFocus: false,
        "onUpdate:modelValue": (value: string) => {
          state.sql = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe(sql));
  view.dispatch({ selection: { anchor: cursor } });
  return { view, host };
}

function keydown(view: EditorView, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const CTRL_SPACE: KeyboardEventInit = { key: " ", code: "Space", ctrlKey: true };
const ALT_SLASH: KeyboardEventInit = { key: "/", code: "Slash", altKey: true };

async function openCompletion(view: EditorView, shortcut: KeyboardEventInit = CTRL_SPACE) {
  expect(keydown(view, shortcut).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"), { timeout: 3000 });
}

// The rendered name; `label` may carry a quote-prefixed filter text.
const shownLabel = (option: { label: string; displayLabel?: string }) => option.displayLabel ?? option.label;

function columnLabels(view: EditorView) {
  return currentCompletions(view.state)
    .filter((option) => option.type === "column")
    .map(shownLabel)
    .sort();
}

function columnIndex(view: EditorView, label: string) {
  const index = currentCompletions(view.state).findIndex((option) => option.type === "column" && shownLabel(option) === label);
  expect(index, `${label} offered`).toBeGreaterThanOrEqual(0);
  return index;
}

function checkbox(host: HTMLElement, label: string) {
  return host.querySelector<HTMLInputElement>(`input.cm-batch-column-selection-checkbox[aria-label="${label}"]`);
}

async function expectTargetOnlyCheckboxPopup(view: EditorView, host: HTMLElement, expected: string[]) {
  expect(columnLabels(view)).toEqual([...expected].sort());
  await vi.waitFor(() => {
    for (const label of expected) expect(checkbox(host, label)).not.toBeNull();
  });
  expect(host.querySelectorAll("input.cm-batch-column-selection-checkbox")).toHaveLength(expected.length);
  expect(host.querySelector(".cm-batch-column-selection-action-marker")).not.toBeNull();
}

async function toggleColumn(view: EditorView, host: HTMLElement, label: string) {
  view.dispatch({ effects: setSelectedCompletion(columnIndex(view, label)) });
  expect(keydown(view, { key: " ", code: "Space" }).defaultPrevented).toBe(true);
  // Toggling reopens the list (explicit request); wait until it is active again with the box checked.
  await vi.waitFor(
    () => {
      expect(completionStatus(view.state)).toBe("active");
      expect(checkbox(host, label)?.checked).toBe(true);
    },
    { timeout: 3000 },
  );
}

async function acceptChecked(view: EditorView, host: HTMLElement, labels: string[]) {
  for (const label of labels) await toggleColumn(view, host, label);
  expect(keydown(view, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
  return view.state.doc.toString();
}

const SELECT_PREFIX_SEMI = "SELECT * FROM users WHERE email = 'a';\n\n";
const SELECT_PREFIX_NO_SEMI = "SELECT * FROM users WHERE email = 'a'\n\n";
const ORG = ["organization_id", "user_id", "role"];
const PG_PUBLIC: MountOptions = { databaseType: "postgres", database: "app", schema: "public" };
const PG_NO_SCHEMA: MountOptions = { databaseType: "postgres", database: "app" };
const MYSQL_APP: MountOptions = { databaseType: "mysql", database: "app" };

describe("mounted QueryEditor: Ctrl+Space in an INSERT target column list", () => {
  it.each<[string, MountOptions, string, string[]]>([
    ["PG public, screenshot doc, cursor after '(' of the completed list", PG_PUBLIC, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|organization_id,user_id) VALUES (1,23);`, ORG],
    ["PG public, screenshot doc without semicolons, after comma", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id,|) VALUES (1,23)`, ORG],
    ["PG public, empty list", PG_PUBLIC, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|) VALUES (1,23);`, ORG],
    ["PG public, partial identifier", PG_PUBLIC, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (organization_id,us|) VALUES (1,23);`, ["user_id"]],
    ["PG no current schema, unqualified target", PG_NO_SCHEMA, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|) VALUES (1,23);`, ORG],
    ["PG no current schema, unqualified target, no semicolons", PG_NO_SCHEMA, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id,|) VALUES (1,23)`, ORG],
    ["PG public, schema-qualified other schema stays scoped", { ...PG_PUBLIC, fixture: "ambiguous" }, "INSERT INTO audit.organization_user (|) VALUES (1)", ["audit_id", "changed_at"]],
    ["PG public, explicit public stays scoped while audit has the same table", { ...PG_PUBLIC, fixture: "ambiguous" }, "INSERT INTO public.organization_user (|) VALUES (1)", ORG],
    ["PG no schema, explicit audit stays scoped while public has the same table", { ...PG_NO_SCHEMA, fixture: "ambiguous" }, "INSERT INTO audit.organization_user (|) VALUES (1)", ["audit_id", "changed_at"]],
    ["PG no schema, explicit public stays scoped while audit has the same table", { ...PG_NO_SCHEMA, fixture: "ambiguous" }, "INSERT INTO public.organization_user (|) VALUES (1)", ORG],
    ["PG selected public schema wins over an audit table of the same name", { ...PG_PUBLIC, fixture: "ambiguous" }, "INSERT INTO organization_user (|) VALUES (1)", ORG],
    ["PG no schema, target that exists only in the unselected audit schema", PG_NO_SCHEMA, "INSERT INTO audit_log (|) VALUES (1)", ["log_id", "payload"]],
    ["PG no schema, unquoted upper-case target folds to the lower-case table", PG_NO_SCHEMA, "INSERT INTO ORGANIZATION_USER (|) VALUES (1)", ORG],
    ["PG quoted qualified target", PG_PUBLIC, 'INSERT INTO "public"."Order Details" (|) VALUES (1)', ["User Name", "qty"]],
    ["MySQL database scope, screenshot doc", MYSQL_APP, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (organization_id,|) VALUES (1,23);`, ORG],
    ["MySQL database scope, no semicolons, empty list", MYSQL_APP, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|) VALUES (1,23)`, ORG],
    ["MySQL other database qualified target", MYSQL_APP, "INSERT INTO `shop`.`order details` (|) VALUES (1)", ["user name", "qty"]],
  ])("%s", async (_name, options, marked, expected) => {
    const { view, host } = await mountAt(marked, options);
    await openCompletion(view);
    await expectTargetOnlyCheckboxPopup(view, host, expected);
  });

  // Expectation correction (fix2): the "PG no current schema" rows above used to run against a
  // catalog where audit.organization_user also existed and silently took the first listed match
  // (public). That contradicts the safety goal, so they now run on the `unique` fixture and the
  // same-name case is asserted as unresolved in the next describe block.

  it("opens the same target-only popup with the configured Alt+/ shortcut", async () => {
    const { view, host } = await mountAt(`${SELECT_PREFIX_SEMI}INSERT INTO organization_user (organization_id,|) VALUES (1,23);`, PG_PUBLIC);
    await openCompletion(view, ALT_SLASH);
    await expectTargetOnlyCheckboxPopup(view, host, ORG);
  });

  it("keeps SELECT column checkboxes working", async () => {
    const { view, host } = await mountAt("SELECT | FROM users", PG_PUBLIC);
    await openCompletion(view);
    expect(columnLabels(view)).toEqual(["email", "id"]);
    await vi.waitFor(() => expect(checkbox(host, "email")).not.toBeNull());
  });

  it("offers SELECT columns after an opening identifier quote", async () => {
    const { view } = await mountAt('SELECT "em|" FROM users', PG_PUBLIC);
    await openCompletion(view);
    expect(columnLabels(view)).toEqual(["email"]);
  });
});

describe("mounted QueryEditor: schema-less INSERT target is resolved only when unambiguous", () => {
  const DOC = `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|) VALUES (1,23);`;
  const DOC_NO_SEMI = `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id,|) VALUES (1,23)`;

  async function expectNoTargetColumns(marked: string, options: MountOptions, table = "organization_user") {
    const { view, host } = await mountAt(marked, options);
    keydown(view, CTRL_SPACE);
    // The lookup that could resolve the target must have completed before asserting absence.
    await vi.waitFor(() => expect(boundary.state.storeCalls.some((call) => call.method === "listCompletionTables")).toBe(true), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(columnLabels(view)).toEqual([]);
    expect(host.querySelectorAll("input.cm-batch-column-selection-checkbox")).toHaveLength(0);
    // Never guess a schema: no column listing for the target carried one.
    const targetColumnCalls = boundary.state.storeCalls.filter((call) => (call.method === "listCompletionColumns" || call.method === "refreshCompletionColumns") && call.args[2] === table);
    expect(targetColumnCalls.filter((call) => call.args[3] !== undefined)).toEqual([]);
  }

  it.each<[string, MountOptions, string]>([
    ["same table in public and audit", { ...PG_NO_SCHEMA, fixture: "ambiguous" }, DOC],
    ["same table in public and audit, reversed metadata order", { ...PG_NO_SCHEMA, fixture: "ambiguous", reversed: true }, DOC],
    ["same table in public and audit, no semicolons", { ...PG_NO_SCHEMA, fixture: "ambiguous" }, DOC_NO_SEMI],
    ["same table in public and audit, no semicolons, reversed", { ...PG_NO_SCHEMA, fixture: "ambiguous", reversed: true }, DOC_NO_SEMI],
    ["limit-sized listing may hide other schemas", { ...PG_NO_SCHEMA, fixture: "truncated" }, DOC],
    ["quoted name does not fold to the lower-case table", PG_NO_SCHEMA, 'INSERT INTO "ORGANIZATION_USER" (|) VALUES (1)'],
  ])("%s stays unresolved without misleading columns", async (_name, options, marked) => {
    await expectNoTargetColumns(marked, options, marked.includes('"ORGANIZATION_USER"') ? "ORGANIZATION_USER" : "organization_user");
  });

  it("does not offer the INSERT template with merged columns either", async () => {
    const { view } = await mountAt(DOC, { ...PG_NO_SCHEMA, fixture: "ambiguous" });
    keydown(view, CTRL_SPACE);
    await vi.waitFor(() => expect(boundary.state.storeCalls.some((call) => call.method === "listCompletionTables")).toBe(true), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const shown = currentCompletions(view.state).map(shownLabel);
    for (const name of ["audit_id", "changed_at", "organization_id", "user_id", "role"]) expect(shown.join(" ")).not.toContain(name);
  });
});

describe("mounted QueryEditor: accepting checked INSERT columns through the popup", () => {
  const ORG_PAIR = ["organization_id", "user_id"];
  it.each<[string, MountOptions, string, string[], string]>([
    ["PG empty list keeps VALUES", PG_PUBLIC, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|) VALUES (1,23);`, ORG_PAIR, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (organization_id, user_id) VALUES (1,23);`],
    ["PG no semicolons, empty list keeps VALUES", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|) VALUES (1,23)`, ORG_PAIR, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id) VALUES (1,23)`],
    ["PG before an existing column", PG_PUBLIC, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (|role) VALUES (1,23,'x');`, ORG_PAIR, `${SELECT_PREFIX_SEMI}INSERT INTO organization_user (organization_id, user_id, role) VALUES (1,23,'x');`],
    ["PG no semicolons, before an existing column", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|role) VALUES (1,23,'x')`, ORG_PAIR, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id, role) VALUES (1,23,'x')`],
    ["PG no current schema, no semicolons", PG_NO_SCHEMA, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|) VALUES (1,23)`, ORG_PAIR, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id) VALUES (1,23)`],
    ["MySQL after comma keeps VALUES", MYSQL_APP, "INSERT INTO organization_user (role,|) VALUES ('x',1,23);", ORG_PAIR, "INSERT INTO organization_user (role,organization_id, user_id) VALUES ('x',1,23);"],
    // The typed prefix filters the list (as in SELECT), so only "User Name" is offered.
    ["PG quoted closing quote", PG_PUBLIC, 'INSERT INTO "public"."Order Details" ("Us|") VALUES (1)', ["User Name"], 'INSERT INTO "public"."Order Details" ("User Name") VALUES (1)'],
    ["PG cursor inside a quoted identifier", PG_PUBLIC, 'INSERT INTO "public"."Order Details" ("Us|er Name", qty) VALUES (1, 2)', ["User Name"], 'INSERT INTO "public"."Order Details" ("User Name", qty) VALUES (1, 2)'],
    ["MySQL cursor inside a backtick identifier", MYSQL_APP, "INSERT INTO `shop`.`order details` (`us|er name`, qty) VALUES (1, 2)", ["user name"], "INSERT INTO `shop`.`order details` (`user name`, qty) VALUES (1, 2)"],
    ["closed list followed by SELECT", PG_PUBLIC, "INSERT INTO organization_user (|) SELECT id, email FROM users", ORG_PAIR, "INSERT INTO organization_user (organization_id, user_id) SELECT id, email FROM users"],
    ["comment before the closing parenthesis", PG_PUBLIC, "INSERT INTO organization_user (| /* pick */) VALUES (1, 2)", ORG_PAIR, "INSERT INTO organization_user (organization_id, user_id /* pick */) VALUES (1, 2)"],
    ["comment between the list and VALUES", PG_PUBLIC, "INSERT INTO organization_user (|) -- values below\nVALUES (1, 2)", ORG_PAIR, "INSERT INTO organization_user (organization_id, user_id) -- values below\nVALUES (1, 2)"],
    ["MySQL singular VALUE", MYSQL_APP, "INSERT INTO organization_user (|) VALUE (1, 2)", ORG_PAIR, "INSERT INTO organization_user (organization_id, user_id) VALUE (1, 2)"],
    ["unclosed list before a separate UPDATE", PG_PUBLIC, "INSERT INTO organization_user (|\nUPDATE users SET email = 'x'", ["role"], "INSERT INTO organization_user (role) VALUES (value)\nUPDATE users SET email = 'x'"],
    ["unclosed list before a separate SELECT", PG_PUBLIC, "INSERT INTO organization_user (|\nSELECT * FROM users", ["role"], "INSERT INTO organization_user (role) VALUES (value)\nSELECT * FROM users"],
  ])("%s", async (_name, options, marked, labels, expected) => {
    const { view, host } = await mountAt(marked, options);
    await openCompletion(view);
    expect(await acceptChecked(view, host, labels)).toBe(expected);
  });
});

describe("mounted QueryEditor: the all-columns INSERT row", () => {
  async function acceptAllColumnsRow(marked: string, options: MountOptions) {
    const { view } = await mountAt(marked, options);
    await openCompletion(view);
    // Let the asynchronous refresh settle so it cannot reset the selection below.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const index = currentCompletions(view.state).findIndex((option) => shownLabel(option) === "organization_user.*");
    expect(index, "organization_user.* row offered").toBeGreaterThanOrEqual(0);
    view.dispatch({ effects: setSelectedCompletion(index) });
    expect(currentCompletions(view.state)[index]?.type).toBe("snippet");
    expect(keydown(view, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull());
    return view.state.doc.toString();
  }

  it.each<[string, MountOptions, string, string]>([
    ["unfinished INSERT template stays useful", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|`, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id, role) VALUES (value, value, value)`],
    ["completed list with VALUES keeps the existing source", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|) VALUES (1,23)`, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id, role) VALUES (1,23)`],
    ["completed list with VALUES and semicolon keeps the existing source", PG_PUBLIC, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (|);`, `${SELECT_PREFIX_NO_SEMI}INSERT INTO organization_user (organization_id, user_id, role) VALUES (value, value, value);`],
  ])("%s", async (_name, options, marked, expected) => {
    expect(await acceptAllColumnsRow(marked, options)).toBe(expected);
  });
});

describe("mounted QueryEditor: single INSERT column acceptance replaces the whole identifier", () => {
  it.each<[string, MountOptions, string, string, string]>([
    ["PG unquoted typo", PG_PUBLIC, "INSERT INTO organization_user (organiz|aton_id, user_id) VALUES (1, 2)", "organization_id", "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
    ["PG quoted typo", PG_PUBLIC, 'INSERT INTO "public"."Order Details" ("Us|r Nme", qty) VALUES (1, 2)', "User Name", 'INSERT INTO "public"."Order Details" ("User Name", qty) VALUES (1, 2)'],
    ["MySQL backtick typo", MYSQL_APP, "INSERT INTO `shop`.`order details` (`us|r nme`, qty) VALUES (1, 2)", "user name", "INSERT INTO `shop`.`order details` (`user name`, qty) VALUES (1, 2)"],
    ["end of identifier is unchanged", PG_PUBLIC, "INSERT INTO organization_user (organization_id, us|) VALUES (1, 2)", "user_id", "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
  ])("%s", async (_name, options, marked, label, expected) => {
    const { view } = await mountAt(marked, options);
    await openCompletion(view);
    view.dispatch({ effects: setSelectedCompletion(columnIndex(view, label)) });
    expect(keydown(view, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(expected));
  });
});
