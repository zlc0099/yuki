use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use std::path::PathBuf;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

#[derive(Clone)]
struct ServerCtx {
    token: String,
    app: tauri::AppHandle,
}

fn state_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("yukipet")
}

fn gen_token() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    format!("{:016x}", h.finish())
}

async fn health() -> &'static str {
    "ok"
}

async fn receive_event(
    State(ctx): State<ServerCtx>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> StatusCode {
    let authorized = headers
        .get("x-pet-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == ctx.token)
        .unwrap_or(false);
    if !authorized {
        return StatusCode::UNAUTHORIZED;
    }
    println!(
        "[pet] event={} session={}",
        body.get("event").and_then(|v| v.as_str()).unwrap_or("?"),
        body.get("session_id").and_then(|v| v.as_str()).unwrap_or("-")
    );
    let _ = ctx.app.emit("agent-event", body);
    StatusCode::OK
}

fn spawn_server(app: tauri::AppHandle) {
    let dir = state_dir();    let _ = std::fs::create_dir_all(&dir);
    let token = gen_token();
    let _ = std::fs::write(dir.join("token.txt"), &token);

    tauri::async_runtime::spawn(async move {
        let mut bound = None;
        for port in 34217u16..34227u16 {
            if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                let _ = std::fs::write(dir.join("port.txt"), port.to_string());
                bound = Some(listener);
                break;
            }
        }
        let Some(listener) = bound else { return };
        let router = Router::new()
            .route("/health", get(health))
            .route("/event", post(receive_event))
            .with_state(ServerCtx { token, app });
        let _ = axum::serve(listener, router).await;
    });
}

#[derive(serde::Serialize)]
struct SessionUsage {
    id: String,
    project: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
    total: u64,
    today: u64,
    month: u64,
    last_ms: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn usage_snapshot() -> Vec<SessionUsage> {
    usage_snapshot_impl()
}

fn usage_snapshot_impl() -> Vec<SessionUsage> {
    use chrono::{DateTime, Local};

    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let root = PathBuf::from(home).join(".claude").join("projects");
    let cutoff = now_secs().saturating_sub(30 * 86400);
    let month_start = now_secs().saturating_sub(30 * 86400) as i64;
    let today = Local::now().date_naive();
    let mut out = Vec::new();

    let Ok(projects) = std::fs::read_dir(&root) else { return out };
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&pdir) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if mtime < cutoff {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let mut usage = SessionUsage {
                id: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                project: proj.file_name().to_string_lossy().to_string(),
                input: 0,
                output: 0,
                cache_read: 0,
                cache_create: 0,
                total: 0,
                today: 0,
                month: 0,
                last_ms: mtime * 1000,
            };
            for line in content.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                    if let Some(name) = PathBuf::from(cwd).file_name() {
                        usage.project = name.to_string_lossy().to_string();
                    }
                }
                let Some(u) = v.get("message").and_then(|m| m.get("usage")) else { continue };
                let input = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let output = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let cache_read = u.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let cache_create = u.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                usage.input += input;
                usage.output += output;
                usage.cache_read += cache_read;
                usage.cache_create += cache_create;
                let ts = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .and_then(|t| DateTime::parse_from_rfc3339(t).ok());
                let is_today = ts
                    .map(|dt| dt.with_timezone(&Local).date_naive() == today)
                    .unwrap_or(false);
                if is_today {
                    usage.today += input + output + cache_read + cache_create;
                }
                let in_month = ts
                    .map(|dt| dt.timestamp() >= month_start)
                    .unwrap_or(true);
                if in_month {
                    usage.month += input + output + cache_read + cache_create;
                }
            }
            usage.total = usage.input + usage.output + usage.cache_read + usage.cache_create;
            if usage.total > 0 {
                out.push(usage);
            }
        }
    }
    out.sort_by(|a, b| b.last_ms.cmp(&a.last_ms));
    out.truncate(12);
    out
}

#[derive(serde::Serialize)]
struct MonitorRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
fn monitor_bounds(window: tauri::Window) -> Option<MonitorRect> {
    window.current_monitor().ok().flatten().map(|m| MonitorRect {
        x: m.position().x,
        y: m.position().y,
        width: m.size().width,
        height: m.size().height,
    })
}

