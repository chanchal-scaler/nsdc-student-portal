import express from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { fetchAndWriteStudents } from './lib/nsdc.js';
import { parseStudentSheet, parseBatchSheet, parseEnrollmentSheet, TEMPLATE_COLUMNS, BATCH_COLUMNS, ENROLLMENT_COLUMNS } from './lib/sheet.js';
import { uploadStudents, buildPayload, isDryRun } from './lib/nsdc-candidates.js';
import { uploadBatches, buildBatchPayload } from './lib/nsdc-batches.js';
import { enrollCandidates, buildEnrollmentPayload } from './lib/nsdc-enrollments.js';
import { initSchema, saveCandidate, saveBatch, saveEnrollment, getPendingEnrollments, findCandidateByEmail, findBatchByName, getEnrolledPairs, countStudentsForBatch, findBatchByName as lookupBatch, isEnabled as dbEnabled } from './lib/db.js';

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
        if (f.startsWith('students_list_') && f.endsWith('.csv')) {
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

// ---- Student upload job state (one job at a time) ----
const upload = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    fileName: null,
    processed: 0,
    total: 0,
    created: 0,
    duplicates: 0,
    failed: 0,
    error: null,
    stoppedAfter: null,
    resultFile: null,
    resultFileName: null
};

// Holds the most recent payload preview so it can be downloaded as a file.
let previewFile = null;

// Built after a student upload whose sheet named a batch per row: the enrolment
// sheet that used to be assembled by hand from the two result files.
let generatedEnrollmentFile = null;

// Sheets are read in memory and never written to disk — only the result CSV is.
const sheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

function resetUpload() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('upload_result_') && f.endsWith('.csv')) ||
            (f.startsWith('enrollment_sheet_') && f.endsWith('.csv')) ||
            (f.startsWith('payload_preview_') && f.endsWith('.json'))) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    upload.state = 'idle';
    upload.startedAt = null;
    upload.finishedAt = null;
    upload.fileName = null;
    upload.processed = 0;
    upload.total = 0;
    upload.created = 0;
    upload.duplicates = 0;
    upload.failed = 0;
    upload.error = null;
    upload.stoppedAfter = null;
    upload.resultFile = null;
    upload.resultFileName = null;
}

function csvCell(value) {
    return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function writeResultCsv(results) {
    const headers = ['rowNumber', 'name', 'email', 'phone', 'dob', 'candidateId', 'status', 'error'];
    const lines = [headers.join(',')];

    for (const result of results) {
        lines.push(headers.map(h => csvCell(result[h])).join(','));
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `upload_result_${dateStr}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    return { filePath, fileName };
}

/**
 * Writes the enrolment sheet for everything still waiting to be enrolled, with
 * batch IDs resolved as they stand right now. Called when the sheet is asked
 * for rather than when students are uploaded, so students and batches can be
 * uploaded in either order — a batch created afterwards simply fills in.
 */
async function buildEnrollmentSheet() {
    const pending = await getPendingEnrollments();
    if (pending.length === 0) {
        generatedEnrollmentFile = null;
        return null;
    }

    const headers = ['email', 'candidateId', 'batchName', 'batchId', 'note'];
    const lines = [headers.join(',')];
    for (const row of pending) {
        lines.push(headers.map(h => csvCell(
            h === 'note'
                ? (row.batchId === '' ? 'No batch of this name has been created yet' : '')
                : row[h]
        )).join(','));
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `enrollment_sheet_${dateStr}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    // Only the current sheet is kept on disk
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.startsWith('enrollment_sheet_') && f !== fileName) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }

    const matched = pending.filter(r => r.batchId !== '').length;
    generatedEnrollmentFile = { path: filePath, name: fileName, rows: pending.length, matched };
    return generatedEnrollmentFile;
}

