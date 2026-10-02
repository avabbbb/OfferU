// OfferU Tauri desktop launcher (dev mode)
// 启动时只 spawn FastAPI + Python AgentKernel @ :8766。
// frontend Vite dev @ :7410 由 tauri.conf.json 的 beforeDevCommand 负责，避免重复启动。
// dev WebView 加载 http://127.0.0.1:7410；release WebView 直接加载嵌入的 dist。
// 关窗时 kill 后端子进程

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

mod process_lifecycle;

use process_lifecycle::ProcessTree;

#[derive(Default)]
struct Children(Arc<Mutex<Option<ProcessTree>>>);

#[derive(Default)]
struct DesktopRuntimeIdentityState(Mutex<Option<DesktopRuntimeIdentity>>);

#[derive(Clone, serde::Serialize)]
struct DesktopRuntimeIdentity {
    runtime_instance_id: String,
    version: String,
    commit: Option<String>,
    build_timestamp: Option<String>,
    dirty: Option<bool>,
    source_fingerprint: Option<String>,
    data_root: String,
    runtime_type: String,
}

struct UiApprovalCapability(String);

#[tauri::command]
fn get_desktop_runtime_identity(
    state: tauri::State<'_, DesktopRuntimeIdentityState>,
) -> Result<DesktopRuntimeIdentity, String> {
    state
        .0
        .lock()
        .map_err(|_| "Desktop Runtime identity is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Desktop Runtime has not initialized its identity".to_string())
}

async fn post_approval_request(
    app: AppHandle,
    path: String,
    body: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let token = app.state::<UiApprovalCapability>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| "无法连接 OfferU 本地服务".to_string())?;
        let response = client
            .post(format!("http://127.0.0.1:8766{path}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|_| "无法提交 OfferU 提案决定".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "OfferU 未接受该提案决定（HTTP {}）",
                response.status()
            ));
        }
        response
            .json::<serde_json::Value>()
            .map_err(|_| "OfferU 返回了无效的提案决定结果".to_string())
    })
    .await
    .map_err(|_| "OfferU 提案决定任务中断".to_string())?
}

fn validate_approval_input(run_id: String, action_id: String) -> Result<(String, String), String> {
    let run_id = Uuid::parse_str(&run_id)
        .map_err(|_| "提案标识无效".to_string())?
        .to_string();
    if action_id.trim().is_empty() || action_id.len() > 200 {
        return Err("提案动作标识无效".to_string());
    }
    Ok((run_id, action_id))
}

#[tauri::command]
async fn decide_agent_proposal(
    app: AppHandle,
    run_id: String,
    action_id: String,
    approve: bool,
) -> Result<serde_json::Value, String> {
    let (run_id, action_id) = validate_approval_input(run_id, action_id)?;
    post_approval_request(
        app,
        format!("/api/bridge/proposals/{run_id}/confirm"),
        serde_json::json!({"approve": approve, "action_id": action_id}),
        Duration::from_secs(15),
    )
    .await
}

#[tauri::command]
async fn decide_agent_runtime_action(
    app: AppHandle,
    run_id: String,
    action_id: String,
    approve: bool,
) -> Result<serde_json::Value, String> {
    let (run_id, action_id) = validate_runtime_approval_input(run_id, action_id)?;
    let decision = if approve { "confirm" } else { "reject" };
    post_approval_request(
        app,
        format!("/api/agent/runtime/runs/{run_id}/{decision}"),
        serde_json::json!({"action_id": action_id}),
        Duration::from_secs(if approve { 240 } else { 15 }),
    )
    .await
}

fn validate_runtime_approval_input(
    run_id: String,
    action_id: String,
) -> Result<(String, String), String> {
    let suffix = run_id.strip_prefix("run_").ok_or("任务标识无效")?;
    if !(16..=32).contains(&suffix.len())
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || action_id.trim().is_empty()
        || action_id.len() > 200
    {
        return Err("任务或动作标识无效".to_string());
    }
    Ok((run_id, action_id))
}

#[cfg(test)]
mod approval_tests {
    use super::validate_runtime_approval_input;

