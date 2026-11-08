fn main() {
    println!("cargo:rerun-if-env-changed=CHALZ_ANTIGRAVITY_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=CHALZ_ANTIGRAVITY_CLIENT_SECRET");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "window_action", "notification_permission", "notify", "get_update_status", "install_update",
        ]),
    )).expect("could not build Tauri application manifest");
}
