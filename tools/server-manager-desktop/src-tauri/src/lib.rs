mod backend;
mod integrated;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(std::sync::Arc::new(backend::ManagerState::load(
                config_dir.join("manager.json"),
                data_dir.join("operations.jsonl"),
            )));
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            integrated::integrated_dashboard,
            integrated::integrated_open_inventory,
            integrated::integrated_start_service,
            integrated::integrated_stop_service,
            integrated::integrated_create_backup,
            integrated::integrated_restore_backup,
            integrated::integrated_check_update,
            integrated::integrated_install_update,
            backend::get_dashboard,
            backend::save_config,
            backend::scan_services,
            backend::start_service,
            backend::stop_service,
            backend::stop_external_service,
            backend::open_system,
            backend::create_backup,
            backend::validate_backup,
            backend::restore_backup,
            backend::check_for_updates,
            backend::run_safe_update,
            backend::run_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
