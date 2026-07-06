# Building the Quarc Notes desktop app

## Prerequisites (one-time setup)

1. **Rust** — https://rustup.rs
   Run the installer, restart your terminal.

2. **Node.js** — https://nodejs.org (v18 or newer)

3. **WebView2** — already installed on Windows 10/11.
   If missing: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

## Generate icons (one-time)

You need a square PNG (at least 1024×1024) to generate all icon sizes.
From the `desktop/` folder, run:

```
npx tauri icon path\to\your-icon.png
```

This writes all required files into `src-tauri/icons/`.

## Build the installer

From the `desktop/` folder:

```
npm install
npm run build
```

The installer is written to:
```
src-tauri/target/release/bundle/nsis/Quarc Notes_1.0.0_x64-setup.exe
```

Hand this `.exe` to users. They run it once to install, then launch
"Quarc Notes" from their Start menu or desktop shortcut.

## Certificate requirement

Users must install and trust the server certificate **before** opening the app,
exactly as described in Quarc Music's README_Users.md (Windows section) — the same
Tailscale cert covers every Quarc app on this host. The desktop app uses WebView2,
which reads from the Windows certificate store, so installing the cert for
Edge/Chrome is sufficient.
