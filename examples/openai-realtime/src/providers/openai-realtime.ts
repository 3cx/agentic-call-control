import WebSocket from 'ws';
import chalk from 'chalk';
import type { IncomingMessage, ClientRequest } from 'http';
import type { AudioWriter, Participant } from '@3cx/call-control-sdk';
import { normalizeToolDefinitions } from '@3cx-examples/mcp';
import type { AppConfig } from '../app-config.ts';
import type { ToolResult } from '../agent/tool-executor.ts';
import {
    downsample24kTo8k,
    gatePcmChunk,
    upsample8kTo24k,
} from '../callcontrol/audio-utils.ts';
import { waitForFirstUtteranceDelay } from '../callcontrol/first-utterance-delay.ts';
import { detectRequestedTools, createAudioPipeMonitor } from '@3cx-examples/logger';
import type { CallLogger, AudioPipeMonitor } from '@3cx-examples/logger';

const LOG = '[OpenAI Realtime]';
const PLAYBACK_PREBUFFER_BYTES = 8000 * 2 * 1.0;

export interface OpenAiToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface OpenAiBridgeConfig {
    appConfig: AppConfig;
    instructions: string;
    localTools: OpenAiToolDef[];
    greeting: string;
    logger?: CallLogger;
}

export interface OpenAiBridgeHandle {
    stop: () => void;
}

const DEFAULT_INPUT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

