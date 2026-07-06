# Quarc Auth

A small standalone login service shared by every Quarc app (Quarc Music, Quarc Notes, and
future apps), so **one account works everywhere**. It only handles register/login/logout/
me/change-password — nothing app-specific lives here.

Each app's own backend still verifies the JWT locally (same `JWT_SECRET`, no network
call needed on every request) — this service is only in the request path for the
login/register/session endpoints themselves, proxied there by each app's nginx.

## Run it standalone

```bash
cd auth
cp .env.example .env   # fill in a real JWT_SECRET
docker network create quarcnet-shared   # once, on the server — shared by all Quarc apps
docker compose up -d --build
```

This starts one `quarc-auth` container on the `quarcnet-shared` external Docker network,
with its own `auth.db` (SQLite) holding just the `users` table.

## Point an app at it

Each app's nginx needs a location block proxying `/api/auth/*` to this container, and its
compose file needs to join the same `quarcnet-shared` network so nginx can resolve
`quarc-auth` by name. Quarc Notes' own `docker-compose.yml`/nginx already do this.

Quarc Music has been wired up the same way (see its `frontend/nginx.conf` and
`docker-compose.yml`) — its own built-in login routes (`backend/src/routes/auth.js`) are
left in place but now unreachable, since nginx intercepts `/api/auth/*` before it would
ever reach Music's backend. Nothing there needed to change or be deleted.

**Both apps' `.env` files must have the exact same `JWT_SECRET`** as this service's
`.env` — that's what makes a login on one app valid on the other.

## One-time cutover for an existing Quarc Music install

Quarc Music already has real users in its own `music.db`. To move them into the shared
`auth.db` without forcing anyone to re-register or reset a password:

1. **Back up first.** On the server: `cd Quarc_Music && bash backup.sh` — this is
   non-destructive but there's no reason not to have a fresh backup before changing
   how login works.
2. Get a copy of the current `music.db` (the backup from step 1 already has one, e.g.
   `backup_YYYYMMDD_HHMMSS/music.db`).
3. Run the migration against that **copy** (never the live file a running container is
   using):
   ```bash
   cd auth
   npm install
   node migrate-from-music.js /path/to/backup_YYYYMMDD_HHMMSS/music.db
   ```
   This preserves each user's `id`/`password_hash`/`role`, so existing passwords keep
   working unchanged.
4. Set `JWT_SECRET` in `auth/.env` to the **same value** already in Quarc Music's `.env`
   (so existing sessions/cookies don't need users to log in again).
5. Start `quarc-auth` (see "Run it standalone" above).
6. Deploy Quarc Music's updated `nginx.conf`/`docker-compose.yml` (`bash deploy.sh` from
   the Quarc_Music repo) and confirm the shared network exists first
   (`docker network create quarcnet-shared` if you haven't already).
7. Verify: log in to Quarc Music as an existing user — should work exactly as before.
   Then log in to Quarc Notes with the **same** username/password — same account,
   same server, no separate registration.
