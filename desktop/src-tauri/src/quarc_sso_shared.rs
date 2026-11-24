//! Quarc Store single sign-on on Windows: what the Store and the apps agree on.
//!
//! Source of truth: Quarc_Store/sso-kit/desktop/quarc_sso_shared.rs. Every Quarc desktop app carries an
//! identical copy, and the Store builds this same file in.
//!
//! Everything lives in one folder, `%LOCALAPPDATA%\Quarc\sso`:
//!
//! ```text
//! state.json         who is signed in to the Store, and where the Store is. No secrets.
//! session.dat        the Store's own login, protected for the current Windows user (DPAPI)
//! applied\<package>  (each app) the epoch of the Store state this app last applied
//! ```
//!
//! This is the Windows counterpart of the Android Store's content provider: the Store keeps the state and its
//! own login; an app that sees the state change asks the server for a login of its own, made with the Store's
//! (a child session: signing out of the Store ends it), and writes it into its own cookie jar.
//!
//! It is weaker in one way: Android tells the Store *which app* is asking (and checks its signing key), while
//! on Windows any program running as the same user can read these files. That is no new exposure: such a
//! program can already read the apps' own browser cookies. Wrapping the Store's login with DPAPI keeps it from
//! other Windows users and from copies of the folder taken to another PC or account.

// The Store uses the whole file, each app only the part it needs.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const STORE_PACKAGE: &str = "com.quarc.store";

/// `com.quarc.music`: the only shape of package name used in file names.
pub fn valid_package(package: &str) -> bool {
    package.strip_prefix("com.quarc.").is_some_and(|s| {
        !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `%LOCALAPPDATA%\Quarc\sso`. None where single sign-on does not exist (not Windows).
/// Debug builds can point `QUARC_SSO_DIR` somewhere else, for tests.
pub fn dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("QUARC_SSO_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Quarc").join("sso"))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    // Written beside the target and moved into place, so a reader never sees half a file.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't replace {}: {e}", path.display())
    })
}

// ── state.json (no secrets) ───────────────────────────────────────────────

pub fn state_path() -> Option<PathBuf> {
    dir().map(|d| d.join("state.json"))
}

pub fn read_state() -> Option<Value> {
    let bytes = fs::read(state_path()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_state(state: &Value) -> Result<(), String> {
    let path = state_path().ok_or("Single sign-on is not available here")?;
    write_atomic(&path, state.to_string().as_bytes())
}

/// The Store's program, from state.json, if it is really there. Only a file called quarc-store.exe counts.
pub fn store_exe(state: &Value) -> Option<PathBuf> {
    let exe = PathBuf::from(state.get("store")?.get("exe")?.as_str()?);
    let named_right = exe
        .file_name()
        .is_some_and(|f| f.eq_ignore_ascii_case("quarc-store.exe"));
    (named_right && exe.is_file()).then_some(exe)
}

// ── the Store's own login (DPAPI) ─────────────────────────────────────────

pub fn session_path() -> Option<PathBuf> {
    dir().map(|d| d.join("session.dat"))
}

pub fn write_secret(path: &Path, value: &Value) -> Result<(), String> {
    write_atomic(path, &dpapi::protect(value.to_string().as_bytes())?)
}

pub fn read_secret(path: &Path) -> Option<Value> {
    let bytes = dpapi::unprotect(&fs::read(path).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn remove(path: &Path) {
    let _ = fs::remove_file(path);
}

// ── what each app remembers ───────────────────────────────────────────────

fn applied_path(package: &str) -> Option<PathBuf> {
    valid_package(package).then(|| dir().map(|d| d.join("applied").join(package)))?
}

pub fn applied_epoch(package: &str) -> Option<i64> {
    fs::read_to_string(applied_path(package)?).ok()?.trim().parse().ok()
}

pub fn set_applied_epoch(package: &str, epoch: i64) {
    if let Some(path) = applied_path(package) {
        let _ = write_atomic(&path, epoch.to_string().as_bytes());
    }
}

/// Apps that have applied some Store state, with the epoch and when (ms): the Store's "apps signed in here" list.
pub fn applied_apps() -> Vec<(String, i64, i64)> {
    let Some(dir) = dir().map(|d| d.join("applied")) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let package = e.file_name().to_string_lossy().into_owned();
            if !valid_package(&package) {
                return None;
            }
            let epoch = fs::read_to_string(e.path()).ok()?.trim().parse().ok()?;
            let at = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some((package, epoch, at))
        })
        .collect()
}

// ── DPAPI ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    /// Mixed into the protection so these files only open for code that knows this label.
    const ENTROPY: &[u8] = b"quarc-store-sso-v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        bytes
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: both blobs point at live slices for the call; `out` is filled by Windows and freed by `take`.
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), 0, &mut out)
        };
        if ok == 0 {
            return Err("Windows could not protect the login".into());
        }
        Ok(unsafe { take(out) })
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out,
            )
        };
        if ok == 0 {
            return Err("Windows could not open the saved login".into());
        }
        Ok(unsafe { take(out) })
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Single sign-on is only available on Windows".into())
    }
    pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Single sign-on is only available on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_names_are_safe_file_names() {
        assert!(valid_package("com.quarc.music"));
        assert!(valid_package("com.quarc.store"));
        assert!(!valid_package("com.quarc."));
        assert!(!valid_package("com.quarc.Music"));
        assert!(!valid_package("com.quarc.mu/sic"));
        assert!(!valid_package("com.quarc.music\\..\\x"));
        assert!(!valid_package("com.other.music"));
    }

    #[cfg(windows)]
    #[test]
    fn protected_data_round_trips_and_is_not_plain() {
        let secret = br#"{"token":"abc.def.ghi"}"#;
        let wrapped = dpapi::protect(secret).unwrap();
        assert!(!wrapped.windows(secret.len()).any(|w| w == secret));
        assert_eq!(dpapi::unprotect(&wrapped).unwrap(), secret);
        // Not valid protected data: refused, not garbage.
        assert!(dpapi::unprotect(b"not dpapi data").is_err());
    }

    #[test]
    fn atomic_write_replaces_the_file() {
        let dir = std::env::temp_dir().join(format!("quarc-sso-test-{}", std::process::id()));
        let file = dir.join("a").join("state.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        let _ = fs::remove_dir_all(&dir);
    }
}
