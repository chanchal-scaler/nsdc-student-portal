# NSDC Student Portal

A small login-protected web app that fetches the full student list from the Skill India (NSDC) admin API and lets you download it as a CSV.

## How it works

- Sign in with the email/password configured via environment variables.
- Click **Fetch student data** — the server authenticates against the NSDC admin API, pages through all students (500 per page, with retry/re-auth/backoff handling), and writes a CSV.
- A progress bar shows pages fetched; when done, click **Download CSV**.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LOGIN_EMAIL` | yes | Email to sign in to this portal |
| `LOGIN_PASSWORD` | yes | Password to sign in to this portal |
| `SESSION_SECRET` | recommended | Long random string for session cookies (auto-generated per boot if unset, which logs everyone out on restart) |
| `NSDC_USERNAME` | yes | Skill India admin username |
| `NSDC_PASSWORD` | yes | Skill India admin password |
| `TP_ID` | no | Training partner ID (default `TP155158`) |
| `PORT` | no | Set automatically by Railway |

## Run locally

```bash
npm install
cp .env.example .env   # fill in values
export $(grep -v '^#' .env | xargs)
npm start
```

Open http://localhost:3000.

## Deploy to Railway

1. Push this folder to a GitHub repo (or use `railway up` from the Railway CLI).
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and pick the repo.
3. In the service's **Variables** tab, add:
   - `LOGIN_EMAIL`, `LOGIN_PASSWORD`
   - `SESSION_SECRET` (generate one: `openssl rand -hex 32`)
   - `NSDC_USERNAME`, `NSDC_PASSWORD`
   - `TP_ID` (optional)
4. Under **Settings → Networking**, click **Generate Domain** to get a public URL.
5. Open the URL, sign in, and fetch the data.

Notes:

- The CSV is written to the container's ephemeral disk — download it after each fetch; it will not survive a redeploy. CSVs from previous runs are deleted automatically whenever a new fetch starts.
- Only one fetch job runs at a time; a second click while a job is running is rejected.

Security hardening in place:

- Timing-safe credential comparison; session ID rotated on login (anti-fixation).
- Login rate-limited (10 attempts per 15 minutes per IP) plus a 500ms delay on failed attempts.
- Security headers via helmet, including a strict CSP (no inline scripts) and `frame-ancestors 'none'`.
- Sessions in a pruning store with httpOnly, SameSite=Lax, Secure (behind Railway's proxy) cookies.
- All data endpoints require login; credentials only via environment variables.
