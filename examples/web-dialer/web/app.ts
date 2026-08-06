interface ServerMessage {
    type: 'pbx-state' | 'call-state' | 'error';
    state?: 'connected' | 'disconnected' | 'dialing' | 'connected' | 'ended' | 'idle';
    message?: string;
    party?: string;
    direction?: 'incoming' | 'outgoing';
}

interface HistoryEntry {
    id: string;
    party: string;
    direction: 'incoming' | 'outgoing';
    startedAt: number;
    endedAt?: number;
    answered: boolean;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const setupPanel = $('#setupPanel');
const phonePanel = $('#phonePanel');
const connectionBadge = $('#connectionBadge');
const connectForm = $('#connectForm') as HTMLFormElement;
const connectButton = $('#connectButton') as HTMLButtonElement;
const numberInput = $('#numberInput') as HTMLInputElement;
const callButton = $('#callButton') as HTMLButtonElement;
const hangupButton = $('#hangupButton') as HTMLButtonElement;
const backspaceButton = $('#backspaceButton') as HTMLButtonElement;
const muteButton = $('#muteButton') as HTMLButtonElement;
const callLabel = $('#callLabel');
const callTimer = $('#callTimer');
const historyList = $('#historyList');
const toast = $('#toast');

let socket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let muted = false;
let callActive = false;
let callStartedAt = 0;
let timerId: number | null = null;
let playbackTime = 0;
let currentHistory: HistoryEntry | null = null;

function showError(message: string): void {
    toast.textContent = message;
    toast.classList.remove('hidden');
    window.setTimeout(() => toast.classList.add('hidden'), 5000);
}

function send(payload: Record<string, unknown>): void {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('尚未连接本地服务');
    socket.send(JSON.stringify(payload));
}

async function prepareAudio(): Promise<void> {
    if (audioContext && mediaStream) {
        await audioContext.resume();
        return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    micProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(micProcessor);
    micProcessor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    micProcessor.onaudioprocess = (event) => {
        if (!callActive || muted || socket?.readyState !== WebSocket.OPEN || !audioContext) return;
        const input = event.inputBuffer.getChannelData(0);
        socket.send(floatToPcm16(downsample(input, audioContext.sampleRate, 8000)));
    };
}

function downsample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) return input;
    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), input.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        output[i] = sum / Math.max(1, end - start);
    }
    return output;
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
}

