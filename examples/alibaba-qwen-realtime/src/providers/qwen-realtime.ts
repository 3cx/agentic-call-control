import WebSocket from 'ws';
import chalk from 'chalk';
import type { Participant } from '@3cx/call-control-sdk';
import { normalizeToolDefinitions } from '@3cx-examples/mcp';
import type { ToolResult } from '../agent/tool-executor.ts';
import { detectRequestedTools, createAudioPipeMonitor } from '@3cx-examples/logger';
import type { CallLogger, AudioPipeMonitor } from '@3cx-examples/logger';

export interface QwenRealtimeConfig {
    apiKey: string;
    /** Base URL without trailing slash, e.g. https://dashscope-intl.aliyuncs.com */
    baseUrl: string;
    /** Default: qwen3.5-omni-flash-realtime */
    model?: string;
    /** Voice name, e.g. "Ethan", "Serena", "Cherry" */
    voice: string;
    instructions: string;
    /** Server VAD silence duration in ms. Default: 500 */
    vadSilenceDurationMs?: number;
    localTools: QwenToolDef[];
    greeting: string;
    speakOnRouteFailure: boolean;
    routeFailureUserReply: string;
    fileLog?: CallLogger;
}

export interface QwenToolDef {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface QwenBridgeHandle {
    stop: () => void;
}

interface PendingFunctionCall {
    callId: string;
    name: string;
    arguments: string;
}

/**
 * Upsample PCM 16-bit mono 8 kHz → 16 kHz (duplicate each sample).
 * DashScope Realtime expects 16 kHz; 3CX provides 8 kHz.
 */
function upsample8kTo16k(input: Buffer): Buffer {
    const samples = Math.floor(input.length / 2);
    const out = Buffer.allocUnsafe(samples * 4);
    for (let i = 0; i < samples; i++) {
        const s = input.readInt16LE(i * 2);
        out.writeInt16LE(s, i * 4);
        out.writeInt16LE(s, i * 4 + 2);
    }
    return out;
}

/**
 * Downsample PCM 16-bit mono 24 kHz → 8 kHz (keep every 3rd sample).
 * DashScope Realtime outputs 24 kHz; 3CX requires 8 kHz.
 */
function downsample24kTo8k(input: Buffer): Buffer {
    const inSamples = Math.floor(input.length / 2);
    const outSamples = Math.floor(inSamples / 3);
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
        out.writeInt16LE(input.readInt16LE(i * 6), i * 2);
    }
    return out;
}