    #[test]
    fn accepts_runtime_ids_and_rejects_path_injection() {
        assert!(
            validate_runtime_approval_input("run_0123456789abcdef".into(), "update:1".into())
                .is_ok()
        );
        for id in [
            "run_0123456789abcdef/confirm",
            "../run_0123456789abcdef",
            "run_short",
            "run_0123456789abcdeg",
        ] {
            assert!(validate_runtime_approval_input(id.into(), "update:1".into()).is_err());
        }
        assert!(
            validate_runtime_approval_input("run_0123456789abcdef".into(), " ".into()).is_err()
        );
    }
}

#[cfg(test)]
mod desktop_runtime_tests {
    use super::{
        build_commit, build_dirty, build_source_fingerprint, build_timestamp,
        database_url_for_data_root, expected_build_mode, health_response_matches, runtime_mode,
        validate_data_root_override,
    };
    use std::ffi::OsString;
    use std::process::Command;
    #[test]
    fn data_root_override_requires_an_absolute_path() {
        assert!(validate_data_root_override(Some(OsString::from("relative/data"))).is_err());
        assert_eq!(validate_data_root_override(None).unwrap(), None);

        let absolute = std::env::temp_dir().join("offeru-test-data");
        assert_eq!(
            validate_data_root_override(Some(absolute.clone().into_os_string())).unwrap(),
            Some(absolute)
        );
    }

    #[test]
    fn desktop_backend_overrides_inherited_database_url_with_selected_data_root() {
        let selected_root = std::env::temp_dir().join("offeru-native-selected-root");
        let foreign_database_url = "sqlite+aiosqlite:///H:/synthetic/foreign-root/djm.db";
        let expected_database_url = database_url_for_data_root(&selected_root);
        let mut command = Command::new("python");
        command.env("DATABASE_URL", foreign_database_url);

        super::configure_backend_command(
            &mut command,
            &selected_root,
            "b0ca9cba-3f8f-4a16-b1db-d607b4e2cb38",
            "synthetic-approval-token",
        );

        let configured_database_url = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("DATABASE_URL"))
            .and_then(|(_, value)| value)
            .expect("desktop child must explicitly configure DATABASE_URL");
        assert_eq!(
            configured_database_url,
            std::ffi::OsStr::new(&expected_database_url)
        );
        assert_ne!(
            configured_database_url,
            std::ffi::OsStr::new(foreign_database_url)
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("OFFERU_DATA_DIR"))
                .and_then(|(_, value)| value),
            Some(selected_root.as_os_str())
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("OFFERU_BUILD_MODE"))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new(expected_build_mode()))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("OFFERU_RUNTIME_MODE"))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new(runtime_mode()))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("OFFERU_VERSION"))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new(env!("CARGO_PKG_VERSION")))
        );
        if cfg!(debug_assertions) {
            assert_eq!(expected_build_mode(), "local-development");
            assert_eq!(runtime_mode(), "local");
        }
    }

    #[test]
    fn backend_ready_requires_this_instance_and_build_identity() {
        let data_root = std::env::temp_dir();
        let expected_id = "b0ca9cba-3f8f-4a16-b1db-d607b4e2cb38";
        let health = serde_json::json!({
            "status": "ok",
            "service": "OfferU",
            "runtime": "python",
            "build_mode": expected_build_mode(),
            "runtime_mode": runtime_mode(),
            "version": env!("CARGO_PKG_VERSION"),
            "runtime_instance_id": expected_id,
            "build_identity": {
                "version": env!("CARGO_PKG_VERSION"),
                "commit": build_commit(),
                "build_timestamp": build_timestamp(),
                "data_root": data_root.to_string_lossy(),
                "runtime_type": runtime_mode(),
                "dirty": build_dirty(),
                "source_fingerprint": build_source_fingerprint()
            }
        });
        let release_identity_known = expected_build_mode() != "release"
            || (build_commit().is_some()
                && build_timestamp().is_some()
                && build_dirty().is_some()
                && build_source_fingerprint().is_some());

        assert_eq!(
            health_response_matches(&health, &data_root, expected_id, runtime_mode()),
            release_identity_known
        );
        assert!(!health_response_matches(
            &health,
            &data_root,
            "a17f6393-6a53-4656-9f21-3798dcc39670",
            runtime_mode()
        ));

        let mut legacy = health.clone();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("runtime_instance_id");
        assert!(!health_response_matches(
            &legacy,
            &data_root,
            expected_id,
            runtime_mode()
        ));

        let mut stale_fingerprint = health.clone();
        stale_fingerprint["build_identity"]["source_fingerprint"] =
            serde_json::Value::String("sha256:stale".to_string());
        assert!(!health_response_matches(
            &stale_fingerprint,
            &data_root,
            expected_id,
            runtime_mode()
        ));
    }

    #[test]
    fn unbuilt_identity_fields_serialize_as_null() {
        let identity = super::DesktopRuntimeIdentity {
            runtime_instance_id: "b0ca9cba-3f8f-4a16-b1db-d607b4e2cb38".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            commit: build_commit().map(str::to_string),
            build_timestamp: build_timestamp().map(str::to_string),
            dirty: build_dirty(),
            source_fingerprint: build_source_fingerprint().map(str::to_string),
            data_root: std::env::temp_dir().to_string_lossy().into_owned(),
            runtime_type: runtime_mode().to_string(),
        };
        let serialized = serde_json::to_value(identity).unwrap();
        if build_timestamp().is_none() {
            assert!(serialized["build_timestamp"].is_null());
        }
        if build_source_fingerprint().is_none() {
            assert!(serialized["source_fingerprint"].is_null());
        }
    }
}

