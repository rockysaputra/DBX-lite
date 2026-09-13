import { expect, test } from "vitest";
import { CONNECTION_PICKER_OPTIONS } from "../../apps/desktop/src/types/generated/connectionProfiles";
import { filterLiteConnectionOptions } from "../../apps/desktop/src/lib/connection/liteConnectionOptions";

test("Lite preserves relational choices and only the requested specialty databases", () => {
  const options = filterLiteConnectionOptions(CONNECTION_PICKER_OPTIONS);
  const values = (category: string) =>
    options
      .filter((option) => option.category === category)
      .map((option) => option.value)
      .sort();
  expect(values("sql")).toEqual(
    CONNECTION_PICKER_OPTIONS.filter((option) => option.category === "sql")
      .map((option) => option.value)
      .sort(),
  );
  expect(values("analytics")).toEqual(["clickhouse", "databricks", "snowflake"]);
  expect(values("lightweight")).toEqual(["sqlite"]);
  expect(values("document")).toEqual(["cassandra", "dynamodb", "elasticsearch", "mongodb", "redis"]);
  expect(values("timeseries")).toEqual(["victoriametrics"]);
  expect(options.some((option) => ["mq", "graph_ai", "registry_config", "domestic"].includes(option.category))).toBe(false);
});

test("Lite filtering keeps the supplied option objects intact and does not mutate the catalog", () => {
  const postgres = Object.freeze({ value: "postgres", label: "PG custom label", category: "sql" as const });
  const catalog = Object.freeze([postgres, { value: "future-analytics", label: "Unknown", category: "analytics" as const }]);
  const options = filterLiteConnectionOptions(catalog);
  expect(options).toEqual([postgres]);
  expect(options[0]).toBe(postgres);
  expect(catalog).toHaveLength(2);
});
