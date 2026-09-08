/**
 * A stand-in for the Skill India (NSDC) admin API, for testing only.
 *
 * It speaks the same endpoints the real service does — CSRF token, public key,
 * login, candidate registration, batch creation, enrolment and assessment — including RSA-OAEP password encryption
 * and the "User Already Exist - CAN_…" duplicate response. Point the portal at
 * it and the entire upload path runs for real, except no candidate is created
 * anywhere outside this process.
 *
 *   node tools/mock-nsdc-server.js
 *   NSDC_BASE_URL=http://localhost:4000 NSDC_USERNAME=TP155158 NSDC_PASSWORD=test node server.js
 *
 * Any username/password is accepted, so no real credentials are needed.
 *
 * Open http://localhost:4000/_mock for a switch that takes the service down and
 * brings it back, so an outage can be rehearsed without stopping the process.
 */
import express from 'express';
import crypto from 'crypto';
import forge from 'node-forge';

const PORT = process.env.MOCK_PORT || 4000;

// One keypair for the process lifetime, exactly as the real service hands out
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Switched on to rehearse an NSDC outage without killing this process, so the
// portal can be watched reacting to one and recovering from it.
let serviceDown = false;

// Going down part way through a run is the case worth rehearsing, and clicking
// the switch fast enough is luck: a batch upload is one request per row, but an
// enrolment is one request per batch, so the whole run can be over in a second.
// This counts real requests down and takes the service out mid-run by itself.
let downAfter = null;

app.use((req, res, next) => {
    if (req.path.startsWith('/_mock')) return next();

    // Signing in costs three calls before a single student is sent — CSRF token,
    // public key, login — and counting those would spend the budget on the way
    // in and take the service down before the run started. Registration lives
    // under the same prefix, so the exemption is by exact path, not prefix.
    const HANDSHAKE = ['/api/user/v1', '/api/user/v1/getkey', '/api/user/v1/login'];

    if (!serviceDown && downAfter !== null && !HANDSHAKE.includes(req.path)) {
        // The budget is in students, and one enrolment or completion request
        // carries many, so those endpoints spend it themselves — see spend()
        const perStudentEndpoint =
            req.path === '/api/thirdparty/v1/enroll/Candidate' ||
            req.path === '/v1/candidates/candidate/pushBatchEachCandidate';

        if (!perStudentEndpoint) {
            if (downAfter <= 0) {
                serviceDown = true;
                downAfter = null;
                log('down: budget spent, service is now down mid-run');
            } else {
                downAfter--;
                log(`down after: ${downAfter} more student(s) will be served`);
            }
        }
    }

    if (!serviceDown) return next();
    log(`down: refused ${req.method} ${req.path}`);
    res.status(503).json({ message: 'Service Unavailable' });
});

/**
 * Spends the "go down after N students" budget for a request that carries many
 * students at once.
 *
 * An enrolment is one request per batch, so a budget counted in requests could
 * only ever refuse a whole batch. Counted in students, the batch is enrolled up
 * to the budget and the request then fails — which is what a real outage part
 * way through a batch looks like: NSDC has some of them, the portal was told
 * nothing succeeded.
 *
 * Returns how many of `count` may be served. Zero means the service has just
 * gone down and the request should be refused.
 */
function spend(count) {
    if (downAfter === null) return count;
    if (downAfter <= 0) {
        serviceDown = true;
        downAfter = null;
        log('down: budget spent, service is now down mid-run');
        return 0;
    }
    const served = Math.min(count, downAfter);
    downAfter -= served;
    log(`down after: served ${served}, ${downAfter} more student(s) to go`);
    return served;
}

// candidateId lookup keyed by email, so re-uploading a student behaves the way
// NSDC does: no second record, the existing ID comes back in an error message.
const candidatesByEmail = new Map();
let nextCandidateId = 41050000;
const registrations = [];

const issuedSecrets = new Set();

function log(...args) {
    console.log(new Date().toISOString().slice(11, 19), ...args);
}

app.head('/api/user/v1', (_req, res) => {
    const token = crypto.randomBytes(16).toString('hex');
    res.setHeader('X-Csrf-Token', token);
    res.status(200).end();
});

app.get('/api/user/v1/getkey', (req, res) => {
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }
    const secret = crypto.randomBytes(8).toString('hex');
    issuedSecrets.add(secret);
    res.json({ publicKey: publicKeyPem, secret });
});

