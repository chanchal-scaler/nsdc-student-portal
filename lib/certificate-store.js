import fs from 'fs';
import path from 'path';

const KIND_LINK = 'link';
const KIND_LOCAL = 'local';

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
    async put() {
        throw new Error('CERT_STORE=s3 is not implemented yet — no bucket has been set up');
    }

    async open() {
        throw new Error('CERT_STORE=s3 is not implemented yet — no bucket has been set up');
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

export { KIND_LINK, KIND_LOCAL };
