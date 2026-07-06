# Quarc Notes

A self-hosted Notion + Obsidian style note app, with pressure-sensitive handwriting for
tablets. Nested pages, a Notion-style block editor, Obsidian-style `[[wikilinks]]` and
backlinks, and a drawing canvas — synced across every device, offline-friendly, and using
the **same login as Quarc Music** (and every other Quarc app).

**Features:**
- Nested pages with a Notion-style block editor (headings, lists, etc.)
- Obsidian-style `[[wikilinks]]` — type `[` to link to another page, with a backlinks panel showing what links to the current page
- Pressure-sensitive handwriting/drawing pages, built for stylus input (S-Pen, Apple Pencil, Wacom) via the Pointer Events API
- Full-text search across all your notes
- Trash with restore / permanent delete
- Offline support — reads and edits are cached locally and synced back when reconnected
- One shared account across every Quarc app — log in once, same credentials everywhere
- Android APK, Windows/macOS/Linux desktop apps, and PWA (Add to Home Screen on iOS/Android)

---

## Part 1 — Server Setup

For the person who owns and runs the server.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A machine that stays on, running [Tailscale](https://tailscale.com) with HTTPS Certificates enabled
- The `quarc-auth` shared login service running (see [auth/README.md](auth/README.md)) — this is what makes one account work across Quarc Music and Quarc Notes

### Step 1 — Set up the shared network and Quarc Auth (once, if not already done)

```bash
docker network create quarcnet-shared
cd auth
cp .env.example .env   # set a real JWT_SECRET
docker compose up -d --build
```

If you already run Quarc Music, see [auth/README.md](auth/README.md) for how to migrate
its existing users into the shared login instead of starting from zero.

### Step 2 — Clone and configure Quarc Notes

```bash
git clone https://github.com/zekicandemiralay/Quarc_Notes.git
cd Quarc_Notes
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to the **exact same value** as `auth/.env`.

### Step 3 — Start the server

```bash
bash deploy.sh
```

nginx serves the Tailscale certificate the same way Quarc Music does. On first login,
register your first account — it's shared with Quarc Music automatically, so if you
already have a Quarc Music account, just log in with those same credentials instead of
registering a new one.

### Step 4 — Access the app

```
https://quarcnet0.tail84500c.ts.net:4001
```

(Quarc Music is on port 4000, Quarc Notes on 4001 — same host, same Tailscale cert.)

### Updating

```bash
git pull
bash deploy.sh
```

### Backup / restore

```bash
bash backup.sh              # creates ./backup_YYYYMMDD_HHMMSS/
bash restore.sh <backup-dir>
bash check.sh                # full health check
```

### Configuration reference

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *(insecure default)* | Must match `auth/.env` exactly — change this in production |

---

## Part 2 — User Setup

Users need Tailscale installed and connected, then:
- **Android tablet/phone**: install the APK from [Releases](https://github.com/zekicandemiralay/Quarc_Notes/releases/latest) for the best handwriting experience (background-friendly, native feel)
- **iOS**: open `https://quarcnet0.tail84500c.ts.net:4001` in Safari and use Share → **Add to Home Screen**
- **Windows/macOS/Linux**: install the desktop app from [Releases](https://github.com/zekicandemiralay/Quarc_Notes/releases/latest)
- **Anyone else**: just open the URL above in a browser

Log in with the same username/password you use for Quarc Music — it's the same account.
