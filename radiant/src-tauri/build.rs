use std::{
    env, fs,
    path::Path,
    process::{Command, Stdio},
};

fn find_schema(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let path = dir.join(name);
    if path.is_file() {
        return Some(path);
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .find_map(|entry| find_schema(&entry.path(), name))
}

fn generate_codex_protocol(binary: &std::ffi::OsStr, generator: &str, output: &Path) {
    let status = Command::new(binary)
        .args(["app-server", generator, "--out"])
        .arg(output)
        .stdin(Stdio::null())
        .status()
        .unwrap_or_else(|error| panic!("Could not run Codex {generator}: {error}"));
    assert!(status.success(), "Codex {generator} failed");
}

fn check_codex_schema(binary: &std::ffi::OsStr, output: &Path) {
    let schema_dir = output.join("schema");
    let types_dir = output.join("types");
    generate_codex_protocol(binary, "generate-json-schema", &schema_dir);
    generate_codex_protocol(binary, "generate-ts", &types_dir);
    let requirements: &[(&str, &[&str])] = &[
        (
            "ThreadStartParams.json",
            &[
                "cwd",
                "approvalPolicy",
                "sandbox",
                "ephemeral",
                "config",
                "developerInstructions",
            ],
        ),
        ("InitializeResponse.json", &["userAgent"]),
        ("GetAccountResponse.json", &["account", "requiresOpenaiAuth"]),
        ("ThreadStartResponse.json", &["thread", "model"]),
        (
            "TurnStartParams.json",
            &["threadId", "input", "effort", "outputSchema"],
        ),
        ("TurnStartResponse.json", &["turn"]),
        ("TurnCompletedNotification.json", &["threadId", "turn"]),
        (
            "ThreadTokenUsageUpdatedNotification.json",
            &["threadId", "turnId", "tokenUsage"],
        ),
        ("GetAccountRateLimitsResponse.json", &["rateLimits"]),
        ("AccountRateLimitsUpdatedNotification.json", &["rateLimits"]),
        (
            "ErrorNotification.json",
            &["threadId", "turnId", "error", "willRetry"],
        ),
    ];
    for (name, fields) in requirements {
        let path = find_schema(&schema_dir, name).unwrap_or_else(|| panic!("Codex omitted {name}"));
        let ts_name = name.replace(".json", ".ts");
        let ts_file = find_schema(&types_dir, &ts_name).unwrap_or_else(|| panic!("Codex omitted {ts_name}"));
        let declarations = fs::read_to_string(ts_file).expect("read generated Codex declarations");
        let schema: serde_json::Value =
            serde_json::from_slice(&fs::read(path).expect("read generated schema"))
                .expect("parse generated Codex schema");
        for field in *fields {
            assert!(
                schema["properties"].get(field).is_some(),
                "Codex schema {name} omitted {field}"
            );
            assert!(
                declarations.contains(&format!("{field}:")) || declarations.contains(&format!("{field}?:")),
                "Codex declaration {ts_name} omitted {field}"
            );
        }
    }
}

fn main() {
    // Normal desktop builds can run on machines without Codex.
    println!("cargo:rerun-if-env-changed=RADIANT_CODEX_SCHEMA_BIN");
    if let Some(binary) = env::var_os("RADIANT_CODEX_SCHEMA_BIN") {
        let output =
            Path::new(&env::var_os("OUT_DIR").expect("Cargo OUT_DIR")).join("codex-protocol");
        if output.exists() {
            fs::remove_dir_all(&output).expect("remove previous generated Codex schema");
        }
        check_codex_schema(&binary, &output);
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/store/foreground.m");
        cc::Build::new().file("src/store/foreground.m").flag("-fobjc-arc").compile("radiant_foreground");
        println!("cargo:rerun-if-changed=src/store/image_preview.m");
        cc::Build::new().file("src/store/image_preview.m").flag("-fobjc-arc").compile("radiant_image_preview");
        // Rust links with -nodefaultlibs. Clang emits an availability helper
        // for the Vision bridge's @available check on older deployment targets.
        let runtime = cc::Build::new().get_compiler().to_command()
            .arg("--print-file-name=libclang_rt.osx.a").output()
            .expect("locate the macOS Clang runtime");
        let archive = Path::new(std::str::from_utf8(&runtime.stdout).expect("Clang runtime path").trim());
        assert!(runtime.status.success() && archive.is_file(), "macOS Clang runtime archive is missing");
        println!("cargo:rustc-link-search=native={}", archive.parent().unwrap().display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        for framework in ["Vision", "ImageIO", "CoreGraphics", "CoreVideo", "Foundation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
