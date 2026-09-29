/**
 * A zip file, written one entry at a time.
 *
 * Entries are stored, not deflated — PDFs are already compressed. That keeps
 * this to the format's own bookkeeping, which is why it is here rather than a
 * dependency that would bring a couple of hundred packages with it.
 */
import { promisify } from 'util';

// The standard CRC-32 (IEEE 802.3), which the zip format requires per entry
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

/** Zip's MS-DOS date fields: two-second units, years from 1980. Clamped, not thrown on. */
function dosDateTime(date) {
    const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

export class ZipWriter {
    constructor(stream) {
        this.stream = stream;
        this.write = promisify(stream.write.bind(stream));
        this.entries = [];
        this.offset = 0;
    }

    async #push(buffer) {
        await this.write(buffer);
        this.offset += buffer.length;
    }

    /** Adds one file. Names are UTF-8, which the flag below declares. */
    async add(name, contents) {
        const nameBytes = Buffer.from(name, 'utf8');
        const crc = crc32(contents);
        const { time, day } = dosDateTime(new Date());
        const start = this.offset;

        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);   // local file header
        header.writeUInt16LE(20, 4);           // version needed
        header.writeUInt16LE(0x0800, 6);       // UTF-8 names
        header.writeUInt16LE(0, 8);            // stored, not deflated
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(day, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(contents.length, 18);
        header.writeUInt32LE(contents.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        header.writeUInt16LE(0, 28);           // no extra field

        await this.#push(header);
        await this.#push(nameBytes);
        await this.#push(contents);

        this.entries.push({ nameBytes, crc, size: contents.length, start, time, day });
    }

    /** Writes the central directory. The file is not readable until this runs. */
    async finish() {
        const start = this.offset;

        for (const entry of this.entries) {
            const record = Buffer.alloc(46);
            record.writeUInt32LE(0x02014b50, 0);   // central directory header
            record.writeUInt16LE(20, 4);           // version made by
            record.writeUInt16LE(20, 6);           // version needed
            record.writeUInt16LE(0x0800, 8);       // UTF-8 names
            record.writeUInt16LE(0, 10);           // stored
            record.writeUInt16LE(entry.time, 12);
            record.writeUInt16LE(entry.day, 14);
            record.writeUInt32LE(entry.crc, 16);
            record.writeUInt32LE(entry.size, 20);
            record.writeUInt32LE(entry.size, 24);
            record.writeUInt16LE(entry.nameBytes.length, 28);
            record.writeUInt32LE(entry.start, 42);
            await this.#push(record);
            await this.#push(entry.nameBytes);
        }

        const size = this.offset - start;
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);          // end of central directory
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(size, 12);
        end.writeUInt32LE(start, 16);
        await this.#push(end);

        await new Promise((resolve, reject) => {
            this.stream.once('error', reject);
            this.stream.end(resolve);
        });
    }
}
