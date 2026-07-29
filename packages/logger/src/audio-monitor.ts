/**
 * Audio-pipe state monitor. Logs only on state transitions so the call log
 * stays readable — typically 2 lines per normal call (FLOWING + STREAM_END)
 * and one extra STALLED line when the pipe goes dead.
 */

import type { CallLogger } from './call-logger.ts';

export interface AudioPipeMonitor {
    onChunk(bytes: number): void;
    onStreamEnd(): void;
    onStreamClose(): void;
    onStreamError(err: Error): void;
    /** Stop the stall timer so the call can end cleanly. */
    dispose(): void;
}

export interface AudioPipeMonitorOptions {
    /** Idle threshold before STALLED fires. Default 3000ms. */
    stallMs?: number;
    /** Prefix for log lines. Default "AUDIO_IN". */
    label?: string;
}

export function createAudioPipeMonitor(
    logger: CallLogger,
    options: AudioPipeMonitorOptions = {},
): AudioPipeMonitor {
    const stallMs = options.stallMs ?? 3000;
    const label = options.label ?? 'AUDIO_IN';

    let firstSeen = false;
    let lastChunkAt = 0;
    let totalChunks = 0;
    let totalBytes = 0;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearStallTimer = () => {
        if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
        }
    };

    const armStallTimer = () => {
        clearStallTimer();
        if (disposed) return;
        stallTimer = setTimeout(() => {
            if (disposed || stalled || !firstSeen) return;
            const idleMs = Date.now() - lastChunkAt;
            stalled = true;
            logger.warn(
                `${label}_STALLED | no chunks for ${Math.round(idleMs / 1000)}s `
                + `(received ${totalChunks} chunks, ${totalBytes} bytes so far)`,
            );
        }, stallMs + 50);
    };

    return {
        onChunk(bytes) {
            if (disposed) return;
            totalChunks++;
            totalBytes += bytes;
            lastChunkAt = Date.now();
            if (!firstSeen) {
                firstSeen = true;
                logger.info(`${label}_FLOWING | first chunk received (${bytes} bytes)`);
            } else if (stalled) {
                stalled = false;
                logger.info(`${label}_RESUMED | chunks resumed (total ${totalChunks} chunks, ${totalBytes} bytes)`);
            }
            armStallTimer();
        },

        onStreamEnd() {
            if (disposed) return;
            clearStallTimer();
            logger.info(`${label}_STREAM_END | total ${totalChunks} chunks, ${totalBytes} bytes`);
        },

        onStreamClose() {
            if (disposed) return;
            clearStallTimer();
            logger.info(`${label}_STREAM_CLOSE | total ${totalChunks} chunks, ${totalBytes} bytes`);
        },

        onStreamError(err) {
            if (disposed) return;
            clearStallTimer();
            logger.error(`${label}_STREAM_ERROR | error="${err.message}"`);
        },

        dispose() {
            disposed = true;
            clearStallTimer();
        },
    };
}
