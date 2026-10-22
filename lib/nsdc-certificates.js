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
 * The body the certificate call takes: one candidate in one batch. `userName`
 * is the candidate ID — NSDC issues the two as the same CAN_ string.
 *
 * Exported so the page can show what would be sent, which is the point: the
 * body is worth seeing before pressing the button that sends it.
 */
export function buildCertificatePayload(candidateId, batchId) {
    return { userName: candidateId, batchId };
}

/**
 * Asks NSDC to issue a certificate per student, one call at a time.
 *
 * Candidates who already have one are left alone by NSDC, so running this again
 * costs a request per student and changes nothing.
 */
export async function generateCertificates({ userName, password, students, onProgress, onResult }) {
    const client = createClient();
    let { csrfToken, authToken } = await authenticate(client, userName, password);

    const endpoint = USER_SERVICE_URL + '/api/v1/cert/certificate?for=trainingPartner';

    const results = [];
    let generated = 0;
    let failed = 0;

    for (const student of students) {
        const payload = buildCertificatePayload(student.candidateId, student.batchId);
        let attempt = 0;
        let settled = false;

        while (!settled) {
            try {
                const response = await client(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Csrf-Token': csrfToken,
                        'Authorization': authToken
                    },
                    body: JSON.stringify(payload),
                    timeout: REQUEST_TIMEOUT_MS
                });

                const raw = await response.text();

                if (!response.ok) {
                    const error = new Error(raw.slice(0, 300) || `HTTP ${response.status}`);
                    error.httpStatus = response.status;
                    error.call = describeCall({ endpoint, payload, status: response.status, responseBody: raw });
                    throw error;
                }

                const row = { ...student, status: 'GENERATED', error: '', response: raw.slice(0, 300) };
                results.push(row);
                generated++;
                settled = true;
                if (onResult) await onResult(row);
            } catch (err) {
                attempt++;

                // 412 means the CSRF token or session expired mid-run:
                // re-authenticate once and retry the same student.
                if (err.httpStatus === 412 && attempt === 1) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        const row = { ...student, status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}`, call: reAuthError.call || describeCall({ endpoint: USER_SERVICE_URL + '/api/user/v1/login', responseBody: reAuthError.message }), attempts: attempt };
                        results.push(row);
                        failed++;
                        settled = true;
                        if (onResult) await onResult(row);
                        break;
                    }
                }

                const retryable = err.httpStatus === 429 || err.httpStatus >= 500 || /timeout/i.test(err.message);
                if (retryable && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                // A service that is down will fail every remaining student the
                // same way; stop and say so rather than burning the list.
                if (isServiceDown(err)) {
                    err.serviceDown = true;
                    throw err;
                }

                const row = { ...student, status: 'FAILED', error: err.message, call: err.call || null, attempts: attempt };
                results.push(row);
                failed++;
                settled = true;
                if (onResult) await onResult(row);
            }
        }

        if (onProgress) {
            onProgress({ processed: results.length, total: students.length, generated, failed });
        }

        await delay(100); // same pacing the other upload flows use
    }

    return { results, generated, failed };
}