fn find_packaged_file(
    resource_dir: &std::path::Path,
    names: &[&str],
) -> Option<std::path::PathBuf> {
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(|directory| directory.to_path_buf()));
    executable_dir
        .into_iter()
        .chain(std::iter::once(resource_dir.to_path_buf()))
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
}

fn project_root_from_exe() -> std::path::PathBuf {
    // dev: target/debug/app.exe -> 向上直到含 frontend/ 和 backend/ 的目录
    let mut d = std::env::current_exe().unwrap();
    for _ in 0..8 {
        if d.join("frontend").is_dir() && d.join("backend").is_dir() {
            return d;
        }
        if !d.pop() {
            break;
        }
    }
    std::env::current_dir().unwrap_or_default()
}

fn build_commit() -> Option<&'static str> {
    option_env!("OFFERU_BUILD_COMMIT").filter(|value| !value.is_empty() && *value != "unknown")
}

fn build_timestamp() -> Option<&'static str> {
    option_env!("OFFERU_BUILD_TIMESTAMP").filter(|value| !value.is_empty() && *value != "unknown")
}

fn build_dirty() -> Option<bool> {
    match option_env!("OFFERU_BUILD_DIRTY") {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

fn build_source_fingerprint() -> Option<&'static str> {
    option_env!("OFFERU_BUILD_SOURCE_FINGERPRINT")
        .filter(|value| !value.is_empty() && *value != "unknown")
}

fn validate_data_root_override(value: Option<OsString>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("OFFERU_DATA_DIR must be an absolute path".to_string());
    }
    Ok(Some(path))
}

fn resolve_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = validate_data_root_override(std::env::var_os("OFFERU_DATA_DIR"))?;
    let data_root = match configured {
        Some(path) => path,
        None if cfg!(debug_assertions) => project_root_from_exe().join("backend"),
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("cannot resolve app data directory: {error}"))?,
    };
    fs::create_dir_all(&data_root)
        .map_err(|error| format!("cannot create app data directory: {error}"))?;
    Ok(data_root)
}

fn runtime_mode() -> &'static str {
    if cfg!(debug_assertions) {
        "local"
    } else {
        "desktop-sidecar"
    }
}

fn database_url_for_data_root(data_root: &Path) -> String {
    let database_path = data_root
        .join("djm.db")
        .to_string_lossy()
        .replace('\\', "/");
    format!("sqlite+aiosqlite:///{database_path}")
}