export function createOpenAiRealtimeBridge(
    participant: Participant,
    config: OpenAiBridgeConfig,
    executeTool: (name: string, argsJson: string) => Promise<ToolResult>,
): OpenAiBridgeHandle {
    const log = config.logger ?? createNoopLogger();
    const appConfig = config.appConfig;
    const model = appConfig.openaiModel ?? 'gpt-realtime-2';
    const voice = appConfig.openaiVoice ?? 'alloy';
    const pcmFormat = { type: 'audio/pcm', rate: 24000 };

    const turnDetection: Record<string, unknown> = { type: 'server_vad' };
    if (appConfig.openaiVadSilenceDurationMs) {
        turnDetection.silence_duration_ms = appConfig.openaiVadSilenceDurationMs;
    }
    if (appConfig.openaiVadThreshold != null) {
        turnDetection.threshold = appConfig.openaiVadThreshold;
    }

    const audioInput: Record<string, unknown> = {
        format: pcmFormat,
        turn_detection: turnDetection,
    };
    const transcriptionModel = appConfig.openaiInputTranscriptionModel ?? DEFAULT_INPUT_TRANSCRIPTION_MODEL;
    if (transcriptionModel !== 'none') {
        const transcription: Record<string, unknown> = { model: transcriptionModel };
        if (appConfig.openaiInputTranscriptionLanguage) {
            transcription.language = appConfig.openaiInputTranscriptionLanguage;
        }
        audioInput.transcription = transcription;
    }

    let stopped = false;
    let ws: WebSocket | null = null;
    const audioWriter = participant.getAudioWriter();
    const playbackGate = createPlaybackGate(audioWriter);
    let audioMonitor: AudioPipeMonitor | null = null;

    const pendingCalls: PendingFunctionCall[] = [];
    /** OpenAI-safe tool name → original MCP / local tool name (dots → underscores). */
    let toolNameMap = new Map<string, string>();
    let pendingCallAction: ToolResult | null = null;
    let awaitingActionAnnouncement = false;
    let functionCallStreaming = false;
    let agentTranscriptBuf = '';
    let responseAudioBytes = 0;
    let responseAudioStartMs = 0;
    let responseActive = false;

    const inputGateThreshold = appConfig.voiceBehavior?.silenceThreshold ?? 1500;

    const send = (obj: Record<string, unknown>) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        audioMonitor?.dispose();
        audioWriter.cancel();
        if (ws) { ws.close(); ws = null; }
        log.info('BRIDGE_STOPPED');
        console.log(chalk.yellow(`${LOG} bridge stopped`));
    };

    const sendSessionUpdate = () => {
        const { tools, nameMap } = buildFlatTools(config.localTools);
        toolNameMap = nameMap;
        send({
            type: 'session.update',
            session: {
                type: 'realtime',
                instructions: config.instructions,
                tools,
                audio: {
                    input: audioInput,
                    output: { format: pcmFormat, voice },
                },
            },
        });
        log.systemPrompt(config.instructions);
        log.info(`SESSION_UPDATE | tools=${tools.length} (${tools.map((t) => t.name).join(', ')}) voice=${voice} model=${model} inputTranscription=${transcriptionModel}`);
        console.log(chalk.cyan(`${LOG} session.update sent (${tools.length} tools, voice: ${voice}, transcription: ${transcriptionModel})`));
    };

    const startAudioPipe = () => {
        audioMonitor = createAudioPipeMonitor(log);
        participant.getAudioStream().then((audioStream) => {
            audioStream.on('data', (chunk: Buffer) => {
                if (stopped) return;
                audioMonitor?.onChunk(chunk.length);
                const gated = gatePcmChunk(chunk, inputGateThreshold);
                send({ type: 'input_audio_buffer.append', audio: upsample8kTo24k(gated).toString('base64') });
            });
            audioStream.on('end', () => audioMonitor?.onStreamEnd());
            audioStream.on('close', () => audioMonitor?.onStreamClose());
            audioStream.on('error', (err: Error) => {
                audioMonitor?.onStreamError(err);
                console.error(chalk.red(`${LOG} audio stream error:`), err.message);
            });
        }).catch((err: Error) => {
            log.error(`AUDIO_PIPE_INIT_ERROR | error="${err.message}"`);
            console.error(chalk.red(`${LOG} getAudioStream error:`), err.message);
        });
    };

    const handleEvent = (event: Record<string, unknown>) => {
        const type = event.type as string;

        switch (type) {
        case 'session.created':
        case 'session.updated':
            log.info(type.toUpperCase().replace('.', '_'));
            console.log(chalk.gray(`${LOG} ${type}`));
            break;

        case 'response.audio.delta':
        case 'response.output_audio.delta': {
            const b64 = event.delta as string;
            if (b64 && !audioWriter.cancelled) {
                if (responseAudioBytes === 0) responseAudioStartMs = Date.now();
                const raw = downsample24kTo8k(Buffer.from(b64, 'base64'));
                responseAudioBytes += raw.length;
                playbackGate.write(raw);
            }
            break;
        }

        case 'response.audio_transcript.delta':
        case 'response.output_audio_transcript.delta':
            agentTranscriptBuf += (event.delta as string) ?? '';
            break;

        case 'response.audio_transcript.done':
        case 'response.output_audio_transcript.done':
            if (agentTranscriptBuf) {
                log.transcript('agent', agentTranscriptBuf.trim());
                console.log(chalk.blueBright(`[Agent] "${agentTranscriptBuf.trim()}"`));
                agentTranscriptBuf = '';
            }
            break;

        case 'input_audio_buffer.speech_started':
            log.speechEvent('CALLER_SPEECH_START');
            if (functionCallStreaming) {
                console.log(chalk.gray(`${LOG} speech started — barge-in suppressed (tool call in progress)`));
            } else if (responseActive) {
                console.log(chalk.gray(`${LOG} speech started — barge-in`));
                send({ type: 'response.cancel' });
                audioWriter.clear();
                agentTranscriptBuf = '';
            } else {
                console.log(chalk.gray(`${LOG} speech started`));
                audioWriter.clear();
            }
            break;

        case 'input_audio_buffer.speech_stopped':
            log.speechEvent('CALLER_SPEECH_STOP');
            console.log(chalk.dim(`${LOG} speech_stopped`));
            break;

        case 'conversation.item.input_audio_transcription.completed': {
            const transcript = (event.transcript as string)?.trim() ?? '';
            log.transcript('caller', transcript);
            console.log(chalk.yellowBright(`[User] "${transcript}"`));
            break;
        }

        case 'conversation.item.input_audio_transcription.failed':
            log.error(`TRANSCRIPTION_FAILED | ${JSON.stringify(event.error ?? event)}`);
            console.error(chalk.red(`${LOG} transcription failed:`), JSON.stringify(event.error ?? event));
            break;

        case 'response.function_call_arguments.delta':
            functionCallStreaming = true;
            break;

        case 'response.function_call_arguments.done':
            functionCallStreaming = false;
            pendingCalls.push({
                callId: event.call_id as string,
                name: event.name as string,
                arguments: event.arguments as string,
            });
            log.toolCalled(event.name as string, event.call_id as string, event.arguments as string);
            console.log(chalk.cyan(`[Tool] ${event.name as string}(${((event.arguments as string) ?? '').substring(0, 200)})`));
            break;

        case 'response.done': {
            functionCallStreaming = false;
            responseActive = false;
            log.speechEvent('AGENT_SPEECH_STOP');
            const calls = [...pendingCalls];
            pendingCalls.length = 0;
            const delayMs = audioRemainingMs(responseAudioBytes, responseAudioStartMs);
            playbackGate.flush();
            responseAudioBytes = 0;

            if (awaitingActionAnnouncement && pendingCallAction && calls.length === 0) {
                awaitingActionAnnouncement = false;

                const action = pendingCallAction;
                pendingCallAction = null;

                executeCallAction(
                    action,
                    participant,
                    stop,
                    appConfig.speakOnRouteFailure,
                    appConfig.routeFailureUserReply,
                    send,
                    delayMs,
                );

                break;
            }

            if (calls.length > 0) {
                void (async () => {
                    let callAction: ToolResult | null = null;

                    for (const call of calls) {
                        const toolName = toolNameMap.get(call.name) ?? call.name;
                        try {
                            const result = await executeTool(toolName, call.arguments);
                            send({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: call.callId,
                                    output: result.content,
                                },
                            });
                            log.toolResult(toolName, call.callId, result.content);
                            for (const req of detectRequestedTools(result.content)) {
                                log.ruleInjected(req.tool, call.callId, result.content);
                            }
                            if (result.action) callAction = result;
                        } catch (err) {
                            const msg = (err as Error).message;
                            log.error(`TOOL_EXEC_ERROR | tool=${toolName} call_id=${call.callId} error="${msg}"`);
                            console.error(chalk.red(`${LOG} tool exec error (${toolName}):`), err);
                            send({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: call.callId,
                                    output: `Error: ${msg}`,
                                },
                            });
                            log.toolResult(toolName, call.callId, `Error: ${msg}`);
                        }
                    }

                    if (callAction) {
                        pendingCallAction = callAction;
                        awaitingActionAnnouncement = true;

                        const announcement = callAction.announcement ?? defaultActionAnnouncement(callAction);

                        send({
                            type: 'response.create',
                            response: {
                                tool_choice: 'none',
                                instructions: `Say exactly: ${JSON.stringify(announcement)} Then stop.`,
                                input: [],
                            },
                        });
                    } else {
                        send({ type: 'response.create' });
                    }
                })();
            }
            break;
        }

        case 'error': {
            const err = event.error as Record<string, unknown> | undefined;
            const code = (err?.code ?? event.code ?? 'unknown') as string;
            const msg = (err?.message ?? event.message ?? JSON.stringify(event)) as string;
            if (msg.includes('Cancellation failed')) break;
            log.error(`SERVER_ERROR | code=${code} message="${msg}"`);
            console.error(chalk.red(`${LOG} server error [${code}]: ${msg}`));
            break;
        }

        case 'response.created':
            responseActive = true;
            playbackGate.reset();
            log.speechEvent('AGENT_SPEECH_START');
            break;

        case 'input_audio_buffer.committed':
            console.log(chalk.dim(`${LOG} committed`));
            break;

        case 'response.audio.done':
        case 'response.output_audio.done':
        case 'response.text.delta':
        case 'response.text.done':
        case 'response.output_item.added':
        case 'response.output_item.done':
        case 'response.content_part.added':
        case 'response.content_part.done':
        case 'input_audio_buffer.cleared':
        case 'conversation.item.created':
        case 'conversation.item.added':
        case 'conversation.item.done':
        case 'conversation.created':
        case 'rate_limits.updated':
        case 'conversation.item.input_audio_transcription.delta':
        case 'ping':
            break;

        default:
            console.log(chalk.gray(`${LOG} unhandled: ${type}`));
        }
    };

    ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
        headers: { Authorization: `Bearer ${appConfig.openaiApiKey}` },
    });

    ws.on('upgrade', (res: IncomingMessage) => {
        log.info(`WS_UPGRADE | status=${res.statusCode}`);
        console.log(chalk.gray(`${LOG} HTTP upgrade: ${res.statusCode}`));
    });

    ws.on('unexpected-response', (_req: ClientRequest, res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
            log.error(`WS_REJECTED | status=${res.statusCode} body=${body}`);
            console.error(chalk.red(`${LOG} WebSocket rejected: ${res.statusCode} ${res.statusMessage}`));
            console.error(chalk.red(`${LOG} Response body: ${body}`));
        });
    });

    ws.on('open', () => {
        log.info('WS_OPEN');
        console.log(chalk.green(`${LOG} WebSocket connected`));
        sendSessionUpdate();
        startAudioPipe();
        void (async () => {
            await waitForFirstUtteranceDelay(appConfig, LOG);
            if (stopped) return;
            send({
                type: 'response.create',
                response: {
                    tool_choice: 'none',
                    instructions: `You must say this greeting word for word: "${config.greeting}". Say nothing else. Do not add any follow-up. Do not call any tools. Just say the greeting and stop.`,
                    input: [],
                },
            });
            log.info(`GREETING_REQUESTED | "${config.greeting}"`);
            console.log(chalk.cyan(`${LOG} greeting queued: "${config.greeting}"`));
        })();
        console.log(chalk.gray(`${LOG} input noise gate: peak ≤ ${inputGateThreshold} → silence`));
    });

    ws.on('message', (data: WebSocket.RawData) => {
        if (stopped) return;
        try {
            const event = JSON.parse(data.toString()) as Record<string, unknown>;
            if (!event.type) {
                console.error(chalk.red(`${LOG} message without type:`), data.toString().substring(0, 200));
                return;
            }
            handleEvent(event);
        } catch (err) {
            log.error(`WS_PARSE_ERROR | error="${(err as Error).message}"`);
            console.error(chalk.red(`${LOG} parse error:`), err);
        }
    });

    ws.on('close', (code, reason) => {
        log.info(`WS_CLOSE | code=${code} reason="${reason.toString()}"`);
        console.log(chalk.yellow(`${LOG} WebSocket closed: ${code} ${reason.toString()}`));
        ws = null;
    });

    ws.on('error', (err) => {
        log.error(`WS_ERROR | error="${err.message}"`);
        console.error(chalk.red(`${LOG} WebSocket error:`), err.message);
    });

    return { stop };
}

