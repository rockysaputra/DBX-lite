// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolbarOverflow = vi.hoisted(() => ({ tier: { value: 0 } }));

// __esModule lets Vue's defineAsyncComponent unwrap `.default` instead of treating the mocked module namespace as the component.
vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGridColumnLayoutPopover.vue", () => ({ __esModule: true, default: { render: () => null } }));
// happy-dom has no layout, so drive the measured tier directly.
vi.mock("@/composables/useToolbarOverflow", () => ({
  useToolbarOverflow: () => ({ tier: toolbarOverflow.tier, measure: () => undefined }),
}));
// Every backend call fails loudly and is recorded: the toolbar must not fetch metadata on render.
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? vi.fn(async () => {
            throw new Error(`unexpected backend call: ${name}`);
          })
        : value,
    ]),
  );
});

import ContentArea from "../ContentArea.vue";
import * as api from "@/lib/backend/api";
import en from "@/i18n/locales/en";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";

const cleanups: Array<() => void> = [];
const EDIT_STRUCTURE = /edit.*structure/i;
const VIEW_DDL = /view.*ddl/i;

function connection(id: string, dbType: DatabaseType): ConnectionConfig {
  return { id, name: `${dbType} conn`, db_type: dbType, host: "localhost", port: 1, username: "", password: "" };
}

interface TableOptions {
  id: string;
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  /** tableMeta values that differ from the tab defaults. */
  metaDatabase?: string;
  metaSchema?: string;
}

function dataTab({ id, connectionId, database, schema, tableName, tableType = "BASE TABLE", metaDatabase = database, metaSchema = schema }: TableOptions): QueryTab {
  return {
    id,
    title: schema ? `${schema}.${tableName}` : tableName,
    connectionId,
    database,
    schema,
    mode: "data",
    sql: "",
    isExecuting: false,
    result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
    tableMeta: {
      schema: metaSchema,
      tableName,
      tableType,
      database: metaDatabase,
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    },
  };
}

const pgTab = () => dataTab({ id: "pg-tab", connectionId: "pg", database: "app", schema: "public", tableName: "users" });
const mssqlTab = () => dataTab({ id: "mssql-tab", connectionId: "mssql", database: "sales", schema: "dbo", tableName: "Orders" });

interface MountOptions {
  /** Extra saved connections; the tab's own connection id may deliberately be absent. */
  extraConnections?: ConnectionConfig[];
  /** Makes the query store report a result execution target on another connection. */
  executionTarget?: { connectionId: string; database?: string; schema?: string };
}