// 所有显示器并集，用于限制桌宠不越出桌面
#[tauri::command]
fn virtual_bounds(window: tauri::Window) -> Option<MonitorRect> {
    let monitors = window.available_monitors().ok()?;
    if monitors.is_empty() {
        return monitor_bounds(window);
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x + s.width as i32);
        max_y = max_y.max(p.y + s.height as i32);
    }
    Some(MonitorRect {
        x: min_x,
        y: min_y,
        width: (max_x - min_x) as u32,
        height: (max_y - min_y) as u32,
    })
}

#[tauri::command]
fn place_pet(window: tauri::Window) -> Result<(), String> {
    let monitor = window.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - (90.0 * scale) as i32;
    let y = monitor.position().y + monitor.size().height as i32 - size.height as i32 - (70.0 * scale) as i32;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct QuotaInfo {
    provider: String,
    ok: bool,
    currency: Option<String>,
    balance: Option<String>,
    message: Option<String>,
}

fn quota_unavailable(provider: &str, message: &str) -> QuotaInfo {
    QuotaInfo {
        provider: provider.to_string(),
        ok: false,
        currency: None,
        balance: None,
        message: Some(message.to_string()),
    }
}

// 读取本机 Claude 配置中的 DeepSeek 密钥查询账户余额；不记录、不回显密钥
#[tauri::command]
async fn quota_snapshot() -> QuotaInfo {
    quota_snapshot_impl()
}

fn quota_snapshot_impl() -> QuotaInfo {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let path = PathBuf::from(home).join(".claude").join("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return quota_unavailable("unknown", "未找到 ~/.claude/settings.json");
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return quota_unavailable("unknown", "settings.json 解析失败");
    };
    let env = v.get("env");
    let key = env
        .and_then(|e| e.get("ANTHROPIC_AUTH_TOKEN"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let base = env
        .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if key.is_empty() {
        return quota_unavailable("unknown", "未配置 ANTHROPIC_AUTH_TOKEN");
    }
    if !base.contains("deepseek.com") {
        return quota_unavailable("custom", "当前 provider 暂不支持余额查询");
    }
    let resp = ureq::get("https://api.deepseek.com/user/balance")
        .set("Authorization", &format!("Bearer {}", key))
        .timeout(std::time::Duration::from_secs(8))
        .call();
    match resp {
        Ok(r) => {
            let body: serde_json::Value = r.into_json().unwrap_or(serde_json::Value::Null);
            let first = body
                .get("balance_infos")
                .and_then(|b| b.as_array())
                .and_then(|arr| arr.first());
            QuotaInfo {
                provider: "deepseek".into(),
                ok: body
                    .get("is_available")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false),
                currency: first
                    .and_then(|x| x.get("currency"))
                    .and_then(|x| x.as_str())
                    .map(String::from),
                balance: first
                    .and_then(|x| x.get("total_balance"))
                    .and_then(|x| x.as_str())
                    .map(String::from),
                message: None,
            }
        }
        Err(e) => quota_unavailable("deepseek", &format!("余额查询失败：{}", e)),
    }
}

#[tauri::command]
fn foreground_hwnd() -> isize {
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize }
}

#[tauri::command]
fn focus_hwnd(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd as _) != 0 }
}

fn window_hwnd(app: &tauri::AppHandle, label: &str) -> Result<isize, String> {
    let w = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window {label} not found"))?;
    let hwnd = w.hwnd().map_err(|e| e.to_string())?;
    Ok(hwnd.0 as isize)
}

