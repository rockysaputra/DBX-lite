//! Explicit local-only MCP regression exercise; never reads the user's DBX storage.
//! Run: cargo run -p dbx-mcp --no-default-features --features sqlite-bundled --example lite_local_smoke
//! Requires local PostgreSQL :5432, MySQL :3306, SQL Server :1433 and
//! DBX_LITE_SQLSERVER_PASSWORD. No host, URL, proxy, or saved-config inputs are accepted.

use std::{error::Error, path::Path, sync::Arc, time::Duration};

use dbx_core::{
    models::connection::{ConnectionConfig, DatabaseType},
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, Peer, RoleClient, ServiceExt};
use serde_json::{json, Value};

type SmokeResult<T> = Result<T, Box<dyn Error>>;

fn validate_local(config: &ConnectionConfig, fixture: &Path) -> SmokeResult<()> {
    if config.connection_string.is_some()
        || config.url_params.is_some()
        || !config.transport_layers.is_empty()
        || !config.attached_databases.is_empty()
        || config.init_script.is_some()
        || config.driver_profile.is_some()
    {
        return Err("Local smoke refuses connection overrides, attachments, and tunnels".into());
    }
    if config.db_type == DatabaseType::Sqlite {
        if Path::new(&config.host) != fixture {
            return Err("SQLite must use the fresh smoke fixture".into());
        }
    } else if config.host != "127.0.0.1"
        || !config.read_only
        || !matches!(
            (config.db_type, config.port),
            (DatabaseType::Postgres, 5432) | (DatabaseType::Mysql, 3306) | (DatabaseType::SqlServer, 1433)
        )
    {
        return Err("Network smoke requires an explicit read-only loopback fixture".into());
    }
    Ok(())
}