app.post('/api/user/v1/login', (req, res) => {
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }

    const { userName, password } = req.body || {};
    if (!userName || !password) {
        return res.status(401).json({ message: 'Username and password are required' });
    }

    // The client appends the plain secret to the base64 ciphertext; splitting it
    // back off proves the portal encrypted the password the way NSDC expects.
    let decrypted = null;
    for (const secret of issuedSecrets) {
        if (!password.endsWith(secret)) continue;
        try {
            const ciphertext = forge.util.decode64(password.slice(0, -secret.length));
            decrypted = keypair.privateKey.decrypt(ciphertext, 'RSA-OAEP', { md: forge.md.sha256.create() });
        } catch {
            decrypted = null;
        }
        break;
    }

    if (decrypted === null) {
        return res.status(401).json({ message: 'Password could not be decrypted — encryption does not match' });
    }

    log(`login ok for ${userName} (password decrypted, ${decrypted.length} chars)`);
    res.json({ token: 'mock-auth-token-' + crypto.randomBytes(8).toString('hex') });
});

app.post('/api/user/v1/register/Candidate/v1', (req, res) => {
    if (!req.get('Authorization')) {
        return res.status(401).json({ message: 'Missing Authorization header' });
    }
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }

    const { personalDetails, contactDetails } = req.body || {};

    // The same fields the real service insists on
    const missing = [];
    if (!personalDetails?.firstName) missing.push('personalDetails.firstName');
    if (!personalDetails?.dob) missing.push('personalDetails.dob');
    if (!personalDetails?.gender) missing.push('personalDetails.gender');
    if (!contactDetails?.email) missing.push('contactDetails.email');

    if (missing.length > 0) {
        log(`rejected: missing ${missing.join(', ')}`);
        return res.status(400).json({ message: `Mandatory field(s) missing: ${missing.join(', ')}` });
    }

    const email = String(contactDetails.email).toLowerCase();

    if (candidatesByEmail.has(email)) {
        const existing = candidatesByEmail.get(email);
        log(`duplicate ${email} -> ${existing}`);
        return res.status(400).json({ message: `User Already Exist - ${existing}` });
    }

    const candidateId = 'CAN_' + nextCandidateId++;
    candidatesByEmail.set(email, candidateId);
    registrations.push({ candidateId, email, body: req.body });

    log(`created ${candidateId} for ${email}`);
    res.json({ candidateId, userName: candidateId, message: 'Candidate registered successfully' });
});

const batchesByName = new Map();
let nextBatchId = 3940000;
const createdBatches = [];

app.post('/api/batch/v1/create', (req, res) => {
    if (!req.get('Authorization')) {
        return res.status(401).json({ message: 'Missing Authorization header' });
    }
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }

    const body = req.body || {};
    const missing = [];
    for (const field of ['batchName', 'size', 'batchStartDate', 'batchEndDate', 'courseId', 'tpId', 'tcId']) {
        if (body[field] === undefined || body[field] === '' || body[field] === null) missing.push(field);
    }
    if (Number.isNaN(body.size)) missing.push('size (not a number)');
    if (typeof body.batchStartDate === 'string' && body.batchStartDate.includes('Invalid')) {
        missing.push('batchStartDate (invalid date)');
    }

    if (missing.length > 0) {
        log(`batch rejected: ${missing.join(', ')}`);
        return res.status(400).json({ message: `Mandatory field(s) missing or invalid: ${missing.join(', ')}` });
    }

    // NSDC suffixes a name that already exists rather than refusing it
    let batchName = body.batchName;
    if (batchesByName.has(batchName)) {
        let suffix = 2;
        while (batchesByName.has(`${body.batchName}(${suffix})`)) suffix++;
        batchName = `${body.batchName}(${suffix})`;
    }

    const batchId = nextBatchId++;
    batchesByName.set(batchName, batchId);
    createdBatches.push({ batchId, batchName, body });

    log(`created batch ${batchId} "${batchName}"`);
    res.json({ Message: 'Created', batchId, batchName, infoMsgForSTT: '' });
});

const enrolments = [];
const enrolledPairs = new Set();

