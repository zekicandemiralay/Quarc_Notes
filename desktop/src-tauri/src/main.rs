#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Quarc Store single sign-on (see Quarc_Store/sso-kit/README.md).
mod quarc_sso;
mod quarc_sso_shared;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            quarc_sso::quarc_sso_peek,
            quarc_sso::quarc_sso_sync,
            quarc_sso::quarc_sso_open_store
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quarc Notes");
}