// 不激活地显示窗口（用于账本/气泡，避免抢走前台输入焦点）
#[tauri::command]
fn show_no_activate(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    let hwnd = window_hwnd(&app, &label)?;
    let ok = unsafe {
        SetWindowPos(
            hwnd as _,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };
    if ok == 0 {
        Err("SetWindowPos failed".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn hide_native(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    let hwnd = window_hwnd(&app, &label)?;
    unsafe { ShowWindow(hwnd as _, SW_HIDE) };
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn existing_instance() -> bool {
    (34217u16..34227u16).any(|port| {
        ureq::get(&format!("http://127.0.0.1:{}/health", port))
            .timeout(Duration::from_millis(250))
            .call()
            .map(|r| r.status() == 200)
            .unwrap_or(false)
    })
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let status = if enabled {
        std::process::Command::new("reg")
            .args([
                "add",
                key,
                "/v",
                "YukiPet",
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{}\"", exe.display()),
                "/f",
            ])
            .status()
    } else {
        std::process::Command::new("reg")
            .args(["delete", key, "/v", "YukiPet", "/f"])
            .status()
    }
    .map_err(|e| e.to_string())?;
    if enabled && !status.success() {
        return Err("写入开机自启失败".into());
    }
    Ok(())
}

// 账本显示时，检测账本矩形外的鼠标左键点击（用于点击外部关闭）
fn spawn_outside_click_watcher(app: tauri::AppHandle) {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, IsWindowVisible,
    };

    std::thread::spawn(move || {
        let mut was_down = false;
        loop {
            std::thread::sleep(Duration::from_millis(70));
            let Some(card) = app.get_webview_window("card") else { continue };
            let Ok(hwnd) = card.hwnd() else { continue };
            let visible = unsafe { IsWindowVisible(hwnd.0) } != 0;
            if !visible {
                was_down = false;
                continue;
            }
            let pressed = (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0;
            if pressed && !was_down {
                let mut pt = POINT { x: 0, y: 0 };
                let mut rc: RECT = unsafe { std::mem::zeroed() };
                unsafe {
                    GetCursorPos(&mut pt);
                    GetWindowRect(hwnd.0, &mut rc);
                }
                let inside = pt.x >= rc.left && pt.x <= rc.right && pt.y >= rc.top && pt.y <= rc.bottom;
                if !inside {
                    let _ = app.emit("global-outside-click", ());
                }
            }
            was_down = pressed;
        }
    });
}

fn read_custom_game_filters() -> (Vec<String>, Vec<String>) {
    let path = state_dir().join("games.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), Vec::new());
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (Vec::new(), Vec::new());
    };
    let collect = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s.as_str())
                    .map(|s| s.to_lowercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    (collect("paths"), collect("names"))
}

fn foreground_exe_and_title() -> Option<(String, String)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let exe = String::from_utf16_lossy(&buf[..len as usize]);
        let mut tbuf = [0u16; 512];
        let tlen = GetWindowTextW(hwnd, tbuf.as_mut_ptr(), 512);
        let title = String::from_utf16_lossy(&tbuf[..tlen.max(0) as usize]);
        Some((exe, title))
    }
}

// 前台进程命中常见游戏目录/自定义规则时，播报“正在玩游戏”
fn spawn_game_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let dirs = [
            "\\steamapps\\common\\",
            "\\epic games\\",
            "\\gog games\\",
            "\\wegame",
            "\\riot games\\",
            "\\battle.net\\",
            "\\xboxgames\\",
            "\\games\\",
        ];
        let mut last: Option<String> = None;
        let mut misses = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(2000));
            let detected = foreground_exe_and_title().and_then(|(exe, title)| {
                let path = exe.to_lowercase();
                if path.contains("yuki-pet") {
                    return None;
                }
                let exe_name = PathBuf::from(&path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let (paths, names) = read_custom_game_filters();
                let is_game = dirs.iter().any(|d| path.contains(d))
                    || paths.iter().any(|p| path.contains(p))
                    || names.iter().any(|n| exe_name == *n || exe_name.contains(n));
                if !is_game {
                    return None;
                }
                let name = if title.trim().is_empty() {
                    exe_name
                } else {
                    title.trim().to_string()
                };
                Some(name)
            });
            match detected {
                Some(name) => {
                    misses = 0;
                    if last.as_deref() != Some(name.as_str()) {
                        last = Some(name.clone());
                        let payload = serde_json::json!({ "playing": true, "name": name });
                        let _ = app.emit("game-state", payload);
                    }
                }
                None => {
                    if last.is_some() {
                        // 拖动桌宠/切窗会让游戏短暂失去前台，连续 3 次（约 6 秒）才判定退出
                        misses += 1;
                        if misses >= 3 {
                            last = None;
                            misses = 0;
                            let payload = serde_json::json!({ "playing": false, "name": "" });
                            let _ = app.emit("game-state", payload);
                        }
                    }
                }
            }
        }
    });
}

