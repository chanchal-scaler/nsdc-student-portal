/**
 * Sends ONE candidate payload to NSDC and prints the raw response.
 *
 * Meant for whoever holds the NSDC credentials to confirm, on the real service,
 * that a payload the portal produced is accepted and returns a candidateId.
 * It reads the payload from a file rather than building one, so exactly what
 * was reviewed is what gets sent.
 *
 *   NSDC_USERNAME=TP155158 NSDC_PASSWORD='...' node tools/send-one-payload.js payload.json
 *
 * The file may hold a single payload object, or the array the portal's
 * "Preview payload only" button downloads — in that case pass the row number:
 *
 *   NSDC_USERNAME=... NSDC_PASSWORD=... node tools/send-one-payload.js payloads.json 2
 *
 * Point it at the mock server first if you want to see it work without
 * creating anybody:  NSDC_BASE_URL=http://localhost:4000 node tools/...
 */
import fs from 'fs';
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';

const BASE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';
const USERNAME = process.env.NSDC_USERNAME;
const PASSWORD = process.env.NSDC_PASSWORD;

const [, , file, rowArg] = process.argv;

if (!file) {
    console.error('Usage: NSDC_USERNAME=... NSDC_PASSWORD=... node tools/send-one-payload.js <payload.json> [row]');
    process.exit(1);
}
if (!USERNAME || !PASSWORD) {
    console.error('Set NSDC_USERNAME and NSDC_PASSWORD in the environment.');
    process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

let payload;
if (Array.isArray(parsed)) {
    const entry = rowArg
        ? parsed.find(p => String(p.row) === String(rowArg))
        : parsed[0];
    if (!entry) {
        console.error(`No entry with row ${rowArg} in ${file}. Rows present: ${parsed.map(p => p.row).join(', ')}`);
        process.exit(1);
    }
    payload = entry.body || entry;
    console.log(`Using row ${entry.row} of ${parsed.length} from ${file}`);
} else {
    payload = parsed.body || parsed;
}

console.log(`\nTarget:  ${BASE_URL}`);
console.log(`Payload:\n${JSON.stringify(payload, null, 2)}\n`);

const client = fetchCookieModule(fetch, new CookieJar());

async function main() {
    const csrfResponse = await client(BASE_URL + '/api/user/v1', { method: 'HEAD' });
    const csrfToken = csrfResponse.headers.get('X-Csrf-Token');
    if (!csrfToken) throw new Error('No X-Csrf-Token in response headers');
    console.log('1/3  CSRF token obtained');

    const keyResponse = await client(BASE_URL + '/api/user/v1/getkey', {
        headers: { 'X-Csrf-Token': csrfToken }
    });
    const { publicKey, secret } = await keyResponse.json();
    const encrypted = forge.pki.publicKeyFromPem(publicKey)
        .encrypt(PASSWORD, 'RSA-OAEP', { md: forge.md.sha256.create() });
    const encryptedPassword = forge.util.encode64(encrypted) + secret;
    console.log('2/3  Password encrypted with the service public key');

    const loginResponse = await client(BASE_URL + '/api/user/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': csrfToken },
        body: JSON.stringify({ userName: USERNAME, password: encryptedPassword })
    });
    if (!loginResponse.ok) {
        throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
    }
    const { token } = await loginResponse.json();
    console.log('3/3  Logged in\n');

    const response = await client(BASE_URL + '/api/user/v1/register/Candidate/v1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken,
            'Authorization': token
        },
        body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log(`HTTP ${response.status}`);
    console.log(text);

    const candidateId = text.match(/CAN_\d+/);
    if (candidateId) {
        const already = /already exist/i.test(text);
        console.log(`\ncandidateId: ${candidateId[0]}  (${already ? 'ALREADY REGISTERED' : 'NEWLY CREATED'})`);
    } else {
        console.log('\nNo candidateId in the response.');
    }
}

main().catch(err => {
    console.error('\nFailed:', err.message);
    process.exit(1);
});
