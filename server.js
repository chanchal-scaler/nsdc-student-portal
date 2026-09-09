import express from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { fetchAndWriteStudents, fetchCandidatesForBatches } from './lib/nsdc.js';
import { parseStudentSheet, parseBatchSheet, TEMPLATE_COLUMNS, BATCH_COLUMNS } from './lib/sheet.js';
import { uploadStudents, buildPayload, isDryRun } from './lib/nsdc-candidates.js';
import { uploadBatches, buildBatchPayload } from './lib/nsdc-batches.js';
import { enrollCandidates } from './lib/nsdc-enrollments.js';
import { isServiceDown, SERVICE_DOWN_MESSAGE } from './lib/nsdc-status.js';
import { PROGRAMMES } from './lib/batch-name.js';
import { initSchema, saveCandidate, saveBatch, saveEnrollment, getPendingEnrollments, findCandidateByEmail, findBatchByName, getEnrolledPairs, countStudentsForBatch, enrolmentHistory, saveRun, recentRuns, runRemaining,
    allBatchIds, saveNsdcBatchStudents, saveNsdcSync, nsdcSyncState, findBatchByName as lookupBatch, isEnabled as dbEnabled,
    findPortalUser, noteLogin, countPortalUsers, recordApiFailure, apiFailures, apiFailure } from './lib/db.js';
import { verifyPassword } from './lib/passwords.js';

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


/**
 * Records one failed NSDC call, for the failures page.
 *
 * Everything the page shows comes from here: the endpoint the lib actually
 * called, the body it sent, NSDC's own answer, the sheet row it was for, and
 * the signed-in person whose upload it was. Never awaited by a run — a failure
 * that cannot be recorded must not stop the rest of the sheet.
 */
function noteFailure({ flow, startedBy, sourceFile, row, kind = 'row-failed', subject, batchName, error, call, attempts }) {
    if (!dbEnabled) return;
    const description = call || (error && error.call) || null;
    recordApiFailure({
        userEmail: startedBy || null,
        flow,
        sourceFile: sourceFile || null,
        rowNumber: row && Number.isInteger(row.rowNumber) ? row.rowNumber : null,
        subject: subject || (row ? row.email || row.batchName || null : null),
        batchName: batchName || (row ? row.batchName || null : null),
        endpoint: description ? description.endpoint : 'unknown',
        method: description ? description.method : 'POST',
        httpStatus: description ? description.httpStatus : null,
        kind,
        errorMessage: typeof error === 'string' ? error : (error && error.message) || (row && row.error) || null,
        requestPayload: description ? description.requestPayload : null,
        responseBody: description ? description.responseBody : null,
        attempts: Number.isInteger(attempts) ? attempts : (row && Number.isInteger(row.attempts) ? row.attempts : null)
    }).catch(err => console.error('Could not record the failure:', err.message));
}

