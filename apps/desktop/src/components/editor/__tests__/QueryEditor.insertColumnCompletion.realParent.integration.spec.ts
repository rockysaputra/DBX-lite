// @vitest-environment happy-dom

import { computed, createApp, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real SQL workspace parent chain:
// SqlEditorWorkspace -> EditorGroup (KeepAlive) -> QueryEditorSurface -> ContentArea -> QueryEditor,
// with the real queryStore and App.vue's editor handlers (App.vue:3682-3695).
// Only the connection metadata boundary is faked; every backend, Tauri and
// network entry point records and rejects, except the store's own tab
// persistence, which is recorded as an expected no-op.
const boundary = vi.hoisted(() => {
  const state = { blocked: [] as string[], persisted: [] as string[] };
  const catalog: Record<string, string[]> = { "public.organization_user": ["organization_id", "user_id", "role"], "public.users": ["id", "email"] };
  const columnsFor = (_database: string, table: string, schema?: string) => (schema ? (catalog[`${schema}.${table}`] ?? []).map((name) => ({ name, table, schema, dataType: "text" })) : []);
  const tablesFor = () => Object.keys(catalog).map((key) => ({ name: key.split(".")[1]!, schema: key.split(".")[0], type: "table" as const }));
  const columnIndex = new Map<string, ReturnType<typeof columnsFor>>();
  const listColumns = async (_id: string, database: string, table: string, schema?: string) => {
    const columns = columnsFor(database, table, schema);
    if (columns.length > 0) columnIndex.set(`${database}|${schema ?? ""}|${table}`, columns);
    return columns;
  };
  const fakeStore: Record<string, unknown> = {
    getConfig: (id: string) => ({ id, name: "synthetic", db_type: "postgres", host: "", port: 0, username: "", password: "" }),
    connectionIdentifierQuote: () => '"',
    completionCacheRevision: () => 0,
    listCompletionColumns: listColumns,
    refreshCompletionColumns: listColumns,
    listCompletionColumnsByPrefix: async (_id: string, database: string, table: string, schema: string | undefined, prefix: string) => columnsFor(database, table, schema).filter((column) => column.name.startsWith(prefix)),
    lookupLocalCompletionColumns: (_id: string, database: string, table: string, schema?: string) => columnIndex.get(`${database}|${schema ?? ""}|${table}`) ?? [],
    lookupLocalCompletionColumnsByPrefix: (_id: string, database: string, table: string, schema: string | undefined, prefix: string) => (columnIndex.get(`${database}|${schema ?? ""}|${table}`) ?? []).filter((column) => column.name.startsWith(prefix)),
    lookupLocalCompletionTables: () => tablesFor(),
    listCompletionTables: async () => tablesFor(),
    lookupLocalCompletionDatabases: () => ["app"],
    listCompletionDatabases: async () => ["app"],
    lookupLocalCompletionSchemas: () => ["public"],
    listCompletionSchemas: async () => ["public"],
    lookupLocalCompletionObjects: () => [],
    listCompletionObjects: async () => [],
    lookupLocalCompletionForeignKeys: () => [],
    listCompletionForeignKeys: async () => [],
    refreshCompletionTables: async () => [],
    refreshCompletionSchemas: async () => [],
    refreshCompletionDatabases: async () => [],
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
  return { state, store, reset: () => columnIndex.clear() };
});

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => boundary.store, COMPLETION_METADATA_CONCURRENCY: 2 }));
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => {
      if (typeof value !== "function") return [name, value];
      // queryStore persists open tabs on change; nothing is written anywhere.
      if (name === "saveOpenTabsState")
        return [
          name,
          async () => {
            boundary.state.persisted.push(name);
          },
        ];
      return [
        name,
        (..._args: unknown[]) => {
          boundary.state.blocked.push(`api.${name}`);
          return Promise.reject(new Error(`blocked backend call api.${name}`));
        },
      ];
    }),
  );
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    boundary.state.blocked.push(`tauri.invoke:${command}`);
    return Promise.reject(new Error(`blocked tauri invoke ${command}`));
  },
}));
// Layout and toolbar children of the workspace that hold no editor state.
vi.mock("splitpanes", () => ({
  Splitpanes: { name: "SplitpanesStub", template: `<div class="splitpanes-stub"><slot /></div>` },
  Pane: { name: "PaneStub", template: `<div class="pane-stub"><slot /></div>` },
}));
vi.mock("@/components/layout/EditorToolbar.vue", () => ({ default: { name: "EditorToolbarStub", template: `<div />` } }));
vi.mock("@/components/layout/EditorGroupTabBar.vue", () => ({ default: { name: "EditorGroupTabBarStub", template: `<div />` } }));
vi.mock("@/components/layout/QueryResultSurface.vue", () => ({ default: { name: "QueryResultSurfaceStub", template: `<div />` } }));

