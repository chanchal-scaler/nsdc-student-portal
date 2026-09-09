import pg from 'pg';

const { Pool } = pg;

// Railway injects DATABASE_URL. Without it the portal still runs — uploads work
// and the result CSV is produced, only the candidate history isn't persisted.
const connectionString = process.env.DATABASE_URL;

export const isEnabled = Boolean(connectionString);

const pool = isEnabled
    ? new Pool({
        connectionString,
        // Railway's Postgres presents a self-signed cert on the public proxy
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000
    })
    : null;

if (pool) {
    pool.on('error', err => console.error('Postgres pool error:', err.message));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
    id            SERIAL PRIMARY KEY,
    candidate_id  TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    name          TEXT,
    phone         TEXT,
    status        TEXT NOT NULL,
    -- The batch the student sheet asked for, held here until the matching batch
    -- exists. Enrolment reads it from this row rather than from a separate list.
    batch_name    TEXT,
    source_file   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS batch_name TEXT;
CREATE INDEX IF NOT EXISTS candidates_email_idx ON candidates (lower(email));

CREATE TABLE IF NOT EXISTS batches (
    id            SERIAL PRIMARY KEY,
    batch_id      BIGINT NOT NULL UNIQUE,
    batch_name    TEXT NOT NULL,
    source_file   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_name_idx ON batches (lower(batch_name));

DROP TABLE IF EXISTS pending_enrollments;

-- What NSDC itself holds, per batch, as of the last read. Kept separate from
-- the portal's own records so the two can be compared: a student this portal
-- uploaded but NSDC does not have in the batch is one still to do.
CREATE TABLE IF NOT EXISTS nsdc_batch_students (
    batch_id      BIGINT NOT NULL,
    candidate_id  TEXT NOT NULL,
    email         TEXT,
    name          TEXT,
    is_certified  BOOLEAN NOT NULL DEFAULT false,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS nsdc_batch_students_batch_idx ON nsdc_batch_students (batch_id);

-- One row, holding when the last read of NSDC happened and how it went
CREATE TABLE IF NOT EXISTS nsdc_sync (
    id            INT PRIMARY KEY DEFAULT 1,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    pages_fetched INT NOT NULL DEFAULT 0,
    candidates    INT NOT NULL DEFAULT 0,
    matched       INT NOT NULL DEFAULT 0,
    failed_pages  INT NOT NULL DEFAULT 0,
    outcome       TEXT,
    error         TEXT,
    CONSTRAINT nsdc_sync_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS runs (
    id            SERIAL PRIMARY KEY,
    -- students | batches | enrolment | completion
    flow          TEXT NOT NULL,
    source_file   TEXT,
    -- The batches this run touched, so a stopped run can be shown against them
    batch_names   TEXT[] NOT NULL DEFAULT '{}',
    total         INT NOT NULL,
    done          INT NOT NULL DEFAULT 0,
    failed        INT NOT NULL DEFAULT 0,
    -- finished | stopped
    outcome       TEXT NOT NULL,
    -- service-down | error, when it stopped
    stop_reason   TEXT,
    error         TEXT,
    -- The rows that never went, so the leftovers can be handed back as a sheet
    -- rather than the whole file being uploaded again blind
    remaining     JSONB NOT NULL DEFAULT '[]',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_finished_idx ON runs (finished_at DESC);

-- Everyone who may sign in to this portal. One shared login could not say
-- whose upload failed, which is the whole point of the failures page; a row per
-- person can. Passwords are scrypt hashes, never the password itself.
CREATE TABLE IF NOT EXISTS portal_users (
    email         TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    label         TEXT,
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- One row per NSDC request that failed, with everything needed to say why:
-- which endpoint, when, who was signed in, which sheet row it was for, the
-- exact body sent and the exact answer that came back.
CREATE TABLE IF NOT EXISTS api_failures (
    id            SERIAL PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The signed-in person whose upload this was
    user_email    TEXT,
    -- students | batches | enrolment | completion | nsdc-read
    flow          TEXT NOT NULL,
    source_file   TEXT,
    row_number    INT,
    -- The student email or batch name the failed row was about
    subject       TEXT,
    batch_name    TEXT,
    endpoint      TEXT NOT NULL,
    method        TEXT NOT NULL DEFAULT 'POST',
    http_status   INT,
    -- row-failed | run-stopped: whether the whole run gave up here
    kind          TEXT NOT NULL DEFAULT 'row-failed',
    error_message TEXT,
    request_payload JSONB,
    response_body TEXT,
    run_id        INT,
    attempts      INT
);
CREATE INDEX IF NOT EXISTS api_failures_time_idx ON api_failures (occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_failures_user_idx ON api_failures (lower(user_email));

CREATE TABLE IF NOT EXISTS enrollments (
    id            SERIAL PRIMARY KEY,
    candidate_id  TEXT NOT NULL,
    batch_id      BIGINT NOT NULL,
    batch_name    TEXT,
    status        TEXT NOT NULL,
    source_file   TEXT,
    enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, batch_id)
);
`;

export async function initSchema() {
    if (!pool) {
        console.warn('DATABASE_URL is not set — candidate IDs will not be stored, only downloadable as CSV');
        return false;
    }
    await pool.query(SCHEMA);
    console.log('Postgres connected, candidates/batches/enrollments tables ready');
    return true;
}

/**
 * Stores one candidate. The same student re-uploaded comes back from NSDC with
 * the candidateId it already has, so conflicts update the existing row instead
 * of erroring or creating a second copy.
 */
export async function saveCandidate({ candidateId, email, name, phone, status, batchName, sourceFile }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO candidates (candidate_id, email, name, phone, status, batch_name, source_file)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (candidate_id) DO UPDATE
            SET email = EXCLUDED.email,
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                status = EXCLUDED.status,
                -- A later sheet naming no batch must not erase the one on file
                batch_name = COALESCE(EXCLUDED.batch_name, candidates.batch_name),
                source_file = EXCLUDED.source_file,
                updated_at = now()`,
        [candidateId, email, name || null, phone || null, status, batchName || null, sourceFile || null]
    );
}

/**
 * Stores one batch. batch_id is the key rather than the name: NSDC has issued
 * two different ids for the same batch name in the past, so a name collision
 * must not overwrite an existing batch.
 */
export async function saveBatch({ batchId, batchName, sourceFile }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO batches (batch_id, batch_name, source_file)
         VALUES ($1, $2, $3)
         ON CONFLICT (batch_id) DO UPDATE
            SET batch_name = EXCLUDED.batch_name,
                source_file = EXCLUDED.source_file,
                updated_at = now()`,
        [batchId, batchName, sourceFile || null]
    );
}

/**
 * Resolves an email to its candidate ID. Where the same address has more than
 * one — NSDC has issued a second ID for a student whose details shifted
 * slightly — the most recently stored one wins.
 */
export async function findCandidateByEmail(email) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `SELECT candidate_id, name FROM candidates
         WHERE lower(email) = lower($1)
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [email]
    );
    return rows[0] || null;
}

/**
 * Resolves a batch name to its ID. A handful of names exist twice with
 * different IDs; the newest is taken, matching what the enrollment script's
 * hand-written mapping always pointed at.
 */
export async function findBatchByName(batchName) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `SELECT batch_id, batch_name FROM batches
         WHERE lower(batch_name) = lower($1)
         ORDER BY batch_id DESC
         LIMIT 1`,
        [batchName]
    );
    if (!rows[0]) return null;
    // pg hands back BIGINT as a string; NSDC wants batchId as a number, the way
    // the enrolment script's hardcoded mapping supplied it.
    return { batch_id: Number(rows[0].batch_id), batch_name: rows[0].batch_name };
}

/**
 * Candidate/batch pairs already in a batch, so a re-run skips them. A completed
 * student is still enrolled — enrolment is where completion started — so both
 * states count, otherwise re-running an enrolment sheet after results were
 * submitted would enrol everybody a second time.
 */
export async function getEnrolledPairs() {
    if (!pool) return new Set();
    const { rows } = await pool.query(
        `SELECT candidate_id, batch_id FROM enrollments
         WHERE status IN ('ENROLLED', 'COMPLETED')`
    );
    return new Set(rows.map(r => `${r.candidate_id}|${r.batch_id}`));
}

export async function saveEnrollment({ candidateId, batchId, batchName, status, sourceFile }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO enrollments (candidate_id, batch_id, batch_name, status, source_file)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (candidate_id, batch_id) DO UPDATE
            SET status = CASE
                    -- Completion is the end of the road. Writing ENROLLED over it
                    -- would make the portal forget results were already sent and
                    -- submit them all over again.
                    WHEN enrollments.status = 'COMPLETED' THEN enrollments.status
                    ELSE EXCLUDED.status
                END,
                batch_name = EXCLUDED.batch_name,
                source_file = EXCLUDED.source_file,
                enrolled_at = now()`,
        [candidateId, batchId, batchName || null, status, sourceFile || null]
    );
}

/**
 * Students whose sheet named a batch and who are not in it yet, with the batch
 * ID filled in where that batch now exists. Resolved on every call, so students
 * and batches can be uploaded in either order.
 */
export async function getPendingEnrollments() {
    if (!pool) return [];
    const { rows } = await pool.query(
        `SELECT c.email,
                c.candidate_id,
                c.batch_name AS requested_name,
                b.batch_name AS resolved_name,
                b.batch_id
         FROM candidates c
         LEFT JOIN LATERAL (
             SELECT batch_id, batch_name FROM batches
             WHERE lower(batch_name) = lower(c.batch_name)
             ORDER BY batch_id DESC LIMIT 1
         ) b ON true
         LEFT JOIN enrollments e
                ON e.candidate_id = c.candidate_id AND e.batch_id = b.batch_id
         WHERE c.batch_name IS NOT NULL
           AND c.batch_name <> ''
           AND e.id IS NULL
         ORDER BY c.id`
    );
    return rows.map(r => ({
        email: r.email,
        candidateId: r.candidate_id,
        batchName: r.resolved_name || r.requested_name,
        batchId: r.batch_id === null ? '' : Number(r.batch_id)
    }));
}

/** Candidate/batch pairs whose results have already been submitted. */
export async function getCompletedPairs() {
    if (!pool) return new Set();
    const { rows } = await pool.query(
        `SELECT candidate_id, batch_id FROM enrollments WHERE status = 'COMPLETED'`
    );
    return new Set(rows.map(r => `${r.candidate_id}|${r.batch_id}`));
}

/** How many uploaded students name this batch — the batch's size. */
export async function countStudentsForBatch(batchName) {
    if (!pool) return 0;
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM candidates WHERE lower(batch_name) = lower($1)`,
        [batchName]
    );
    return rows[0].n;
}