function startDownloadJob(startedBy) {
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
        noteFailure({ flow: 'download', startedBy, kind: 'run-stopped', error: err });
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
    serviceDown: false,
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
    upload.serviceDown = false;
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

/**
 * Files what happened, once, at the end of a run.
 *
 * The job state is in memory and the result CSV is deleted on the next page
 * load, so without this a restart loses the answer to "how far did last time
 * get" — which is the question someone returning months later starts with.
 * `remaining` is everything that did not succeed, failures included, so it can
 * be handed back as a sheet to upload next time.
 */
async function recordRun({ flow, sourceFile, batchNames, total, done, failed,
    outcome, stopReason, error, remaining, startedAt }) {
    if (!dbEnabled) return;
    try {
        await saveRun({
            flow, sourceFile,
            batchNames: [...new Set((batchNames || []).filter(Boolean))],
            total, done, failed, outcome, stopReason, error,
            remaining: remaining || [],
            startedAt
        });
    } catch (err) {
        // A run that worked must not be reported as failed because the record
        // of it could not be written
        console.error(`Could not record the ${flow} run:`, err.message);
    }
}

/**
 * The student rows still to do: never sent, or sent and failed. Returned in the
 * template's own columns so the sheet handed back can be uploaded as it is.
 */
function studentsLeft(students, collected) {
    const done = new Set(collected.filter(r => r.candidateId).map(r => String(r.email).toLowerCase()));
    return students
        .filter(row => !done.has(String(row.email).toLowerCase()))
        .map(row => ({
            namePrefix: row.namePrefix,
            name: row.name,
            gender: row.gender || '',
            dob: row.dob,
            guardianName: row.guardianName,
            email: row.email,
            phone: row.phone,
            countryCode: row.countryCode,
            'Batch Name': row.batchName || ''
        }));
}

function startUploadJob(students, sourceFileName, startedBy) {
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
            if (!result.candidateId) {
                noteFailure({
                    flow: 'students', startedBy, sourceFile: sourceFileName,
                    row: result, subject: result.email, error: result.error, call: result.call
                });
            }
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
        recordRun({
            flow: 'students',
            sourceFile: sourceFileName,
            batchNames: students.map(r => r.batchName),
            total: students.length,
            done: created + duplicates,
            failed,
            outcome: 'finished',
            remaining: studentsLeft(students, collected),
            startedAt: upload.startedAt
        });
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
        upload.serviceDown = Boolean(err.serviceDown) || isServiceDown(err);
        upload.error = upload.serviceDown ? `${SERVICE_DOWN_MESSAGE} (${err.message})` : err.message;
        upload.stoppedAfter = collected.length;
        // The call the run gave up on. Recorded as its own entry: the row
        // failures above say which rows NSDC refused, this says why the run
        // stopped touching the rest of the sheet.
        noteFailure({
            flow: 'students', startedBy, sourceFile: sourceFileName,
            kind: 'run-stopped', error: err
        });
        recordRun({
            flow: 'students',
            sourceFile: sourceFileName,
            batchNames: students.map(r => r.batchName),
            total: students.length,
            done: collected.filter(r => r.candidateId).length,
            failed: collected.filter(r => !r.candidateId).length,
            outcome: 'stopped',
            stopReason: upload.serviceDown ? 'service-down' : 'error',
            error: err.message,
            remaining: studentsLeft(students, collected),
            startedAt: upload.startedAt
        });
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
    serviceDown: false,
    // Why rows failed, so the page can say it rather than only the result CSV
    failures: [],
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
    batchJob.serviceDown = false;
    batchJob.failures = [];
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

/**
 * The batch rows still to do. `size` is left out: it is counted from the
 * students on file at the time of upload, not carried in the sheet.
 */
function batchesLeft(ready, collected) {
    const done = new Set(collected.filter(r => r.batchId).map(r => String(r.batchName).toLowerCase()));
    return ready
        .filter(row => !done.has(String(row.batchName).toLowerCase()))
        .map(({ size, rowNumber, ...row }) => row);
}

function startBatchJob({ ready, blocked }, sourceFileName, startedBy) {
    resetBatchJob();

    batchJob.state = 'running';
    batchJob.startedAt = new Date().toISOString();
    batchJob.fileName = sourceFileName;
    batchJob.total = ready.length;
    batchJob.failed = blocked.length;
    batchJob.failures = blocked.map(b => ({
        row: b.rowNumber, batchName: b.batchName, error: b.error
    }));

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
            if (!result.batchId) {
                batchJob.failures.push({
                    row: result.rowNumber,
                    batchName: result.batchName,
                    error: result.error
                });
                noteFailure({
                    flow: 'batches', startedBy, sourceFile: sourceFileName,
                    row: result, subject: result.batchName, error: result.error, call: result.call
                });
                return;
            }
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
        recordRun({
            flow: 'batches',
            sourceFile: sourceFileName,
            batchNames: ready.map(r => r.batchName),
            total: ready.length,
            done: created,
            failed: failed + blocked.length,
            outcome: 'finished',
            remaining: batchesLeft(ready, collected),
            startedAt: batchJob.startedAt
        });
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
        batchJob.serviceDown = Boolean(err.serviceDown) || isServiceDown(err);
        batchJob.error = batchJob.serviceDown ? `${SERVICE_DOWN_MESSAGE} (${err.message})` : err.message;
        batchJob.stoppedAfter = collected.length;
        // The call the run gave up on. Recorded as its own entry: the row
        // failures above say which rows NSDC refused, this says why the run
        // stopped touching the rest of the sheet.
        noteFailure({
            flow: 'batches', startedBy, sourceFile: sourceFileName,
            kind: 'run-stopped', error: err
        });
        recordRun({
            flow: 'batches',
            sourceFile: sourceFileName,
            batchNames: ready.map(r => r.batchName),
            total: ready.length,
            done: collected.filter(r => r.batchId).length,
            failed: collected.filter(r => !r.batchId).length + blocked.length,
            outcome: 'stopped',
            stopReason: batchJob.serviceDown ? 'service-down' : 'error',
            error: err.message,
            remaining: batchesLeft(ready, collected),
            startedAt: batchJob.startedAt
        });
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
    serviceDown: false,
    resultFile: null,
    resultFileName: null
};


function resetEnrollJob() {
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.startsWith('enroll_result_') && f.endsWith('.csv')) {
            try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* best effort */ }
        }
    }
    Object.assign(enrollJob, {
        state: 'idle', startedAt: null, finishedAt: null, fileName: null,
        processed: 0, total: 0, enrolled: 0, alreadyEnrolled: 0, skipped: 0,
        failed: 0, error: null, stoppedAfter: null, serviceDown: false, resultFile: null, resultFileName: null
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

/**
 * The students still to enrol: never sent, sent and failed, or never matched to
 * a candidate or batch in the first place. Enrolment is driven from what the
 * portal already stored rather than a sheet, so this is a plain list to read
 * rather than a file to re-upload.
 */
function enrolmentsLeft(groups, collected, unresolved) {
    const done = new Set(collected
        .filter(r => r.status !== 'FAILED')
        .map(r => `${r.candidateId}|${r.batchId}`));

    const left = [];
    for (const group of groups) {
        for (const row of group.rows) {
            if (done.has(`${row.candidateId}|${group.batchId}`)) continue;
            left.push({
                email: row.email,
                candidateId: row.candidateId,
                batchName: group.batchName,
                batchId: group.batchId,
                reason: 'not enrolled yet'
            });
        }
    }
    for (const row of unresolved || []) {
        left.push({
            email: row.email,
            candidateId: row.candidateId || '',
            batchName: row.batchName || '',
            batchId: row.batchId || '',
            reason: row.error || 'could not be matched'
        });
    }
    return left;
}

function startEnrollJob({ groups, unresolved, skipped }, sourceFileName, startedBy) {
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
            if (result.status === 'FAILED') {
                noteFailure({
                    flow: 'enrolment', startedBy, sourceFile: sourceFileName,
                    row: result, subject: result.email, batchName: result.batchName,
                    error: result.error, call: result.call
                });
                return;
            }
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
        recordRun({
            flow: 'enrolment',
            sourceFile: sourceFileName,
            batchNames: groups.map(g => g.batchName),
            total,
            done: enrolled + alreadyEnrolled,
            failed: failed + unresolved.length,
            outcome: 'finished',
            remaining: enrolmentsLeft(groups, collected, unresolved),
            startedAt: enrollJob.startedAt
        });
        console.log(`Enrolment complete: ${enrolled} enrolled, ${alreadyEnrolled} already in batch, ${skipped.length} skipped, ${failed + unresolved.length} failed`);
    }).catch(err => {
        const { filePath, fileName } = writeEnrollResultCsv([...collected, ...unresolved, ...skipped]);
        enrollJob.resultFile = filePath;
        enrollJob.resultFileName = fileName;
        enrollJob.state = 'error';
        enrollJob.finishedAt = new Date().toISOString();
        enrollJob.serviceDown = Boolean(err.serviceDown) || isServiceDown(err);
        enrollJob.error = enrollJob.serviceDown ? `${SERVICE_DOWN_MESSAGE} (${err.message})` : err.message;
        enrollJob.stoppedAfter = collected.length;
        // The call the run gave up on. Recorded as its own entry: the row
        // failures above say which rows NSDC refused, this says why the run
        // stopped touching the rest of the sheet.
        noteFailure({
            flow: 'enrolment', startedBy, sourceFile: sourceFileName,
            kind: 'run-stopped', error: err
        });
        recordRun({
            flow: 'enrolment',
            sourceFile: sourceFileName,
            batchNames: groups.map(g => g.batchName),
            total,
            done: collected.filter(r => r.status !== 'FAILED').length,
            failed: collected.filter(r => r.status === 'FAILED').length + unresolved.length,
            outcome: 'stopped',
            stopReason: enrollJob.serviceDown ? 'service-down' : 'error',
            error: err.message,
            remaining: enrolmentsLeft(groups, collected, unresolved),
            startedAt: enrollJob.startedAt
        });
        console.error(`Enrolment job stopped after ${collected.length} of ${total}:`, err);
    });
}