interface PendingFunctionCall {
    callId: string;
    name: string;
    arguments: string;
}

function createPlaybackGate(audioWriter: AudioWriter, prebufferBytes = PLAYBACK_PREBUFFER_BYTES) {
    let pending = Buffer.alloc(0);
    let started = false;

    return {
        reset() {
            pending = Buffer.alloc(0);
            started = false;
        },
        write(chunk: Buffer) {
            if (audioWriter.cancelled) return;
            if (started) {
                audioWriter.write(chunk);
                return;
            }
            pending = Buffer.concat([pending, chunk]);
            if (pending.length >= prebufferBytes) {
                started = true;
                audioWriter.write(pending);
                pending = Buffer.alloc(0);
            }
        },
        flush() {
            if (pending.length > 0 && !audioWriter.cancelled) {
                audioWriter.write(pending);
                pending = Buffer.alloc(0);
            }
            started = true;
        },
    };
}

/** OpenAI Realtime: sanitize names + parameters via shared MCP normalizer. */
function buildFlatTools(tools: OpenAiToolDef[]) {
    const normalized = normalizeToolDefinitions(tools, 'openai');
    const flat = normalized.tools.map((tool) => {
        return {
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        };
    });
    return { tools: flat, nameMap: normalized.originalNameByName };
}

