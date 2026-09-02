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
    source_file   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
export async function saveCandidate({ candidateId, email, name, phone, status, sourceFile }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO candidates (candidate_id, email, name, phone, status, source_file)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (candidate_id) DO UPDATE
            SET email = EXCLUDED.email,
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                status = EXCLUDED.status,
                source_file = EXCLUDED.source_file,
                updated_at = now()`,
        [candidateId, email, name || null, phone || null, status, sourceFile || null]
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

/** Candidate/batch pairs already recorded, so a re-run skips them. */
export async function getEnrolledPairs() {
    if (!pool) return new Set();
    const { rows } = await pool.query(
        `SELECT candidate_id, batch_id FROM enrollments WHERE status = 'ENROLLED'`
    );
    return new Set(rows.map(r => `${r.candidate_id}|${r.batch_id}`));
}

export async function saveEnrollment({ candidateId, batchId, batchName, status, sourceFile }) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO enrollments (candidate_id, batch_id, batch_name, status, source_file)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (candidate_id, batch_id) DO UPDATE
            SET status = EXCLUDED.status,
                batch_name = EXCLUDED.batch_name,
                source_file = EXCLUDED.source_file,
                enrolled_at = now()`,
        [candidateId, batchId, batchName || null, status, sourceFile || null]
    );
}

/** Candidate/batch pairs whose results have already been submitted. */
export async function getCompletedPairs() {
    if (!pool) return new Set();
    const { rows } = await pool.query(
        `SELECT candidate_id, batch_id FROM enrollments WHERE status = 'COMPLETED'`
    );
    return new Set(rows.map(r => `${r.candidate_id}|${r.batch_id}`));
}

export async function countCandidates() {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    return rows[0].n;
}