function playPcm(data: ArrayBuffer): void {
    if (!audioContext || !callActive || data.byteLength < 2) return;
    const view = new DataView(data);
    const samples = new Float32Array(Math.floor(data.byteLength / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    const buffer = audioContext.createBuffer(1, samples.length, 8000);
    buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const now = audioContext.currentTime;
    playbackTime = Math.max(playbackTime, now + 0.04);
    source.start(playbackTime);
    playbackTime += buffer.duration;
}

function connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${location.host}/ws`);
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('无法连接本地拨号服务'));
        socket.onclose = () => {
            connectionBadge.className = 'badge offline';
            connectionBadge.innerHTML = '<i></i>已断开';
            callActive = false;
        };
        socket.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) playPcm(event.data);
            else handleServerMessage(JSON.parse(String(event.data)) as ServerMessage);
        };
    });
}

function handleServerMessage(message: ServerMessage): void {
    if (message.type === 'error') {
        showError(message.message ?? '未知错误');
        connectButton.disabled = false;
        connectButton.textContent = '重试连接';
        return;
    }
    if (message.type === 'pbx-state' && message.state === 'connected') {
        ($('#appSecret') as HTMLInputElement).value = '';
        connectionBadge.className = 'badge online';
        connectionBadge.innerHTML = '<i></i>已连接';
        setupPanel.classList.add('hidden');
        phonePanel.classList.remove('hidden');
        return;
    }
    if (message.type !== 'call-state') return;
    if (message.state === 'dialing') beginCall(message.party ?? numberInput.value, 'outgoing', false);
    else if (message.state === 'connected') beginCall(message.party ?? '未知号码', message.direction ?? 'incoming', true);
    else if (message.state === 'ended' || message.state === 'idle') endCall();
}

function beginCall(party: string, direction: 'incoming' | 'outgoing', answered: boolean): void {
    if (!currentHistory) {
        currentHistory = {
            id: crypto.randomUUID(),
            party,
            direction,
            startedAt: Date.now(),
            answered,
        };
    } else if (answered) currentHistory.answered = true;

    numberInput.value = party;
    numberInput.readOnly = true;
    callLabel.textContent = direction === 'incoming' ? 'INCOMING CALL' : answered ? 'CONNECTED' : 'CALLING';
    callTimer.textContent = answered ? '00:00' : '正在呼叫…';
    callButton.classList.add('hidden');
    backspaceButton.classList.add('hidden');
    hangupButton.classList.remove('hidden');
    callActive = answered;
    if (answered) {
        callStartedAt = Date.now();
        playbackTime = audioContext?.currentTime ?? 0;
        if (timerId) window.clearInterval(timerId);
        timerId = window.setInterval(updateTimer, 1000);
    }
}

function updateTimer(): void {
    const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
    callTimer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}

function endCall(): void {
    if (timerId) window.clearInterval(timerId);
    timerId = null;
    callActive = false;
    playbackTime = 0;
    if (currentHistory) {
        currentHistory.endedAt = Date.now();
        saveHistory(currentHistory);
        currentHistory = null;
    }
    callLabel.textContent = 'READY TO CALL';
    callTimer.textContent = '等待拨号';
    numberInput.value = '';
    numberInput.readOnly = false;
    callButton.classList.remove('hidden');
    backspaceButton.classList.remove('hidden');
    hangupButton.classList.add('hidden');
}

function getHistory(): HistoryEntry[] {
    try { return JSON.parse(localStorage.getItem('3cx-web-dialer-history') ?? '[]') as HistoryEntry[]; }
    catch { return []; }
}

function saveHistory(entry: HistoryEntry): void {
    localStorage.setItem('3cx-web-dialer-history', JSON.stringify([entry, ...getHistory()].slice(0, 50)));
    renderHistory();
}

function renderHistory(): void {
    const entries = getHistory();
    if (!entries.length) {
        historyList.innerHTML = '<div class="history-empty">还没有通话记录</div>';
        return;
    }
    historyList.replaceChildren(...entries.map((entry) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const duration = entry.answered && entry.endedAt ? Math.max(0, Math.floor((entry.endedAt - entry.startedAt) / 1000)) : 0;
        row.innerHTML = `<div class="history-icon ${entry.answered ? '' : 'missed'}">${entry.direction === 'incoming' ? '↙' : '↗'}</div><div><div class="history-party"></div><div class="history-meta">${entry.direction === 'incoming' ? '呼入' : '呼出'} · ${entry.answered ? `${duration} 秒` : '未接通'}</div></div><div class="history-time">${new Date(entry.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>`;
        row.querySelector('.history-party')!.textContent = entry.party;
        row.addEventListener('click', () => { if (!callActive) numberInput.value = entry.party; });
        return row;
    }));
}

connectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    connectButton.disabled = true;
    connectButton.textContent = '正在连接…';
    try {
        await prepareAudio();
        await connectSocket();
        send({
            type: 'connect',
            pbxBase: ($('#pbxBase') as HTMLInputElement).value,
            appId: ($('#appId') as HTMLInputElement).value,
            appSecret: ($('#appSecret') as HTMLInputElement).value,
        });
    } catch (error) {
        connectButton.disabled = false;
        connectButton.textContent = '重试连接';
        showError(error instanceof Error ? error.message : String(error));
    }
});

$('#keypad').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
    if (!button || numberInput.readOnly) return;
    const key = button.dataset.key ?? '';
    if (key === '0' && numberInput.value === '0') numberInput.value = '+';
    else numberInput.value += key;
});

backspaceButton.addEventListener('click', () => { numberInput.value = numberInput.value.slice(0, -1); });
callButton.addEventListener('click', async () => {
    const destination = numberInput.value.trim();
    if (!destination) return showError('请先输入号码');
    try {
        await prepareAudio();
        send({ type: 'dial', destination });
    } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
});
hangupButton.addEventListener('click', () => send({ type: 'hangup' }));
muteButton.addEventListener('click', () => {
    muted = !muted;
    muteButton.classList.toggle('active', muted);
    muteButton.textContent = muted ? '静' : '♩';
});
$('#clearHistoryButton').addEventListener('click', () => {
    localStorage.removeItem('3cx-web-dialer-history');
    renderHistory();
});
numberInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') callButton.click();
});

renderHistory();