fn configure_backend_command(
    command: &mut Command,
    data_root: &Path,
    runtime_instance_id: &str,
    approval_token: &str,
) {
    command
        .env("OFFERU_DATA_DIR", data_root)
        // The desktop-selected data root is the authority for the Runtime DB.
        // An inherited DATABASE_URL wins over both backend/.env and the
        // runtime default, so bind the child explicitly to this root.
        .env("DATABASE_URL", database_url_for_data_root(data_root))
        .env("OFFERU_RUNTIME_INSTANCE_ID", runtime_instance_id)
        .env(
            "OFFERU_BUILD_MODE",
            if cfg!(debug_assertions) {
                "local-development"
            } else {
                "release"
            },
        )
        .env("OFFERU_RUNTIME_MODE", runtime_mode())
        .env("OFFERU_APPROVAL_TOKEN", approval_token)
        .env("OFFERU_VERSION", env!("CARGO_PKG_VERSION"))
        .env("OFFERU_PORT", "8766")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(commit) = build_commit() {
        command.env("OFFERU_BUILD_COMMIT", commit);
    } else {
        command.env_remove("OFFERU_BUILD_COMMIT");
    }
    if let Some(timestamp) = build_timestamp() {
        command.env("OFFERU_BUILD_TIMESTAMP", timestamp);
    } else {
        command.env_remove("OFFERU_BUILD_TIMESTAMP");
    }
    if let Some(dirty) = build_dirty() {
        command.env("OFFERU_BUILD_DIRTY", dirty.to_string());
    } else {
        command.env_remove("OFFERU_BUILD_DIRTY");
    }
    if let Some(source_fingerprint) = build_source_fingerprint() {
        command.env("OFFERU_BUILD_SOURCE_FINGERPRINT", source_fingerprint);
    } else {
        command.env_remove("OFFERU_BUILD_SOURCE_FINGERPRINT");
    }
}

fn spawn_python_backend(
    root: &Path,
    data_root: &Path,
    runtime_instance_id: &str,
    approval_token: &str,
) -> Command {
    let py = root
        .join("backend")
        .join(".venv312")
        .join("Scripts")
        .join("python.exe");
    let py_str = if py.is_file() {
        py.to_string_lossy().into_owned()
    } else {
        String::from("python")
    };
    let cwd = root.join("backend");

    println!("[OfferU] spawning Python backend on :8766: run_server.py");

    let mut cmd = Command::new(&py_str);
    cmd.arg("run_server.py").current_dir(&cwd);
    configure_backend_command(&mut cmd, data_root, runtime_instance_id, approval_token);
    cmd
}

fn spawn_release_sidecar(
    app: &AppHandle,
    data_root: &Path,
    runtime_instance_id: &str,
    approval_token: &str,
) -> Result<Command, String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(path) => path,
        Err(error) => return Err(format!("cannot resolve resource directory: {error}")),
    };
    #[cfg(windows)]
    let backend_names = [
        "offeru-backend.exe",
        "offeru-backend-x86_64-pc-windows-msvc.exe",
        "offeru-backend-aarch64-pc-windows-msvc.exe",
    ];
    #[cfg(target_os = "macos")]
    let backend_names = [
        "offeru-backend",
        "offeru-backend-aarch64-apple-darwin",
        "offeru-backend-x86_64-apple-darwin",
    ];
    #[cfg(target_os = "linux")]
    let backend_names = [
        "offeru-backend",
        "offeru-backend-x86_64-unknown-linux-gnu",
        "offeru-backend-aarch64-unknown-linux-gnu",
    ];
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let backend_names = ["offeru-backend"];

    #[cfg(windows)]
    let node_names = [
        "offeru-node.exe",
        "offeru-node-x86_64-pc-windows-msvc.exe",
        "offeru-node-aarch64-pc-windows-msvc.exe",
    ];
    #[cfg(target_os = "macos")]
    let node_names = [
        "offeru-node",
        "offeru-node-aarch64-apple-darwin",
        "offeru-node-x86_64-apple-darwin",
    ];
    #[cfg(target_os = "linux")]
    let node_names = [
        "offeru-node",
        "offeru-node-x86_64-unknown-linux-gnu",
        "offeru-node-aarch64-unknown-linux-gnu",
    ];
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let node_names = ["offeru-node"];

    let sidecar = find_packaged_file(&resource_dir, &backend_names);

    let Some(sidecar) = sidecar else {
        return Err("packaged backend sidecar was not found beside the app executable or in the resource directory".to_string());
    };
    let node = find_packaged_file(&resource_dir, &node_names);
    if node.is_none() {
        eprintln!("[OfferU] packaged Node runtime was not found; Node-based Agent providers may be unavailable");
    }

    let cors_origins = concat!(
        "http://localhost:7410,http://127.0.0.1:7410,",
        "http://tauri.localhost,https://tauri.localhost,tauri://localhost"
    );
    println!("[OfferU] spawning packaged backend sidecar on :8766");
    let mut cmd = Command::new(sidecar);
    cmd.env(
        "OFFERU_AGENT_RUNTIME_DIR",
        resource_dir.join("agent-runtime"),
    )
    .env("CORS_ORIGINS", cors_origins)
    .current_dir(data_root);
    configure_backend_command(&mut cmd, data_root, runtime_instance_id, approval_token);
    if let Some(node) = node {
        cmd.env("OFFERU_NODE_PATH", node);
    }

    Ok(cmd)
}