/** Every batch ID this portal knows a name for — what a read of NSDC asks about. */
export async function allBatchIds() {
    if (!pool) return [];
    const { rows } = await pool.query(
        `SELECT batch_id, batch_name FROM batches ORDER BY batch_id DESC`);
    return rows.map(r => ({ batchId: Number(r.batch_id), batchName: r.batch_name }));
}

/**
 * Replaces what NSDC holds for the batches just read.
 *
 * Written per batch rather than as one wipe-and-reload: a read that stops part
 * way — NSDC went down mid-paging — must not delete the batches it never got
 * to and leave them looking empty.
 */
export async function saveNsdcBatchStudents(byBatch) {
    if (!pool) return 0;
    const client = await pool.connect();
    let written = 0;
    try {
        await client.query('BEGIN');
        for (const [batchId, students] of byBatch) {
            await client.query('DELETE FROM nsdc_batch_students WHERE batch_id = $1', [batchId]);
            for (const student of students) {
                await client.query(
                    `INSERT INTO nsdc_batch_students (batch_id, candidate_id, email, name, is_certified)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (batch_id, candidate_id) DO UPDATE
                        SET email = EXCLUDED.email,
                            name = EXCLUDED.name,
                            is_certified = EXCLUDED.is_certified,
                            synced_at = now()`,
                    [batchId, student.candidateId, student.email || null,
                        student.name || null, Boolean(student.isCertified)]
                );
                written++;
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    return written;
}

export async function saveNsdcSync({ startedAt, finishedAt, pagesFetched, candidates,
    matched, failedPages, outcome, error }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO nsdc_sync (id, started_at, finished_at, pages_fetched, candidates,
                                matched, failed_pages, outcome, error)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
            SET started_at = EXCLUDED.started_at,
                finished_at = EXCLUDED.finished_at,
                pages_fetched = EXCLUDED.pages_fetched,
                candidates = EXCLUDED.candidates,
                matched = EXCLUDED.matched,
                failed_pages = EXCLUDED.failed_pages,
                outcome = EXCLUDED.outcome,
                error = EXCLUDED.error`,
        [startedAt || null, finishedAt || null, pagesFetched || 0, candidates || 0,
            matched || 0, failedPages || 0, outcome || null, error || null]
    );
}

/**
 * When NSDC was last read, how that read went, and what it holds.
 *
 * The counts come from the snapshot rather than from the portal's own
 * enrolments table on purpose: one request enrols a whole batch, so a request
 * that wrote some students and then failed leaves the portal's count wrong.
 * NSDC's own answer is the only count worth quoting.
 */
export async function nsdcSyncState() {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT * FROM nsdc_sync WHERE id = 1');
    if (!rows[0]) return null;

    const [snapshot, lastRun] = await Promise.all([
        pool.query(
            `SELECT count(*)::int AS students,
                    count(DISTINCT batch_id)::int AS batches,
                    count(*) FILTER (WHERE is_certified)::int AS certified,
                    max(synced_at) AS synced_at
             FROM nsdc_batch_students`),
        pool.query('SELECT max(finished_at) AS at FROM runs')
    ]);

    const r = rows[0];
    const syncedAt = snapshot.rows[0].synced_at || r.finished_at;
    const runAt = lastRun.rows[0].at;

    return {
        // NSDC's own count of who is in these batches
        enrolled: snapshot.rows[0].students,
        batches: snapshot.rows[0].batches,
        certified: snapshot.rows[0].certified,
        syncedAt,
        // A run since the last read means these numbers are behind, and saying
        // so is the difference between a stale count and a wrong one
        staleSince: runAt && syncedAt && new Date(runAt) > new Date(syncedAt) ? runAt : null,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        pagesFetched: r.pages_fetched,
        candidates: r.candidates,
        matched: r.matched,
        failedPages: r.failed_pages,
        outcome: r.outcome,
        error: r.error
    };
}

/**
 * Records how a run went, whether it finished or stopped part way.
 *
 * The job state itself lives in memory and a result CSV is deleted on the next
 * page load, so before this there was no way to answer "what happened last
 * time" after a restart — the one question someone coming back months later
 * actually has. `remaining` holds the rows that never went, so the leftovers
 * can be handed back as a sheet instead of re-uploading the whole file.
 */
export async function saveRun({ flow, sourceFile, batchNames, total, done, failed,
    outcome, stopReason, error, remaining, startedAt }) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `INSERT INTO runs (flow, source_file, batch_names, total, done, failed,
                           outcome, stop_reason, error, remaining, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         RETURNING id`,
        [flow, sourceFile || null, batchNames || [], total, done, failed,
            outcome, stopReason || null, error || null,
            JSON.stringify(remaining || []), startedAt || new Date().toISOString()]
    );
    return rows[0].id;
}

/** The last few runs, newest first, without the row payloads. */
export async function recentRuns(limit = 5) {
    if (!pool) return [];
    const { rows } = await pool.query(
        `SELECT id, flow, source_file, batch_names, total, done, failed,
                outcome, stop_reason, error, started_at, finished_at,
                jsonb_array_length(remaining) AS remaining_count
         FROM runs
         ORDER BY finished_at DESC, id DESC
         LIMIT $1`,
        [limit]
    );
    return rows.map(r => ({
        id: r.id,
        flow: r.flow,
        sourceFile: r.source_file,
        batchNames: r.batch_names || [],
        total: r.total,
        done: r.done,
        failed: r.failed,
        outcome: r.outcome,
        stopReason: r.stop_reason,
        error: r.error,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        remainingCount: r.remaining_count
    }));
}

/** The rows a stopped run never sent, for handing back as a sheet. */
export async function runRemaining(id) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `SELECT flow, source_file, remaining FROM runs WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return { flow: rows[0].flow, sourceFile: rows[0].source_file, rows: rows[0].remaining };
}

/**
 * Everything the portal has recorded, grouped by batch, most recently touched
 * first, one page at a time.
 *
 * The page it feeds is read before an upload, to see which months are done and
 * who is already in them. It is paged rather than returned whole because the
 * list only grows — every month adds batches — and the page loads the next few
 * as they are scrolled to.
 *
 * Batches come from three places, so nothing recorded is invisible: batches
 * that were created, batches a student named that do not exist yet (no ID), and
 * a batch ID enrolled into whose name was never recorded here (shown as the
 * bare ID rather than dropped).
 */
export async function enrolmentHistory({ limit = 10, offset = 0 } = {}) {
    if (!pool) return { batches: [], total: 0, nextOffset: null };

    const [students, emptyBatches, unnamed, stoppedRuns, nsdc] = await Promise.all([
        pool.query(
            `SELECT COALESCE(b.batch_name, c.batch_name) AS batch_name,
                    b.batch_id,
                    b.created_at   AS batch_created_at,
                    c.candidate_id,
                    c.name,
                    c.email,
                    c.created_at   AS student_created_at,
                    e.status       AS enrolment_status,
                    e.enrolled_at
             FROM candidates c
             LEFT JOIN LATERAL (
                 SELECT batch_id, batch_name, created_at FROM batches
                 WHERE lower(batch_name) = lower(c.batch_name)
                 ORDER BY batch_id DESC LIMIT 1
             ) b ON true
             LEFT JOIN enrollments e
                    ON e.candidate_id = c.candidate_id AND e.batch_id = b.batch_id
             WHERE c.batch_name IS NOT NULL AND c.batch_name <> ''`),

        // A batch created before its students were uploaded has nobody naming
        // it yet; it still belongs on the page, at size zero
        pool.query(
            `SELECT b.batch_id, b.batch_name, b.created_at
             FROM batches b
             WHERE NOT EXISTS (
                 SELECT 1 FROM candidates c
                 WHERE lower(c.batch_name) = lower(b.batch_name))`),

        // An enrolment against a batch this portal never recorded a name for
        pool.query(
            `SELECT e.batch_id, max(e.batch_name) AS batch_name, count(*)::int AS n,
                    max(e.enrolled_at) AS last_at
             FROM enrollments e
             WHERE NOT EXISTS (SELECT 1 FROM batches b WHERE b.batch_id = e.batch_id)
             GROUP BY e.batch_id`),

        pool.query(
            `SELECT id, flow, source_file, batch_names, total, done, failed,
                    stop_reason, finished_at,
                    jsonb_array_length(remaining) AS remaining_count
             FROM runs
             WHERE outcome = 'stopped'
             ORDER BY finished_at DESC`),

        // What NSDC itself has in each batch, as of the last read
        pool.query(
            `SELECT batch_id, candidate_id, is_certified, max(synced_at) OVER () AS synced_at
             FROM nsdc_batch_students`)
    ]);

    // candidateId -> batch IDs NSDC has that candidate in
    const nsdcByBatch = new Map();
    let syncedAt = null;
    for (const row of nsdc.rows) {
        const batchId = Number(row.batch_id);
        if (!nsdcByBatch.has(batchId)) nsdcByBatch.set(batchId, new Map());
        nsdcByBatch.get(batchId).set(row.candidate_id, { certified: row.is_certified });
        syncedAt = row.synced_at;
    }

    const batches = new Map();
    const keyFor = name => name.toLowerCase();

    const ensure = (name, batchId, createdAt) => {
        const key = keyFor(name);
        if (!batches.has(key)) {
            batches.set(key, {
                batchName: name,
                // pg hands BIGINT back as a string; a number keeps it consistent
                // with the rest of the portal
                batchId: batchId === null || batchId === undefined ? null : Number(batchId),
                createdAt: createdAt || null,
                students: []
            });
        }
        return batches.get(key);
    };

    for (const row of students.rows) {
        ensure(row.batch_name, row.batch_id, row.batch_created_at).students.push({
            candidateId: row.candidate_id,
            name: row.name,
            email: row.email,
            addedAt: row.student_created_at,
            // Three states, in the order they happen: on file only, in the
            // batch, results submitted
            status: row.enrolment_status || 'NOT ENROLLED',
            enrolledAt: row.enrolled_at
        });
    }

    for (const row of emptyBatches.rows) {
        ensure(row.batch_name, row.batch_id, row.created_at);
    }

    for (const row of unnamed.rows) {
        const name = row.batch_name || `Batch ${row.batch_id}`;
        const batch = ensure(name, row.batch_id, row.last_at);
        batch.nameKnown = Boolean(row.batch_name);
        batch.enrolledElsewhere = row.n;
    }

    const stamp = value => (value ? new Date(value).getTime() : 0);

    const all = [...batches.values()]
        .map(batch => {
            // Most recent of anything that happened to this batch: a student
            // added, the batch created, someone enrolled. That is what "last
            // updated" means here, and what the page is ordered by.
            const lastActivityAt = [
                batch.createdAt,
                ...batch.students.map(s => s.addedAt),
                ...batch.students.map(s => s.enrolledAt)
            ].filter(Boolean).sort((a, b) => stamp(b) - stamp(a))[0] || null;

            // A run that stopped part way is reported against the batches it was
            // uploading, so the next upload starts from what is actually left
            const stopped = stoppedRuns.rows.find(r =>
                (r.batch_names || []).some(n => keyFor(n) === keyFor(batch.batchName)));

            // The comparison the page is for: a student this portal holds for the
            // batch that NSDC does not have in it never made it — the run stopped,
            // or that row failed. Those are the ones still to upload.
            const inNsdc = nsdcByBatch.get(batch.batchId) || new Map();
            const readYet = batch.batchId !== null && nsdcByBatch.size > 0;
            const missing = batch.batchId === null
                // Nothing to compare against until the batch exists
                ? batch.students.slice()
                : batch.students.filter(s => !inNsdc.has(s.candidateId));

            return {
                ...batch,
                nsdc: {
                    // null rather than 0 where NSDC has never been read, so the
                    // page can say "not read yet" instead of "none"
                    inBatch: batch.batchId === null || nsdcByBatch.size === 0 ? null : inNsdc.size,
                    certified: [...inNsdc.values()].filter(v => v.certified).length,
                    syncedAt
                },
                missing: missing.map(s => ({
                    candidateId: s.candidateId,
                    name: s.name,
                    email: s.email,
                    addedAt: s.addedAt,
                    // What the portal thinks, next to NSDC not having it
                    status: s.status
                })),
                missingCount: missing.length,
                // Newest student activity first inside the batch too, so the
                // students enrolled last time are at the top of the list
                students: [...batch.students]
                    .map(s => ({
                        ...s,
                        // What NSDC says, next to what the portal recorded. Where
                        // they disagree NSDC is right: the portal only knows what
                        // a request told it, and a request can write students and
                        // then fail.
                        onNsdc: readYet ? inNsdc.has(s.candidateId) : null,
                        certifiedOnNsdc: readYet
                            ? Boolean(inNsdc.get(s.candidateId)?.certified)
                            : null
                    }))
                    .sort((a, b) =>
                        stamp(b.enrolledAt) - stamp(a.enrolledAt) ||
                        stamp(b.addedAt) - stamp(a.addedAt) ||
                        String(a.name || a.email).localeCompare(String(b.name || b.email))),
                size: batch.students.length,
                // Two counts, deliberately: what the portal recorded, and what
                // NSDC holds. The second is the one to quote.
                enrolled: batch.students.filter(s => s.status !== 'NOT ENROLLED').length,
                completed: batch.students.filter(s => s.status === 'COMPLETED').length,
                lastEnrolledAt: batch.students
                    .map(s => s.enrolledAt)
                    .filter(Boolean)
                    .sort((a, b) => stamp(b) - stamp(a))[0] || null,
                lastActivityAt,
                lastStoppedRun: stopped ? {
                    id: stopped.id,
                    flow: stopped.flow,
                    sourceFile: stopped.source_file,
                    total: stopped.total,
                    done: stopped.done,
                    failed: stopped.failed,
                    remainingCount: stopped.remaining_count,
                    stopReason: stopped.stop_reason,
                    finishedAt: stopped.finished_at
                } : null
            };
        })
        .sort((a, b) => stamp(b.lastActivityAt) - stamp(a.lastActivityAt) ||
            a.batchName.localeCompare(b.batchName));

    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length < all.length ? offset + page.length : null;

    return {
        batches: page,
        total: all.length,
        totals: {
            students: all.reduce((n, b) => n + b.size, 0),
            enrolled: all.reduce((n, b) => n + b.enrolled, 0),
            completed: all.reduce((n, b) => n + b.completed, 0),
            missing: all.reduce((n, b) => n + b.missingCount, 0),
            inNsdc: nsdcByBatch.size === 0
                ? null
                : all.reduce((n, b) => n + (b.nsdc.inBatch || 0), 0),
            syncedAt
        },
        nextOffset
    };
}

export async function countCandidates() {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    return rows[0].n;
}

// ---- Portal logins ----

/** The login row for an email, or null. Inactive users are not returned. */
export async function findPortalUser(email) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `SELECT email, password_hash, label, active FROM portal_users
         WHERE lower(email) = lower($1) AND active`,
        [String(email || '').trim()]);
    return rows[0] || null;
}

/** Adds a login, or replaces the password on one that already exists. */
export async function savePortalUser({ email, passwordHash, label }) {
    if (!pool) throw new Error('No database is configured, so logins cannot be stored');
    await pool.query(
        `INSERT INTO portal_users (email, password_hash, label)
         VALUES (lower($1), $2, $3)
         ON CONFLICT (email) DO UPDATE
            SET password_hash = EXCLUDED.password_hash,
                label = COALESCE(EXCLUDED.label, portal_users.label),
                active = true`,
        [String(email).trim(), passwordHash, label || null]);
}

export async function listPortalUsers() {
    if (!pool) return [];
    const { rows } = await pool.query(
        `SELECT email, label, active, created_at, last_login_at
         FROM portal_users ORDER BY email`);
    return rows;
}

/**
 * Turns a login off rather than deleting it: the failures that login is named
 * on are the record of who did what, and should keep naming somebody.
 */
export async function deactivatePortalUser(email) {
    if (!pool) return false;
    const { rowCount } = await pool.query(
        `UPDATE portal_users SET active = false WHERE lower(email) = lower($1)`,
        [String(email || '').trim()]);
    return rowCount > 0;
}

export async function noteLogin(email) {
    if (!pool) return;
    await pool.query(
        `UPDATE portal_users SET last_login_at = now() WHERE lower(email) = lower($1)`,
        [String(email || '').trim()]);
}

export async function countPortalUsers() {
    if (!pool) return 0;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM portal_users WHERE active');
    return rows[0].n;
}

// ---- Failed NSDC calls ----

// A payload is stored whole so a rejection can be read against what was sent,
// but a response body can be an HTML error page; enough is kept to diagnose,
// not the whole page.
const MAX_RESPONSE_CHARS = 8000;

/**
 * Records one failed NSDC request. Never throws: a failure that cannot be
 * written must not take down the run that was already failing.
 */
export async function recordApiFailure(entry) {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            `INSERT INTO api_failures
                (occurred_at, user_email, flow, source_file, row_number, subject,
                 batch_name, endpoint, method, http_status, kind, error_message,
                 request_payload, response_body, run_id, attempts)
             VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6, $7, $8, COALESCE($9,'POST'),
                     $10, COALESCE($11,'row-failed'), $12, $13, $14, $15, $16)
             RETURNING id`,
            [
                entry.occurredAt || null,
                entry.userEmail || null,
                entry.flow,
                entry.sourceFile || null,
                Number.isInteger(entry.rowNumber) ? entry.rowNumber : null,
                entry.subject || null,
                entry.batchName || null,
                entry.endpoint || 'unknown',
                entry.method || 'POST',
                Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
                entry.kind || 'row-failed',
                entry.errorMessage || null,
                entry.requestPayload ? JSON.stringify(entry.requestPayload) : null,
                entry.responseBody ? String(entry.responseBody).slice(0, MAX_RESPONSE_CHARS) : null,
                Number.isInteger(entry.runId) ? entry.runId : null,
                Number.isInteger(entry.attempts) ? entry.attempts : null
            ]);
        return rows[0].id;
    } catch (err) {
        console.error('Could not record the failed NSDC call:', err.message);
        return null;
    }
}