async fn call(peer: &Peer<RoleClient>, name: &str, arguments: Value, expect_error: bool) -> SmokeResult<String> {
    let request = CallToolRequestParams::new(name.to_owned())
        .with_arguments(arguments.as_object().ok_or("Tool arguments must be an object")?.clone());
    let result = tokio::time::timeout(Duration::from_secs(30), peer.call_tool(request)).await??;
    // Do not print tool payloads: connection failures may contain driver diagnostics.
    if result.is_error.unwrap_or(false) != expect_error {
        if arguments.get("connection_id").and_then(Value::as_str) == Some("lite-sqlite") {
            // This fixture has no credentials and only a temporary local path.
            eprintln!("SQLite fixture diagnostic: {:?}", result.content);
        }
        return Err(format!("{name}: unexpected tool error status (payload withheld)").into());
    }
    Ok(result
        .content
        .iter()
        .filter_map(|item| item.as_text().map(|text| text.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn query(peer: &Peer<RoleClient>, id: &str, sql: &str) -> SmokeResult<String> {
    call(peer, "dbx_execute_query", json!({ "connection_id": id, "sql": sql }), false).await
}

fn session_id(text: &str) -> SmokeResult<&str> {
    text.lines().find_map(|line| line.strip_prefix("session_id: ")).ok_or_else(|| "Missing MCP session ID".into())
}

#[tokio::main]
async fn main() -> SmokeResult<()> {
    let directory = tempfile::tempdir()?;
    let fixture = directory.path().join("lite-fixture.sqlite");
    // Normal DBX connections intentionally refuse to create missing databases.
    std::fs::File::create(&fixture)?;
    let password = std::env::var("DBX_LITE_SQLSERVER_PASSWORD")
        .map_err(|_| "Set DBX_LITE_SQLSERVER_PASSWORD for the local SQL Server fixture")?;
    let mut configs = Vec::new();
    for (id, kind, port, user, database, secret) in [
        ("lite-postgres", "postgres", 5432, "postgres", "postgres", ""),
        ("lite-mysql", "mysql", 3306, "root", "mysql", ""),
        ("lite-sqlserver", "sqlserver", 1433, "sa", "master", password.as_str()),
    ] {
        configs.push(serde_json::from_value::<ConnectionConfig>(json!({
            "id": id, "name": id, "db_type": kind, "host": "127.0.0.1", "port": port,
            "username": user, "password": secret, "database": database,
            "read_only": true, "ssl": false, "connect_timeout_secs": 5, "query_timeout_secs": 10
        }))?);
    }
    configs.push(serde_json::from_value(json!({
        "id": "lite-sqlite", "name": "lite-sqlite", "db_type": "sqlite", "host": fixture.to_string_lossy(), "port": 0,
        "username": "", "password": "", "database": "main", "ssl": false
    }))?);
    for config in &configs {
        validate_local(config, &fixture)?;
    }
    let ids = configs.iter().map(|config| config.id.clone()).collect::<Vec<_>>();
    let storage_path = directory.path().join("dbx.db");
    let storage = Storage::open(&storage_path).await?;
    storage.save_connections(&configs).await?;
    storage
        .save_mcp_global_policy(&McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true, // Only the fresh SQLite config permits writes.
            allowed_connection_ids: Some(ids.clone()),
            query_timeout_secs: Some(10),
            ..Default::default()
        })
        .await?;
    let backend = Arc::new(LocalBackend::open(&storage_path).await?);
    let server = DbxMcpServer::with_runtime_options(
        backend.clone(),
        McpScope { connection_ids: ids.clone(), ..Default::default() },
        false,
    );
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await?;
    let peer = client.peer();
    let tools = peer.list_all_tools().await?;
    for name in [
        "dbx_list_connections",
        "dbx_execute_query",
        "dbx_list_tables",
        "dbx_describe_table",
        "dbx_get_schema_context",
        "dbx_open_session",
        "dbx_close_session",
    ] {
        assert!(tools.iter().any(|tool| tool.name == name), "Required MCP tool missing: {name}");
    }
    let connections = call(peer, "dbx_list_connections", json!({}), false).await?;
    for id in &ids {
        assert!(connections.contains(id), "Isolated connection absent");
    }
    println!("PASS MCP initialization, tool discovery, four isolated connections");

    // A portable synthetic SELECT produces more than MCP's 100-row result ceiling.
    let many_rows =
        (0..120).map(|index| format!("SELECT {index} AS lite_value")).collect::<Vec<_>>().join(" UNION ALL ");
    for id in &ids {
        let result = query(peer, id, "SELECT 1 AS lite_value").await?;
        assert!(result.contains("| 1 |"), "SELECT 1 result missing for {id}");
        let capped = query(peer, id, &many_rows).await?;
        assert_eq!(
            capped.lines().filter(|line| line.starts_with("| ")).count(),
            101,
            "Expected header plus 100 rows for {id}"
        );
        assert!(capped.contains("truncated"), "Missing result ceiling notice for {id}");
        call(peer, "dbx_execute_query", json!({ "connection_id": id, "sql": "SELECT lite_missing_column" }), true)
            .await?;
        assert!(query(peer, id, "SELECT 1 AS lite_value").await?.contains("| 1 |"));
        call(peer, "dbx_list_tables", json!({ "connection_id": id }), false).await?;

        let opened = call(peer, "dbx_open_session", json!({ "connection_id": id }), false).await?;
        let session = session_id(&opened)?;
        let session_result = call(
            peer,
            "dbx_execute_query",
            json!({ "connection_id": id, "session_id": session, "sql": "SELECT 1 AS lite_value" }),
            false,
        )
        .await?;
        assert!(session_result.contains("| 1 |"));
        call(peer, "dbx_close_session", json!({ "session_id": session }), false).await?;
        let closed = call(
            peer,
            "dbx_execute_query",
            json!({ "connection_id": id, "session_id": session, "sql": "SELECT 1" }),
            true,
        )
        .await?;
        assert!(closed.contains("SESSION_NOT_FOUND"));
        backend.state().remove_connection_pools_detached(id).await;
        assert!(query(peer, id, "SELECT 1 AS lite_value").await?.contains("| 1 |"));
        println!("PASS {id}: query, 100-row cap, error recovery, table discovery, session close, reconnect");
    }

    // All mutation statements below are confined to a new temporary SQLite file.
    query(peer, "lite-sqlite", "CREATE TABLE lite_fixture (id INTEGER PRIMARY KEY, label TEXT NOT NULL)").await?;
    query(peer, "lite-sqlite", "INSERT INTO lite_fixture VALUES (1, 'before'), (2, 'second')").await?;
    query(peer, "lite-sqlite", "UPDATE lite_fixture SET label = 'after' WHERE id = 1").await?;
    let edited = query(peer, "lite-sqlite", "SELECT id, label FROM lite_fixture ORDER BY id").await?;
    assert!(edited.contains("| 1 | after |") && edited.contains("| 2 | second |"));
    let described =
        call(peer, "dbx_describe_table", json!({ "connection_id": "lite-sqlite", "table": "lite_fixture" }), false)
            .await?;
    assert!(described.contains("label") && described.contains("id"));
    let context = call(
        peer,
        "dbx_get_schema_context",
        json!({ "connection_id": "lite-sqlite", "tables": ["lite_fixture"] }),
        false,
    )
    .await?;
    assert!(context.contains("lite_fixture") && context.contains("label"));
    println!("PASS SQLite create, insert, edit, ordered readback, describe, schema context");
    client.cancel().await?;
    server_task.abort();
    println!("PASS local MCP smoke complete; temporary storage and SQLite fixture removed on exit");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_guard_rejects_remote_hosts_and_connection_overrides() {
        let fixture = Path::new("/temporary/lite-fixture.sqlite");
        let base = json!({ "id": "test", "name": "test", "db_type": "postgres", "host": "127.0.0.1", "port": 5432, "username": "postgres", "password": "", "database": "postgres", "read_only": true, "ssl": false });
        let config: ConnectionConfig = serde_json::from_value(base.clone()).unwrap();
        assert!(validate_local(&config, fixture).is_ok());
        for (field, value) in [
            ("host", json!("db.example.com")),
            ("host", json!("localhost")),
            ("read_only", json!(false)),
            ("connection_string", json!("postgres://db.example.com/postgres")),
            ("url_params", json!("host=db.example.com")),
        ] {
            let mut altered = base.clone();
            altered[field] = value;
            assert!(validate_local(&serde_json::from_value(altered).unwrap(), fixture).is_err());
        }
    }
}
