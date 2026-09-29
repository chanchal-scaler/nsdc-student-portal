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
                    'Authorization': authToken
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

/**
 * How NSDC answers a download request, learnt once and reused.
 *
 * The documentation leaves the method blank for this endpoint and says nothing
 * about what comes back, and the Postman collection it points at for both has
 * never reached us. Rather than wait on an answer, the first request finds out:
 * GET is tried, POST only if GET is refused as the wrong method, and whatever
 * comes back is read by its content type. What that first request learns is
 * kept, so a run of five hundred does not repeat the discovery five hundred
 * times.
 */
let downloadMethod = null;

/**
 * One candidate's certificate. Three response shapes are handled because the
 * doc names none: the file, the file base64-encoded in JSON, or a link to it.
 */
async function fetchCertificate(client, batchId, candidateId, csrfToken, authToken) {
    const endpoint = `${USER_SERVICE_URL}/api/v1/cert/uc/singledocdownload` +
        `?batchId=${encodeURIComponent(batchId)}` +
        `&candidateId=${encodeURIComponent(candidateId)}` +
        `&type=externalcertificate`;

    const headers = {
        'X-Csrf-Token': csrfToken,
        'Authorization': authToken
    };

    const send = method => client(endpoint, { method, headers, timeout: REQUEST_TIMEOUT_MS });

    let method = downloadMethod || 'GET';
    let response = await send(method);

    // 405 means wrong method; the other one is all it could be.
    if (response.status === 405 && !downloadMethod) {
        method = method === 'GET' ? 'POST' : 'GET';
        response = await send(method);
    }

    if (!response.ok) {
        const body = await response.text();
        const error = new Error(`Certificate download failed: ${response.status} ${body.slice(0, 200)}`);
        error.httpStatus = response.status;
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: body });
        throw error;
    }

    downloadMethod = method;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('json')) {
        const body = await response.json();
        const encoded = body.data || body.file || body.document || body.base64 || body.content;
        if (typeof encoded === 'string' && encoded.length > 0) {
            return { buffer: Buffer.from(encoded.replace(/^data:.*?;base64,/, ''), 'base64') };
        }
        const url = body.url || body.link || body.downloadUrl || body.fileUrl;
        if (typeof url === 'string' && url.length > 0) {
            const file = await client(url, { timeout: REQUEST_TIMEOUT_MS });
            if (!file.ok) {
                const error = new Error(`Certificate link returned ${file.status}`);
                error.httpStatus = file.status;
                error.call = describeCall({ endpoint: url, method: 'GET', status: file.status });
                throw error;
            }
            return { buffer: Buffer.from(await file.arrayBuffer()) };
        }
        const error = new Error('NSDC answered with JSON carrying neither a file nor a link: ' +
            JSON.stringify(body).slice(0, 200));
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: JSON.stringify(body) });
        throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // A service that answers an error as 200 with an HTML page is a real thing,
    // and an HTML page saved as a PDF is worse than a failure: nobody finds out
    // until they open it.
    if (buffer.length === 0) {
        const error = new Error('NSDC returned an empty certificate');
        error.call = describeCall({ endpoint, method, status: response.status });
        throw error;
    }
    if (buffer.subarray(0, 4).toString() !== '%PDF' && /html/.test(contentType)) {
        const error = new Error('NSDC returned a web page rather than a certificate');
        error.call = describeCall({ endpoint, method, status: response.status, responseBody: buffer.subarray(0, 300).toString() });
        throw error;
    }

    return { buffer };
}

/**
 * Fetches a certificate per student, reporting each as it lands.
 *
 * One call per candidate is what the endpoint takes, so a large partner is a
 * long run: it is built to be stopped and resumed like the others, and every
 * certificate already in hand is kept when it stops.
 */
export async function downloadCertificates({ userName, password, students, onProgress, onResult }) {
    const client = createClient();
    let { csrfToken, authToken } = await authenticate(client, userName, password);

    let downloaded = 0;
    let failed = 0;

    for (const student of students) {
        let attempt = 0;
        let settled = false;

        while (!settled) {
            try {
                const { buffer } = await fetchCertificate(client, student.batchId, student.candidateId, csrfToken, authToken);
                downloaded++;
                settled = true;
                if (onResult) await onResult({ ...student, status: 'DOWNLOADED', error: '', buffer });
            } catch (err) {
                attempt++;

                if (err.httpStatus === 412 && attempt === 1) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        failed++;
                        settled = true;
                        if (onResult) await onResult({ ...student, status: 'FAILED', error: `Re-authentication failed: ${reAuthError.message}`, call: reAuthError.call || null, attempts: attempt });
                        break;
                    }
                }

                const retryable = err.httpStatus === 429 || err.httpStatus >= 500 || /timeout/i.test(err.message);
                if (retryable && attempt <= 3) {
                    await delay(Math.min(1000 * 2 ** attempt, 30000));
                    continue;
                }

                if (isServiceDown(err)) {
                    err.serviceDown = true;
                    throw err;
                }

                failed++;
                settled = true;
                if (onResult) await onResult({ ...student, status: 'FAILED', error: err.message, call: err.call || null, attempts: attempt });
            }
        }

        if (onProgress) onProgress({ processed: downloaded + failed, total: students.length, downloaded, failed });

        // The same pacing the candidate read uses: NSDC rate-limits a fast reader
        await delay(200);
    }

    return { downloaded, failed };
}
