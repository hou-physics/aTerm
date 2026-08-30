use std::path::Path;

/// 只做路径校验，不接触外部程序——因此可以被单测覆盖而不会真的弹出访达。
///
/// 收窄到"已存在的目录"不只是更严格：`reveal_in_finder` 的两个调用点（侧栏会话、
/// 主页项目）传的都是项目 cwd，语义就是"打开这个文件夹"。允许文件等于凭空多出一条
/// "用它打开任意文件"的路径。
///
/// 校验顺序固定为先 `exists()` 后 `is_dir()`：两种失败的错误文案不同（"不存在" vs
/// "不是文件夹"），顺序决定了当路径根本不存在时用户看到的是哪一句。
pub(crate) fn validate_reveal_dir(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    if !p.is_dir() {
        return Err(format!("不是文件夹：{path}"));
    }
    Ok(p)
}

/// 在访达里打开一个文件夹。侧栏与主页的右键菜单各有一个调用点，传的都是项目 cwd。
///
/// 这是本仓库第一个会启动外部程序的命令，所以校验写实（见 `validate_reveal_dir`）：
/// 只接受已存在的目录，不存在或不是目录一律拒绝，且拒绝时不调用 `open`。
///
/// 路径作为独立参数交给 `open`（`.arg(p)`），不经 shell、不做任何字符串拼接，因此
/// 路径里的空格、引号、`;`、`$` 等一律是字面量，没有注入面。
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = validate_reveal_dir(&path)?;
    std::process::Command::new("open")
        .arg(p)
        .spawn()
        .map_err(|e| format!("打开访达失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 以下三个测试只调用 validate_reveal_dir——纯校验函数，不 spawn 任何外部进程。
    // 它们都不调用 reveal_in_finder 本身，因此跑 `cargo test` 不会弹出访达窗口。

    #[test]
    fn rejects_missing_path() {
        // 会因为什么失败：如果校验顺序改成先 is_dir() 再 exists()，或者错误文案
        // 换了措辞，这个断言就会失败。
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("不存在的目录");
        let err = validate_reveal_dir(&missing.to_string_lossy()).unwrap_err();
        assert!(err.contains("不存在"), "错误文案应告诉用户路径不存在，实际：{err}");
    }

    #[test]
    fn rejects_file_because_this_command_opens_folders() {
        // 会因为什么失败：如果 validate_reveal_dir 退化成只检查 exists()（不再区分
        // 文件与目录），文件路径会被错误地放行，这条测试就会失败。
        //
        // 收窄到目录不只是"更严格"：两个调用点传的都是项目 cwd，语义就是打开文件夹。
        // 允许文件等于凭空多出一条"用它打开任意文件"的路径。
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        let err = validate_reveal_dir(&file.to_string_lossy()).unwrap_err();
        assert!(err.contains("不是文件夹"), "错误文案应说明这不是文件夹，实际：{err}");
    }

    #[test]
    fn accepts_an_existing_directory() {
        // 会因为什么失败：如果校验对已存在的真实目录也返回 Err（例如误把
        // exists()/is_dir() 的判断取反），这条测试就会失败。
        //
        // 只断言校验放行了（Ok），不涉及 spawn——这个函数本身就不接触外部程序。
        let tmp = tempfile::tempdir().unwrap();
        assert!(validate_reveal_dir(&tmp.path().to_string_lossy()).is_ok());
    }
}
