/**
 * A stand-in for the Skill India (NSDC) admin API, for testing only.
 *
 * It speaks the same endpoints the real service does — CSRF token, public key,
 * login, candidate registration, batch creation and enrolment — including RSA-OAEP password encryption
 * and the "User Already Exist - CAN_…" duplicate response. Point the portal at
 * it and the entire upload path runs for real, except no candidate is created
 * anywhere outside this process.
 *
 *   node tools/mock-nsdc-server.js
 *   NSDC_BASE_URL=http://localhost:4000 NSDC_USERNAME=TP155158 NSDC_PASSWORD=test node server.js
 *
 * Any username/password is accepted, so no real credentials are needed.
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

    for (const id of fresh) {
        enrolledPairs.add(`${id}|${batchId}`);
        enrolments.push({ batchId, candidateId: id });
    }

    log(`enrol batch ${batchId}: ${fresh.length} candidate(s) enrolled`);
    res.json({ message: 'Candidates enrolled successfully', batchId, enrolled: fresh.length });
});

// Test helpers, not part of the real API
app.get('/_mock/registrations', (_req, res) => res.json(registrations));
app.get('/_mock/batches', (_req, res) => res.json(createdBatches));
app.get('/_mock/enrolments', (_req, res) => res.json(enrolments));
app.post('/_mock/reset', (_req, res) => {
    candidatesByEmail.clear();
    registrations.length = 0;
    batchesByName.clear();
    createdBatches.length = 0;
    enrolledPairs.clear();
    enrolments.length = 0;
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