function audioRemainingMs(totalBytes: number, startMs: number): number {
    if (totalBytes === 0) return 0;
    const totalMs = (totalBytes / 16000) * 1000;
    const elapsedMs = Date.now() - startMs;
    return Math.max(0, totalMs - elapsedMs) + 300;
}

function defaultActionAnnouncement(result: ToolResult): string {
    switch (result.action) {
    case 'transfer':
        return "I'll transfer you now.";
    case 'transfer_voicemail':
        return "I'll send you to voicemail now.";
    case 'drop':
        return 'Goodbye.';
    default:
        return 'One moment, please.';
    }
}

function executeCallAction(
    result: ToolResult,
    participant: Participant,
    stop: () => void,
    speakOnRouteFailure: boolean,
    routeFailureReply: string,
    send: (obj: Record<string, unknown>) => void,
    delayMs = 0,
): void {
    const destination = result.destination ?? '';

    const run = () => {
        switch (result.action) {
        case 'transfer':
            console.log(chalk.magentaBright(`${LOG} SDK transfer → ${destination}`));
            participant.transfer(destination)
                .then(() => stop())
                .catch((err: Error) => {
                    console.error(chalk.red(`${LOG} transfer error:`), err.message);
                    if (speakOnRouteFailure) {
                        send({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role: 'user',
                                content: [{
                                    type: 'input_text',
                                    text: `[system: transfer to ${destination} failed — ${routeFailureReply}]`,
                                }],
                            },
                        });
                        send({ type: 'response.create' });
                    }
                });
            break;

        case 'drop':
            console.log(chalk.magentaBright(`${LOG} SDK drop`));
            participant.drop()
                .then(() => stop())
                .catch((err: Error) => console.error(chalk.red(`${LOG} drop error:`), err.message));
            break;

        case 'transfer_voicemail':
            console.log(chalk.magentaBright(`${LOG} SDK transferToVoiceMail → ${destination}`));
            participant.transferToVoiceMail(destination)
                .then(() => stop())
                .catch((err: Error) => {
                    console.error(chalk.red(`${LOG} voicemail error:`), err.message);
                    if (speakOnRouteFailure) {
                        send({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role: 'user',
                                content: [{
                                    type: 'input_text',
                                    text: `[system: voicemail transfer to ${destination} failed — ${routeFailureReply}]`,
                                }],
                            },
                        });
                        send({ type: 'response.create' });
                    }
                });
            break;
        }
    };

    if (delayMs > 0) {
        console.log(chalk.gray(`${LOG} deferring ${result.action} by ${Math.round(delayMs)} ms (audio drain)`));
        setTimeout(run, delayMs);
    } else {
        run();
    }
}

function createNoopLogger(): CallLogger {
    return {
        callId: 0,
        callStart() {},
        callEnd() {},
        systemPrompt() {},
        transcript() {},
        speechEvent() {},
        responseCreated() {},
        responseDone() {},
        ruleInjected() {},
        toolCalled() {},
        toolResult() {},
        info() {},
        warn() {},
        error() {},
        close() {},
    };
}
