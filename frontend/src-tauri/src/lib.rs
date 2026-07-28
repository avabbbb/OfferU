// OfferU Tauri desktop launcher (dev mode)
// 启动时只 spawn FastAPI + Python AgentKernel @ :8000。
// frontend Next dev @ :3300 由 tauri.conf.json 的 beforeDevCommand 负责，避免重复启动。
// Tauri webview 加载 http://localhost:3300
// 关窗时 kill 后端子进程

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

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

    println!("[OfferU] spawning Python backend on :8000: {} run_server.py", py_str);

    let mut cmd = Command::new(&py_str);
    cmd.arg("run_server.py")
        .env("OFFERU_PORT", "8000")
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

fn wait_for_url(url: &str, timeout_secs: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let client = reqwest::blocking::Client::new();
    loop {
        match client.get(url).timeout(Duration::from_secs(1)).send() {
            Ok(_) => return true,
            Err(_) => {
                if std::time::Instant::now() > deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(700));
            }
        }
    }
}

fn wait_for_python_backend(timeout_secs: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let client = reqwest::blocking::Client::new();
    loop {
        if let Ok(response) = client
            .get("http://127.0.0.1:8000/api/health")
            .timeout(Duration::from_secs(1))
            .send()
        {
            if response.text().map(|body| body.contains("\"runtime\":\"python\"")).unwrap_or(false) {
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
        .plugin(tauri_plugin_shell::init())
        .manage(Children(Mutex::new(Vec::new())))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let root = project_root_from_exe();
            println!("[OfferU] project root: {:?}", root);

            let state = app.state::<Children>();
            let mut kids = state.0.lock().unwrap();

            if let Some(child) = spawn_python_backend(&root) { kids.push(child); }

            drop(kids);

            let handle = app.handle().clone();
            thread::spawn(move || {
                let backend_ok = wait_for_python_backend(45);
                let frontend_ok = wait_for_url("http://127.0.0.1:3300", 90);
                println!("[OfferU] backend_ready={}, frontend_ready={}", backend_ok, frontend_ok);
                if backend_ok && frontend_ok {
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
