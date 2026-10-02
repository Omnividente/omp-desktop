// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(code) = omp_desktop_lib::windows_terminal_input::run_private_cli() {
        std::process::exit(code);
    }
    omp_desktop_lib::run()
}
