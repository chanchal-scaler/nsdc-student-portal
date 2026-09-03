/**
 * Empties everything a demo run leaves behind: the four tables, the mock
 * server's memory, and the result files on disk.
 *
 *   npm run demo:reset
 *
 * Only ever points at whatever DATABASE_URL is set to, so keep it away from a
 * database holding real candidate IDs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Read .env here rather than relying on the caller having exported it: a reset
// that quietly clears nothing is worse than one that refuses to run.
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) continue;
        process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
}
const MOCK_URL = process.env.NSDC_BASE_URL || 'http://localhost:4000';

const TABLES = ['enrollments', 'batches', 'candidates'];

async function clearDatabase() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set, and .env does not carry it — nothing was cleared');
        process.exitCode = 1;
        return;
    }

    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        for (const table of TABLES) {
            try {
                const { rowCount } = await pool.query(`DELETE FROM ${table}`);
                console.log(`  ${table}: ${rowCount} row(s) deleted`);
            } catch (err) {
                // A table that does not exist yet is fine — the server creates
                // them at boot, and a first run may not have happened.
                if (err.code === '42P01') console.log(`  ${table}: not created yet`);
                else throw err;
            }
        }
    } finally {
        await pool.end();
    }
}

async function clearMock() {
    try {
        const response = await fetch(MOCK_URL + '/_mock/reset', { method: 'POST' });
        console.log(response.ok ? `  mock at ${MOCK_URL}: cleared` : `  mock at ${MOCK_URL}: ${response.status}`);
    } catch {
        console.log(`  mock at ${MOCK_URL}: not running (nothing to clear)`);
    }
}

function clearFiles() {
    if (!fs.existsSync(DATA_DIR)) return;
    let removed = 0;
    for (const file of fs.readdirSync(DATA_DIR)) {
        if (file.endsWith('.csv') || file.endsWith('.json')) {
            fs.unlinkSync(path.join(DATA_DIR, file));
            removed++;
        }
    }
    console.log(`  data/: ${removed} file(s) removed`);
}

console.log('Clearing the demo state');
await clearDatabase();
await clearMock();
clearFiles();
console.log('Done. Restart nothing — the portal picks this up on the next request.');
