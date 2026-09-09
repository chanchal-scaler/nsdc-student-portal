# NSDC Student Portal

A small login-protected web app that fetches the full student list from the Skill India (NSDC) admin API and lets you download it as a CSV.

## How it works

- Sign in with the email/password configured via environment variables.
- Click **Fetch student data** — the server authenticates against the NSDC admin API, pages through all students (500 per page, with retry/re-auth/backoff handling), and writes a CSV.
- A progress bar shows pages fetched; when done, click **Download CSV**.

## Pages

| Page | What it is for |
|---|---|
| `/` | Download the full student list as CSV |
| `/upload` | Register students from a sheet |
| `/batches` | Create batches from a sheet |
| `/enroll` | Enrol the students waiting for a batch |
| `/complete` | Submit assessment results |
| `/history` | Enrolled so far — every batch, who is in it, and what NSDC actually holds |
| `/failures` | Every NSDC call that did not go through: endpoint, timestamp, uploader, payload sent, answer received |

## Logins

Each person who uploads gets their own email and password, so a failure can name
whose upload it was. They are kept in the `portal_users` table as scrypt hashes
and handed out with:

```bash
set -a; . ./.env; set +a          # DATABASE_URL
node tools/portal-user.js list
node tools/portal-user.js add priya@scaler.com                 # password generated
node tools/portal-user.js add priya@scaler.com "a-password" "Priya, ops"
node tools/portal-user.js off priya@scaler.com                 # can no longer sign in
```

`LOGIN_EMAIL`/`LOGIN_PASSWORD` still work as a fallback, so a portal with no
rows in that table — or no database — is not locked out. A login is turned off
rather than deleted: the failures it is named on are the record of who did what.

## When an upload fails

`/failures` answers the question the upload pages cannot. Every refused NSDC
request is recorded with:

- which endpoint was called, and with which method
- the timestamp
- which signed-in person's upload it was
- which sheet, which row, and which student or batch it was for
- the exact JSON body that was sent
- the exact answer NSDC gave back, and the HTTP status

Two kinds of entry appear. `row-failed` is one row NSDC refused while the run
carried on. `run-stopped` is the call the run gave up on — NSDC was down or the
sign-in handshake failed — which is why the rest of the sheet was never tried.

Filter by flow, by person, by how far back, or search the messages; the same
list downloads as a CSV. Request payloads are stored whole, which means student
personal details are in that table and readable by anyone with a portal login.

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
