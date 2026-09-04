// OfferU Tauri desktop launcher (dev mode)
// 启动时只 spawn FastAPI + Python AgentKernel @ :8765。
// frontend Vite dev @ :7410 由 tauri.conf.json 的 beforeDevCommand 负责，避免重复启动。
// dev WebView 加载 http://127.0.0.1:7410；release WebView 直接加载嵌入的 dist。
// 关窗时 kill 后端子进程

use std::fs;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Children(Mutex<Vec<Child>>);

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

fn spawn_python_backend(root: &std::path::Path) -> Option<Child> {
    let py = root.join("backend").join(".venv312").join("Scripts").join("python.exe");
    let py_str = if py.is_file() { py.to_str().unwrap().to_string() } else { String::from("python") };
    let cwd = root.join("backend");

    println!("[OfferU] spawning Python backend on :8765: run_server.py");

    let mut cmd = Command::new(&py_str);
    cmd.arg("run_server.py")
        .env("OFFERU_PORT", "8765")
        .env("OFFERU_BUILD_MODE", "local-development")
        .env("OFFERU_RUNTIME_MODE", "local")
        .env("OFFERU_VERSION", env!("CARGO_PKG_VERSION"))
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().ok()
}

fn spawn_release_sidecar(app: &AppHandle) -> Option<Child> {
    let data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[OfferU] cannot resolve app data directory: {}", error);
            return None;
        }
    };
    if let Err(error) = fs::create_dir_all(&data_dir) {
        eprintln!("[OfferU] cannot create app data directory: {}", error);
        return None;
    }

    let resource_dir = match app.path().resource_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[OfferU] cannot resolve resource directory: {}", error);
            return None;
        }
    };
    let sidecar = [
        "offeru-backend-x86_64-pc-windows-msvc.exe",
        "offeru-backend-aarch64-pc-windows-msvc.exe",
        "offeru-backend.exe",
        "offeru-backend-x86_64-apple-darwin",
        "offeru-backend-aarch64-apple-darwin",
        "offeru-backend-x86_64-unknown-linux-gnu",
        "offeru-backend-aarch64-unknown-linux-gnu",
    ]
    .iter()
    .map(|name| resource_dir.join(name))
    .find(|path| path.is_file());

    let Some(sidecar) = sidecar else {
        eprintln!("[OfferU] packaged Python sidecar was not found in the resource directory");
        return None;
    };

    let cors_origins = concat!(
        "http://localhost:7410,http://127.0.0.1:7410,",
        "http://tauri.localhost,https://tauri.localhost,tauri://localhost"
    );
    println!("[OfferU] spawning packaged backend sidecar on :8765");
    let mut cmd = Command::new(sidecar);
    cmd.env("OFFERU_DATA_DIR", &data_dir)
        .env("OFFERU_AGENT_RUNTIME_DIR", resource_dir.join("agent-runtime"))
        .env("OFFERU_NODE_PATH", resource_dir.join("node.exe"))
        .env("OFFERU_BUILD_MODE", "release")
        .env("OFFERU_RUNTIME_MODE", "desktop-sidecar")
        .env("OFFERU_VERSION", env!("CARGO_PKG_VERSION"))
        .env("OFFERU_PORT", "8765")
        .env("CORS_ORIGINS", cors_origins)
        .current_dir(&data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().ok()
}

fn spawn_backend(app: &AppHandle) -> Option<Child> {
    if cfg!(debug_assertions) {
        return spawn_python_backend(&project_root_from_exe());
    }
    spawn_release_sidecar(app)
}

fn wait_for_python_backend(timeout_secs: u64) -> bool {
    let expected_build_mode = if cfg!(debug_assertions) {
        "local-development"
    } else {
        "release"
    };
    let expected_version = env!("CARGO_PKG_VERSION");
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("[OfferU] cannot create direct loopback health client: {}", error);
            return false;
        }
    };
    loop {
        if let Ok(response) = client
            .get("http://127.0.0.1:8765/api/health")
            .timeout(Duration::from_secs(1))
            .send()
        {
            let response_ok = response.status().is_success();
            let health_identity_ok = response
                .text()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .and_then(|payload| {
                    let object = payload.as_object()?;
                    Some(
                        object.get("status").and_then(|value| value.as_str()) == Some("ok")
                            && object.get("service").and_then(|value| value.as_str()) == Some("OfferU")
                            && object.get("runtime").and_then(|value| value.as_str()) == Some("python")
                            && object.get("build_mode").and_then(|value| value.as_str()) == Some(expected_build_mode)
                            && object.get("version").and_then(|value| value.as_str()) == Some(expected_version),
                    )
                })
                .unwrap_or(false);
            if response_ok && health_identity_ok {
                return true;
            }
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(700));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Children(Mutex::new(Vec::new())))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let state = app.state::<Children>();
            let mut kids = state.0.lock().unwrap();

            if let Some(child) = spawn_backend(app.handle()) { kids.push(child); }

            drop(kids);

            let handle = app.handle().clone();
            thread::spawn(move || {
                let backend_ok = wait_for_python_backend(45);
                println!("[OfferU] backend_ready={}", backend_ok);
                if backend_ok {
                    handle.emit("offeru-ready", true).ok();
                } else {
                    handle.emit("offeru-ready", false).ok();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<Children>() {
                    let mut kids = state.0.lock().unwrap();
                    while let Some(mut child) = kids.pop() {
                        let _ = child.kill();
                        println!("[OfferU] killed child");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
