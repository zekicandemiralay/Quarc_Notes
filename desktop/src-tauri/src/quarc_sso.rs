//! Quarc Store single sign-on, the app side, on Windows. JS name: the `quarc_sso_*` commands.
//!
//! Source of truth: Quarc_Store/sso-kit/desktop/quarc_sso.rs. Every Quarc desktop app carries an identical copy.
//!
//! If Quarc Store is installed on this PC and signed in, `quarc_sso_sync` asks the server for a login made
//! just for this app (using the Store's own login, which the Store keeps for exactly this) and puts it into
//! this app's browser cookie jar as the same httpOnly `token` cookie a normal login sets, so the rest of the
//! app can't tell the difference. If the Store isn't installed (or isn't signed in), nothing happens and the
//! app's own login screen works as always: the Store is optional.
//!
//! The Store's state carries an "epoch" that changes whenever its login changes (sign in, switch account, sign
//! out). This app remembers the last epoch it applied and only acts when it changes, so:
//!   - signing in to the Store signs this app in (the Store wins),
//!   - signing out of the Store signs this app out,
//!   - but signing in to this app on its own afterwards is respected.
//! This is the same behaviour as the Android plugin (sso-kit/android/QuarcSsoPlugin.java).
//!
//! The commands do their work on a separate thread: on Windows the cookie calls must not run on the main thread.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tauri::webview::cookie::{time::Duration, Cookie, SameSite};
use tauri::{AppHandle, Webview};

use crate::quarc_sso_shared as shared;

#[derive(Debug, PartialEq)]
enum Action {
    Unchanged,
    SignIn,
    SignOut,
    /// The Store was never signed in: leave this app's own login alone, but remember the epoch.
    Remember,
}

/// What to do with the Store's state, given the last epoch this app applied.
fn decide(state: &str, epoch: i64, applied: Option<i64>, force: bool) -> Action {
    let force_sign_in = force && state == "signed_in";
    if applied == Some(epoch) && !force_sign_in {
        return Action::Unchanged;
    }
    match state {
        "signed_in" => Action::SignIn,
        "signed_out" => Action::SignOut,
        _ => Action::Remember,
    }
}

fn public_user(state: &Value) -> Option<Value> {
    state.get("user").filter(|u| u.is_object()).cloned()
}

/// Is the Store here, and who is signed in to it? Changes nothing.
#[tauri::command]
pub async fn quarc_sso_peek() -> Value {
    let Some(state) = shared::read_state() else {
        return json!({ "installed": false, "available": false });
    };
    if shared::store_exe(&state).is_none() {
        return json!({ "installed": false, "available": false });
    }
    let name = state.get("state").and_then(Value::as_str).unwrap_or("none");
    let mut out = json!({ "installed": true, "available": true, "state": name });
    if name == "signed_in" {
        if let Some(user) = public_user(&state) {
            out["user"] = user;
        }
    }
    out
}

/// Applies the Store's current login to this app if it changed since the last time.
/// `force` re-applies a signed-in Store login even if unchanged (the "Continue with Quarc Store" button).
///
/// result: unavailable | unchanged | none | signed_in | signed_out | error
#[tauri::command]
pub async fn quarc_sso_sync(app: AppHandle, webview: Webview, server_origin: String, force: Option<bool>) -> Value {
    let package = app.config().identifier.clone();
    let force = force.unwrap_or(false);
    let done = tauri::async_runtime::spawn_blocking(move || sync(&package, &webview, &server_origin, force)).await;
    match done {
        Ok(Ok(v)) => v,
        Ok(Err(reason)) => json!({ "result": "error", "reason": reason }),
        Err(_) => json!({ "result": "error", "reason": "interrupted" }),
    }
}

