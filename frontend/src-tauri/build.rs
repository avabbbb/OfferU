use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const UNKNOWN: &str = "unknown";

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("Tauri manifest must be inside frontend/src-tauri")
        .to_path_buf()
}

fn watch_identity_sources(root: &Path, artifact: &Path, helper: &Path) {
    println!("cargo:rerun-if-env-changed=OFFERU_NODE_PATH");
    println!("cargo:rerun-if-changed={}", artifact.display());
    println!("cargo:rerun-if-changed={}", helper.display());
    for source in [
        "backend/app",
        "backend/requirements.txt",
        "backend/sidecar_entry.py",
        "backend/scripts/build_sidecar.mjs",
        "backend/scripts/build_sidecar.ps1",
        "backend/tests/fixtures",
        "frontend/src",
        "frontend/public",
        "frontend/index.html",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/vite.config.ts",
        "frontend/postcss.config.mjs",
        "frontend/tailwind.config.ts",
        "frontend/src-tauri/src",
        "frontend/src-tauri/build.rs",
        "frontend/src-tauri/Cargo.toml",
        "frontend/src-tauri/Cargo.lock",
        "frontend/src-tauri/tauri.conf.json",
        "agent-runtime/src",
        "agent-runtime/package.json",
        "agent-runtime/package-lock.json",
        ".agents/skills/offeru",
    ] {
        let path = root.join(source);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn git_value(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn valid_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn verify_release_identity(root: &Path, artifact: &Path, helper: &Path) {
    if !artifact.is_file() {
        panic!("release Tauri builds require a freshly packaged OfferU build identity artifact");
    }
    let node = std::env::var_os("OFFERU_NODE_PATH").unwrap_or_else(|| "node".into());
    let verified = Command::new(node)
        .arg(helper)
        .arg("--root")
        .arg(root)
        .arg("--verify")
        .arg(artifact)
        .current_dir(root)
        .output()
        .expect("Node is required to verify the OfferU build identity artifact");
    if !verified.status.success() {
        panic!(
            "release build identity does not match the current source; rebuild the sidecar first"
        );
    }

    let json = fs::read_to_string(artifact).expect("build identity artifact must be readable");
    let identity: Value =
        serde_json::from_str(&json).expect("build identity artifact must be valid JSON");
    let version = identity
        .get("version")
        .and_then(Value::as_str)
        .expect("build identity version is required");
    let commit = identity
        .get("commit")
        .and_then(Value::as_str)
        .expect("build identity commit is required");
    let timestamp = identity
        .get("build_timestamp")
        .and_then(Value::as_str)
        .expect("build timestamp is required");
    let fingerprint = identity
        .get("source_fingerprint")
        .and_then(Value::as_str)
        .expect("source fingerprint is required");
    let dirty = identity
        .get("dirty")
        .and_then(Value::as_bool)
        .expect("build dirty flag is required");
    if version != env!("CARGO_PKG_VERSION")
        || !valid_hex(commit, 40)
        || !valid_hex(fingerprint.trim_start_matches("sha256:"), 64)
        || !timestamp.ends_with('Z')
        || !fingerprint.starts_with("sha256:")
    {
        panic!("release build identity artifact is malformed or version-inconsistent");
    }
    println!("cargo:rustc-env=OFFERU_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=OFFERU_BUILD_TIMESTAMP={timestamp}");
    println!("cargo:rustc-env=OFFERU_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=OFFERU_BUILD_SOURCE_FINGERPRINT={fingerprint}");
}

fn configure_source_identity(root: &Path) {
    let commit = git_value(root, &["rev-parse", "HEAD"])
        .filter(|value| valid_hex(value, 40))
        .unwrap_or_default();
    let dirty = git_value(root, &["status", "--porcelain", "--untracked-files=normal"])
        .map(|value| (!value.is_empty()).to_string())
        .unwrap_or_else(|| UNKNOWN.to_string());
    // Source runs are not packages: no compile/startup time is presented as a build time.
    println!("cargo:rustc-env=OFFERU_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=OFFERU_BUILD_TIMESTAMP=");
    println!("cargo:rustc-env=OFFERU_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=OFFERU_BUILD_SOURCE_FINGERPRINT=");
}

fn main() {
    let root = repository_root();
    let artifact = root.join(".tmp/offeru-build-identity.json");
    let helper = root.join("backend/scripts/build_identity.mjs");
    watch_identity_sources(&root, &artifact, &helper);

    if std::env::var("PROFILE").as_deref() == Ok("release") {
        verify_release_identity(&root, &artifact, &helper);
    } else {
        configure_source_identity(&root);
    }

    tauri_build::build()
}