app.post('/api/thirdparty/v1/enroll/Candidate', (req, res) => {
    if (!req.get('Authorization')) {
        return res.status(401).json({ message: 'Missing Authorization header' });
    }
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }

    const { batchId, candidateIds } = req.body || {};
    if (!batchId || !Array.isArray(candidateIds) || candidateIds.length === 0) {
        return res.status(400).json({ message: 'batchId and a non-empty candidateIds array are required' });
    }

    const fresh = candidateIds.filter(id => !enrolledPairs.has(`${id}|${batchId}`));

    if (fresh.length === 0) {
        log(`enrol batch ${batchId}: all ${candidateIds.length} already enrolled`);
        return res.status(409).send('Candidates already enrolled in this batch');
    }

    const allowed = spend(fresh.length);

    for (const id of fresh.slice(0, allowed)) {
        enrolledPairs.add(`${id}|${batchId}`);
        enrolments.push({ batchId, candidateId: id });
    }

    if (allowed < fresh.length) {
        // Part of the batch really is enrolled, and the caller is told the
        // request failed — the case the portal has to survive
        log(`enrol batch ${batchId}: ${allowed} of ${fresh.length} enrolled, then went down`);
        return res.status(503).json({ message: 'Service Unavailable' });
    }

    log(`enrol batch ${batchId}: ${fresh.length} candidate(s) enrolled`);
    res.json({ message: 'Candidates enrolled successfully', batchId, enrolled: fresh.length });
});

const completions = [];

app.post('/v1/candidates/candidate/pushBatchEachCandidate', (req, res) => {
    if (!req.get('Authorization')) {
        return res.status(401).json({ message: 'Missing Authorization header' });
    }
    if (!req.get('X-Csrf-Token')) {
        return res.status(412).json({ message: 'CSRF token missing' });
    }

    const { batchId, candidates } = req.body || {};
    if (!batchId || !Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({ message: 'batchId and a non-empty candidates array are required' });
    }

    for (const candidate of candidates) {
        if (!candidate.candidateID) {
            return res.status(400).json({ message: 'Each candidate needs a candidateID' });
        }
        if (!candidate.assessmentDetails || !candidate.certificationDetails) {
            return res.status(400).json({ message: `Missing assessment or certification details for ${candidate.candidateID}` });
        }
    }

    const allowed = spend(candidates.length);

    for (const candidate of candidates.slice(0, allowed)) {
        completions.push({ batchId, candidateId: candidate.candidateID, body: candidate });
    }

    if (allowed < candidates.length) {
        log(`batch ${batchId}: ${allowed} of ${candidates.length} results submitted, then went down`);
        return res.status(503).json({ message: 'Service Unavailable' });
    }

    log(`batch ${batchId}: results submitted for ${candidates.length} candidate(s)`);
    res.json({ message: 'Assessment data uploaded successfully', batchId, processed: candidates.length });
});

// Test helpers, not part of the real API
// A page with buttons rather than URLs to visit: a tab left open on
/**
 * The candidate list the portal reads batch membership from, in the shape the
 * real endpoint answers with: a `data` array of candidates, each carrying its
 * own `batches[]`, plus a `pagination.count`. Built from what this process has
 * been asked to register, enrol and complete, so a full run through the portal
 * produces a list that matches it.
 */
app.post('/v1/candidates/pmkvy/candidates/list', (req, res) => {
    const pageNo = Math.max(1, Number(req.query.pageNo) || 1);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
    const onlyInBatch = String(req.query.isEnrolledToBatch || '').toLowerCase() === 'yes';

    const candidates = registrations.map(registration => {
        const memberships = enrolments
            .filter(e => e.candidateId === registration.candidateId)
            .map(e => {
                const batch = createdBatches.find(b => String(b.batchId) === String(e.batchId));
                return {
                    batchId: Number(e.batchId),
                    // The real service leaves the name out here, so this does too
                    batchName: '',
                    batchStartDate: batch && batch.body && batch.body.batchStartDate || null,
                    batchEndDate: batch && batch.body && batch.body.batchEndDate || null,
                    isCertified: completions.some(c =>
                        c.candidateId === registration.candidateId &&
                        String(c.batchId) === String(e.batchId)) || null
                };
            });

        const personal = registration.body && registration.body.personalDetails || {};
        const contact = registration.body && registration.body.contactDetails || {};

        return {
            candidateId: registration.candidateId,
            userName: registration.candidateId,
            personalDetails: personal,
            contactDetails: contact,
            batches: memberships,
            isEnrolledToBatch: memberships.length > 0 ? 'Yes' : 'No'
        };
    }).filter(candidate => !onlyInBatch || candidate.batches.length > 0);

    const start = (pageNo - 1) * limit;
    log(`list page ${pageNo} (limit ${limit}${onlyInBatch ? ', in a batch only' : ''}) -> ${Math.max(0, Math.min(limit, candidates.length - start))} of ${candidates.length}`);

    res.json({
        data: candidates.slice(start, start + limit),
        pagination: { count: candidates.length, pageNo, limit }
    });
});

