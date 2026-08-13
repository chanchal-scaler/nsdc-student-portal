import express from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAndWriteStudents } from './lib/nsdc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Configuration (all via environment variables) ----
const PORT = process.env.PORT || 3000;
const LOGIN_EMAIL = process.env.LOGIN_EMAIL;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const NSDC_USERNAME = process.env.NSDC_USERNAME;
const NSDC_PASSWORD = process.env.NSDC_PASSWORD;
const TP_ID = process.env.TP_ID || 'TP155158';
const DATA_DIR = path.join(__dirname, 'data');

const missing = [];
if (!LOGIN_EMAIL) missing.push('LOGIN_EMAIL');
if (!LOGIN_PASSWORD) missing.push('LOGIN_PASSWORD');
if (!NSDC_USERNAME) missing.push('NSDC_USERNAME');
if (!NSDC_PASSWORD) missing.push('NSDC_PASSWORD');
if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // Railway runs behind a proxy

// Security headers. CSP stays at helmet defaults (inline scripts blocked —
// page JS lives in /public), except frames are fully disallowed and the
// https-upgrade directive is dropped outside production for local http testing.
const cspDirectives = {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'frame-ancestors': ["'none'"]
};
if (process.env.NODE_ENV !== 'production') {
    delete cspDirectives['upgrade-insecure-requests'];
}
app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MemoryStore = createMemoryStore(session);
app.use(session({
    store: new MemoryStore({ checkPeriod: 60 * 60 * 1000 }), // prune expired sessions hourly
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'nsdc.sid',
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
}));

// ---- Login helpers ----
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Basic in-memory rate limiting for login attempts
const loginAttempts = new Map(); // ip -> { count, firstAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > WINDOW_MS) {
        loginAttempts.delete(ip);
        return false;
    }
    return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
    const entry = loginAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
        entry.count++;
    }
}

// Prune expired attempt entries so the map cannot grow unbounded
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
        if (now - entry.firstAt > WINDOW_MS) loginAttempts.delete(ip);
    }
}, WINDOW_MS).unref();

function requireLogin(req, res, next) {
    if (req.session && req.session.loggedIn) return next();
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    return res.redirect('/login');
}

// ---- Download job state (one job at a time) ----
const job = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    pagesFetched: 0,
    totalPages: null,
    totalStudents: 0,
    failedPages: [],
    error: null,
    file: null,
    fileName: null
};

// Reset job state back to idle and remove any CSVs on disk, so student PII
// doesn't linger and a finished download doesn't reappear after a page reload.
function resetJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.endsWith('.csv')) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    job.state = 'idle';
    job.startedAt = null;
    job.finishedAt = null;
    job.pagesFetched = 0;
    job.totalPages = null;
    job.totalStudents = 0;
    job.failedPages = [];
    job.error = null;
    job.file = null;
    job.fileName = null;
}

function startDownloadJob() {
    // Clear any previous run (and its CSV) before starting a fresh one
    resetJob();

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `students_list_${dateStr}.csv`;
    const outputFile = path.join(DATA_DIR, fileName);

    job.state = 'running';
    job.startedAt = new Date().toISOString();

    fetchAndWriteStudents({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        tpId: TP_ID,
        outputFile,
        onProgress: ({ pagesFetched, totalPages, totalStudents, failedPages }) => {
            job.pagesFetched = pagesFetched;
            job.totalPages = totalPages;
            job.totalStudents = totalStudents;
            job.failedPages = failedPages;
        }
    }).then(({ totalStudents, failedPages }) => {
        job.state = 'done';
        job.finishedAt = new Date().toISOString();
        job.totalStudents = totalStudents;
        job.failedPages = failedPages;
        job.file = outputFile;
        job.fileName = fileName;
        console.log(`Download complete: ${totalStudents} students, ${failedPages.length} failed pages`);
    }).catch(err => {
        job.state = 'error';
        job.finishedAt = new Date().toISOString();
        job.error = err.message;
        console.error('Download job failed:', err);
    });
}

// ---- Routes ----
app.get('/login', (req, res) => {
    if (req.session.loggedIn) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
    const ip = req.ip;
    if (isRateLimited(ip)) {
        return res.redirect('/login?error=' + encodeURIComponent('Too many attempts. Try again in 15 minutes.'));
    }

    const { email, password } = req.body || {};
    if (typeof email === 'string' && typeof password === 'string' &&
        safeEqual(email.trim().toLowerCase(), LOGIN_EMAIL.toLowerCase()) &&
        safeEqual(password, LOGIN_PASSWORD)) {
        loginAttempts.delete(ip);
        // Rotate the session ID on login to prevent session fixation
        return req.session.regenerate(err => {
            if (err) {
                console.error('Session regeneration failed:', err);
                return res.redirect('/login?error=' + encodeURIComponent('Login failed, please try again'));
            }
            req.session.loggedIn = true;
            res.redirect('/');
        });
    }

    recordAttempt(ip);
    // Small fixed delay to slow down brute-force attempts
    setTimeout(() => {
        res.redirect('/login?error=' + encodeURIComponent('Invalid email or password'));
    }, 500);
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, (req, res) => {
    // Start each page visit from a clean slate: a finished or failed job (and its
    // CSV) is cleared on reload so it doesn't linger and confuse. A running job is
    // left untouched so refreshing mid-download still shows live progress.
    if (job.state !== 'running') {
        resetJob();
    }
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.post('/api/download/start', requireLogin, (req, res) => {
    if (job.state === 'running') {
        return res.status(409).json({ error: 'A download is already in progress' });
    }
    startDownloadJob();
    res.json({ started: true });
});

app.get('/api/download/status', requireLogin, (req, res) => {
    res.json({
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        pagesFetched: job.pagesFetched,
        totalPages: job.totalPages,
        totalStudents: job.totalStudents,
        failedPages: job.failedPages,
        error: job.error,
        fileReady: Boolean(job.file),
        fileName: job.fileName
    });
});

app.get('/api/download/file', requireLogin, (req, res) => {
    if (!job.file || !fs.existsSync(job.file)) {
        return res.status(404).json({ error: 'No file available. Run a download first.' });
    }
    res.download(job.file, job.fileName);
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
    console.log(`NSDC student portal listening on port ${PORT}`);
});