// ---- NSDC read job (one at a time) ----
//
// Reads what NSDC holds for the batches this portal knows about, so the
// "Enrolled so far" page can say which students never made it — the ones a
// stopped run left behind. The list endpoint has no batch filter, so this pages
// the whole list and keeps the batches asked about; it takes minutes against
// the real service, which is why it runs as a job with progress rather than
// inside a request.
const syncJob = {
    state: 'idle', // idle | running | done | error
    startedAt: null,
    finishedAt: null,
    pagesFetched: 0,
    totalPages: null,
    candidatesSeen: 0,
    matched: 0,
    batches: 0,
    failedPages: [],
    serviceDown: false,
    error: null
};

function startSyncJob(batches, startedBy) {
    syncJob.state = 'running';
    syncJob.startedAt = new Date().toISOString();
    syncJob.finishedAt = null;
    syncJob.pagesFetched = 0;
    syncJob.totalPages = null;
    syncJob.candidatesSeen = 0;
    syncJob.matched = 0;
    syncJob.batches = batches.length;
    syncJob.failedPages = [];
    syncJob.serviceDown = false;
    syncJob.error = null;

    fetchCandidatesForBatches({
        userName: NSDC_USERNAME,
        password: NSDC_PASSWORD,
        tpId: TP_ID,
        batchIds: batches.map(b => b.batchId),
        onProgress: ({ pagesFetched, totalPages, candidatesSeen, matched, failedPages }) => {
            syncJob.pagesFetched = pagesFetched;
            syncJob.totalPages = totalPages;
            syncJob.candidatesSeen = candidatesSeen;
            syncJob.matched = matched;
            syncJob.failedPages = failedPages;
        }
    }).then(async ({ byBatch, candidatesSeen, pagesFetched, failedPages }) => {
        const written = await saveNsdcBatchStudents(byBatch);
        syncJob.state = 'done';
        syncJob.finishedAt = new Date().toISOString();
        syncJob.matched = written;
        await saveNsdcSync({
            startedAt: syncJob.startedAt,
            finishedAt: syncJob.finishedAt,
            pagesFetched,
            candidates: candidatesSeen,
            matched: written,
            failedPages: failedPages.length,
            outcome: failedPages.length > 0 ? 'partial' : 'finished'
        });
        console.log(`NSDC read complete: ${candidatesSeen} candidates over ${pagesFetched} page(s), ${written} in known batches`);
    }).catch(async err => {
        // A read that stopped part way still wrote the batches it got to, so
        // what it did read is kept rather than thrown away
        if (err.partial && err.partial.byBatch && err.partial.byBatch.size > 0) {
            try {
                syncJob.matched = await saveNsdcBatchStudents(err.partial.byBatch);
            } catch (writeErr) {
                console.error('Could not store the partial NSDC read:', writeErr.message);
            }
        }
        syncJob.state = 'error';
        syncJob.finishedAt = new Date().toISOString();
        syncJob.serviceDown = Boolean(err.serviceDown) || isServiceDown(err);
        syncJob.error = syncJob.serviceDown ? `${SERVICE_DOWN_MESSAGE} (${err.message})` : err.message;
        noteFailure({ flow: 'nsdc-read', startedBy, sourceFile: null, kind: 'run-stopped', error: err });
        try {
            await saveNsdcSync({
                startedAt: syncJob.startedAt,
                finishedAt: syncJob.finishedAt,
                pagesFetched: syncJob.pagesFetched,
                candidates: syncJob.candidatesSeen,
                matched: syncJob.matched,
                failedPages: (syncJob.failedPages || []).length,
                outcome: 'stopped',
                error: err.message
            });
        } catch (saveErr) {
            console.error('Could not record the NSDC read:', saveErr.message);
        }
        console.error('NSDC read stopped:', err.message);
    });
}

