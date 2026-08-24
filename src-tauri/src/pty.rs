use crate::pty_core::{self, PtyHandle};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct PtyManager(pub Mutex<HashMap<String, Arc<PtyHandle>>>);

#[derive(Clone, Serialize)]
struct OutPayload { id: String, data: String }
#[derive(Clone, Serialize)]
struct ExitPayload { id: String, code: u32 }

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<PtyManager>, cwd: Option<String>, inject: Option<String>, cols: u16, rows: u16) -> Result<String, String> {
    let id = format!("pty-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let cwd_path = cwd.map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir());
    let (a1, a2, id1, id2) = (app.clone(), app.clone(), id.clone(), id.clone());
    let handle = pty_core::spawn(
        "/bin/zsh", &["-l".to_string()], cwd_path.as_deref(), inject.as_deref(), cols, rows,
        Box::new(move |bytes| {
            let _ = a1.emit("pty-output", OutPayload { id: id1.clone(), data: B64.encode(bytes) });
        }),
        Box::new(move |code| {
            a2.state::<PtyManager>().0.lock().ok().map(|mut m| m.remove(&id2));
            let _ = a2.emit("pty-exit", ExitPayload { id: id2.clone(), code });
        }),
    )?;
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), Arc::new(handle));
    Ok(id)
}

fn with_pty<T>(state: &State<PtyManager>, id: &str, f: impl FnOnce(&PtyHandle) -> T) -> Result<T, String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    map.get(id).map(|h| f(h)).ok_or_else(|| format!("pty 不存在: {id}"))
}

#[tauri::command]
pub fn pty_write(state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    with_pty(&state, &id, |h| h.write(data.as_bytes()))?
}
#[tauri::command]
pub fn pty_resize(state: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    with_pty(&state, &id, |h| h.resize(cols, rows))?
}
#[tauri::command]
pub fn pty_kill(state: State<PtyManager>, id: String) -> Result<(), String> {
    with_pty(&state, &id, |h| h.kill())
}
#[tauri::command]
pub fn pty_is_alive(state: State<PtyManager>, id: String) -> bool {
    with_pty(&state, &id, |h| h.is_alive()).unwrap_or(false)
}
