/**
 * Upsample PCM from 8 kHz to 16 kHz via sample duplication.
 */
export function upsample8kTo16k(buf: Buffer): Buffer {
    const samples = Math.floor(buf.length / 2);
    const out = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) {
        const sample = buf.readInt16LE(i * 2);
        out.writeInt16LE(sample, i * 4);
        out.writeInt16LE(sample, i * 4 + 2);
    }
    return out;
}

/**
 * Downsample PCM from 24 kHz to 8 kHz via simple 3:1 decimation.
 */
export function downsample24kTo8k(buf: Buffer): Buffer {
    const samples24k = Math.floor(buf.length / 2);
    const samples8k = Math.floor(samples24k / 3);
    const out = Buffer.alloc(samples8k * 2);
    for (let i = 0; i < samples8k; i++) {
        const srcByte = i * 3 * 2;
        if (srcByte + 1 < buf.length) {
            out.writeInt16LE(buf.readInt16LE(srcByte), i * 2);
        }
    }
    return out;
}
