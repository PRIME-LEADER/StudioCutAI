fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("StudioCut desktop runtime failed");
}
