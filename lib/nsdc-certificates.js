import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import { promisify } from 'util';
import { isServiceDown } from './nsdc-status.js';
import { describeCall } from './nsdc-call.js';

const delay = promisify(setTimeout);

const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

const REQUEST_TIMEOUT_MS = 60000;

function createClient() {
    return fetchCookieModule(fetch, new CookieJar());
}

async function getCsrfToken(client) {
    const endpoint = USER_SERVICE_URL + '/api/user/v1';
    const response = await client(endpoint, { method: 'HEAD' });
    if (!response.ok) {
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method: 'HEAD', status: response.status });
        throw error;
    }
    const csrfToken = response.headers.get('X-Csrf-Token');
    if (!csrfToken) {
        throw new Error('CSRF token not found in response headers');
    }
    return csrfToken;
}

async function getPublicKey(client, csrfToken) {
    const endpoint = USER_SERVICE_URL + '/api/user/v1/getkey';
    const response = await client(endpoint, {
        headers: { 'X-Csrf-Token': csrfToken }
    });
    if (!response.ok) {
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method: 'GET', status: response.status });
        throw error;
    }
    return response.json();
}

async function authenticate(client, userName, password) {
    const csrfToken = await getCsrfToken(client);
    const { publicKey, secret } = await getPublicKey(client, csrfToken);
    const encrypted = forge.pki.publicKeyFromPem(publicKey)
        .encrypt(password, 'RSA-OAEP', { md: forge.md.sha256.create() });
    const encryptedPassword = forge.util.encode64(encrypted) + secret;

    const response = await client(USER_SERVICE_URL + '/api/user/v1/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken
        },
        body: JSON.stringify({ userName, password: encryptedPassword })
    });

    if (!response.ok) {
        const error = new Error(`Authentication failed: ${response.status} ${response.statusText}`);
        error.httpStatus = response.status;
        error.call = describeCall({
            endpoint: USER_SERVICE_URL + '/api/user/v1/login',
            status: response.status,
            responseBody: response.statusText
        });
        throw error;
    }

    const body = await response.json();
    return { csrfToken, authToken: body.token };
}

/**
 * The body the certificate call takes: nothing.
 *
 * NSDC issues certificates a training partner at a time, not a batch or a
 * candidate at a time — `for=trainingPartner` in the URL is the whole of the
 * instruction, and which partner is read from the account the call is signed in
 * as. There is no list to send and nothing to choose.
 *
 * Exported so the page can show what would be sent, which is the point: an
 * empty body is worth seeing before pressing a button that acts on everybody.
 */
export function buildCertificatePayload() {
    return {};
}

/**
 * Asks NSDC to issue certificates for this training partner.
 *
 * One request, for everyone NSDC considers eligible. It answers for the partner
 * as a whole, so what comes back is kept as it arrives rather than read for
 * per-candidate detail — who actually ended up with a certificate is read back
 * from NSDC afterwards, where it is recorded against each candidate.
 *
 * Candidates who already have one are left alone by NSDC, so running this again
 * costs a request and changes nothing.
 */
export async function generateCertificates({ userName, password }) {
    const client = createClient();
    const { csrfToken, authToken } = await authenticate(client, userName, password);

    const endpoint = USER_SERVICE_URL + '/api/v1/cert/certificate?for=trainingPartner';
    const payload = buildCertificatePayload();

    let attempt = 0;
    while (true) {
        attempt++;
        try {
            const response = await client(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Csrf-Token': csrfToken,
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(payload),
                timeout: REQUEST_TIMEOUT_MS
            });

            const raw = await response.text();

            if (!response.ok) {
                const error = new Error(`Certificate generation failed: ${response.status} ${raw.slice(0, 300)}`);
                error.httpStatus = response.status;
                error.call = describeCall({ endpoint, payload, status: response.status, responseBody: raw });
                throw error;
            }

            let body = null;
            try { body = JSON.parse(raw); } catch { /* not every service answers JSON */ }
            return { response: body, raw: raw.slice(0, 2000) };
        } catch (err) {
            const retryable = err.httpStatus === 429 || err.httpStatus >= 500 || /timeout/i.test(err.message);
            if (retryable && attempt <= 3) {
                await delay(Math.min(1000 * 2 ** attempt, 30000));
                continue;
            }
            if (isServiceDown(err)) err.serviceDown = true;
            throw err;
        }
    }
}
