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

async function readCertificate(client, csrfToken, authToken, candidateId, batchId) {
    const endpoint = `${USER_SERVICE_URL}/api/v1/cert/uc/singledocdownload` +
        `?batchId=${encodeURIComponent(batchId)}` +
        `&candidateId=${encodeURIComponent(candidateId)}` +
        `&type=externalcertificate`;

    const headers = { 'X-Csrf-Token': csrfToken, 'Authorization': authToken };

    let method = 'GET';
    let response = await client(endpoint, { method, headers, timeout: REQUEST_TIMEOUT_MS });

    if (response.status === 405) {
        method = 'POST';
        response = await client(endpoint, { method, headers, timeout: REQUEST_TIMEOUT_MS });
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (!response.ok) {
        const raw = await response.text();
        const error = new Error(`Certificate download failed: ${response.status} ${raw.slice(0, 200)}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: raw });
        throw error;
    }

    if (contentType.includes('json')) {
        const body = await response.json();
        const link = body.url || body.link || body.downloadUrl || body.fileUrl;
        if (typeof link === 'string' && link.length > 0) {
            return { format: 'link', method, contentType, link };
        }
        const encoded = body.data || body.file || body.document || body.base64 || body.content;
        if (typeof encoded === 'string' && encoded.length > 0) {
            return {
                format: 'base64 file in JSON', method, contentType,
                buffer: Buffer.from(encoded.replace(/^data:.*?;base64,/, ''), 'base64')
            };
        }
        const error = new Error('NSDC answered with JSON carrying neither a file nor a link: ' +
            JSON.stringify(body).slice(0, 200));
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: JSON.stringify(body) });
        throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const start = buffer.subarray(0, 24).toString('latin1');

    if (buffer.length === 0) {
        const error = new Error('NSDC returned an empty certificate');
        error.call = describeCall({ endpoint, method, status: response.status });
        throw error;
    }
    if (!start.startsWith('%PDF') && /html/.test(contentType)) {
        const error = new Error('NSDC returned a web page rather than a certificate');
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: buffer.subarray(0, 300).toString() });
        throw error;
    }

    return { format: start.startsWith('%PDF') ? 'pdf' : 'file', method, contentType, buffer };
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

                let download;
                try {
                    download = await readCertificate(client, csrfToken, authToken, student.candidateId, student.batchId);
                } catch (downloadErr) {
                    download = { error: downloadErr.message, call: downloadErr.call || null };
                }

                const row = { ...student, status: 'GENERATED', error: '', response: raw.slice(0, 300), download };
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
