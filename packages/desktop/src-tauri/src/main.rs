#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:39787";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStatus {
    id: String,
    name: String,
    connected: bool,
    running: bool,
    account_id: Option<String>,
    last_seen_at: Option<String>,
    session_expires_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteSummary {
    id: String,
    name: String,
    description: String,
    enabled: bool,
    priority: i32,
    connector_id: String,
    match_text: Vec<String>,
    stats: RouteStats,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteStats {
    messages_today: u32,
    last_hit_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSummary {
    id: String,
    name: String,
    kind: String,
    status: String,
    route_count: u32,
    description: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceEvent {
    id: String,
    time: String,
    level: String,
    source: String,
    message: String,
    route_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSnapshot {
    llm_provider: String,
    memory_provider: String,
    autostart_enabled: bool,
    router_endpoint: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
    profile: ProfileStatus,
    routes: Vec<RouteSummary>,
    agents: Vec<AgentSummary>,
    traces: Vec<TraceEvent>,
    settings: SettingsSnapshot,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QrLoginResponse {
    profile_id: String,
    qr_url: String,
    qr_payload: String,
    qrcode: String,
    expires_in_seconds: u32,
    status: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStatus {
    profile_id: String,
    status: String,
    active: bool,
    connected: bool,
    account_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsPayload {
    llm_provider: String,
    memory_provider: String,
    autostart_enabled: bool,
    router_endpoint: String,
}

fn sample_snapshot() -> DashboardSnapshot {
    DashboardSnapshot {
        profile: ProfileStatus {
            id: "default".into(),
            name: "Main WeChat".into(),
            connected: false,
            running: false,
            account_id: None,
            last_seen_at: None,
            session_expires_at: None,
        },
        routes: vec![
            RouteSummary {
                id: "main-assistant-default".into(),
                name: "大助手".into(),
                description: "默认入口：普通对话、创建 route、管理下游功能。".into(),
                enabled: true,
                priority: -100,
                connector_id: "main-assistant".into(),
                match_text: vec!["fallback".into()],
                stats: RouteStats {
                    messages_today: 0,
                    last_hit_at: None,
                },
            },
            RouteSummary {
                id: "assistant-route-default-sales".into(),
                name: "Sales".into(),
                description: "示例 route：处理报价、价格、销售相关消息。".into(),
                enabled: true,
                priority: 80,
                connector_id: "route-assistant".into(),
                match_text: vec!["报价".into(), "价格".into(), "/sales".into()],
                stats: RouteStats {
                    messages_today: 0,
                    last_hit_at: None,
                },
            },
            RouteSummary {
                id: "assistant-route-default-calendar".into(),
                name: "Calendar".into(),
                description: "示例 route：后续可接 macOS Calendar / Reminder。".into(),
                enabled: false,
                priority: 70,
                connector_id: "mcp-calendar".into(),
                match_text: vec!["日程".into(), "calendar".into()],
                stats: RouteStats {
                    messages_today: 0,
                    last_hit_at: None,
                },
            },
        ],
        agents: vec![
            AgentSummary {
                id: "main-assistant".into(),
                name: "大助手".into(),
                kind: "LLM route harness".into(),
                status: "ready".into(),
                route_count: 1,
                description: "负责默认对话、route 分发和 route 创建。".into(),
            },
            AgentSummary {
                id: "wechat2all-mcp".into(),
                name: "wechat2all MCP Server".into(),
                kind: "MCP".into(),
                status: "planned".into(),
                route_count: 0,
                description: "给 Codex/Claude/Cursor 等 agent 暴露微信发送和查询工具。".into(),
            },
        ],
        traces: vec![
            TraceEvent {
                id: "trace-1".into(),
                time: "not connected".into(),
                level: "info".into(),
                source: "desktop".into(),
                message: "Dashboard is running. Router daemon integration is the next layer.".into(),
                route_id: None,
            },
        ],
        settings: SettingsSnapshot {
            llm_provider: "deepseek/openai-compatible".into(),
            memory_provider: "local-jsonl + mem0".into(),
            autostart_enabled: false,
            router_endpoint: "local://wechat2all-router".into(),
        },
    }
}

fn env_or_default(name: &str, default_value: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default_value.to_string())
}

fn trim_trailing_slash(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn daemon_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("Failed to create local router daemon HTTP client: {err}"))
}

fn daemon_error(action: &str, status: reqwest::StatusCode, body: &str) -> String {
    let parsed_error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_string));
    let detail = parsed_error.unwrap_or_else(|| body.trim().to_string());
    if detail.is_empty() {
        format!("{action} failed ({status}). Check the router-daemon terminal output for details.")
    } else {
        format!("{action} failed ({status}): {detail}")
    }
}

#[tauri::command]
async fn get_dashboard_snapshot() -> DashboardSnapshot {
    let daemon_url = trim_trailing_slash(&env_or_default(
        "WECHAT2ALL_ROUTER_DAEMON_URL",
        DEFAULT_DAEMON_URL,
    ));
    let url = format!("{daemon_url}/snapshot");
    let client = match daemon_http_client() {
        Ok(client) => client,
        Err(_) => return sample_snapshot(),
    };
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => {
            response.json::<DashboardSnapshot>().await.unwrap_or_else(|_| sample_snapshot())
        }
        _ => sample_snapshot(),
    }
}

#[tauri::command]
async fn request_qr_login(profile_id: String) -> Result<QrLoginResponse, String> {
    let daemon_url = trim_trailing_slash(&env_or_default(
        "WECHAT2ALL_ROUTER_DAEMON_URL",
        DEFAULT_DAEMON_URL,
    ));
    let url = format!("{daemon_url}/login/qr/start");
    let response = daemon_http_client()?
        .post(&url)
        .json(&serde_json::json!({ "profileId": profile_id }))
        .send()
        .await
        .map_err(|err| {
            format!(
                "Router daemon is not reachable at {daemon_url}. Start it with `pnpm desktop`. Details: {err}"
            )
        })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read router daemon QR response: {err}"))?;
    if !status.is_success() {
        return Err(daemon_error("Router daemon QR request", status, &body));
    }
    serde_json::from_str::<QrLoginResponse>(&body)
        .map_err(|err| format!("Failed to parse router daemon QR response: {err}: {body}"))
}

#[tauri::command]
async fn get_login_status(profile_id: String) -> Result<LoginStatus, String> {
    let daemon_url = trim_trailing_slash(&env_or_default(
        "WECHAT2ALL_ROUTER_DAEMON_URL",
        DEFAULT_DAEMON_URL,
    ));
    let url = format!("{daemon_url}/login/status?profileId={profile_id}");
    let response = daemon_http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("Router daemon is not reachable at {daemon_url}: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read router daemon login status: {err}"))?;
    if !status.is_success() {
        return Err(daemon_error("Router daemon login status", status, &body));
    }
    serde_json::from_str::<LoginStatus>(&body)
        .map_err(|err| format!("Failed to parse router daemon login status: {err}: {body}"))
}

#[tauri::command]
async fn unlink_wechat_session(profile_id: String) -> Result<(), String> {
    let daemon_url = trim_trailing_slash(&env_or_default(
        "WECHAT2ALL_ROUTER_DAEMON_URL",
        DEFAULT_DAEMON_URL,
    ));
    let url = format!("{daemon_url}/login/unlink");
    let response = daemon_http_client()?
        .post(&url)
        .json(&serde_json::json!({ "profileId": profile_id }))
        .send()
        .await
        .map_err(|err| format!("Router daemon is not reachable at {daemon_url}: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read router daemon unlink response: {err}"))?;
    if !status.is_success() {
        return Err(daemon_error("Router daemon unlink request", status, &body));
    }
    Ok(())
}

#[tauri::command]
fn save_settings(payload: SaveSettingsPayload) -> SettingsSnapshot {
    SettingsSnapshot {
        llm_provider: payload.llm_provider,
        memory_provider: payload.memory_provider,
        autostart_enabled: payload.autostart_enabled,
        router_endpoint: payload.router_endpoint,
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_dashboard_snapshot,
            request_qr_login,
            get_login_status,
            unlink_wechat_session,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running wechat2all desktop app");
}
