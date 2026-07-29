/**
 * Upsample PCM from 8 kHz to 24 kHz via sample triplication.
 */
export function upsample8kTo24k(buf: Buffer): Buffer {
    const samples = Math.floor(buf.length / 2);
    const out = Buffer.alloc(samples * 6);
    for (let i = 0; i < samples; i++) {
        const sample = buf.readInt16LE(i * 2);
        out.writeInt16LE(sample, i * 6);
        out.writeInt16LE(sample, i * 6 + 2);
        out.writeInt16LE(sample, i * 6 + 4);
    }
    return out;
}

function peakPcmAmplitude(chunk: Buffer): number {
    let peak = 0;
    for (let i = 0; i < chunk.length - 1; i += 2) {
        const abs = Math.abs(chunk.readInt16LE(i));
        if (abs > peak) peak = abs;
    }
    return peak;
}

/** Zero out low-level mic noise so server VAD ignores it. */
export function gatePcmChunk(chunk: Buffer, peakThreshold: number): Buffer {
    if (peakThreshold <= 0) return chunk;
    return peakPcmAmplitude(chunk) <= peakThreshold ? Buffer.alloc(chunk.length) : chunk;
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