fn sync(package: &str, webview: &Webview, server_origin: &str, force: bool) -> Result<Value, String> {
    let origin = tauri::Url::parse(server_origin).map_err(|_| "bad_origin".to_string())?;
    let host = origin.host_str().ok_or("bad_origin")?.to_string();
    if origin.scheme() != "https" {
        return Err("An https serverOrigin is required".into());
    }
    // The login may only be handed to the server this app's own window is showing, or by this app's own
    // bundled copy of the page (the Windows Weather app carries its page inside the app).
    #[cfg(not(debug_assertions))]
    if !window_may_use(webview.url().ok().as_ref().and_then(|u| u.host_str()), &host) {
        return Err("origin_mismatch".into());
    }

    let Some(state) = shared::read_state() else {
        return Ok(json!({ "result": "unavailable" }));
    };
    if shared::store_exe(&state).is_none() {
        // The Store was removed: its leftovers mean nothing.
        return Ok(json!({ "result": "unavailable" }));
    }
    let name = state.get("state").and_then(Value::as_str).unwrap_or("none");
    let epoch = state.get("epoch").and_then(Value::as_i64).unwrap_or(0);
    let mut out = json!({ "state": name });
    if let Some(user) = public_user(&state).filter(|_| name == "signed_in") {
        out["user"] = user;
    }

    match decide(name, epoch, shared::applied_epoch(package), force) {
        Action::Unchanged => out["result"] = json!("unchanged"),
        Action::Remember => {
            shared::set_applied_epoch(package, epoch);
            out["result"] = json!("none");
        }
        Action::SignOut => {
            clear_cookie(webview, &host)?;
            shared::set_applied_epoch(package, epoch);
            out["result"] = json!("signed_out");
        }
        Action::SignIn => match sign_in(package, webview, &origin, &host) {
            Ok(SignIn::Done(user)) => {
                shared::set_applied_epoch(package, epoch);
                out["user"] = user;
                out["result"] = json!("signed_in");
            }
            Ok(SignIn::StoreSessionGone) => {
                // The Store's own login was revoked (signed out elsewhere, password changed, ...): the PC is
                // signed out. The Store notices the next time it opens and says so to every app.
                clear_cookie(webview, &host)?;
                shared::set_applied_epoch(package, epoch);
                out["state"] = json!("signed_out");
                out["result"] = json!("signed_out");
            }
            // Offline or server trouble: keep whatever this app has, try again next time.
            Err(reason) => {
                out["result"] = json!("error");
                out["reason"] = json!(reason);
            }
        },
    }
    Ok(out)
}

/// Which page may use the Store's login: the Quarc server's own page, or the app's own bundled copy of it, which
/// is embedded in the app and served from tauri.localhost (nobody else can be shown there).
#[cfg_attr(debug_assertions, allow(dead_code))]
fn window_may_use(window_host: Option<&str>, server_host: &str) -> bool {
    matches!(window_host, Some(h) if h == server_host || h == "tauri.localhost")
}

enum SignIn {
    Done(Value),
    StoreSessionGone,
}

fn sign_in(package: &str, webview: &Webview, origin: &tauri::Url, host: &str) -> Result<SignIn, String> {
    let session = shared::session_path()
        .and_then(|p| shared::read_secret(&p))
        .ok_or("no_store_session")?;
    let parent = session.get("token").and_then(Value::as_str).ok_or("no_store_session")?;
    // The Store's login is only ever sent to the server it was made for.
    let session_host = session
        .get("origin")
        .and_then(Value::as_str)
        .and_then(|o| tauri::Url::parse(o).ok())
        .and_then(|u| u.host_str().map(str::to_owned));
    if session_host.as_deref() != Some(host) {
        return Err("store_signed_in_elsewhere".into());
    }

    let (status, body) = mint(origin, parent, package)?;
    if status == 401 {
        return Ok(SignIn::StoreSessionGone);
    }
    if status != 200 {
        return Err(format!("mint_failed_http_{status}"));
    }
    let login: Value = serde_json::from_str(&body).map_err(|_| "bad_answer".to_string())?;
    let token = login.get("token").and_then(Value::as_str).ok_or("bad_answer")?;
    let expires_at = login.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
    let max_age = if expires_at > 0 {
        (expires_at - shared::now_ms() / 1000).max(60)
    } else {
        365 * 86400
    };
    set_cookie(webview, host, token, max_age)?;
    Ok(SignIn::Done(login.get("user").cloned().filter(Value::is_object).unwrap_or(Value::Null)))
}

fn device_label() -> String {
    match std::env::var("COMPUTERNAME") {
        Ok(name) if !name.is_empty() => format!("{name} (Windows)"),
        _ => "Windows PC".to_string(),
    }
}