fn spawn_backend(
    app: &AppHandle,
    data_root: &Path,
    runtime_instance_id: &str,
    approval_token: &str,
) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        return Ok(spawn_python_backend(
            &project_root_from_exe(),
            data_root,
            runtime_instance_id,
            approval_token,
        ));
    }
    spawn_release_sidecar(app, data_root, runtime_instance_id, approval_token)
}

fn expected_build_mode() -> &'static str {
    let expected_build_mode = if cfg!(debug_assertions) {
        "local-development"
    } else {
        "release"
    };
    expected_build_mode
}

fn optional_string_matches(
    identity: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    expected: Option<&str>,
) -> bool {
    match expected {
        Some(expected) => identity.get(key).and_then(|value| value.as_str()) == Some(expected),
        None => identity.get(key).is_some_and(serde_json::Value::is_null),
    }
}

fn optional_bool_matches(
    identity: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    expected: Option<bool>,
) -> bool {
    match expected {
        Some(expected) => identity.get(key).and_then(|value| value.as_bool()) == Some(expected),
        None => identity.get(key).is_some_and(serde_json::Value::is_null),
    }
}

fn normalized_data_root(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn build_identity_matches(
    object: &serde_json::Map<String, serde_json::Value>,
    data_root: &Path,
    expected_runtime_type: &str,
) -> bool {
    let Some(identity) = object
        .get("build_identity")
        .and_then(|value| value.as_object())
    else {
        return false;
    };
    let expected_data_root = data_root.to_string_lossy();
    let release_identity_known = expected_build_mode() != "release"
        || (build_commit().is_some()
            && build_timestamp().is_some()
            && build_dirty().is_some()
            && build_source_fingerprint().is_some());

    identity.get("version").and_then(|value| value.as_str()) == Some(env!("CARGO_PKG_VERSION"))
        && optional_string_matches(&identity, "commit", build_commit())
        && optional_string_matches(&identity, "build_timestamp", build_timestamp())
        && optional_bool_matches(&identity, "dirty", build_dirty())
        && optional_string_matches(&identity, "source_fingerprint", build_source_fingerprint())
        && identity
            .get("data_root")
            .and_then(|value| value.as_str())
            .is_some_and(|value| {
                normalized_data_root(value) == normalized_data_root(&expected_data_root)
            })
        && identity
            .get("runtime_type")
            .and_then(|value| value.as_str())
            == Some(expected_runtime_type)
        && release_identity_known
}

fn health_response_matches(
    payload: &serde_json::Value,
    data_root: &Path,
    runtime_instance_id: &str,
    expected_runtime_type: &str,
) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };
    object.get("status").and_then(|value| value.as_str()) == Some("ok")
        && object.get("service").and_then(|value| value.as_str()) == Some("OfferU")
        && object.get("runtime").and_then(|value| value.as_str()) == Some("python")
        && object.get("build_mode").and_then(|value| value.as_str()) == Some(expected_build_mode())
        && object.get("runtime_mode").and_then(|value| value.as_str())
            == Some(expected_runtime_type)
        && object.get("version").and_then(|value| value.as_str()) == Some(env!("CARGO_PKG_VERSION"))
        && object
            .get("runtime_instance_id")
            .and_then(|value| value.as_str())
            == Some(runtime_instance_id)
        && build_identity_matches(object, data_root, expected_runtime_type)
}

fn owned_backend_is_alive(children: &Arc<Mutex<Option<ProcessTree>>>) -> bool {
    children
        .lock()
        .map(|mut children| children.as_mut().is_some_and(ProcessTree::is_alive))
        .unwrap_or(false)
}

