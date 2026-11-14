#![cfg_attr(all(windows, not(feature = "updater-qa")), windows_subsystem = "windows")]

#[path = "../updater_package.rs"]
mod updater_package;
#[cfg(windows)]
#[path = "../updater_windows.rs"]
mod updater_windows;

#[cfg(windows)]
fn main() {
    updater_windows::main();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("SUGRID updater requires Windows.");
}