function startUploadJob(students, sourceFileName) {
    resetUpload();

    upload.state = 'running';
    upload.startedAt = new Date().toISOString();
    upload.fileName = sourceFileName;
    upload.total = students.length;

    // Collected as each row lands, so a run that stops halfway still has a
    // record of what was created — and re-uploading skips those rows.
    const collected = [];

    uploadStudents({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        students,
        onProgress: ({ processed, created, duplicates, failed }) => {
            upload.processed = processed;
            upload.created = created;
            upload.duplicates = duplicates;
            upload.failed = failed;
        },
        onResult: async result => {
            collected.push(result);
            if (!result.candidateId || isDryRun) return;
            try {
                await saveCandidate({
                    candidateId: result.candidateId,
                    email: result.email,
                    name: result.name,
                    phone: result.phone,
                    status: result.status,
                    batchName: result.batchName || null,
                    sourceFile: sourceFileName
                });
            } catch (err) {
                console.error(`Could not store ${result.candidateId}:`, err.message);
            }
        }
    }).then(({ created, duplicates, failed }) => {
        const { filePath, fileName } = writeResultCsv(collected);

        upload.state = 'done';
        upload.finishedAt = new Date().toISOString();
        upload.created = created;
        upload.duplicates = duplicates;
        upload.failed = failed;
        upload.resultFile = filePath;
        upload.resultFileName = fileName;
        console.log(`Upload complete: ${created} new, ${duplicates} duplicate, ${failed} failed`);
    }).catch(err => {
        // Whatever finished before the failure is written out and reported, so
        // the user can see how far it got instead of losing the run.
        if (collected.length > 0) {
            const { filePath, fileName } = writeResultCsv(collected);
            upload.resultFile = filePath;
            upload.resultFileName = fileName;
        }
        upload.state = 'error';
        upload.finishedAt = new Date().toISOString();
        upload.error = err.message;
        upload.stoppedAfter = collected.length;
        console.error(`Upload job stopped after ${collected.length} of ${students.length}:`, err);
    });
}

/**
 * Fills in each batch's size from the students already uploaded for it, and
 * separates out the rows that must not be sent: a batch nobody is going into,
 * and a batch that already exists. NSDC does not refuse a repeated name — it
 * quietly creates "Academy Sep26(2)" — so the check has to happen here.
 */
async function prepareBatches(rows) {
    const ready = [];
    const blocked = [];

    for (const row of rows) {
        const existing = await lookupBatch(row.batchName);
        if (existing) {
            blocked.push({
                ...row,
                batchId: existing.batch_id,
                status: 'ALREADY_EXISTS',
                error: `A batch named "${existing.batch_name}" already exists (${existing.batch_id}) — creating it again would make a second batch called "${row.batchName}(2)"`
            });
            continue;
        }

        const size = await countStudentsForBatch(row.batchName);
        if (size === 0) {
            blocked.push({
                ...row,
                batchId: '',
                status: 'NO_STUDENTS',
                error: `No uploaded student names this batch — upload the students for "${row.batchName}" first, so the batch is created with the right size`
            });
            continue;
        }

        ready.push({ ...row, size });
    }

    return { ready, blocked };
}

// ---- Batch upload job state (one job at a time) ----
const batchJob = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    fileName: null,
    processed: 0,
    total: 0,
    created: 0,
    failed: 0,
    error: null,
    stoppedAfter: null,
    resultFile: null,
    resultFileName: null
};

let batchPreviewFile = null;

function resetBatchJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('batch_result_') && f.endsWith('.csv')) ||
            (f.startsWith('batch_payload_preview_') && f.endsWith('.json'))) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    batchJob.state = 'idle';
    batchJob.startedAt = null;
    batchJob.finishedAt = null;
    batchJob.fileName = null;
    batchJob.processed = 0;
    batchJob.total = 0;
    batchJob.created = 0;
    batchJob.failed = 0;
    batchJob.error = null;
    batchJob.stoppedAfter = null;
    batchJob.resultFile = null;
    batchJob.resultFileName = null;
}

