import type { ConnectionPickerOption } from "@/types/generated/connectionProfiles";

const specialtyDatabases: Readonly<Record<string, readonly string[]>> = {
  analytics: ["clickhouse", "snowflake", "databricks"],
  lightweight: ["sqlite"],
  document: ["redis", "mongodb", "dynamodb", "elasticsearch", "cassandra"],
  timeseries: ["victoriametrics"],
};

/** Lite's new-connection catalog. Existing connection/driver models stay compatible. */
export function filterLiteConnectionOptions<T extends ConnectionPickerOption>(options: readonly T[]): T[] {
  return options.filter((option) => option.category === "sql" || specialtyDatabases[option.category]?.includes(option.value));
}
