use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    alive: Arc<AtomicBool>,
}

impl PtyHandle {
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master.lock().map_err(|e| e.to_string())?
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }
    pub fn kill(&self) {
        if let Ok(mut k) = self.killer.lock() { let _ = k.kill(); }
    }
    pub fn is_alive(&self) -> bool { self.alive.load(Ordering::SeqCst) }
}

pub fn spawn(
    program: &str, args: &[String], cwd: Option<&Path>, inject: Option<&str>,
    cols: u16, rows: u16,
    mut on_output: Box<dyn FnMut(&[u8]) + Send>, on_exit: Box<dyn FnOnce(u32) + Send>,
) -> Result<PtyHandle, String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.env("TERM", "xterm-256color");
    if std::env::var("LANG").is_err() { cmd.env("LANG", "en_US.UTF-8"); }
    // aTerm 可能从 Claude 会话内启动；剥离继承的 CLAUDE* 变量，避免内部 claude 误判为子会话。
    // zsh -l 会重新 source 用户 profile，用户自己 export 的变量不受影响。
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE") {
            cmd.env_remove(&key);
        }
    }
    if let Some(d) = cwd { cmd.cwd(d); }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    if let Some(cmdline) = inject {
        writer.write_all(format!("{cmdline}\r").as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().ok();
    }
    let alive = Arc::new(AtomicBool::new(true));

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Ok(0) | Err(_) => break,
                Ok(n) => on_output(&buf[..n]),
            }
        }
    });
    let alive2 = alive.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        alive2.store(false, Ordering::SeqCst);
        on_exit(code);
    });

    Ok(PtyHandle { master: Mutex::new(pair.master), writer: Mutex::new(writer), killer: Mutex::new(killer), alive })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_echo_captures_output_and_exit() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<u32>();
        let h = spawn("/bin/echo", &["hello-pty".to_string()], None, None, 80, 24,
            Box::new(move |b| { let _ = tx.send(b.to_vec()); }),
            Box::new(move |c| { let _ = etx.send(c); }),
        ).unwrap();
        let code = erx.recv_timeout(Duration::from_secs(5)).expect("应收到退出事件");
        assert_eq!(code, 0);
        std::thread::sleep(Duration::from_millis(200)); // 等 reader 清空
        let mut all = Vec::new();
        while let Ok(chunk) = rx.try_recv() { all.extend(chunk); }
        assert!(String::from_utf8_lossy(&all).contains("hello-pty"));
        assert!(!h.is_alive());
    }

    #[test]
    fn inject_writes_initial_command() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<u32>();
        // cat 会把注入的 stdin 回显出来后被 kill
        let h = spawn("/bin/cat", &[], None, Some("marker-123"), 80, 24,
            Box::new(move |b| { let _ = tx.send(b.to_vec()); }),
            Box::new(move |c| { let _ = etx.send(c); }),
        ).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut all = Vec::new();
        while std::time::Instant::now() < deadline {
            while let Ok(chunk) = rx.try_recv() { all.extend(chunk); }
            if String::from_utf8_lossy(&all).contains("marker-123") { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(String::from_utf8_lossy(&all).contains("marker-123"));
        h.kill();
        let _ = erx.recv_timeout(Duration::from_secs(5)).expect("kill 后应收到退出事件");
        assert!(!h.is_alive());
    }

    #[test]
    fn claude_env_vars_are_stripped_from_child() {
        std::env::set_var("CLAUDE_PROBE_FOR_TEST", "1");
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (etx, erx) = std::sync::mpsc::channel::<u32>();
        let _h = spawn("/usr/bin/env", &[], None, None, 80, 24,
            Box::new(move |b| { let _ = tx.send(b.to_vec()); }),
            Box::new(move |c| { let _ = etx.send(c); }),
        ).unwrap();
        let code = erx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(code, 0);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut all = Vec::new();
        while let Ok(chunk) = rx.try_recv() { all.extend(chunk); }
        let out = String::from_utf8_lossy(&all);
        assert!(out.contains("TERM=xterm-256color"), "sanity: env output visible, got: {out}");
        assert!(!out.contains("CLAUDE_PROBE_FOR_TEST"), "CLAUDE* var leaked into child: {out}");
    }
}