// /_mock/down would flip the service off again on every reload, which is
// exactly the confusion this is meant to rehearse, not cause.
app.get('/_mock', (_req, res) => {
    res.type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Mock NSDC</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 30rem; margin: 4rem auto; padding: 0 1rem; color: #111827; }
  h1 { font-size: 1.25rem; }
  .state { padding: 1rem; border-radius: 10px; font-weight: 600; margin: 1rem 0; }
  .up { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
  .down { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  button { padding: 0.6rem 1.25rem; border-radius: 8px; border: none; font-size: 0.9375rem;
    font-weight: 600; cursor: pointer; margin-right: 0.5rem; }
  .stop { background: #dc2626; color: #fff; }
  .start { background: #059669; color: #fff; }
  table { border-collapse: collapse; margin-top: 1.5rem; font-size: 0.875rem; }
  td { padding: 0.25rem 1.5rem 0.25rem 0; color: #4b5563; }
</style>
<h1>Mock NSDC</h1>
<div class="state \${serviceDown ? 'down' : 'up'}">
  \${serviceDown ? 'Down — every endpoint answers 503' : 'Up — answering normally'}
</div>
<form method="POST" action="/_mock/down" style="display:inline"><button class="stop">Take it down</button></form>
<form method="POST" action="/_mock/up" style="display:inline"><button class="start">Bring it back</button></form>
<form method="POST" action="/_mock/down-after" style="margin-top:1rem">
  <label>Go down by itself after
    <input type="number" name="requests" value="5" min="0" max="1000" style="width:5rem">
    more student(s)</label>
  <button class="stop">Arm it</button>
</form>
<p style="margin-top:0.5rem;font-size:0.8125rem;color:#6b7280">
  For a run that stops part way: arm it, then start the upload. The budget is
  counted in students, so arming with 5 lets 5 students through — a registration
  each, or the first 5 of a batch being enrolled — and then the service goes
  down. Signing in does not count against it.
  ${downAfter === null ? 'Not armed.' : `Armed — ${downAfter} more request(s) will be served.`}
</p>
<table>
  <tr><td>candidates registered</td><td>\${registrations.length}</td></tr>
  <tr><td>batches created</td><td>\${createdBatches.length}</td></tr>
  <tr><td>enrolments</td><td>\${enrolments.length}</td></tr>
  <tr><td>completions</td><td>\${completions.length}</td></tr>
</table>`);
});

app.post('/_mock/down', (_req, res) => {
    serviceDown = true;
    log('down: every NSDC endpoint now answers 503');
    res.redirect('/_mock');
});
app.post('/_mock/up', (_req, res) => {
    downAfter = null;
    serviceDown = false;
    log('up: answering normally again');
    res.redirect('/_mock');
});
app.post('/_mock/down-after', (req, res) => {
    const requests = Number(req.body && req.body.requests);
    downAfter = Number.isFinite(requests) && requests >= 0 ? Math.floor(requests) : 1;
    serviceDown = false;
    log(`armed: going down after ${downAfter} more request(s)`);
    res.redirect('/_mock');
});

app.get('/_mock/state', (_req, res) => res.json({
    downAfter,
    serviceDown,
    candidates: registrations.length,
    batches: createdBatches.length,
    enrolments: enrolments.length,
    completions: completions.length
}));

app.get('/_mock/registrations', (_req, res) => res.json(registrations));
app.get('/_mock/batches', (_req, res) => res.json(createdBatches));
app.get('/_mock/enrolments', (_req, res) => res.json(enrolments));
app.get('/_mock/completions', (_req, res) => res.json(completions));
app.all('/_mock/reset', (_req, res) => {
    candidatesByEmail.clear();
    registrations.length = 0;
    batchesByName.clear();
    createdBatches.length = 0;
    enrolledPairs.clear();
    enrolments.length = 0;
    completions.length = 0;
    res.json({ ok: true });
});

app.use((req, res) => {
    log(`unhandled ${req.method} ${req.path}`);
    res.status(404).json({ message: `Mock NSDC has no route for ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
    console.log(`Mock NSDC server listening on http://localhost:${PORT}`);
    console.log('Any username/password is accepted. Registrations are kept in memory only.');
});