// 系统媒体会话（Windows SMTC）：读取当前播放歌曲与播放状态
fn session_props(session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession) -> Option<(String, String)> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    if title.is_empty() { None } else { Some((title, artist)) }
}

fn detect_music() -> Option<(bool, String, String)> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus;

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;
    // 优先选择正在播放的会话（网易云/Spotify/浏览器等可能同时存在多个）
    if let Ok(sessions) = manager.GetSessions() {
        if let Ok(size) = sessions.Size() {
            for i in 0..size {
                let Ok(session) = sessions.GetAt(i) else { continue };
                // 只认音乐类应用，避免把 B 站/浏览器视频当成音乐
                let app = session.SourceAppUserModelId().map(|s| s.to_string().to_lowercase()).unwrap_or_default();
                let is_music_app = ["spotify", "cloudmusic", "netease", "qqmusic", "kugou", "applemusic", "musicbee", "foobar", "aimp"]
                    .iter()
                    .any(|k| app.contains(k));
                if !is_music_app { continue; }
                let Ok(info) = session.GetPlaybackInfo() else { continue };
                let status = info.PlaybackStatus().unwrap_or(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed);
                if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
                    if let Some((title, artist)) = session_props(&session) {
                        return Some((true, title, artist));
                    }
                }
            }
        }
    }
    // 没有正在播放的会话时，退到播放器窗口标题兜底
    if let Some((title, artist)) = fallback_music_title() {
        return Some((true, title, artist));
    }
    None
}

static MUSIC_TITLES: std::sync::Mutex<Vec<(u32, String)>> = std::sync::Mutex::new(Vec::new());
const PLAYER_EXES: [&str; 5] = ["cloudmusic.exe", "qqmusic.exe", "spotify.exe", "kugou.exe", "music.exe"];

// SMTC 兜底：从常见播放器窗口标题里取“歌名 - 歌手”
unsafe extern "system" fn music_enum_cb(hwnd: *mut core::ffi::c_void, _: isize) -> i32 {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 { return 1; }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() { return 1; }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
    CloseHandle(handle);
    if ok == 0 { return 1; }
    let exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
    let name = exe.rsplit('\\').next().unwrap_or("").to_string();
    if !PLAYER_EXES.contains(&name.as_str()) { return 1; }
    let mut tbuf = [0u16; 512];
    let tlen = GetWindowTextW(hwnd, tbuf.as_mut_ptr(), 512);
    if tlen <= 0 { return 1; }
    let title = String::from_utf16_lossy(&tbuf[..tlen as usize]).trim().to_string();
    if !title.is_empty() {
        if let Ok(mut list) = MUSIC_TITLES.lock() {
            list.push((pid, title));
        }
    }
    1
}

fn active_audio_pids() -> Vec<u32> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let mut pids = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return pids,
        };
        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) { Ok(d) => d, Err(_) => return pids };
        let manager: IAudioSessionManager2 = match device.Activate(CLSCTX_ALL, None) { Ok(m) => m, Err(_) => return pids };
        let sessions = match manager.GetSessionEnumerator() { Ok(s) => s, Err(_) => return pids };
        let count = match sessions.GetCount() { Ok(c) => c, Err(_) => return pids };
        for i in 0..count {
            let Ok(ctrl) = sessions.GetSession(i) else { continue };
            let Ok(state) = ctrl.GetState() else { continue };
            if state != AudioSessionStateActive { continue; }
            if let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() {
                if let Ok(pid) = ctrl2.GetProcessId() { pids.push(pid); }
            }
        }
    }
    pids
}



fn fallback_music_titles() -> Vec<(u32, String)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;
    if let Ok(mut list) = MUSIC_TITLES.lock() {
        list.clear();
    }
    unsafe { EnumWindows(Some(music_enum_cb), 0) };
    MUSIC_TITLES
        .lock()
        .map(|mut l| l.drain(..).collect::<Vec<_>>())
        .unwrap_or_default()
}