import SqlEditorWorkspace from "@/components/layout/SqlEditorWorkspace.vue";
import { useQueryStore } from "@/stores/queryStore";
import { resolveExecutableSql } from "@/lib/sql/sqlExecutionTarget";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  boundary.state.blocked.length = 0;
  boundary.state.persisted.length = 0;
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
  // Zero backend, Tauri, network or unfaked connectionStore access; tab persistence is the only expected store call.
  expect(boundary.state.blocked).toEqual([]);
  expect(new Set(boundary.state.persisted)).toEqual(new Set(["saveOpenTabsState"]));
});

async function mountWorkspace(marked: string) {
  const cursor = marked.indexOf("|");
  const sql = marked.slice(0, cursor) + marked.slice(cursor + 1);
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useQueryStore();
  const tabId = store.createTab("synthetic-connection", "app", "Query 1", "query", "public");
  store.updateSql(tabId, sql);
  const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
  // App.vue locals and handlers.
  const local = reactive({ selectedSql: "", cursorPos: 0 });
  const activeTab = computed(() => store.tabs.find((candidate) => candidate.id === store.activeTabId));
  const host = document.createElement("div");
  document.body.append(host);
  const app: App = createApp({
    render: () =>
      h(SqlEditorWorkspace, {
        activeTab: activeTab.value ?? undefined,
        activeConnection: undefined,
        executableSql: activeTab.value ? resolveExecutableSql(activeTab.value.sql, local.selectedSql, { mode: "statement" as never, cursorPos: local.cursorPos }) : "",
        activeOutputView: "result",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: local.selectedSql,
        cursorPos: local.cursorPos,
        blockDangerousRedisCommands: false,
        showTabNavigation: true,
        onEditorUpdate: (id: string, value: string) => store.updateSql(id, value),
        onEditorSelectionChange: (id: string, value: string) => {
          if (id === store.activeTabId) local.selectedSql = value;
        },
        onEditorCursorChange: (id: string, pos: number) => {
          if (id === store.activeTabId) local.cursorPos = pos;
        },
        onEditorViewportChange: (id: string, viewport: { scrollTop: number; scrollLeft: number }) => store.updateEditorViewport(id, viewport),
        onEditorSelectionStateChange: (id: string, selection: { anchor: number; head: number }) => store.updateEditorSelection(id, selection),
        onEditorStateFlushed: (id: string) => void store.flushEditorState(id),
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
  // Selection-only transactions (a caret re-anchor is two of them).
  const moves: number[] = [];
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (!tr.docChanged && tr.selection) moves.push(tr.selection.main.head);
      }),
    ),
  });
  view.focus();
  view.dispatch({ selection: { anchor: cursor } });
  await nextTick();
  moves.length = 0;
  return { view, tab, moves };
}

function keydown(view: EditorView, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function domCaret(view: EditorView) {
  const selection = document.getSelection();
  return selection?.focusNode ? view.posAtDOM(selection.focusNode, selection.focusOffset) : -1;
}

// A keystroke at the native DOM caret through CodeMirror's input handlers.
function typeAtNativeCaret(view: EditorView, text: string) {
  keydown(view, { key: text });
  const at = domCaret(view);
  const defaultInsert = () => view.state.update({ changes: { from: at, to: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type", scrollIntoView: true });
  if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, at, at, text, defaultInsert))) view.dispatch(defaultInsert());
}

async function typeKeys(view: EditorView, text: string) {
  for (const character of text) {
    typeAtNativeCaret(view, character);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitPopup(view: EditorView) {
  await vi.waitFor(() => expect(currentCompletions(view.state).length > 0 && !!document.querySelector(".cm-tooltip-autocomplete")).toBe(true), { timeout: 3000, interval: 1 });
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await nextTick();
}

describe("real SQL workspace parent: single INSERT column accepted with Enter", () => {
  it.each([
    ["typed '(' auto-opens an empty-prefix popup", "insert into organization_user |", "("],
    ["typed prefix", "insert into organization_user (|)", "organization_i"],
  ])("%s: caret, parent store and DOM caret stay after the column; one re-anchor after the accept; comma lands right", async (_name, marked, typed) => {
    const { view, tab, moves } = await mountWorkspace(marked);
    await typeKeys(view, typed);
    await waitPopup(view);
    moves.length = 0;
    keydown(view, { key: "Enter", code: "Enter" });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull(), { timeout: 3000 });
    const doc = "insert into organization_user (organization_id)";
    expect(view.state.doc.toString()).toBe(doc);
    await settle();
    expect(view.state.selection.main.head).toBe(46);
    expect(domCaret(view)).toBe(46);
    expect(tab.sql).toBe(doc);
    expect(tab.editorSelection).toEqual({ anchor: 46, head: 46 });
    // The WebKit re-anchor shared with paste (queryEditorPasteCaretResync.ts): away and back.
    expect(moves).toEqual([47, 46]);
    typeAtNativeCaret(view, ",");
    await nextTick();
    expect(view.state.doc.toString()).toBe("insert into organization_user (organization_id,)");
    expect(tab.sql).toBe("insert into organization_user (organization_id,)");
    expect(tab.editorSelection).toEqual({ anchor: 47, head: 47 });
  });
});
