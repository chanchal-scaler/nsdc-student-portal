/**
 * Loads IDs that already exist on NSDC into the portal's database.
 *
 * Enrollment resolves an email to a candidate ID and a batch name to a batch
 * ID from those tables. Without this, only students and batches created
 * through the portal can be enrolled — everything from before is invisible.
 *
 *   node tools/backfill.js batches   <dir with Batch_Upload_Output_*.json>
 *   node tools/backfill.js students  <students_list_*.csv from the download page>
 *
 * Both are safe to re-run: rows are upserted on their ID, never duplicated.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import { saveBatch, saveCandidate, isEnabled } from '../lib/db.js';

const [, , mode, target] = process.argv;

if (!mode || !target) {
    console.error('Usage: node tools/backfill.js <batches|students> <path>');
    process.exit(1);
}
if (!isEnabled) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}

async function backfillBatches(dir) {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('Batch_Upload_Output'));
    console.log(`Reading ${files.length} batch output file(s) from ${dir}`);

    // Same batch name has been issued more than one id, so the id is the key
    const seen = new Map();
    let skipped = 0;

    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
            skipped++;
            continue;
        }
        if (!Array.isArray(parsed)) { skipped++; continue; }

        for (const entry of parsed) {
            if (entry && entry.batchId && entry.batchName) {
                seen.set(entry.batchId, entry.batchName);
            }
        }
    }

    console.log(`${seen.size} distinct batch id(s) found${skipped ? `, ${skipped} file(s) unreadable` : ''}`);

    let written = 0;
    for (const [batchId, batchName] of seen) {
        await saveBatch({ batchId, batchName, sourceFile: 'backfill' });
        written++;
    }
    console.log(`${written} batch row(s) written`);
}

async function backfillStudents(file) {
    const records = parseCsv(fs.readFileSync(file), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true
    });
    console.log(`Reading ${records.length} row(s) from ${path.basename(file)}`);

    let written = 0;
    let noEmail = 0;
    let unreadable = 0;

    for (const record of records) {
        const candidateId = record.candidateId;
        if (!candidateId || !/^CAN_\d+$/.test(candidateId)) { unreadable++; continue; }

        let contact = {};
        let personal = {};
        try {
            contact = JSON.parse(record.contactDetails || '{}');
            personal = JSON.parse(record.personalDetails || '{}');
        } catch {
            // A shifted row puts JSON in the wrong column; skip rather than
            // store an email against the wrong candidate.
            unreadable++;
            continue;
        }

        const email = (contact.email || '').trim();
        if (!email) { noEmail++; continue; }

        const name = [personal.firstName, personal.middleName, personal.lastName]
            .filter(Boolean).join(' ').trim();

        await saveCandidate({
            candidateId,
            email,
            name: name || null,
            phone: contact.phone ? String(contact.phone) : null,
            status: 'EXISTING',
            sourceFile: 'backfill'
        });
        written++;

        if (written % 2000 === 0) console.log(`  ${written} written…`);
    }

    console.log(`${written} candidate row(s) written`);
    if (noEmail) console.log(`${noEmail} row(s) skipped — no email to match on`);
    if (unreadable) console.log(`${unreadable} row(s) skipped — could not be read (missing or shifted columns)`);
}

const run = mode === 'batches' ? backfillBatches
    : mode === 'students' ? backfillStudents
    : null;

if (!run) {
    console.error(`Unknown mode "${mode}". Use batches or students.`);
    process.exit(1);
}

run(target)
    .then(() => process.exit(0))
    .catch(err => { console.error('Failed:', err.message); process.exit(1); });