fn fallback_music_title() -> Option<(String, String)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;

    let active = active_audio_pids();
    if active.is_empty() { return None; }
    let candidates = fallback_music_titles();
    for (pid, raw) in candidates {
        if !active.contains(&pid) { continue; }
        let mut title = raw;
        for suffix in [" - 网易云音乐", " - QQ音乐", " - Spotify", " - 酷狗音乐", "网易云音乐", "QQ音乐", "Spotify", "酷狗音乐"] {
            if title == suffix { title.clear(); break; }
            if title.ends_with(suffix) { title = title.trim_end_matches(suffix).trim().to_string(); }
        }
        let ignore = ["桌面歌词", "歌词", "迷你播放器", "网易云音乐", "QQ音乐", "Spotify", "酷狗音乐", "音乐"];
        if title.len() < 2
            || ignore.contains(&title.as_str())
            || title.contains("GDI+ Window")
            || title.contains(".exe)")
            || title.contains("Default IME")
            || title.contains("MSCTFIME")
        {
            continue;
        }
        let mut parts = title.splitn(2, " - ");
        let song = parts.next().unwrap_or("").trim().to_string();
        let artist = parts.next().unwrap_or("").trim().to_string();
        if !song.is_empty() {
            return Some((song, artist));
        }
    }
    None
}

#[derive(serde::Serialize)]
struct MusicDebug {
    ok: bool,
    error: Option<String>,
    sessions: Vec<serde_json::Value>,
    fallback: Option<String>,
    fallback_all: Vec<String>,
}

#[tauri::command]
fn music_snapshot() -> MusicDebug {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

    unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok().and_then(|op| op.get().ok()) {
        Some(m) => m,
        None => return MusicDebug { ok: false, error: Some("RequestAsync failed".into()), sessions: vec![], fallback: None, fallback_all: fallback_music_titles().into_iter().map(|(_, t)| t).collect() },
    };
    let mut out = vec![];
    if let Ok(sessions) = manager.GetSessions() {
        if let Ok(size) = sessions.Size() {
            for i in 0..size {
                let Ok(session) = sessions.GetAt(i) else { continue };
                let app = session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default();
                let status = session.GetPlaybackInfo().ok().and_then(|info| info.PlaybackStatus().ok());
                let props = session_props(&session);
                out.push(serde_json::json!({
                    "app": app,
                    "status": format!("{:?}", status),
                    "title": props.as_ref().map(|p| p.0.clone()).unwrap_or_default(),
                    "artist": props.as_ref().map(|p| p.1.clone()).unwrap_or_default(),
                }));
            }
        }
    }
    MusicDebug {
        ok: true,
        error: None,
        sessions: out,
        fallback: fallback_music_title().map(|(t, a)| if a.is_empty() { t } else { format!("{t} - {a}") }),
        fallback_all: fallback_music_titles().into_iter().map(|(_, t)| t).collect(),
    }
}

fn spawn_music_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // WinRT 需要 COM 初始化，否则媒体会话接口会失败
        unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
        let mut last: Option<(bool, String, String)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(2000));
            let current = detect_music();
            if current != last {
                last = current.clone();
                let (playing, title, artist) = current.unwrap_or((false, String::new(), String::new()));
                let payload = serde_json::json!({
                    "playing": playing,
                    "title": title,
                    "artist": artist
                });
                let _ = app.emit("music-state", payload);
            }
        }
    });
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "tray_toggle", "显示 / 隐藏桌宠", true, None::<&str>)?;
    let passthrough = CheckMenuItem::with_id(app, "tray_passthrough", "点击穿透", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &passthrough, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_quit" => app.exit(0),
            "tray_toggle" => {
                if let Some(w) = app.get_webview_window("pet") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                    }
                }
            }
            "tray_passthrough" => {
                let _ = app.emit("tray-passthrough-toggle", ());
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    std::mem::forget(tray);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if existing_instance() {
                app.handle().exit(0);
                return Ok(());
            }
            spawn_server(app.handle().clone());
            spawn_outside_click_watcher(app.handle().clone());
            spawn_game_watcher(app.handle().clone());
            spawn_music_watcher(app.handle().clone());
            if let Err(err) = setup_tray(app.handle()) {
                eprintln!("tray setup failed: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            usage_snapshot,
            monitor_bounds,
            virtual_bounds,
            place_pet,
            quota_snapshot,
            quit_app,
            set_autostart,
            foreground_hwnd,
            focus_hwnd,
            show_no_activate,
            hide_native,
            music_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
