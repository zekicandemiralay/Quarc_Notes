# Quarc Notes

A self-hosted Notion + Obsidian style note app, with pressure-sensitive handwriting for
tablets. Nested pages, a Notion-style block editor, Obsidian-style `[[wikilinks]]` and
backlinks, and a drawing canvas — synced across every device, offline-friendly, and using
the **same login as Quarc Music** (and every other Quarc app).

**Features:**
- **Pages** — a Notion-style block editor (headings, lists, checklists, tables, code, images with upload), nested pages, emoji icons, favorites, duplicate, move; **full width** (per page, or by default on a device) for big screens
- **Links** — type `[` to link another page (or create one on the spot); links follow renames, and every page shows its "Linked mentions" (works offline)
- **Notebooks** — pressure-sensitive handwriting for stylus input (S-Pen, Apple Pencil, Wacom):
  - multi-page notebooks (A5/A4/Letter, portrait/landscape, lined/squared/dotted/blank paper) with a page navigator, add/insert/delete page
  - **hold to snap**: keep the pen still at the end of a stroke and it becomes a clean straight line, arc, L-shape, circle/ellipse, rectangle/square, triangle, diamond or polygon — keep holding to move/resize/rotate it into place; afterwards it stays an editable shape
  - pen + highlighter (drawn under the ink); **colour wheel** with brightness bar, hex field and a history of recently used colours; stylus button/eraser end erases, undo/redo (also two-finger tap)
  - palm rejection; fingers scroll (with momentum) once a stylus is used, or draw on phones; pinch to zoom, double-tap or the **Fit width** button to fit
  - cut-selection (rectangle / free-form) that really cuts through strokes, plus all Excalidraw shapes and text
- **Export** — from a page's ⋯ menu: documents as **PDF** (real text, A4/Letter), **Word (.docx)**, **Markdown** (a zip with an `assets/` folder when the page has images), **HTML** (one self-contained file) or plain text; notebooks as **PDF** (one page per sheet), **PNG**, **SVG** or an editable **.excalidraw** file. Saved as a download in the browser, with a Save-as dialog on desktop and the share sheet on Android
- **Dark mode** — light / dark / follow system, including dark paper for notebooks
- **Search** — Ctrl/⌘ K quick switcher and full-text search across pages, tables and text in drawings
- **Offline-first sync** — everything works offline and syncs when back online; edits from two devices never get lost (drawings merge stroke by stroke, a document edited on both keeps both versions)
- **Trash** with restore (sub-pages included) and delete forever
- One shared account across every Quarc app; Android APK, Windows/macOS/Linux desktop apps, and PWA (Add to Home Screen on iOS/Android)

---

## Part 1 — Server Setup

For the person who owns and runs the server.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A machine that stays on, running [Tailscale](https://tailscale.com) with HTTPS Certificates enabled
- The `quarc-auth` shared login service running (it lives in the [Quarc Store](https://github.com/zekicandemiralay/Quarc_Store) repo, in `auth/`) — this is what makes one account work across every Quarc app

### Step 1 — Set up the shared network and Quarc Auth (once, if not already done)

The shared login lives in the Quarc Store repo:

```bash
git clone https://github.com/zekicandemiralay/Quarc_Store.git
cd Quarc_Store
cp auth/.env.example auth/.env   # set a real JWT_SECRET
bash deploy.sh auth              # also creates the quarcnet-shared network
```

If you already run Quarc Music, see `Quarc_Store/auth/README.md` for how to migrate
its existing users into the shared login instead of starting from zero.

### Step 2 — Clone and configure Quarc Notes

```bash
git clone https://github.com/zekicandemiralay/Quarc_Notes.git
cd Quarc_Notes
cp .env.example .env
```

Set `JWT_SECRET` in `.env` to the **exact same value** as `Quarc_Store/auth/.env`.

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
| `JWT_SECRET` | *(insecure default)* | Must match `Quarc_Store/auth/.env` exactly — change this in production |

---

## Part 2 — User Setup

Users need Tailscale installed and connected, then:
- **Android tablet/phone**: install the APK from [Releases](https://github.com/zekicandemiralay/Quarc_Notes/releases/latest) for the best handwriting experience (background-friendly, native feel)
- **iOS**: open `https://quarcnet0.tail84500c.ts.net:4001` in Safari and use Share → **Add to Home Screen**
- **Windows/macOS/Linux**: install the desktop app from [Releases](https://github.com/zekicandemiralay/Quarc_Notes/releases/latest)
- **Anyone else**: just open the URL above in a browser

Log in with the same username/password you use for Quarc Music — it's the same account.

---

## Part 3 — Development

```bash
cd backend && npm install && npm test     # API + sync tests (temporary SQLite database)
cd frontend && npm install && npm test    # shape recognition, cut selection, colours, export (PDF/zip) tests
cd frontend && npm run dev                # dev server; proxies /api/auth to :3902 (quarc-auth) and /api to :3903
```

Sync protocol (backend `routes/sync.js`): devices push only the fields they changed, with the
server version their edit was based on; the server detects real conflicts per page *content*
(another device changed it since) and resolves them without losing anything. Older app
versions' push/pull format is still accepted.