fn terminate_owned_backend(children: &Arc<Mutex<Option<ProcessTree>>>) {
    let child = children
        .lock()
        .ok()
        .and_then(|mut children| children.take());
    drop(child);
}

fn wait_for_python_backend(
    children: &Arc<Mutex<Option<ProcessTree>>>,
    data_root: &Path,
    runtime_instance_id: &str,
    expected_runtime_type: &str,
    timeout_secs: u64,
) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!(
                "[OfferU] cannot create direct loopback health client: {}",
                error
            );
            return false;
        }
    };
    loop {
        if !owned_backend_is_alive(children) {
            return false;
        }
        if let Ok(response) = client
            .get("http://127.0.0.1:8766/api/health")
            .timeout(Duration::from_secs(1))
            .send()
        {
            let response_ok = response.status().is_success();
            let health_identity_ok = response
                .text()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .is_some_and(|payload| {
                    health_response_matches(
                        &payload,
                        data_root,
                        runtime_instance_id,
                        expected_runtime_type,
                    )
                });
            if response_ok && health_identity_ok && owned_backend_is_alive(children) {
                return true;
            }
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(700));
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "外部链接无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" | "mailto" | "tel" => {}
        _ => return Err("不支持此外部链接协议".to_string()),
    }

    let target = parsed.as_str();

    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(target);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
        return command
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法使用系统默认应用打开链接".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        return Command::new("/usr/bin/open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法使用系统默认应用打开链接".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        return Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法使用系统默认应用打开链接".to_string());
    }

    #[allow(unreachable_code)]
    Err("当前平台暂不支持打开外部链接".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Children::default())
        .manage(DesktopRuntimeIdentityState::default())
        .manage(UiApprovalCapability(Uuid::new_v4().to_string()))
        .invoke_handler(tauri::generate_handler![
            decide_agent_proposal,
            decide_agent_runtime_action,
            get_desktop_runtime_identity,
            open_external_url
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let data_root = match resolve_data_root(app.handle()) {
                Ok(path) => path,
                Err(error) => {
                    eprintln!("[OfferU] backend startup failed: {error}");
                    app.emit("offeru-ready", false).ok();
                    return Ok(());
                }
            };
            let runtime_instance_id = Uuid::new_v4().to_string();
            let expected_runtime_type = runtime_mode().to_string();
            let identity = DesktopRuntimeIdentity {
                runtime_instance_id: runtime_instance_id.clone(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                commit: build_commit().map(str::to_string),
                build_timestamp: build_timestamp().map(str::to_string),
                dirty: build_dirty(),
                source_fingerprint: build_source_fingerprint().map(str::to_string),
                data_root: data_root.to_string_lossy().into_owned(),
                runtime_type: expected_runtime_type.clone(),
            };
            *app.state::<DesktopRuntimeIdentityState>().0.lock().unwrap() = Some(identity);

            let approval_token = app.state::<UiApprovalCapability>().0.clone();
            let children = app.state::<Children>().0.clone();
            let handle = app.handle().clone();
            let startup = spawn_backend(
                app.handle(),
                &data_root,
                &runtime_instance_id,
                &approval_token,
            )
            .and_then(|command| {
                ProcessTree::spawn(command)
                    .map_err(|error| format!("cannot start owned backend process tree: {error}"))
            });

            match startup {
                Ok(child) => {
                    *children.lock().unwrap() = Some(child);
                    let children_for_wait = children.clone();
                    thread::spawn(move || {
                        let backend_ok = wait_for_python_backend(
                            &children_for_wait,
                            &data_root,
                            &runtime_instance_id,
                            &expected_runtime_type,
                            45,
                        );
                        println!("[OfferU] backend_ready={}", backend_ok);
                        if !backend_ok {
                            terminate_owned_backend(&children_for_wait);
                        }
                        handle.emit("offeru-ready", backend_ok).ok();
                    });
                }
                Err(error) => {
                    eprintln!("[OfferU] backend startup failed: {error}");
                    handle.emit("offeru-ready", false).ok();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<Children>() {
                    let child = state.0.lock().ok().and_then(|mut children| children.take());
                    drop(child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