export function createQwenRealtimeBridge(
    participant: Participant,
    config: QwenRealtimeConfig,
    executeTool: (name: string, argsJson: string) => Promise<ToolResult>,
): QwenBridgeHandle {
    const log = config.fileLog ?? createNoopLogger();
    let stopped = false;
    let ws: WebSocket | null = null;
    let currentResponseId = '';
    let responseActive = false;
    let audioMonitor: AudioPipeMonitor | null = null;
    const pendingCalls: PendingFunctionCall[] = [];

    const audioWriter = participant.getAudioWriter();

    const send = (obj: Record<string, unknown>) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const sendSessionUpdate = () => {
        // DashScope uses nested tool format (Chat Completion style), not flat OpenAI Realtime style
        const normalized = normalizeToolDefinitions(config.localTools, 'qwen');
        const tools = normalized.tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));

        const turnDetection: Record<string, unknown> = { type: 'server_vad' };
        if (config.vadSilenceDurationMs) {
            turnDetection.silence_duration_ms = config.vadSilenceDurationMs;
        }

        send({
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                voice: config.voice,
                instructions: config.instructions,
                tools,
                turn_detection: turnDetection,
                // DashScope: only PCM supported; input 16 kHz, output 24 kHz
                input_audio_format: 'pcm',
                output_audio_format: 'pcm',
                input_audio_transcription: { model: 'gummy-realtime-v1' },
            },
        });

        log.systemPrompt(config.instructions);
        log.info(`SESSION_UPDATE | tools=${tools.length} (${tools.map((t) => t.function.name).join(', ')}) voice=${config.voice}`);
        console.log(chalk.cyan(`[Qwen Realtime] session.update sent (${tools.length} tools, voice: ${config.voice})`));
    };

    const sendGreeting = () => {
        // DashScope requires at least one user message before response.create.
        // Pass the configured greeting verbatim so the model says it as-is
        // instead of improvising its own opening line.
        const greetingInstruction = config.greeting
            ? `[Call connected. Say exactly: "${config.greeting}"]`
            : '[Call connected. Greet the caller now.]';
        send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: greetingInstruction }],
            },
        });
        send({ type: 'response.create' });
        log.info(`GREETING_REQUESTED | "${config.greeting}"`);
        console.log(chalk.cyan(`[Qwen Realtime] greeting queued: "${config.greeting}"`));
    };

    const startAudioPipe = () => {
        audioMonitor = createAudioPipeMonitor(log);
        participant.getAudioStream().then((audioStream) => {
            audioStream.on('data', (chunk: Buffer) => {
                if (stopped) return;
                audioMonitor?.onChunk(chunk.length);
                send({
                    type: 'input_audio_buffer.append',
                    audio: upsample8kTo16k(chunk).toString('base64'),
                });
            });
            audioStream.on('end', () => audioMonitor?.onStreamEnd());
            audioStream.on('close', () => audioMonitor?.onStreamClose());
            audioStream.on('error', (err: Error) => {
                audioMonitor?.onStreamError(err);
                console.error(chalk.red('[Qwen Realtime] audio stream error:'), err.message);
            });
        }).catch((err: Error) => {
            log.error(`AUDIO_PIPE_INIT_ERROR | error="${err.message}"`);
            console.error(chalk.red('[Qwen Realtime] getAudioStream error:'), err.message);
        });
    };

    let agentTranscriptBuf = '';
    // Set to true when a function call starts streaming, false when response.done fires.
    // Used to prevent barge-in from cancelling an in-progress tool call.
    let functionCallStreaming = false;

    const handleEvent = (event: Record<string, unknown>) => {
        const type = event.type as string;

        switch (type) {
            case 'session.created':
            case 'session.updated':
                log.info(type === 'session.created' ? 'SESSION_CREATED' : 'SESSION_UPDATED');
                console.log(chalk.gray(`[Qwen Realtime] ${type}`));
                break;

            case 'response.output_item.added': {
                // If the model is starting a function_call item, mute any audio it generates
                // (Qwen3.5-Omni vocalizes tool parameters as part of its response — suppress it)
                const item = event.item as Record<string, unknown> | undefined;
                if (item?.type === 'function_call') {
                    audioWriter.clear();
                    agentTranscriptBuf = '';
                    console.log(chalk.gray('[Qwen Realtime] function_call item started — audio muted'));
                }
                break;
            }

            case 'response.audio.delta':
            case 'response.output_audio.delta': {
                const b64 = event.delta as string;
                if (b64 && !audioWriter.cancelled) {
                    audioWriter.write(downsample24kTo8k(Buffer.from(b64, 'base64')));
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
                    // A tool call is in progress — let it complete, don't cancel the response
                    console.log(chalk.gray('[Qwen Realtime] speech started — barge-in suppressed (tool call in progress)'));
                } else {
                    if (responseActive) log.speechEvent('AGENT_INTERRUPTED');
                    console.log(chalk.gray('[Qwen Realtime] speech started — barge-in'));
                    send({ type: 'response.cancel' });
                    audioWriter.clear();
                    agentTranscriptBuf = '';
                }
                break;

            case 'input_audio_buffer.speech_stopped':
                log.speechEvent('CALLER_SPEECH_STOP');
                break;

            case 'conversation.item.input_audio_transcription.completed': {
                const transcript = (event.transcript as string)?.trim() ?? '';
                log.transcript('caller', transcript);
                console.log(chalk.yellowBright(`[User] "${transcript}"`));
                break;
            }

            case 'conversation.item.input_audio_transcription.delta':
                break;

            case 'response.function_call_arguments.delta':
                functionCallStreaming = true;
                break;

            case 'response.function_call_arguments.done': {
                functionCallStreaming = false;
                const callIdArg = event.call_id as string;
                const toolName = event.name as string;
                const args = event.arguments as string;
                pendingCalls.push({ callId: callIdArg, name: toolName, arguments: args });
                log.toolCalled(toolName, callIdArg, args);
                console.log(chalk.cyan(`[Tool] ${toolName}(${args.substring(0, 200)})`));
                break;
            }

            case 'response.created':
                responseActive = true;
                currentResponseId = (event.response as { id?: string } | undefined)?.id ?? '<unknown>';
                log.responseCreated(currentResponseId);
                log.speechEvent('AGENT_SPEECH_START');
                break;

            case 'response.done': {
                functionCallStreaming = false;
                responseActive = false;
                const status = (event.response as { status?: string } | undefined)?.status ?? 'completed';
                log.responseDone(currentResponseId, status);
                log.speechEvent('AGENT_SPEECH_STOP');
                if (pendingCalls.length > 0) {
                    void handlePendingFunctionCalls();
                }
                break;
            }

            case 'error':
                log.error(`SERVER_ERROR | ${JSON.stringify(event)}`);
                console.error(chalk.red('[Qwen Realtime] server error:'), JSON.stringify(event));
                break;

            // Silent events
            case 'response.audio.done':
            case 'response.output_audio.done':
            case 'response.text.delta':
            case 'response.text.done':
            case 'response.output_item.done':
            case 'response.content_part.added':
            case 'response.content_part.done':
            case 'input_audio_buffer.committed':
            case 'input_audio_buffer.cleared':
            case 'conversation.item.created':
            case 'conversation.item.added':
            case 'conversation.created':
            case 'ping':
                break;

            default:
                console.log(chalk.gray(`[Qwen Realtime] unhandled: ${type}`));
        }
    };

    const handlePendingFunctionCalls = async () => {
        const calls = [...pendingCalls];
        pendingCalls.length = 0;

        let callAction: ToolResult | null = null;

        for (const call of calls) {
            try {
                const result = await executeTool(call.name, call.arguments);
                send({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: call.callId,
                        output: result.content,
                    },
                });
                log.toolResult(call.name, call.callId, result.content);
                for (const req of detectRequestedTools(result.content)) {
                    log.ruleInjected(req.tool, call.callId, result.content);
                }
                if (result.action) {
                    callAction = result;
                }
            } catch (err) {
                const msg = (err as Error).message;
                log.error(`TOOL_EXEC_ERROR | tool=${call.name} call_id=${call.callId} error="${msg}"`);
                console.error(chalk.red(`[Qwen Realtime] tool exec error (${call.name}):`), err);
                send({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: call.callId,
                        output: `Error: ${msg}`,
                    },
                });
                log.toolResult(call.name, call.callId, `Error: ${msg}`);
            }
        }

        if (callAction) {
            executeCallAction(callAction);
        } else {
            send({ type: 'response.create' });
        }
    };

    const executeCallAction = (result: ToolResult) => {
        const destination = result.destination ?? '';
        switch (result.action) {
            case 'transfer':
                log.info(`SDK_ACTION | transfer destination=${destination}`);
                console.log(chalk.magentaBright(`[Qwen Realtime] SDK transfer → ${destination}`));
                participant.transfer(destination)
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_TRANSFER_ERROR | destination=${destination} error="${err.message}"`);
                        console.error(chalk.red('[Qwen Realtime] transfer error:'), err.message);
                        if (config.speakOnRouteFailure) sendAssistantMessage(config.routeFailureUserReply);
                    });
                break;

            case 'drop':
                log.info('SDK_ACTION | drop');
                console.log(chalk.magentaBright('[Qwen Realtime] SDK drop'));
                participant.drop()
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_DROP_ERROR | error="${err.message}"`);
                        console.error(chalk.red('[Qwen Realtime] drop error:'), err.message);
                    });
                break;

            case 'transfer_voicemail':
                log.info(`SDK_ACTION | voicemail destination=${destination}`);
                console.log(chalk.magentaBright(`[Qwen Realtime] SDK transferToVoiceMail → ${destination}`));
                participant.transferToVoiceMail(destination)
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_VOICEMAIL_ERROR | destination=${destination} error="${err.message}"`);
                        console.error(chalk.red('[Qwen Realtime] voicemail error:'), err.message);
                        if (config.speakOnRouteFailure) sendAssistantMessage(config.routeFailureUserReply);
                    });
                break;
        }
    };

    const sendAssistantMessage = (text: string) => {
        send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'input_text', text }],
            },
        });
        send({ type: 'response.create' });
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        audioMonitor?.dispose();
        audioWriter.cancel();
        if (ws) { ws.close(); ws = null; }
        log.info('BRIDGE_STOPPED');
        console.log(chalk.yellow('[Qwen Realtime] bridge stopped'));
    };

    const model = config.model ?? 'qwen3.5-omni-flash-realtime';
    const wsBase = config.baseUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/api-ws/v1/realtime?model=${model}`;

    ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    ws.on('upgrade', (res) => {
        log.info(`WS_UPGRADE | status=${res.statusCode}`);
        console.log(chalk.gray(`[Qwen Realtime] HTTP upgrade: ${res.statusCode}`));
    });

    ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
            log.error(`WS_REJECTED | status=${res.statusCode} body=${body}`);
            console.error(chalk.red(`[Qwen Realtime] WebSocket rejected: ${res.statusCode} ${res.statusMessage}`));
            console.error(chalk.red(`[Qwen Realtime] Response body: ${body}`));
        });
    });

    ws.on('open', () => {
        log.info('WS_OPEN');
        console.log(chalk.green('[Qwen Realtime] WebSocket connected'));
        sendSessionUpdate();
        sendGreeting();
        startAudioPipe();
    });

    ws.on('message', (data: WebSocket.RawData) => {
        if (stopped) return;
        try {
            const raw = data.toString();
            const event = JSON.parse(raw) as Record<string, unknown>;
            if (!event.type) {
                log.error(`WS_MESSAGE_WITHOUT_TYPE | preview="${raw.substring(0, 500)}"`);
                console.error(chalk.red('[Qwen Realtime] message without type:'), raw.substring(0, 500));
                return;
            }
            handleEvent(event);
        } catch (err) {
            log.error(`WS_PARSE_ERROR | error="${(err as Error).message}"`);
            console.error(chalk.red('[Qwen Realtime] parse error:'), err);
        }
    });

    ws.on('close', (code, reason) => {
        log.info(`WS_CLOSE | code=${code} reason="${reason.toString()}"`);
        console.log(chalk.yellow(`[Qwen Realtime] WebSocket closed: ${code} ${reason.toString()}`));
        ws = null;
    });

    ws.on('error', (err) => {
        log.error(`WS_ERROR | error="${err.message}"`);
        console.error(chalk.red('[Qwen Realtime] WebSocket error:'), err.message);
    });

    return { stop };
}

function createNoopLogger(): CallLogger {
    return {
        callId: 0,
        callStart() { },
        callEnd() { },
        systemPrompt() { },
        transcript() { },
        speechEvent() { },
        responseCreated() { },
        responseDone() { },
        ruleInjected() { },
        toolCalled() { },
        toolResult() { },
        info() { },
        warn() { },
        error() { },
        close() { },
    };
}
