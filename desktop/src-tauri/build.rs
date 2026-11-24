fn main() {
    // Commands called from a page the window loads from a server need to be listed, then allowed in
    // capabilities/default.json (Quarc Store single sign-on: sso-kit/README.md).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["quarc_sso_peek", "quarc_sso_sync", "quarc_sso_open_store"]),
        ),
    )
    .expect("failed to run tauri-build");
}