function mount(initialTab: QueryTab, options: MountOptions = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection("pg", "postgres"), connection("mssql", "sqlserver"), connection("mysql", "mysql"), connection("influx", "influxdb"), ...(options.extraConnections ?? [])];
  if (options.executionTarget) {
    const target = options.executionTarget;
    vi.spyOn(useQueryStore(), "activeResultExecutionTarget").mockReturnValue({ database: initialTab.database, ...target } as ReturnType<ReturnType<typeof useQueryStore>["activeResultExecutionTarget"]>);
  }
  const state = reactive({ activeTab: initialTab });
  const onViewTableDdl = vi.fn();
  const onEditTableStructure = vi.fn();
  const root = defineComponent({
    setup: () => () =>
      h(ContentArea, {
        activeTab: state.activeTab,
        activeConnection: connectionStore.getConfig(state.activeTab.connectionId),
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
        onViewTableDdl,
        onEditTableStructure,
      }),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(root);
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  return { state, host, onViewTableDdl, onEditTableStructure };
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function accessibleName(button: HTMLButtonElement): string {
  return button.getAttribute("aria-label") || button.textContent?.trim() || button.getAttribute("title") || "";
}

function findAction(host: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => name.test(accessibleName(button)));
}

function click(host: HTMLElement, name: RegExp) {
  const button = findAction(host, name);
  expect(button, `button matching ${name}`).toBeDefined();
  button!.click();
}

describe("ContentArea table data toolbar structure/DDL actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    toolbarOverflow.tier.value = 0;
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await nextTick();
  });

  it.each([
    ["postgres public", pgTab, { name: "users", database: "app", schema: "public" }],
    ["sqlserver dbo", mssqlTab, { name: "Orders", database: "sales", schema: "dbo" }],
  ] as const)("emits the existing events with this tab's id and target for %s", async (_, createTab, expected) => {
    const tab = createTab();
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    click(host, EDIT_STRUCTURE);
    expect(onEditTableStructure).toHaveBeenCalledTimes(1);
    expect(onEditTableStructure.mock.calls[0]![0]).toBe(tab.id);
    expect(onEditTableStructure.mock.calls[0]![1]).toMatchObject(expected);
    expect(onEditTableStructure.mock.calls[0]![1].type ?? "table").toBe("table");

    click(host, VIEW_DDL);
    expect(onViewTableDdl).toHaveBeenCalledTimes(1);
    expect(onViewTableDdl.mock.calls[0]![0]).toBe(tab.id);
    expect(onViewTableDdl.mock.calls[0]![1]).toMatchObject(expected);
    expect(onViewTableDdl.mock.calls[0]![1].type ?? "table").toBe("table");
  });

  it("never reuses a stale target after the active tab or its schema/name changes", async () => {
    const { host, state, onViewTableDdl, onEditTableStructure } = mount(pgTab());
    await settle();
    click(host, EDIT_STRUCTURE);
    expect(onEditTableStructure).toHaveBeenLastCalledWith("pg-tab", expect.objectContaining({ name: "users", schema: "public" }));

    // Different tab and connection.
    state.activeTab = mssqlTab();
    await settle();
    click(host, VIEW_DDL);
    expect(onViewTableDdl).toHaveBeenLastCalledWith("mssql-tab", expect.objectContaining({ name: "Orders", schema: "dbo", database: "sales" }));

    // Same tab id, table re-pointed at another schema and name.
    state.activeTab = { ...dataTab({ id: "mssql-tab", connectionId: "mssql", database: "sales", schema: "archive", tableName: "Orders2024" }) };
    await settle();
    click(host, EDIT_STRUCTURE);
    expect(onEditTableStructure).toHaveBeenCalledTimes(2);
    expect(onEditTableStructure).toHaveBeenLastCalledWith("mssql-tab", expect.objectContaining({ name: "Orders2024", schema: "archive", database: "sales" }));
  });

  it("passes quoted, spaced and dotted identifiers through verbatim", async () => {
    const tab = dataTab({ id: "odd", connectionId: "pg", database: "My App", schema: "Odd Schema", tableName: 'Weird "Table".v1' });
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    click(host, EDIT_STRUCTURE);
    click(host, VIEW_DDL);
    for (const handler of [onEditTableStructure, onViewTableDdl]) {
      const target = handler.mock.calls[0]![1];
      expect(target.name).toBe('Weird "Table".v1');
      expect(target.schema).toBe("Odd Schema");
      expect(target.database).toBe("My App");
    }
  });

  it.each([
    ["VIEW", "view"],
    ["MATERIALIZED VIEW", "materialized_view"],
    ["MATERIALIZED_VIEW", "materialized_view"],
  ] as const)("offers View DDL but not Edit Structure for a %s", async (tableType, navigationType) => {
    const tab = dataTab({ id: "view-tab", connectionId: "pg", database: "app", schema: "public", tableName: "active_users", tableType });
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    click(host, VIEW_DDL);
    expect(onViewTableDdl).toHaveBeenCalledWith("view-tab", expect.objectContaining({ name: "active_users", schema: "public", type: navigationType }));
    expect(onEditTableStructure).not.toHaveBeenCalled();
  });

  it("prefers the table's own tableMeta database and schema over the tab defaults", async () => {
    const tab = dataTab({ id: "meta-tab", connectionId: "pg", database: "app", schema: "public", tableName: "audit_log", metaDatabase: "audit", metaSchema: "logs" });
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    click(host, EDIT_STRUCTURE);
    click(host, VIEW_DDL);
    for (const handler of [onEditTableStructure, onViewTableDdl]) {
      expect(handler).toHaveBeenCalledWith("meta-tab", expect.objectContaining({ name: "audit_log", database: "audit", schema: "logs" }));
    }
  });

  it("emits a schema-less MySQL target using the tableMeta database", async () => {
    const tab = dataTab({ id: "mysql-tab", connectionId: "mysql", database: "shop", tableName: "orders", metaDatabase: "shop_archive" });
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    click(host, EDIT_STRUCTURE);
    click(host, VIEW_DDL);
    for (const handler of [onEditTableStructure, onViewTableDdl]) {
      const target = handler.mock.calls[0]![1];
      expect(handler.mock.calls[0]![0]).toBe("mysql-tab");
      expect(target).toMatchObject({ name: "orders", database: "shop_archive" });
      expect(target.schema).toBeUndefined();
    }
  });

  // Routine types are canonical navigation types (procedure/function/trigger), not tables.
  it.each([["PROCEDURE"], ["FUNCTION"], ["TRIGGER"]])("shows no structure or DDL controls for unsupported %s metadata", async (tableType) => {
    const { host } = mount(dataTab({ id: "odd-type", connectionId: "pg", database: "app", schema: "public", tableName: "thing", tableType }));
    await settle();
    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL)).toBeUndefined();
  });

  it("shows no controls for a database that supports neither structure editing nor DDL", async () => {
    const { host } = mount(dataTab({ id: "influx-tab", connectionId: "influx", database: "metrics", tableName: "cpu" }));
    await settle();
    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL)).toBeUndefined();
  });

  it("shows no controls and emits nothing when the tab has no table identity", async () => {
    const tab = dataTab({ id: "blank", connectionId: "pg", database: "app", schema: "public", tableName: "x" });
    tab.title = "  ";
    tab.tableMeta = { ...tab.tableMeta!, tableName: "   ", columns: [], primaryKeys: [] };
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL)).toBeUndefined();
    expect(onViewTableDdl).not.toHaveBeenCalled();
    expect(onEditTableStructure).not.toHaveBeenCalled();
  });

  it("keeps an accessible name and tooltip when the compact tier hides the visible labels", async () => {
    toolbarOverflow.tier.value = 1;
    const { host, onEditTableStructure } = mount(pgTab());
    await settle();

    for (const name of [EDIT_STRUCTURE, VIEW_DDL]) {
      const button = findAction(host, name);
      expect(button, `compact button matching ${name}`).toBeDefined();
      expect(button!.textContent?.trim()).toBe("");
      expect(button!.getAttribute("title") ?? button!.getAttribute("aria-label") ?? "").toMatch(name);
    }
    click(host, EDIT_STRUCTURE);
    expect(onEditTableStructure).toHaveBeenCalledTimes(1);
  });

  it("shows visible text labels in the full layout", async () => {
    const { host } = mount(pgTab());
    await settle();
    const edit = findAction(host, EDIT_STRUCTURE);
    const ddl = findAction(host, VIEW_DDL);
    expect(edit, "Edit Structure button").toBeDefined();
    expect(ddl, "View DDL button").toBeDefined();
    expect(edit!.textContent).toMatch(EDIT_STRUCTURE);
    expect(ddl!.textContent).toMatch(VIEW_DDL);
  });

  it("offers no controls when the tab's connection config cannot be resolved", async () => {
    // Unknown db type must not fall through to the "DDL supported by default" capability.
    const { host, onViewTableDdl, onEditTableStructure } = mount(dataTab({ id: "orphan", connectionId: "deleted-connection", database: "app", schema: "public", tableName: "users" }));
    await settle();

    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL)).toBeUndefined();
    expect(onViewTableDdl).not.toHaveBeenCalled();
    expect(onEditTableStructure).not.toHaveBeenCalled();
  });

  it("judges capability by the tab's connection, not by a different result execution target", async () => {
    // Tab on postgres, results executed against influxdb: the App route still opens the postgres table.
    const supported = mount(pgTab(), { executionTarget: { connectionId: "influx", database: "metrics" } });
    await settle();
    expect(findAction(supported.host, EDIT_STRUCTURE), "Edit Structure on postgres tab").toBeDefined();
    expect(findAction(supported.host, VIEW_DDL), "View DDL on postgres tab").toBeDefined();
    click(supported.host, VIEW_DDL);
    expect(supported.onViewTableDdl).toHaveBeenCalledWith("pg-tab", expect.objectContaining({ name: "users", schema: "public", database: "app" }));

    // Tab on influxdb (no structure/DDL), results executed against postgres: still no controls.
    const unsupported = mount(dataTab({ id: "influx-tab", connectionId: "influx", database: "metrics", tableName: "cpu" }), { executionTarget: { connectionId: "pg", database: "app", schema: "public" } });
    await settle();
    expect(findAction(unsupported.host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(unsupported.host, VIEW_DDL)).toBeUndefined();
  });

  it("resolves a generic JDBC connection through its effective dialect", async () => {
    const jdbcPostgres: ConnectionConfig = { ...connection("jdbc-pg", "jdbc"), driver_profile: "custom", connection_string: "jdbc:postgresql://localhost:5432/app" };
    const tab = dataTab({ id: "jdbc-pg-tab", connectionId: "jdbc-pg", database: "app", schema: "public", tableName: "users" });
    const { host, onEditTableStructure } = mount(tab, { extraConnections: [jdbcPostgres] });
    await settle();

    // Raw db_type "jdbc" has no structure capability; the inferred postgres dialect does.
    expect(findAction(host, EDIT_STRUCTURE), "Edit Structure for jdbc->postgres").toBeDefined();
    expect(findAction(host, VIEW_DDL), "View DDL for jdbc->postgres").toBeDefined();
    click(host, EDIT_STRUCTURE);
    expect(onEditTableStructure).toHaveBeenCalledWith("jdbc-pg-tab", expect.objectContaining({ name: "users", schema: "public", database: "app" }));
  });

  it("keeps a generic JDBC connection without an inferable dialect read-only", async () => {
    const genericJdbc: ConnectionConfig = { ...connection("jdbc-generic", "jdbc"), driver_profile: "acme", connection_string: "jdbc:acme://localhost/app" };
    const { host } = mount(dataTab({ id: "jdbc-generic-tab", connectionId: "jdbc-generic", database: "app", schema: "public", tableName: "users" }), { extraConnections: [genericJdbc] });
    await settle();

    // Effective type stays "jdbc": no structure-editing capability, default (true) DDL capability.
    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL), "View DDL for generic jdbc").toBeDefined();
  });

  it("moves both actions into the overflow menu at the narrowest tier and routes them to the same events", async () => {
    toolbarOverflow.tier.value = 2;
    const tab = pgTab();
    const { host, onViewTableDdl, onEditTableStructure } = mount(tab);
    await settle();

    // No clipped toolbar buttons remain; the actions live behind the "more actions" trigger.
    expect(findAction(host, EDIT_STRUCTURE)).toBeUndefined();
    expect(findAction(host, VIEW_DDL)).toBeUndefined();
    const trigger = findAction(host, /more actions/i);
    expect(trigger, "overflow trigger").toBeDefined();

    const menuItem = (name: RegExp) => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => name.test(item.textContent ?? ""));
    const openMenu = async () => {
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle();
    };

    await openMenu();
    expect(menuItem(EDIT_STRUCTURE), "Edit Structure menu item").toBeDefined();
    expect(menuItem(VIEW_DDL), "View DDL menu item").toBeDefined();
    menuItem(EDIT_STRUCTURE)!.click();
    await settle();
    expect(onEditTableStructure).toHaveBeenCalledTimes(1);
    expect(onEditTableStructure).toHaveBeenCalledWith(tab.id, expect.objectContaining({ name: "users", database: "app", schema: "public" }));

    await openMenu();
    menuItem(VIEW_DDL)!.click();
    await settle();
    expect(onViewTableDdl).toHaveBeenCalledTimes(1);
    expect(onViewTableDdl).toHaveBeenCalledWith(tab.id, expect.objectContaining({ name: "users", database: "app", schema: "public" }));
  });

  it("loads no metadata from the backend while rendering, only the emitted event carries the request", async () => {
    const { host, onViewTableDdl } = mount(pgTab());
    await settle();
    // The controls must exist (otherwise this guard is vacuous).
    expect(findAction(host, EDIT_STRUCTURE)).toBeDefined();
    expect(findAction(host, VIEW_DDL)).toBeDefined();

    const backendCalls = Object.values(api).flatMap((value) => (vi.isMockFunction(value) ? value.mock.calls : []));
    expect(backendCalls).toEqual([]);

    click(host, VIEW_DDL);
    await settle();
    expect(onViewTableDdl).toHaveBeenCalledTimes(1);
    const callsAfterClick = Object.values(api).flatMap((value) => (vi.isMockFunction(value) ? value.mock.calls : []));
    expect(callsAfterClick).toEqual([]);
  });
});
