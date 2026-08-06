import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { CallControlClient, type AudioWriter, type Participant } from '@3cx/call-control-sdk';
import { WebSocket, WebSocketServer } from 'ws';

interface ConnectMessage {
    type: 'connect';
    pbxBase: string;
    appId: string;
    appSecret: string;
}

interface DialMessage {
    type: 'dial';
    destination: string;
}

interface HangupMessage {
    type: 'hangup';
}

interface AcceptMessage {
    type: 'accept';
}

type ClientMessage = ConnectMessage | DialMessage | HangupMessage | AcceptMessage;

const port = Number(process.env.PORT ?? 8787);
const maxBufferedAudioBytes = 320 * 10;
const maxSocketBufferedBytes = 64 * 1024;
const incomingRingTimeoutMs = 30_000;
const ringbackCycleMs = 3_000;

function createRingbackTone(): Buffer {
    const sampleRate = 8_000;
    const durationSeconds = 1;
    const samples = sampleRate * durationSeconds;
    const pcm = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index++) {
        const time = index / sampleRate;
        const fade = Math.min(1, index / 80, (samples - index) / 80);
        const mixed = (Math.sin(2 * Math.PI * 440 * time) + Math.sin(2 * Math.PI * 480 * time)) * 0.12 * fade;
        pcm.writeInt16LE(Math.round(mixed * 0x7fff), index * 2);
    }
    return pcm;
}

const ringbackTone = createRingbackTone();
const webRoot = fileURLToPath(new URL('../web', import.meta.url));
const builtWebRoot = fileURLToPath(new URL('../dist/web', import.meta.url));

const mimeTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = safePath === 'app.js' ? join(builtWebRoot, safePath) : join(webRoot, safePath);
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(webRoot, 'index.html');

    res.writeHead(200, {
        'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    });
    createReadStream(filePath).pipe(res);
}

const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizePbxBase(value: string): string {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') throw new Error('3CX 域名必须使用 https://');
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

class DialerSession {
    private client: CallControlClient | null = null;
    private activeParticipant: Participant | null = null;
    private audioStream: Readable | null = null;
    private audioWriter: AudioWriter | null = null;
    private mediaActive = false;
    private incomingParty = '';
    private ringTimer: NodeJS.Timeout | null = null;
    private ringbackTimer: NodeJS.Timeout | null = null;
    private pendingDestination = '';
    private pendingParticipantId: number | null = null;
    private cancelPendingCall = false;
    private callDirection: 'incoming' | 'outgoing' = 'incoming';

    constructor(private readonly socket: WebSocket) {}

    private send(payload: Record<string, unknown>): void {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
    }

    fail(error: unknown): void {
        this.send({ type: 'error', message: messageOf(error) });
    }

    async handleText(text: string): Promise<void> {
        let message: ClientMessage;
        try {
            message = JSON.parse(text) as ClientMessage;
        } catch {
            throw new Error('无效的客户端消息');
        }

        if (message.type === 'connect') await this.connect(message);
        else if (message.type === 'dial') await this.dial(message.destination);
        else if (message.type === 'accept') await this.accept();
        else if (message.type === 'hangup') await this.hangup();
        else throw new Error('不支持的操作');
    }

    handleAudio(data: Buffer): void {
        if (!this.activeParticipant || !this.mediaActive || data.length === 0) return;
        this.audioWriter ??= this.activeParticipant.getAudioWriter();
        if (this.audioWriter.bufferedBytes > maxBufferedAudioBytes) this.audioWriter.clear();
        this.audioWriter.write(data);
    }

    private async connect(message: ConnectMessage): Promise<void> {
        if (this.client) throw new Error('已经连接到 3CX，请先刷新页面再更换账号');
        const appId = message.appId.trim();
        const appSecret = message.appSecret.trim();
        if (!appId || !appSecret) throw new Error('Client ID 和 Key 不能为空');

        const client = new CallControlClient({
            pbxBase: normalizePbxBase(message.pbxBase),
            appId,
            appSecret,
        });

        client.on('participantConnected', (participant) => void this.onParticipantConnected(participant));
        client.on('participantDisconnected', (id) => this.onParticipantDisconnected(id));
        client.on('error', (error) => this.fail(error));
        client.on('disconnected', () => this.send({ type: 'pbx-state', state: 'disconnected' }));

        await client.connect();
        this.client = client;
        this.send({ type: 'pbx-state', state: 'connected', appId });
    }

    private async dial(destinationValue: string): Promise<void> {
        if (!this.client) throw new Error('请先连接 3CX');
        if (this.activeParticipant || this.pendingDestination) throw new Error('当前已有通话');
        const destination = destinationValue.trim();
        if (!/^[0-9+*#]+$/.test(destination)) throw new Error('号码只能包含数字、+、* 和 #');

        this.pendingDestination = destination;
        this.cancelPendingCall = false;
        this.callDirection = 'outgoing';
        this.send({ type: 'call-state', state: 'dialing', party: destination, direction: 'outgoing' });
        try {
            const participantId = await this.client.makeCall(destination);
            this.pendingParticipantId = participantId ?? null;
            if (this.cancelPendingCall && participantId != null) {
                await this.client.drop(participantId).catch(() => undefined);
                this.pendingParticipantId = null;
                this.cancelPendingCall = false;
            }
        } catch (error) {
            this.pendingDestination = '';
            this.pendingParticipantId = null;
            this.cancelPendingCall = false;
            this.send({ type: 'call-state', state: 'idle' });
            throw error;
        }
    }

    private async onParticipantConnected(participant: Participant): Promise<void> {
        if (this.cancelPendingCall) {
            this.pendingParticipantId = participant.id;
            await participant.drop().catch(() => undefined);
            return;
        }
        if (this.activeParticipant && this.activeParticipant.id !== participant.id) {
            await participant.drop().catch(() => undefined);
            return;
        }

        this.activeParticipant = participant;
        const party = this.pendingDestination
            || participant.info.party_caller_name
            || participant.info.party_caller_id
            || participant.info.party_dn
            || '未知号码';
        const direction = this.pendingDestination ? 'outgoing' : 'incoming';
        this.callDirection = direction;
        this.pendingDestination = '';
        this.pendingParticipantId = null;
        this.cancelPendingCall = false;
        if (direction === 'incoming') {
            this.incomingParty = party;
            this.send({
                type: 'call-state',
                state: 'ringing',
                participantId: participant.id,
                party,
                direction,
            });
            this.startRemoteRingback(participant);
            this.ringTimer = setTimeout(() => void this.hangup(), incomingRingTimeoutMs);
            return;
        }

        await this.startMedia(participant, party, direction);
    }

    private async accept(): Promise<void> {
        if (!this.activeParticipant || this.callDirection !== 'incoming' || this.mediaActive) return;
        this.clearRingTimer();
        this.stopRemoteRingback();
        await this.startMedia(this.activeParticipant, this.incomingParty || '未知号码', 'incoming');
    }

    private async startMedia(
        participant: Participant,
        party: string,
        direction: 'incoming' | 'outgoing',
    ): Promise<void> {
        this.mediaActive = true;
        this.send({
            type: 'call-state',
            state: 'connected',
            participantId: participant.id,
            party,
            direction,
        });

        try {
            const stream = await participant.getAudioStream();
            if (this.activeParticipant?.id !== participant.id || !this.mediaActive) {
                stream.destroy();
                return;
            }
            this.audioStream = stream;
            stream.on('data', (chunk: Buffer) => {
                if (
                    this.mediaActive
                    && this.socket.readyState === WebSocket.OPEN
                    && this.socket.bufferedAmount < maxSocketBufferedBytes
                ) {
                    this.socket.send(chunk, { binary: true });
                }
            });
            stream.on('error', (error) => this.fail(error));
        } catch (error) {
            this.fail(error);
        }
    }

    private onParticipantDisconnected(id: number): void {
        if (this.activeParticipant?.id !== id) return;
        this.stopAudio();
        this.clearRingTimer();
        this.stopRemoteRingback();
        this.activeParticipant = null;
        this.incomingParty = '';
        this.pendingDestination = '';
        this.pendingParticipantId = null;
        this.cancelPendingCall = false;
        this.send({ type: 'call-state', state: 'ended', direction: this.callDirection });
    }

    private async hangup(): Promise<void> {
        if (this.activeParticipant) {
            const participant = this.activeParticipant;
            this.clearRingTimer();
            this.stopRemoteRingback();
            this.stopAudio();
            this.send({ type: 'call-state', state: 'ended', direction: this.callDirection });
            await participant.drop().catch((error) => this.fail(error));
            return;
        }
        if (this.pendingDestination) {
            this.cancelPendingCall = true;
            if (this.pendingParticipantId != null && this.client) {
                await this.client.drop(this.pendingParticipantId).catch(() => undefined);
                this.pendingParticipantId = null;
                this.cancelPendingCall = false;
            }
            this.pendingDestination = '';
            this.send({ type: 'call-state', state: 'idle' });
        }
    }

    private stopAudio(): void {
        this.mediaActive = false;
        this.audioStream?.destroy();
        this.audioStream = null;
        this.audioWriter?.clear();
        this.audioWriter?.cancel();
        this.audioWriter = null;
    }

    private startRemoteRingback(participant: Participant): void {
        this.stopRemoteRingback();
        this.audioWriter = participant.getAudioWriter();
        const writeTone = () => this.audioWriter?.write(ringbackTone);
        writeTone();
        this.ringbackTimer = setInterval(writeTone, ringbackCycleMs);
    }

    private stopRemoteRingback(): void {
        if (this.ringbackTimer) clearInterval(this.ringbackTimer);
        this.ringbackTimer = null;
        this.audioWriter?.clear();
    }

    private clearRingTimer(): void {
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.ringTimer = null;
    }

    close(): void {
        this.stopAudio();
        this.clearRingTimer();
        this.stopRemoteRingback();
        this.client?.disconnect();
        this.client = null;
        this.activeParticipant = null;
    }
}

wss.on('connection', (socket) => {
    const session = new DialerSession(socket);
    socket.on('message', (data, isBinary) => {
        if (isBinary) session.handleAudio(Buffer.from(data as Buffer));
        else void session.handleText(data.toString()).catch((error) => session.fail(error));
    });
    socket.on('close', () => session.close());
    socket.on('error', () => session.close());
});

server.listen(port, '127.0.0.1', () => {
    console.log(`3CX Web Dialer: http://localhost:${port}`);
});