// ---- Routes ----
app.get('/login', (req, res) => {
    if (req.session.loggedIn) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

/**
 * Who this email and password belong to, or null.
 *
 * A login of our own (portal_users) is checked first; the LOGIN_EMAIL pair in
 * the environment still works, so a portal with no rows in that table — or no
 * database at all — is not locked out.
 */
async function authenticateUser(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string') return null;
    const address = email.trim().toLowerCase();

    if (dbEnabled) {
        try {
            const user = await findPortalUser(address);
            if (user && verifyPassword(password, user.password_hash)) {
                return { email: user.email, label: user.label || null, source: 'portal_users' };
            }
        } catch (err) {
            // A database that is unreachable must not lock out the env login
            console.error('Could not check the stored logins:', err.message);
        }
    }

    if (safeEqual(address, LOGIN_EMAIL.toLowerCase()) && safeEqual(password, LOGIN_PASSWORD)) {
        return { email: LOGIN_EMAIL.toLowerCase(), label: 'Shared login', source: 'environment' };
    }

    return null;
}

app.post('/login', async (req, res) => {
    const ip = req.ip;
    if (isRateLimited(ip)) {
        return res.redirect('/login?error=' + encodeURIComponent('Too many attempts. Try again in 15 minutes.'));
    }

    const { email, password } = req.body || {};
    const user = await authenticateUser(email, password);
    if (user) {
        loginAttempts.delete(ip);
        if (user.source === 'portal_users') noteLogin(user.email).catch(() => { /* best effort */ });
        // Rotate the session ID on login to prevent session fixation
        return req.session.regenerate(err => {
            if (err) {
                console.error('Session regeneration failed:', err);
                return res.redirect('/login?error=' + encodeURIComponent('Login failed, please try again'));
            }
            req.session.loggedIn = true;
            // Every run is recorded against this, so a failure can name the
            // person whose upload it was
            req.session.userEmail = user.email;
            req.session.userLabel = user.label;
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
    startDownloadJob(req.session.userEmail);
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

    startUploadJob(parsed.rows, req.file.originalname, req.session.userEmail);
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
        serviceDown: Boolean(upload.serviceDown),
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

    startBatchJob(prepared, req.file.originalname, req.session.userEmail);
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
        serviceDown: Boolean(batchJob.serviceDown),
        failures: batchJob.failures.slice(0, 20),
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

    startEnrollJob({ groups: [...groups.values()], unresolved, skipped: [] }, 'pending list', req.session.userEmail);
    res.json({ started: true, total: ready.length, groups: groups.size, skipped: 0, unresolvedCount: unresolved.length });
});

/**
 * The pending list as a CSV: what each email and batch name resolved to, and
 * why a row did not. Offered so the resolution can be checked before anyone is
 * enrolled, which is what a preview of the sheet used to be for.
 */
app.get('/api/enroll/mapping', requireLogin, async (req, res) => {
    const pending = await getPendingEnrollments();

    const headers = ['email', 'candidateId', 'batchName', 'batchId', 'note'];
    const lines = [headers.join(',')];
    for (const row of pending) {
        lines.push(headers.map(h => csvCell(
            h === 'note'
                ? (row.batchId === '' ? 'No batch of this name has been created yet' : '')
                : row[h]
        )).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="enrolment_mapping_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n') + '\n');
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
        serviceDown: Boolean(enrollJob.serviceDown),
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

/**
 * Where the portal got to last time. Uploads come every few months, so the
 * first thing anyone needs on returning is which months are already done.
 */
/**
 * Where the portal got to, in full. The one-line summary on the upload pages
 * says which months are done; this page says who is in each of those batches,
 * which is the question that follows it.
 */
app.get('/history', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'history.html'));
});

app.get('/api/history', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so nothing has been recorded' });
    }
    // Paged, because the list only grows: the page loads the next few batches as
    // they are scrolled to rather than every month ever in one response
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    try {
        const page = await enrolmentHistory({ limit, offset });
        // The runs panel and the state of the last NSDC read are only wanted on
        // the first page
        page.runs = offset === 0 ? await recentRuns(5) : [];
        page.sync = offset === 0 ? await nsdcSyncState() : null;
        res.json(page);
    } catch (err) {
        res.status(500).json({ error: `Could not read what has been recorded: ${err.message}` });
    }
});

/** Starts a read of NSDC for every batch this portal knows about. */
app.post('/api/history/sync', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so there is nothing to compare against' });
    }
    if (syncJob.state === 'running') {
        return res.status(409).json({ error: 'A read of NSDC is already in progress' });
    }

    let batches;
    try {
        batches = await allBatchIds();
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    if (batches.length === 0) {
        return res.status(400).json({ error: 'No batch has been created yet, so there is nothing to read' });
    }

    startSyncJob(batches, req.session.userEmail);
    res.json({ started: true, batches: batches.length });
});

app.get('/api/history/sync/status', requireLogin, async (req, res) => {
    let last = null;
    try {
        last = dbEnabled ? await nsdcSyncState() : null;
    } catch { /* the live job state is still worth answering with */ }

    res.json({
        state: syncJob.state,
        startedAt: syncJob.startedAt,
        finishedAt: syncJob.finishedAt,
        pagesFetched: syncJob.pagesFetched,
        totalPages: syncJob.totalPages,
        candidatesSeen: syncJob.candidatesSeen,
        matched: syncJob.matched,
        batches: syncJob.batches,
        failedPages: syncJob.failedPages.length,
        serviceDown: syncJob.serviceDown,
        error: syncJob.error,
        last
    });
});

/**
 * The rows a run did not get through, as a sheet.
 *
 * A run that stopped when NSDC went down has really done part of the work.
 * Handing back only what is left is the difference between uploading the
 * remainder and uploading the whole file again to find out.
 */
app.get('/api/runs/:id/remaining', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so nothing has been recorded' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Not a run id' });
    }

    let run;
    try {
        run = await runRemaining(id);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    if (!run) return res.status(404).json({ error: 'No such run' });
    if (!run.rows || run.rows.length === 0) {
        return res.status(404).json({ error: 'That run has nothing left to do' });
    }

    // Postgres sorts jsonb keys alphabetically, so the column order has to be
    // put back: a sheet handed back is uploaded again, and it should look like
    // the template it came from
    const ORDERS = {
        students: [...TEMPLATE_COLUMNS, 'Batch Name'],
        batches: BATCH_COLUMNS,
        enrolment: ['email', 'candidateId', 'batchName', 'batchId', 'reason']
    };
    const present = Object.keys(run.rows[0]);
    const order = ORDERS[run.flow] || [];
    const headers = [
        ...order.filter(column => present.includes(column)),
        ...present.filter(column => !order.includes(column))
    ];
    const escape = value => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
        headers.join(','),
        ...run.rows.map(row => headers.map(h => escape(row[h])).join(','))
    ].join('\n') + '\n';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
        `attachment; filename="still_to_do_${run.flow}_run${id}.csv"`);
    res.send(csv);
});

