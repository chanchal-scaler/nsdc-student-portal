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

/** How many uploaded students name this batch — the batch's size. */
export async function countStudentsForBatch(batchName) {
    if (!pool) return 0;
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM candidates WHERE lower(batch_name) = lower($1)`,
        [batchName]
    );
    return rows[0].n;
}

export async function countCandidates() {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    return rows[0].n;
}