function writeBatchResultCsv(results) {
    const headers = ['rowNumber', 'batchName', 'size', 'batchStartDate', 'batchEndDate', 'batchId', 'status', 'error'];
    const lines = [headers.join(',')];
    for (const result of results) {
        lines.push(headers.map(h => csvCell(result[h])).join(','));
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `batch_result_${dateStr}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    return { filePath, fileName };
}

function startBatchJob({ ready, blocked }, sourceFileName) {
    resetBatchJob();

    batchJob.state = 'running';
    batchJob.startedAt = new Date().toISOString();
    batchJob.fileName = sourceFileName;
    batchJob.total = ready.length;
    batchJob.failed = blocked.length;

    const collected = [];

    uploadBatches({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        batches: ready,
        onProgress: ({ processed, created, failed }) => {
            batchJob.processed = processed;
            batchJob.created = created;
            batchJob.failed = failed + blocked.length;
        },
        onResult: async result => {
            collected.push(result);
            if (!result.batchId) return;
            try {
                await saveBatch({
                    batchId: result.batchId,
                    batchName: result.batchName,
                    sourceFile: sourceFileName
                });
            } catch (err) {
                console.error(`Could not store batch ${result.batchId}:`, err.message);
            }
        }
    }).then(({ created, failed }) => {
        const all = [...collected, ...blocked].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
        const { filePath, fileName } = writeBatchResultCsv(all);

        batchJob.state = 'done';
        batchJob.finishedAt = new Date().toISOString();
        batchJob.created = created;
        batchJob.failed = failed + blocked.length;
        batchJob.resultFile = filePath;
        batchJob.resultFileName = fileName;
        console.log(`Batch upload complete: ${created} created, ${failed + blocked.length} not created`);
    }).catch(err => {
        if (collected.length > 0 || blocked.length > 0) {
            const all = [...collected, ...blocked].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
            const { filePath, fileName } = writeBatchResultCsv(all);
            batchJob.resultFile = filePath;
            batchJob.resultFileName = fileName;
        }
        batchJob.state = 'error';
        batchJob.finishedAt = new Date().toISOString();
        batchJob.error = err.message;
        batchJob.stoppedAfter = collected.length;
        console.error(`Batch job stopped after ${collected.length} of ${ready.length}:`, err);
    });
}

// ---- Enrolment job state (one job at a time) ----
const enrollJob = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    fileName: null,
    processed: 0,
    total: 0,
    enrolled: 0,
    alreadyEnrolled: 0,
    skipped: 0,
    failed: 0,
    error: null,
    stoppedAfter: null,
    resultFile: null,
    resultFileName: null
};

let enrollPreviewFile = null;
let enrollMappingFile = null;

function resetEnrollJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('enroll_result_') && f.endsWith('.csv')) ||
            (f.startsWith('enroll_mapping_') && f.endsWith('.csv')) ||
            (f.startsWith('enroll_payload_preview_') && f.endsWith('.json'))) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    Object.assign(enrollJob, {
        state: 'idle', startedAt: null, finishedAt: null, fileName: null,
        processed: 0, total: 0, enrolled: 0, alreadyEnrolled: 0, skipped: 0,
        failed: 0, error: null, stoppedAfter: null, resultFile: null, resultFileName: null
    });
}

/**
 * Turns sheet rows into per-batch groups, looking every email and batch name up
 * in what earlier uploads stored. Rows that cannot be resolved, and pairs
 * already recorded as enrolled, are returned separately rather than sent.
 */
async function resolveEnrollmentRows(rows) {
    const enrolledPairs = await getEnrolledPairs();
    const groups = new Map();
    const unresolved = [];
    const skipped = [];

    for (const row of rows) {
        const candidate = await findCandidateByEmail(row.email);
        if (!candidate) {
            unresolved.push({ ...row, status: 'NOT_FOUND', error: 'No candidate ID stored for this email — upload the student first' });
            continue;
        }

        const batch = await findBatchByName(row.batchName);
        if (!batch) {
            unresolved.push({ ...row, candidateId: candidate.candidate_id, status: 'NOT_FOUND', error: `No batch ID stored for "${row.batchName}" — create the batch first` });
            continue;
        }

        const resolved = {
            ...row,
            candidateId: candidate.candidate_id,
            batchId: batch.batch_id,
            batchName: batch.batch_name
        };

        if (enrolledPairs.has(`${candidate.candidate_id}|${batch.batch_id}`)) {
            skipped.push({ ...resolved, status: 'SKIPPED', error: 'Already enrolled in this batch' });
            continue;
        }

        const key = String(batch.batch_id);
        if (!groups.has(key)) {
            groups.set(key, { batchId: batch.batch_id, batchName: batch.batch_name, rows: [] });
        }
        groups.get(key).rows.push(resolved);
    }

    return { groups: [...groups.values()], unresolved, skipped };
}

function writeEnrollResultCsv(results) {
    const headers = ['rowNumber', 'email', 'candidateId', 'batchName', 'batchId', 'status', 'error'];
    const lines = [headers.join(',')];
    const ordered = [...results].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
    for (const result of ordered) {
        lines.push(headers.map(h => csvCell(result[h])).join(','));
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `enroll_result_${dateStr}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    return { filePath, fileName };
}

function startEnrollJob({ groups, unresolved, skipped }, sourceFileName) {
    resetEnrollJob();

    const total = groups.reduce((n, g) => n + g.rows.length, 0);

    enrollJob.state = 'running';
    enrollJob.startedAt = new Date().toISOString();
    enrollJob.fileName = sourceFileName;
    enrollJob.total = total;
    enrollJob.skipped = skipped.length;
    enrollJob.failed = unresolved.length;

    const collected = [];

    enrollCandidates({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        groups,
        onProgress: ({ processed, enrolled, alreadyEnrolled, failed }) => {
            enrollJob.processed = processed;
            enrollJob.enrolled = enrolled;
            enrollJob.alreadyEnrolled = alreadyEnrolled;
            enrollJob.failed = failed + unresolved.length;
        },
        onResult: async result => {
            collected.push(result);
            if (result.status === 'FAILED') return;
            try {
                await saveEnrollment({
                    candidateId: result.candidateId,
                    batchId: result.batchId,
                    batchName: result.batchName,
                    status: 'ENROLLED',
                    sourceFile: sourceFileName
                });
            } catch (err) {
                console.error(`Could not store enrolment ${result.candidateId}:`, err.message);
            }
        }
    }).then(({ enrolled, alreadyEnrolled, failed }) => {
        const { filePath, fileName } = writeEnrollResultCsv([...collected, ...unresolved, ...skipped]);

        enrollJob.state = 'done';
        enrollJob.finishedAt = new Date().toISOString();
        enrollJob.enrolled = enrolled;
        enrollJob.alreadyEnrolled = alreadyEnrolled;
        enrollJob.failed = failed + unresolved.length;
        enrollJob.resultFile = filePath;
        enrollJob.resultFileName = fileName;
        console.log(`Enrolment complete: ${enrolled} enrolled, ${alreadyEnrolled} already in batch, ${skipped.length} skipped, ${failed + unresolved.length} failed`);
    }).catch(err => {
        const { filePath, fileName } = writeEnrollResultCsv([...collected, ...unresolved, ...skipped]);
        enrollJob.resultFile = filePath;
        enrollJob.resultFileName = fileName;
        enrollJob.state = 'error';
        enrollJob.finishedAt = new Date().toISOString();
        enrollJob.error = err.message;
        enrollJob.stoppedAfter = collected.length;
        console.error(`Enrolment job stopped after ${collected.length} of ${total}:`, err);
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

app.get('/upload', requireLogin, (req, res) => {
    if (upload.state !== 'running') {
        resetUpload();
    }
    res.sendFile(path.join(__dirname, 'views', 'upload.html'));
});

app.get('/api/upload/template', requireLogin, (req, res) => {
    const example = ['Mr.', 'Rahul Sharma', 'male', '1997-04-07', 'Suresh Sharma', 'rahul.sharma@example.com', '9876543210', '91'];
    const csv = TEMPLATE_COLUMNS.join(',') + '\n' + example.join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="student_upload_template.csv"');
    res.send(csv);
});

app.post('/api/upload/students', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (upload.state === 'running') {
        return res.status(409).json({ error: 'An upload is already in progress' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file received' });
    }
    if (!/\.(csv|xlsx|xls)$/i.test(req.file.originalname)) {
        return res.status(400).json({ error: 'Upload a .csv or .xlsx file' });
    }

    let parsed;
    try {
        parsed = await parseStudentSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
        return res.status(400).json({ error: `Could not read the file: ${err.message}` });
    }

    // Nothing reaches NSDC until the whole sheet is clean, so a half-uploaded
    // file can never leave some candidates created and the rest rejected.
    if (parsed.headerErrors.length > 0 || parsed.errors.length > 0) {
        return res.status(422).json({
            headerErrors: parsed.headerErrors,
            errors: parsed.errors.slice(0, 200),
            errorCount: parsed.errors.length,
            validRows: parsed.rows.length,
            ignoredColumns: parsed.ignoredColumns
        });
    }

    if (parsed.rows.length === 0) {
        return res.status(400).json({ error: 'The sheet has no student rows' });
    }

    startUploadJob(parsed.rows, req.file.originalname);
    res.json({ started: true, total: parsed.rows.length, ignoredColumns: parsed.ignoredColumns });
});

app.post('/api/upload/preview', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file received' });
    }

    let parsed;
    try {
        parsed = await parseStudentSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
        return res.status(400).json({ error: `Could not read the file: ${err.message}` });
    }

    if (parsed.headerErrors.length > 0 || parsed.errors.length > 0) {
        return res.status(422).json({
            headerErrors: parsed.headerErrors,
            errors: parsed.errors.slice(0, 200),
            errorCount: parsed.errors.length,
            validRows: parsed.rows.length,
            ignoredColumns: parsed.ignoredColumns
        });
    }

    // Exactly what a real run would send, without sending any of it
    const payloads = parsed.rows.map(row => ({
        row: row.rowNumber,
        method: 'POST',
        url: 'https://adminservices.skillindiadigital.gov.in/api/user/v1/register/Candidate/v1',
        body: buildPayload(row)
    }));

    const fileName = `payload_preview_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    previewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    res.json({ total: payloads.length, fileName, payloads: payloads.slice(0, 20), ignoredColumns: parsed.ignoredColumns });
});

app.get('/api/upload/preview/file', requireLogin, (req, res) => {
    if (!previewFile || !fs.existsSync(previewFile.path)) {
        return res.status(404).json({ error: 'No preview available. Run a preview first.' });
    }
    res.download(previewFile.path, previewFile.name);
});

app.get('/api/upload/status', requireLogin, async (req, res) => {
    try {
        await buildEnrollmentSheet();
    } catch (err) {
        console.error('Could not build the enrolment sheet:', err.message);
    }

    res.json({
        state: upload.state,
        startedAt: upload.startedAt,
        finishedAt: upload.finishedAt,
        fileName: upload.fileName,
        processed: upload.processed,
        total: upload.total,
        created: upload.created,
        duplicates: upload.duplicates,
        failed: upload.failed,
        error: upload.error,
        stoppedAfter: upload.stoppedAfter,
        resultReady: Boolean(upload.resultFile),
        resultFileName: upload.resultFileName,
        dryRun: isDryRun,
        dbEnabled,
        enrollmentSheet: generatedEnrollmentFile
            ? { fileName: generatedEnrollmentFile.name, rows: generatedEnrollmentFile.rows, matched: generatedEnrollmentFile.matched }
            : null
    });
});

app.get('/api/upload/enrollment-sheet', requireLogin, async (req, res) => {
    try {
        await buildEnrollmentSheet();
    } catch (err) {
        console.error('Could not build the enrolment sheet:', err.message);
    }
    if (!generatedEnrollmentFile || !fs.existsSync(generatedEnrollmentFile.path)) {
        return res.status(404).json({ error: 'No enrolment sheet available. Upload a student sheet that names a batch per row.' });
    }
    res.download(generatedEnrollmentFile.path, generatedEnrollmentFile.name);
});

app.get('/api/upload/result', requireLogin, (req, res) => {
    if (!upload.resultFile || !fs.existsSync(upload.resultFile)) {
        return res.status(404).json({ error: 'No result available. Run an upload first.' });
    }
    res.download(upload.resultFile, upload.resultFileName);
});

app.get('/batches', requireLogin, (req, res) => {
    if (batchJob.state !== 'running') {
        resetBatchJob();
    }
    res.sendFile(path.join(__dirname, 'views', 'batches.html'));
});

app.get('/api/batches/template', requireLogin, (req, res) => {
    const example = [
        'Academy Jan26', '10-Jan-2026', '13-Feb-2027', 'FeeSchCor_31336_v1', '1',
        '1/10/2026 2:00:00', '2/13/2027 2:00:00', '319000', 'Self-Paid',
        '20-Feb-2027', '21-Feb-2027', 'Self', 'Regular', 'Fee Based',
        'NSDC Market led programme', '1', 'Fee Based', '34735', 'Scheme_1159',
        'TP155158', 'TC205331'
    ];
    const csv = BATCH_COLUMNS.join(',') + '\n' + example.join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="batch_upload_template.csv"');
    res.send(csv);
});

app.post('/api/batches/preview', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file received' });
    }

    let parsed;
    try {
        parsed = await parseBatchSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
        return res.status(400).json({ error: `Could not read the file: ${err.message}` });
    }

    if (parsed.headerErrors.length > 0 || parsed.errors.length > 0) {
        return res.status(422).json({
            headerErrors: parsed.headerErrors,
            errors: parsed.errors.slice(0, 200),
            errorCount: parsed.errors.length,
            validRows: parsed.rows.length,
            ignoredColumns: parsed.ignoredColumns
        });
    }

    const { ready, blocked } = await prepareBatches(parsed.rows);

    const payloads = ready.map(row => ({
        row: row.rowNumber,
        method: 'POST',
        url: 'https://adminservices.skillindiadigital.gov.in/api/batch/v1/create',
        body: buildBatchPayload(row)
    }));

    const fileName = `batch_payload_preview_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    batchPreviewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    res.json({
        total: payloads.length,
        fileName,
        payloads: payloads.slice(0, 20),
        ignoredColumns: parsed.ignoredColumns,
        blocked: blocked.map(b => ({ row: b.rowNumber, batchName: b.batchName, error: b.error })),
        blockedCount: blocked.length
    });
});

app.get('/api/batches/preview/file', requireLogin, (req, res) => {
    if (!batchPreviewFile || !fs.existsSync(batchPreviewFile.path)) {
        return res.status(404).json({ error: 'No preview available. Run a preview first.' });
    }
    res.download(batchPreviewFile.path, batchPreviewFile.name);
});

app.post('/api/batches/upload', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (batchJob.state === 'running') {
        return res.status(409).json({ error: 'A batch upload is already in progress' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file received' });
    }
    if (!/\.(csv|xlsx|xls)$/i.test(req.file.originalname)) {
        return res.status(400).json({ error: 'Upload a .csv or .xlsx file' });
    }

    let parsed;
    try {
        parsed = await parseBatchSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
        return res.status(400).json({ error: `Could not read the file: ${err.message}` });
    }

    if (parsed.headerErrors.length > 0 || parsed.errors.length > 0) {
        return res.status(422).json({
            headerErrors: parsed.headerErrors,
            errors: parsed.errors.slice(0, 200),
            errorCount: parsed.errors.length,
            validRows: parsed.rows.length,
            ignoredColumns: parsed.ignoredColumns
        });
    }

    if (parsed.rows.length === 0) {
        return res.status(400).json({ error: 'The sheet has no batch rows' });
    }

    const prepared = await prepareBatches(parsed.rows);

    if (prepared.ready.length === 0) {
        return res.status(422).json({
            headerErrors: [],
            errors: prepared.blocked.map(b => ({ row: b.rowNumber, message: b.error })),
            errorCount: prepared.blocked.length,
            validRows: 0,
            note: 'No batch in this sheet can be created.'
        });
    }

    startBatchJob(prepared, req.file.originalname);
    res.json({
        started: true,
        total: prepared.ready.length,
        blockedCount: prepared.blocked.length,
        ignoredColumns: parsed.ignoredColumns
    });
});

app.get('/api/batches/status', requireLogin, (req, res) => {
    res.json({
        state: batchJob.state,
        startedAt: batchJob.startedAt,
        finishedAt: batchJob.finishedAt,
        fileName: batchJob.fileName,
        processed: batchJob.processed,
        total: batchJob.total,
        created: batchJob.created,
        failed: batchJob.failed,
        error: batchJob.error,
        stoppedAfter: batchJob.stoppedAfter,
        resultReady: Boolean(batchJob.resultFile),
        resultFileName: batchJob.resultFileName,
        dbEnabled
    });
});

app.get('/api/batches/result', requireLogin, (req, res) => {
    if (!batchJob.resultFile || !fs.existsSync(batchJob.resultFile)) {
        return res.status(404).json({ error: 'No result available. Run a batch upload first.' });
    }
    res.download(batchJob.resultFile, batchJob.resultFileName);
});

app.get('/enroll', requireLogin, (req, res) => {
    if (enrollJob.state !== 'running') {
        resetEnrollJob();
    }
    res.sendFile(path.join(__dirname, 'views', 'enroll.html'));
});

/**
 * What the student sheets have asked for and that is still waiting: the same
 * list the enrolment sheet is built from, ready to act on without downloading
 * and re-uploading a file.
 */
app.get('/api/enroll/pending', requireLogin, async (req, res) => {
    try {
        const pending = await getPendingEnrollments();
        res.json({
            ready: pending.filter(r => r.batchId !== '').length,
            waiting: pending.filter(r => r.batchId === '').map(r => ({ email: r.email, batchName: r.batchName })),
            rows: pending.slice(0, 50),
            total: pending.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/enroll/pending', requireLogin, async (req, res) => {
    if (enrollJob.state === 'running') {
        return res.status(409).json({ error: 'An enrolment is already in progress' });
    }

    const pending = await getPendingEnrollments();
    const ready = pending.filter(r => r.batchId !== '');

    if (ready.length === 0) {
        return res.status(422).json({
            headerErrors: [],
            errors: pending.map((r, i) => ({ row: i + 1, message: `${r.email}: no batch named "${r.batchName}" has been created yet` })),
            errorCount: pending.length,
            validRows: 0,
            note: pending.length === 0
                ? 'Nothing is waiting to be enrolled.'
                : 'Every waiting row names a batch that does not exist yet — create those batches first.'
        });
    }

    const groups = new Map();
    for (const row of ready) {
        const key = String(row.batchId);
        if (!groups.has(key)) groups.set(key, { batchId: row.batchId, batchName: row.batchName, rows: [] });
        groups.get(key).rows.push({ ...row, rowNumber: groups.get(key).rows.length + 1 });
    }

    const unresolved = pending.filter(r => r.batchId === '').map(r => ({
        ...r, status: 'NOT_FOUND', error: `No batch ID stored for "${r.batchName}" — create the batch first`
    }));

    startEnrollJob({ groups: [...groups.values()], unresolved, skipped: [] }, 'pending list');
    res.json({ started: true, total: ready.length, groups: groups.size, skipped: 0, unresolvedCount: unresolved.length });
});

app.get('/api/enroll/template', requireLogin, (req, res) => {
    const csv = ENROLLMENT_COLUMNS.join(',') + '\n' +
        'rahul.sharma@example.com,Academy Jan26\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="enrollment_template.csv"');
    res.send(csv);
});

async function readEnrollmentUpload(req, res) {
    if (!req.file) {
        res.status(400).json({ error: 'No file received' });
        return null;
    }
    if (!/\.(csv|xlsx|xls)$/i.test(req.file.originalname)) {
        res.status(400).json({ error: 'Upload a .csv or .xlsx file' });
        return null;
    }

    let parsed;
    try {
        parsed = await parseEnrollmentSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
        res.status(400).json({ error: `Could not read the file: ${err.message}` });
        return null;
    }

    if (parsed.headerErrors.length > 0 || parsed.errors.length > 0) {
        res.status(422).json({
            headerErrors: parsed.headerErrors,
            errors: parsed.errors.slice(0, 200),
            errorCount: parsed.errors.length,
            validRows: parsed.rows.length,
            ignoredColumns: parsed.ignoredColumns
        });
        return null;
    }

    if (parsed.rows.length === 0) {
        res.status(400).json({ error: 'The sheet has no rows' });
        return null;
    }

    return parsed;
}

app.post('/api/enroll/preview', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    const parsed = await readEnrollmentUpload(req, res);
    if (!parsed) return;

    const { groups, unresolved, skipped } = await resolveEnrollmentRows(parsed.rows);

    const payloads = groups.map(group => ({
        batchName: group.batchName,
        students: group.rows.length,
        method: 'POST',
        url: 'https://adminservices.skillindiadigital.gov.in/api/thirdparty/v1/enroll/Candidate',
        body: buildEnrollmentPayload(group.batchId, group.rows.map(r => r.candidateId))
    }));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const fileName = `enroll_payload_preview_${stamp}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    enrollPreviewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    // The same resolution as a CSV: what each email and batch name turned into.
    // This is the sheet that used to be assembled by hand before a run.
    const mappingHeaders = ['rowNumber', 'email', 'candidateId', 'batchName', 'batchId', 'status', 'note'];
    const mappingRows = [
        ...groups.flatMap(group => group.rows.map(row => ({ ...row, status: 'READY', note: '' }))),
        ...skipped.map(row => ({ ...row, note: row.error })),
        ...unresolved.map(row => ({ ...row, note: row.error }))
    ].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));

    const mappingName = `enroll_mapping_${stamp}.csv`;
    fs.writeFileSync(
        path.join(DATA_DIR, mappingName),
        [mappingHeaders.join(','), ...mappingRows.map(r => mappingHeaders.map(h => csvCell(r[h])).join(','))].join('\n') + '\n',
        'utf8'
    );
    enrollMappingFile = { path: path.join(DATA_DIR, mappingName), name: mappingName };

    res.json({
        total: groups.reduce((n, g) => n + g.rows.length, 0),
        groups: groups.length,
        skipped: skipped.length,
        unresolved: unresolved.map(u => ({ row: u.rowNumber, email: u.email, error: u.error })).slice(0, 200),
        unresolvedCount: unresolved.length,
        payloads: payloads.slice(0, 20),
        fileName,
        mappingFile: mappingName
    });
});

app.get('/api/enroll/mapping', requireLogin, (req, res) => {
    if (!enrollMappingFile || !fs.existsSync(enrollMappingFile.path)) {
        return res.status(404).json({ error: 'No mapping available. Run a preview first.' });
    }
    res.download(enrollMappingFile.path, enrollMappingFile.name);
});

app.get('/api/enroll/preview/file', requireLogin, (req, res) => {
    if (!enrollPreviewFile || !fs.existsSync(enrollPreviewFile.path)) {
        return res.status(404).json({ error: 'No preview available. Run a preview first.' });
    }
    res.download(enrollPreviewFile.path, enrollPreviewFile.name);
});

app.post('/api/enroll/upload', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (enrollJob.state === 'running') {
        return res.status(409).json({ error: 'An enrolment is already in progress' });
    }

    const parsed = await readEnrollmentUpload(req, res);
    if (!parsed) return;

    const resolved = await resolveEnrollmentRows(parsed.rows);

    if (resolved.groups.length === 0) {
        return res.status(422).json({
            headerErrors: [],
            errors: resolved.unresolved.map(u => ({ row: u.rowNumber, message: u.error })),
            errorCount: resolved.unresolved.length,
            validRows: 0,
            note: resolved.skipped.length > 0
                ? `${resolved.skipped.length} row(s) are already enrolled; nothing left to send.`
                : 'No row could be matched to a stored candidate and batch.'
        });
    }

    startEnrollJob(resolved, req.file.originalname);
    res.json({
        started: true,
        total: resolved.groups.reduce((n, g) => n + g.rows.length, 0),
        groups: resolved.groups.length,
        skipped: resolved.skipped.length,
        unresolvedCount: resolved.unresolved.length
    });
});

app.get('/api/enroll/status', requireLogin, (req, res) => {
    res.json({
        state: enrollJob.state,
        startedAt: enrollJob.startedAt,
        finishedAt: enrollJob.finishedAt,
        fileName: enrollJob.fileName,
        processed: enrollJob.processed,
        total: enrollJob.total,
        enrolled: enrollJob.enrolled,
        alreadyEnrolled: enrollJob.alreadyEnrolled,
        skipped: enrollJob.skipped,
        failed: enrollJob.failed,
        error: enrollJob.error,
        stoppedAfter: enrollJob.stoppedAfter,
        resultReady: Boolean(enrollJob.resultFile),
        resultFileName: enrollJob.resultFileName,
        dbEnabled
    });
});

app.get('/api/enroll/result', requireLogin, (req, res) => {
    if (!enrollJob.resultFile || !fs.existsSync(enrollJob.resultFile)) {
        return res.status(404).json({ error: 'No result available. Run an enrolment first.' });
    }
    res.download(enrollJob.resultFile, enrollJob.resultFileName);
});

app.get('/health', (req, res) => res.json({ ok: true }));

initSchema().catch(err => console.error('Database setup failed:', err.message));

app.listen(PORT, () => {
    console.log(`NSDC student portal listening on port ${PORT}`);
});
