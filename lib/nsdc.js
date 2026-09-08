import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import forge from 'node-forge';
import fetchCookieModule from 'fetch-cookie';
import fs from 'fs';
import { promisify } from 'util';

const delay = promisify(setTimeout);
const writeFile = promisify(fs.writeFile);
const appendFile = promisify(fs.appendFile);

// Points at NSDC itself unless overridden — set NSDC_BASE_URL to the mock in
// tools/mock-nsdc-server.js to exercise the fetch without touching NSDC
const USER_SERVICE_URL = process.env.NSDC_BASE_URL || 'https://adminservices.skillindiadigital.gov.in';

function createClient() {
    return fetchCookieModule(fetch, new CookieJar());
}

async function getPublicKey(client, csrfToken) {
    const response = await client(USER_SERVICE_URL + '/api/user/v1/getkey', {
        headers: { 'X-Csrf-Token': csrfToken }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function encryptPassword(publicKeyPem, password, secret) {
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
    const encryptedPassword = publicKey.encrypt(password, 'RSA-OAEP', {
        md: forge.md.sha256.create(),
    });
    return forge.util.encode64(encryptedPassword) + secret;
}

async function getEncryptedPassword(client, password, csrfToken) {
    const { publicKey, secret } = await getPublicKey(client, csrfToken);
    return encryptPassword(publicKey, password, secret);
}

async function getCsrfToken(client) {
    const response = await client(USER_SERVICE_URL + '/api/user/v1', { method: 'HEAD' });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const csrfToken = response.headers.get('X-Csrf-Token');
    if (!csrfToken) {
        throw new Error('CSRF token not found in response headers');
    }
    return csrfToken;
}

async function authenticateAndGetToken(client, username, encryptedPassword, csrfToken) {
    const response = await client(USER_SERVICE_URL + '/api/user/v1/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': csrfToken
        },
        body: JSON.stringify({ userName: username, password: encryptedPassword })
    });
    if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.json();
    return body.token;
}

async function authenticate(client, username, password) {
    const csrfToken = await getCsrfToken(client);
    const encryptedPassword = await getEncryptedPassword(client, password, csrfToken);
    const authToken = await authenticateAndGetToken(client, username, encryptedPassword, csrfToken);
    return { csrfToken, authToken };
}

async function fetchStudentPage(client, pageNo, csrfToken, authToken, tpId, filters = {}) {
    const apiUrl = `${USER_SERVICE_URL}/v1/candidates/pmkvy/candidates/list`;

    const params = new URLSearchParams({
        pageNo: pageNo.toString(),
        limit: String(filters.limit || 500),
        state: 'undefined',
        district: 'undefined',
        srcofregister: 'undefined',
        candidateId: 'undefined',
        locationSpoc: 'undefined',
        regType: 'undefined',
        tpId: tpId,
        startDate: 'undefined',
        // The list has no batch filter, so the one filter worth setting is
        // whether the candidate is in a batch at all: reading batch membership
        // means skipping everyone who is in none
        isEnrolledToBatch: filters.isEnrolledToBatch || 'undefined',
        sortBy: 'candidateId',
        sortOrder: '1',
        keyword: filters.keyword || ''
    });

    const response = await client(`${apiUrl}?${params}`, {
        method: 'POST',
        headers: {
            'Authorization': authToken,
            'X-Csrf-Token': csrfToken,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({
            "createdBy": [tpId],
            "tpId": tpId
        })
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function convertToCSV(students, includeHeaders = true) {
    if (!students || students.length === 0) {
        return '';
    }

    const headers = Object.keys(students[0]);

    const csvRows = students.map(student => {
        return headers.map(header => {
            let value = student[header];
            if (value === null || value === undefined) {
                value = '';
            } else if (typeof value === 'object') {
                value = JSON.stringify(value);
            }
            value = value.toString().replace(/"/g, '""');
            return `"${value}"`;
        }).join(',');
    });

    if (includeHeaders) {
        return [headers.join(','), ...csvRows].join('\n');
    }
    return csvRows.join('\n');
}

async function appendToCSV(students, filename, isFirstPage) {
    const csvContent = convertToCSV(students, isFirstPage);
    if (isFirstPage) {
        await writeFile(filename, csvContent + '\n', 'utf8');
    } else {
        await appendFile(filename, csvContent + '\n', 'utf8');
    }
}

/**
 * Reads what NSDC holds for the batches given, batch by batch.
 *
 * The list endpoint has no batch filter — batchName comes back empty too — so
 * the batches have to be read out of each candidate's own `batches[]` and kept
 * only where the ID is one we asked about. `isEnrolledToBatch=Yes` narrows the
 * paging to candidates who are in a batch at all, which is the only filter the
 * endpoint offers that helps here.
 *
 * Returns { byBatch, candidatesSeen, pagesFetched, failedPages } where byBatch
 * maps a batch ID to the candidates NSDC has in it. Pages are reported through
 * onProgress as they land, so a long read can be watched.
 */
export async function fetchCandidatesForBatches({ userName, password, tpId, batchIds, onProgress }) {
    const client = createClient();
    const wanted = new Set((batchIds || []).map(Number));
    const byBatch = new Map();

    let { csrfToken, authToken } = await authenticate(client, userName, password);

    let pageNo = 1;
    let maxPages = 200;
    let totalPages = null;
    let candidatesSeen = 0;
    const failedPages = [];
    const MAX_RETRIES = 3;

    const report = () => {
        if (onProgress) {
            onProgress({
                pagesFetched: pageNo - 1,
                totalPages,
                candidatesSeen,
                matched: [...byBatch.values()].reduce((n, list) => n + list.length, 0),
                failedPages: [...failedPages]
            });
        }
    };

    while (pageNo <= maxPages) {
        let retries = 0;
        let page = null;

        while (retries < MAX_RETRIES && page === null) {
            try {
                page = await fetchStudentPage(client, pageNo, csrfToken, authToken, tpId,
                    { isEnrolledToBatch: 'Yes' });
            } catch (err) {
                retries++;
                // A CSRF token expires part way through a long read; the page is
                // worth retrying once the token is replaced
                if (err.message.includes('412')) {
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch {
                        break;
                    }
                }
                if (err.message.includes('429')) {
                    await delay(Math.min(1000 * 2 ** retries, 30000));
                    continue;
                }
                if (retries >= MAX_RETRIES) {
                    // Out of retries on this page: remember it, so the caller can
                    // say the read was incomplete rather than treat gaps as truth
                    failedPages.push(pageNo);
                    if (isNsdcUnreachable(err)) {
                        err.serviceDown = true;
                        err.partial = { byBatch, candidatesSeen, pagesFetched: pageNo - 1, failedPages };
                        throw err;
                    }
                    break;
                }
                await delay(1000);
            }
        }

        if (!page || !page.data || page.data.length === 0) break;

        if (pageNo === 1) {
            const count = page.pagination?.count || 0;
            totalPages = Math.ceil(count / 500) || 1;
            maxPages = Math.min(totalPages, 200);
        }

        for (const candidate of page.data) {
            candidatesSeen++;
            for (const membership of candidate.batches || []) {
                const batchId = Number(membership.batchId);
                if (!batchId) continue;
                if (wanted.size > 0 && !wanted.has(batchId)) continue;

                if (!byBatch.has(batchId)) byBatch.set(batchId, []);
                byBatch.get(batchId).push({
                    candidateId: candidate.candidateId,
                    name: [candidate.personalDetails?.firstName, candidate.personalDetails?.lastName]
                        .filter(Boolean).join(' ') || null,
                    email: candidate.contactDetails?.email || null,
                    // NSDC records completion on the membership, not the candidate
                    isCertified: membership.isCertified === true,
                    batchName: membership.batchName || null,
                    enrolledAt: membership.batchStartDate || null
                });
            }
        }

        pageNo++;
        report();

        // The same pacing the CSV download uses: NSDC rate-limits a fast reader
        await delay(500 + Math.floor(pageNo / 10) * 100);
    }

    report();
    return {
        byBatch,
        candidatesSeen,
        pagesFetched: pageNo - 1,
        failedPages
    };
}

/** Whether a failure means NSDC itself could not be reached. */
function isNsdcUnreachable(err) {
    const text = String(err && err.message || '');
    return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network|502|503|504/i.test(text);
}

/**
 * Fetches all student pages and writes them incrementally to outputFile.
 * Calls onProgress({ pagesFetched, totalPages, totalStudents, failedPages }) as it goes.
 * Returns { totalStudents, failedPages }.
 */
export async function fetchAndWriteStudents({ userName, password, tpId, outputFile, onProgress }) {
    const client = createClient();

    let pageNo = 1;
    let maxPages = 1000;
    let hasMoreData = true;
    let totalStudents = 0;
    let totalPages = null;
    let isFirstPage = true;
    let failedPages = [];
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    const MAX_RETRIES = 3;

    let { csrfToken, authToken } = await authenticate(client, userName, password);

    const report = () => {
        if (onProgress) {
            onProgress({ pagesFetched: pageNo - 1, totalPages, totalStudents, failedPages: [...failedPages] });
        }
    };

    while (hasMoreData && pageNo <= maxPages) {
        let retryCount = 0;
        let pageSuccess = false;

        while (retryCount < MAX_RETRIES && !pageSuccess) {
            try {
                const pageData = await fetchStudentPage(client, pageNo, csrfToken, authToken, tpId);

                if (pageData && pageData.data && pageData.data.length > 0) {
                    if (pageNo === 1) {
                        const totalCount = pageData.pagination?.count || 0;
                        totalPages = Math.ceil(totalCount / 500);
                        if (totalPages > 0) maxPages = Math.min(totalPages, 200);
                    }

                    await appendToCSV(pageData.data, outputFile, isFirstPage);
                    isFirstPage = false;

                    totalStudents += pageData.data.length;
                    pageSuccess = true;
                    consecutiveFailures = 0;
                    pageNo++;
                    report();
                } else {
                    hasMoreData = false;
                    pageSuccess = true;
                }

                // Delay between requests to avoid rate limiting, growing slightly over time
                const baseDelay = 500;
                const additionalDelay = Math.floor(pageNo / 10) * 100;
                await delay(baseDelay + additionalDelay);

            } catch (error) {
                retryCount++;
                consecutiveFailures++;
                console.error(`Failed to fetch page ${pageNo} (Attempt ${retryCount}/${MAX_RETRIES}):`, error.message);

                if (error.message.includes('412')) {
                    // CSRF/auth expired — re-authenticate and retry the same page
                    try {
                        ({ csrfToken, authToken } = await authenticate(client, userName, password));
                        await delay(2000);
                        continue;
                    } catch (reAuthError) {
                        console.error('Re-authentication failed:', reAuthError.message);
                        failedPages.push(pageNo);
                        break;
                    }
                } else if (error.message.includes('429') || error.message.includes('rate limit')) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
                    await delay(backoffDelay);
                } else if (retryCount < MAX_RETRIES) {
                    await delay(1000 * Math.pow(2, retryCount));
                } else {
                    failedPages.push(pageNo);
                    console.error(`Max retries exceeded for page ${pageNo}. Moving to next page.`);
                }

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.error(`Too many consecutive failures (${consecutiveFailures}). Stopping.`);
                    hasMoreData = false;
                    break;
                }
            }
        }

        if (!pageSuccess && retryCount >= MAX_RETRIES) {
            pageNo++;
            report();
        }
    }

    report();
    return { totalStudents, failedPages };
}