/**
 * The failures page: every NSDC call that did not go through.
 *
 * The four upload pages say a row failed; this says which endpoint refused it,
 * when, what was sent, what came back, and whose upload it was.
 */
app.get('/failures', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'failures.html'));
});

app.get('/api/failures', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so failures are not being recorded' });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    // "Last 24 hours" and the like, as a filter the page can hand back
    let since = null;
    const hours = Number(req.query.hours);
    if (Number.isFinite(hours) && hours > 0) {
        since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    }

    try {
        const page = await apiFailures({
            limit,
            offset,
            flow: req.query.flow || null,
            userEmail: req.query.user || null,
            search: req.query.q ? String(req.query.q).trim() : null,
            since
        });
        res.json({ ...page, signedInAs: req.session.userEmail || null });
    } catch (err) {
        res.status(500).json({ error: `Could not read the failures: ${err.message}` });
    }
});

/**
 * The same list as a sheet, for sending on to whoever has to fix the data.
 * The payload is one JSON column rather than exploded into columns: which
 * fields exist depends on which flow failed.
 */
app.get('/api/failures/export/csv', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so failures are not being recorded' });
    }

    let page;
    try {
        page = await apiFailures({
            limit: 100,
            offset: 0,
            flow: req.query.flow || null,
            userEmail: req.query.user || null,
            search: req.query.q ? String(req.query.q).trim() : null
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const full = await Promise.all(page.failures.map(f => apiFailure(f.id)));
    const headers = ['id', 'occurredAt', 'userEmail', 'flow', 'sourceFile', 'rowNumber',
        'subject', 'batchName', 'endpoint', 'method', 'httpStatus', 'kind',
        'errorMessage', 'attempts', 'requestPayload', 'responseBody'];
    const lines = [headers.join(',')];
    for (const failure of full.filter(Boolean)) {
        lines.push(headers.map(h => csvCell(
            h === 'requestPayload' && failure[h] ? JSON.stringify(failure[h]) : failure[h]
        )).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
        `attachment; filename="nsdc_failures_${new Date().toISOString().replace(/[:.]/g, '-')}.csv"`);
    res.send(lines.join('\n') + '\n');
});

/** One failure in full: the request body sent and the answer NSDC gave. */
app.get('/api/failures/:id', requireLogin, async (req, res) => {
    if (!dbEnabled) {
        return res.status(503).json({ error: 'No database is configured, so failures are not being recorded' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Not a failure id' });
    }
    try {
        const failure = await apiFailure(id);
        if (!failure) return res.status(404).json({ error: 'No such failure' });
        res.json(failure);
    } catch (err) {
        res.status(500).json({ error: `Could not read that failure: ${err.message}` });
    }
});

/** Who is signed in, for the header on every page. */
app.get('/api/me', requireLogin, (req, res) => {
    res.json({
        email: req.session.userEmail || null,
        label: req.session.userLabel || null
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

initSchema().catch(err => console.error('Database setup failed:', err.message));

app.listen(PORT, () => {
    console.log(`NSDC student portal listening on port ${PORT}`);
});
