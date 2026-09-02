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
import { parseStudentSheet, parseBatchSheet, parseEnrollmentSheet, parseAssessmentSheet, TEMPLATE_COLUMNS, BATCH_COLUMNS, ENROLLMENT_COLUMNS, ASSESSMENT_COLUMNS } from './lib/sheet.js';
import { uploadStudents, buildPayload, isDryRun } from './lib/nsdc-candidates.js';
import { uploadBatches, buildBatchPayload } from './lib/nsdc-batches.js';
import { enrollCandidates, buildEnrollmentPayload } from './lib/nsdc-enrollments.js';
import { submitAssessments, buildAssessmentPayload } from './lib/nsdc-assessments.js';
import { initSchema, saveCandidate, saveBatch, saveEnrollment, findCandidateByEmail, findBatchByName, getEnrolledPairs, getCompletedPairs, isEnabled as dbEnabled } from './lib/db.js';

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
    resultFile: null,
    resultFileName: null
};

// Holds the most recent payload preview so it can be downloaded as a file.
let previewFile = null;

// Sheets are read in memory and never written to disk — only the result CSV is.
const sheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

function resetUpload() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('upload_result_') && f.endsWith('.csv')) ||
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

function startUploadJob(students, sourceFileName) {
    resetUpload();

    upload.state = 'running';
    upload.startedAt = new Date().toISOString();
    upload.fileName = sourceFileName;
    upload.total = students.length;

    uploadStudents({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        students,
        onProgress: ({ processed, created, duplicates, failed }) => {
            upload.processed = processed;
            upload.created = created;
            upload.duplicates = duplicates;
            upload.failed = failed;
        }
    }).then(async ({ results, created, duplicates, failed }) => {
        // The CSV is written first: it is the user's copy of the candidate IDs
        // and must survive even if the database write fails.
        const { filePath, fileName } = writeResultCsv(results);

        for (const result of results) {
            // Dry runs invent candidate IDs, so they must never reach the database
            if (!result.candidateId || isDryRun) continue;
            try {
                await saveCandidate({
                    candidateId: result.candidateId,
                    email: result.email,
                    name: result.name,
                    phone: result.phone,
                    status: result.status,
                    sourceFile: sourceFileName
                });
            } catch (err) {
                console.error(`Could not store ${result.candidateId}:`, err.message);
            }
        }

        upload.state = 'done';
        upload.finishedAt = new Date().toISOString();
        upload.created = created;
        upload.duplicates = duplicates;
        upload.failed = failed;
        upload.resultFile = filePath;
        upload.resultFileName = fileName;
        console.log(`Upload complete: ${created} new, ${duplicates} duplicate, ${failed} failed`);
    }).catch(err => {
        upload.state = 'error';
        upload.finishedAt = new Date().toISOString();
        upload.error = err.message;
        console.error('Upload job failed:', err);
    });
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

function startBatchJob(batches, sourceFileName) {
    resetBatchJob();

    batchJob.state = 'running';
    batchJob.startedAt = new Date().toISOString();
    batchJob.fileName = sourceFileName;
    batchJob.total = batches.length;

    uploadBatches({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        batches,
        onProgress: ({ processed, created, failed }) => {
            batchJob.processed = processed;
            batchJob.created = created;
            batchJob.failed = failed;
        }
    }).then(async ({ results, created, failed }) => {
        const { filePath, fileName } = writeBatchResultCsv(results);

        for (const result of results) {
            if (!result.batchId) continue;
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

        batchJob.state = 'done';
        batchJob.finishedAt = new Date().toISOString();
        batchJob.created = created;
        batchJob.failed = failed;
        batchJob.resultFile = filePath;
        batchJob.resultFileName = fileName;
        console.log(`Batch upload complete: ${created} created, ${failed} failed`);
    }).catch(err => {
        batchJob.state = 'error';
        batchJob.finishedAt = new Date().toISOString();
        batchJob.error = err.message;
        console.error('Batch upload job failed:', err);
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
    resultFile: null,
    resultFileName: null
};

let enrollPreviewFile = null;

function resetEnrollJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('enroll_result_') && f.endsWith('.csv')) ||
            (f.startsWith('enroll_payload_preview_') && f.endsWith('.json'))) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    Object.assign(enrollJob, {
        state: 'idle', startedAt: null, finishedAt: null, fileName: null,
        processed: 0, total: 0, enrolled: 0, alreadyEnrolled: 0, skipped: 0,
        failed: 0, error: null, resultFile: null, resultFileName: null
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

    enrollCandidates({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        groups,
        onProgress: ({ processed, enrolled, alreadyEnrolled, failed }) => {
            enrollJob.processed = processed;
            enrollJob.enrolled = enrolled;
            enrollJob.alreadyEnrolled = alreadyEnrolled;
            enrollJob.failed = failed + unresolved.length;
        }
    }).then(async ({ results, enrolled, alreadyEnrolled, failed }) => {
        const all = [...results, ...unresolved, ...skipped];
        const { filePath, fileName } = writeEnrollResultCsv(all);

        for (const result of results) {
            if (result.status === 'FAILED') continue;
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

        enrollJob.state = 'done';
        enrollJob.finishedAt = new Date().toISOString();
        enrollJob.enrolled = enrolled;
        enrollJob.alreadyEnrolled = alreadyEnrolled;
        enrollJob.failed = failed + unresolved.length;
        enrollJob.resultFile = filePath;
        enrollJob.resultFileName = fileName;
        console.log(`Enrolment complete: ${enrolled} enrolled, ${alreadyEnrolled} already in batch, ${skipped.length} skipped, ${failed + unresolved.length} failed`);
    }).catch(err => {
        enrollJob.state = 'error';
        enrollJob.finishedAt = new Date().toISOString();
        enrollJob.error = err.message;
        console.error('Enrolment job failed:', err);
    });
}

// ---- Assessment job state (one job at a time) ----
const assessJob = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    fileName: null,
    processed: 0,
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    error: null,
    resultFile: null,
    resultFileName: null
};

let assessPreviewFile = null;

function resetAssessJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if ((f.startsWith('assess_result_') && f.endsWith('.csv')) ||
            (f.startsWith('assess_payload_preview_') && f.endsWith('.json'))) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    Object.assign(assessJob, {
        state: 'idle', startedAt: null, finishedAt: null, fileName: null,
        processed: 0, total: 0, completed: 0, skipped: 0, failed: 0,
        error: null, resultFile: null, resultFileName: null
    });
}

/**
 * Resolves assessment rows the same way enrolment does, with one extra check:
 * results can only be submitted for a student the portal has recorded as
 * enrolled in that batch. Sending results for someone who was never enrolled
 * would be rejected by NSDC anyway, and less legibly.
 */
async function resolveAssessmentRows(rows) {
    const enrolledPairs = await getEnrolledPairs();
    const completedPairs = await getCompletedPairs();
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
        const pair = `${candidate.candidate_id}|${batch.batch_id}`;

        if (completedPairs.has(pair)) {
            skipped.push({ ...resolved, status: 'SKIPPED', error: 'Results already submitted for this batch' });
            continue;
        }

        if (!enrolledPairs.has(pair)) {
            unresolved.push({ ...resolved, status: 'NOT_ENROLLED', error: 'Not enrolled in this batch — enrol the student first' });
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

function writeAssessResultCsv(results) {
    const headers = ['rowNumber', 'email', 'candidateId', 'batchName', 'batchId', 'result', 'status', 'error'];
    const lines = [headers.join(',')];
    const ordered = [...results].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
    for (const result of ordered) {
        lines.push(headers.map(h => csvCell(result[h])).join(','));
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `assess_result_${dateStr}.csv`;
    const filePath = path.join(DATA_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    return { filePath, fileName };
}

function startAssessJob({ groups, unresolved, skipped }, sourceFileName) {
    resetAssessJob();

    const total = groups.reduce((n, g) => n + g.rows.length, 0);

    assessJob.state = 'running';
    assessJob.startedAt = new Date().toISOString();
    assessJob.fileName = sourceFileName;
    assessJob.total = total;
    assessJob.skipped = skipped.length;
    assessJob.failed = unresolved.length;

    submitAssessments({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        groups,
        onProgress: ({ processed, completed, failed }) => {
            assessJob.processed = processed;
            assessJob.completed = completed;
            assessJob.failed = failed + unresolved.length;
        }
    }).then(async ({ results, completed, failed }) => {
        const all = [...results, ...unresolved, ...skipped];
        const { filePath, fileName } = writeAssessResultCsv(all);

        for (const result of results) {
            if (result.status !== 'COMPLETED') continue;
            try {
                await saveEnrollment({
                    candidateId: result.candidateId,
                    batchId: result.batchId,
                    batchName: result.batchName,
                    status: 'COMPLETED',
                    sourceFile: sourceFileName
                });
            } catch (err) {
                console.error(`Could not record completion for ${result.candidateId}:`, err.message);
            }
        }

        assessJob.state = 'done';
        assessJob.finishedAt = new Date().toISOString();
        assessJob.completed = completed;
        assessJob.failed = failed + unresolved.length;
        assessJob.resultFile = filePath;
        assessJob.resultFileName = fileName;
        console.log(`Assessment complete: ${completed} submitted, ${skipped.length} skipped, ${failed + unresolved.length} failed`);
    }).catch(err => {
        assessJob.state = 'error';
        assessJob.finishedAt = new Date().toISOString();
        assessJob.error = err.message;
        console.error('Assessment job failed:', err);
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

app.get('/api/upload/status', requireLogin, (req, res) => {
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
        resultReady: Boolean(upload.resultFile),
        resultFileName: upload.resultFileName,
        dryRun: isDryRun,
        dbEnabled
    });
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
        'Academy Jan26', '100', '10-Jan-2026', '13-Feb-2027', 'FeeSchCor_31336_v1', '1',
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

    const payloads = parsed.rows.map(row => ({
        row: row.rowNumber,
        method: 'POST',
        url: 'https://adminservices.skillindiadigital.gov.in/api/batch/v1/create',
        body: buildBatchPayload(row)
    }));

    const fileName = `batch_payload_preview_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    batchPreviewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    res.json({ total: payloads.length, fileName, payloads: payloads.slice(0, 20), ignoredColumns: parsed.ignoredColumns });
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

    startBatchJob(parsed.rows, req.file.originalname);
    res.json({ started: true, total: parsed.rows.length, ignoredColumns: parsed.ignoredColumns });
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

    const fileName = `enroll_payload_preview_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    enrollPreviewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    res.json({
        total: groups.reduce((n, g) => n + g.rows.length, 0),
        groups: groups.length,
        skipped: skipped.length,
        unresolved: unresolved.map(u => ({ row: u.rowNumber, email: u.email, error: u.error })).slice(0, 200),
        unresolvedCount: unresolved.length,
        payloads: payloads.slice(0, 20),
        fileName
    });
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

app.get('/complete', requireLogin, (req, res) => {
    if (assessJob.state !== 'running') {
        resetAssessJob();
    }
    res.sendFile(path.join(__dirname, 'views', 'complete.html'));
});

app.get('/api/complete/template', requireLogin, (req, res) => {
    const csv = ASSESSMENT_COLUMNS.join(',') + '\n' +
        'rahul.sharma@example.com,Academy Jan26,1\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="batch_completion_template.csv"');
    res.send(csv);
});

async function readAssessmentUpload(req, res) {
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
        parsed = await parseAssessmentSheet(req.file.buffer, req.file.originalname);
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

app.post('/api/complete/preview', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    const parsed = await readAssessmentUpload(req, res);
    if (!parsed) return;

    const { groups, unresolved, skipped } = await resolveAssessmentRows(parsed.rows);

    const payloads = groups.map(group => ({
        batchName: group.batchName,
        students: group.rows.length,
        method: 'POST',
        url: 'https://adminservices.skillindiadigital.gov.in/v1/candidates/candidate/pushBatchEachCandidate',
        body: buildAssessmentPayload(group.batchId, group.rows)
    }));

    const fileName = `assess_payload_preview_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(payloads, null, 2), 'utf8');
    assessPreviewFile = { path: path.join(DATA_DIR, fileName), name: fileName };

    res.json({
        total: groups.reduce((n, g) => n + g.rows.length, 0),
        groups: groups.length,
        skipped: skipped.length,
        unresolved: unresolved.map(u => ({ row: u.rowNumber, email: u.email, error: u.error })).slice(0, 200),
        unresolvedCount: unresolved.length,
        payloads: payloads.slice(0, 5),
        fileName
    });
});

app.get('/api/complete/preview/file', requireLogin, (req, res) => {
    if (!assessPreviewFile || !fs.existsSync(assessPreviewFile.path)) {
        return res.status(404).json({ error: 'No preview available. Run a preview first.' });
    }
    res.download(assessPreviewFile.path, assessPreviewFile.name);
});

app.post('/api/complete/upload', requireLogin, sheetUpload.single('sheet'), async (req, res) => {
    if (assessJob.state === 'running') {
        return res.status(409).json({ error: 'A submission is already in progress' });
    }

    const parsed = await readAssessmentUpload(req, res);
    if (!parsed) return;

    const resolved = await resolveAssessmentRows(parsed.rows);

    if (resolved.groups.length === 0) {
        return res.status(422).json({
            headerErrors: [],
            errors: resolved.unresolved.map(u => ({ row: u.rowNumber, message: u.error })),
            errorCount: resolved.unresolved.length,
            validRows: 0,
            note: resolved.skipped.length > 0
                ? `${resolved.skipped.length} row(s) already submitted; nothing left to send.`
                : 'No row could be matched to an enrolled student.'
        });
    }

    startAssessJob(resolved, req.file.originalname);
    res.json({
        started: true,
        total: resolved.groups.reduce((n, g) => n + g.rows.length, 0),
        groups: resolved.groups.length,
        skipped: resolved.skipped.length,
        unresolvedCount: resolved.unresolved.length
    });
});

app.get('/api/complete/status', requireLogin, (req, res) => {
    res.json({
        state: assessJob.state,
        startedAt: assessJob.startedAt,
        finishedAt: assessJob.finishedAt,
        fileName: assessJob.fileName,
        processed: assessJob.processed,
        total: assessJob.total,
        completed: assessJob.completed,
        skipped: assessJob.skipped,
        failed: assessJob.failed,
        error: assessJob.error,
        resultReady: Boolean(assessJob.resultFile),
        resultFileName: assessJob.resultFileName,
        dbEnabled
    });
});

app.get('/api/complete/result', requireLogin, (req, res) => {
    if (!assessJob.resultFile || !fs.existsSync(assessJob.resultFile)) {
        return res.status(404).json({ error: 'No result available. Run a submission first.' });
    }
    res.download(assessJob.resultFile, assessJob.resultFileName);
});

app.get('/health', (req, res) => res.json({ ok: true }));

initSchema().catch(err => console.error('Database setup failed:', err.message));

app.listen(PORT, () => {
    console.log(`NSDC student portal listening on port ${PORT}`);
});
