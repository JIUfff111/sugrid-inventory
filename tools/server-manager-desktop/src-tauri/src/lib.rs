#[cfg(test)]
mod backend;
mod integrated;
mod updater_package;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
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
            integrated::integrated_check_inventory_update,
            integrated::integrated_cached_inventory,
            integrated::integrated_prefetch_inventory,
            integrated::integrated_updater_status,
            integrated::integrated_install_inventory_online,
            integrated::integrated_install_inventory_cached,
            integrated::integrated_install_inventory_file,
            integrated::integrated_cancel_inventory_update
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
