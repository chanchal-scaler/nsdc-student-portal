import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const KIND_LINK = 'link';
const KIND_LOCAL = 'local';
const KIND_S3 = 's3';

const backend = (process.env.CERT_STORE || 'local').toLowerCase();

export function storageKey(candidateId, batchId) {
    return `${batchId}/${candidateId}.pdf`;
}

export class LocalStore {
    constructor(root) {
        this.root = root;
    }

    async put(key, buffer) {
        const full = path.join(this.root, key);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buffer);
        return { kind: KIND_LOCAL, ref: key };
    }

    async open(ref) {
        const full = path.join(this.root, ref);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full);
    }
}

export class S3Store {
    constructor() {
        this.bucket = process.env.S3_BUCKET;
        if (!this.bucket) {
            throw new Error('CERT_STORE=s3 needs S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set');
        }
        this.client = new S3Client(
            process.env.S3_ENDPOINT
                ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
                : {}
        );
    }

    async put(key, buffer) {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: 'application/pdf'
        }));
        return { kind: KIND_S3, ref: key };
    }

    async open(ref) {
        let response;
        try {
            response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref }));
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
            throw err;
        }
        return Buffer.from(await response.Body.transformToByteArray());
    }

    async presignedUrl(ref, expiresIn = 15 * 60) {
        return getSignedUrl(this.client,
            new GetObjectCommand({ Bucket: this.bucket, Key: ref }), { expiresIn });
    }
}

export function createStore(localRoot) {
    if (backend === 's3') return new S3Store();
    return new LocalStore(localRoot);
}

export const storeKind = backend;

export async function keep(store, { candidateId, batchId, buffer, link }) {
    if (link) return { kind: KIND_LINK, ref: link };
    if (!buffer) throw new Error('nothing to keep: neither a file nor a link');
    return store.put(storageKey(candidateId, batchId), buffer);
}

export async function read(store, { storageKind, storageRef }) {
    if (!storageRef) return { buffer: null, link: null };
    if (storageKind === KIND_LINK) return { buffer: null, link: storageRef };
    return { buffer: await store.open(storageRef), link: null };
}

export { KIND_LINK, KIND_LOCAL, KIND_S3 };
