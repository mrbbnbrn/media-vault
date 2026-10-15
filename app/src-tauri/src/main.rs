// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// mimalloc instead of the system allocator: quicker when many threads
// allocate at once (decrypting, importing, analysing, the web engine's IPC).
// Freed memory that held secrets is still wiped first (zeroize does that
// before anything is freed, whatever the allocator).
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    media_vault_app::run()
}