/// POST /api/auth/sso/token with the Store's login: a new session for this app that is a child of the Store's
/// (so signing out of the Store ends it). Done with the curl.exe that ships with Windows 10 and 11, so no web
/// client has to be built into every app; the login goes in through stdin, never onto a command line.
fn mint(origin: &tauri::Url, parent_token: &str, package: &str) -> Result<(u16, String), String> {
    // A login is made of these characters only; anything else would not be one (and must never reach the config).
    if parent_token.is_empty() || !parent_token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return Err("bad_store_session".into());
    }
    let body = json!({ "client": package, "device": device_label() }).to_string();
    let config = format!(
        "header = \"Authorization: Bearer {parent_token}\"\nheader = \"Content-Type: application/json\"\ndata = \"{}\"\n",
        body.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let url = format!("{}://{}/api/auth/sso/token", origin.scheme(), origin.authority());

    let mut command = Command::new(curl_exe());
    command.args(["-sS", "--max-time", "20", "--proto", "=https", "-w", "\n%{http_code}", "-K", "-"]);
    #[cfg(debug_assertions)]
    if std::env::var_os("QUARC_SSO_INSECURE").is_some() {
        command.arg("-k");
    }
    command.arg(url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| "no_curl".to_string())?;
    child
        .stdin
        .take()
        .ok_or("no_curl")?
        .write_all(config.as_bytes())
        .map_err(|_| "no_curl".to_string())?;
    let output = child.wait_with_output().map_err(|_| "no_curl".to_string())?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let (body, status) = text.rsplit_once('\n').ok_or("network")?;
    let status: u16 = status.trim().parse().map_err(|_| "network".to_string())?;
    if status == 0 {
        return Err("network".into());
    }
    Ok((status, body.to_string()))
}

/// Windows' own curl (System32), not whatever the PATH finds first.
fn curl_exe() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| Path::new(&root).join("System32").join("curl.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| "curl".into())
}

fn set_cookie(webview: &Webview, host: &str, token: &str, max_age_secs: i64) -> Result<(), String> {
    let cookie = Cookie::build(("token", token.to_string()))
        .domain(host.to_string())
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::None)
        .max_age(Duration::seconds(max_age_secs))
        .build();
    webview.set_cookie(cookie).map_err(|e| format!("cookie: {e}"))
}

fn clear_cookie(webview: &Webview, host: &str) -> Result<(), String> {
    let cookie = Cookie::build(("token", String::new()))
        .domain(host.to_string())
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::None)
        .build();
    webview.delete_cookie(cookie).map_err(|e| format!("cookie: {e}"))
}

/// Opens Quarc Store: target "login", "app/<package>" or "updates". It can bring the user back here.
#[tauri::command]
pub async fn quarc_sso_open_store(app: AppHandle, target: String) -> Value {
    let own = app.config().identifier.clone();
    let safe = target.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'));
    let exe = shared::read_state().and_then(|s| shared::store_exe(&s));
    let (Some(exe), true) = (exe, safe) else {
        return json!({ "opened": false });
    };
    let url = format!("quarcstore://{target}?return={own}");
    json!({ "opened": spawn_detached(&exe, &url) })
}

fn spawn_detached(exe: &Path, arg: &str) -> bool {
    let mut command = Command::new(exe);
    command.arg(arg);
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_page_and_the_apps_own_bundled_page_may_sign_in_nobody_else() {
        let server = "quarcnet0.tail84500c.ts.net";
        assert!(window_may_use(Some(server), server));
        assert!(window_may_use(Some("tauri.localhost"), server));
        assert!(!window_may_use(Some("evil.example"), server));
        assert!(!window_may_use(Some("tauri.localhost.evil.example"), server));
        assert!(!window_may_use(Some("localhost"), server));
        assert!(!window_may_use(None, server));
    }

    #[test]
    fn acts_only_when_the_store_state_changed() {
        // First time: adopt the Store's state.
        assert_eq!(decide("signed_in", 5, None, false), Action::SignIn);
        assert_eq!(decide("signed_out", 5, None, false), Action::SignOut);
        assert_eq!(decide("none", 5, None, false), Action::Remember);
        // Already applied: leave the app alone (its own sign-in/out afterwards is respected).
        assert_eq!(decide("signed_in", 5, Some(5), false), Action::Unchanged);
        assert_eq!(decide("signed_out", 5, Some(5), false), Action::Unchanged);
        // The Store changed since: act again.
        assert_eq!(decide("signed_in", 6, Some(5), false), Action::SignIn);
        assert_eq!(decide("signed_out", 7, Some(6), false), Action::SignOut);
        // "Continue with Quarc Store" re-applies a signed-in Store even if unchanged, but never a signed-out one.
        assert_eq!(decide("signed_in", 5, Some(5), true), Action::SignIn);
        assert_eq!(decide("signed_out", 5, Some(5), true), Action::Unchanged);
    }

    #[test]
    fn refuses_a_store_login_that_is_not_a_login() {
        let origin = tauri::Url::parse("https://example.invalid").unwrap();
        for bad in ["", "abc\"def", "abc\ndef", "abc def", "a;b"] {
            assert_eq!(mint(&origin, bad, "com.quarc.music"), Err("bad_store_session".to_string()), "{bad:?}");
        }
    }
}