/**
 * The failed calls, newest first, filtered the way the page filters them.
 * Payloads are left out of the list — they are large, and the list is a list;
 * one row's payload is read with apiFailure(id).
 */
export async function apiFailures({ limit = 25, offset = 0, flow, userEmail, since, search } = {}) {
    if (!pool) return { failures: [], total: 0, nextOffset: null, flows: [], users: [] };

    const where = [];
    const params = [];

    if (flow) { params.push(flow); where.push(`flow = $${params.length}`); }
    if (userEmail) { params.push(userEmail); where.push(`lower(user_email) = lower($${params.length})`); }
    if (since) { params.push(since); where.push(`occurred_at >= $${params.length}`); }
    if (search) {
        params.push(`%${search}%`);
        const i = params.length;
        where.push(`(subject ILIKE $${i} OR batch_name ILIKE $${i} OR error_message ILIKE $${i} OR source_file ILIKE $${i})`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const [page, count, flows, users] = await Promise.all([
        pool.query(
            `SELECT id, occurred_at, user_email, flow, source_file, row_number, subject,
                    batch_name, endpoint, method, http_status, kind, error_message,
                    run_id, attempts,
                    request_payload IS NOT NULL AS has_payload
             FROM api_failures ${clause}
             ORDER BY occurred_at DESC, id DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        pool.query(`SELECT count(*)::int AS n FROM api_failures ${clause}`, params.slice(0, params.length - 2)),
        // The filter lists come from what is actually there, so a flow nobody
        // has ever run does not appear as an option
        pool.query('SELECT flow, count(*)::int AS n FROM api_failures GROUP BY flow ORDER BY flow'),
        pool.query(`SELECT user_email, count(*)::int AS n FROM api_failures
                    WHERE user_email IS NOT NULL GROUP BY user_email ORDER BY user_email`)
    ]);

    const total = count.rows[0].n;
    const failures = page.rows.map(row => ({
        id: row.id,
        occurredAt: row.occurred_at,
        userEmail: row.user_email,
        flow: row.flow,
        sourceFile: row.source_file,
        rowNumber: row.row_number,
        subject: row.subject,
        batchName: row.batch_name,
        endpoint: row.endpoint,
        method: row.method,
        httpStatus: row.http_status,
        kind: row.kind,
        errorMessage: row.error_message,
        runId: row.run_id,
        attempts: row.attempts,
        hasPayload: row.has_payload
    }));

    return {
        failures,
        total,
        nextOffset: offset + failures.length < total ? offset + failures.length : null,
        flows: flows.rows.map(r => ({ flow: r.flow, count: r.n })),
        users: users.rows.map(r => ({ userEmail: r.user_email, count: r.n }))
    };
}

/** One failed call in full, payload and response included. */
export async function apiFailure(id) {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT * FROM api_failures WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
        id: row.id,
        occurredAt: row.occurred_at,
        userEmail: row.user_email,
        flow: row.flow,
        sourceFile: row.source_file,
        rowNumber: row.row_number,
        subject: row.subject,
        batchName: row.batch_name,
        endpoint: row.endpoint,
        method: row.method,
        httpStatus: row.http_status,
        kind: row.kind,
        errorMessage: row.error_message,
        requestPayload: row.request_payload,
        responseBody: row.response_body,
        runId: row.run_id,
        attempts: row.attempts
    };
}

/** How many calls have failed since a moment, for the one-line summary. */
export async function countApiFailuresSince(since) {
    if (!pool) return 0;
    const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM api_failures WHERE occurred_at >= $1', [since]);
    return rows[0].n;
}
