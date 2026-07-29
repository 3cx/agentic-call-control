import WebSocket from 'ws';
import chalk from 'chalk';
import type { IncomingMessage, ClientRequest } from 'http';
import type { Participant } from '@3cx/call-control-sdk';
import { normalizeToolDefinitions } from '@3cx-examples/mcp';
import type { ToolResult } from '../agent/tool-executor.ts';
import { isUnavailableRouteError } from '../agent/call-routing.ts';
import { detectRequestedTools, createAudioPipeMonitor } from '@3cx-examples/logger';
import type { CallLogger, AudioPipeMonitor } from '@3cx-examples/logger';

export interface XaiBridgeConfig {
    xaiApiKey: string;
    voice: string;
    instructions: string;
    vadSilenceDurationMs?: number;
    model?: string;
    localTools: XaiToolDef[];
    openingLine: string;
    speakOnRouteFailure: boolean;
    routeFailureUserReply: string;
    logger?: CallLogger;
}

export interface XaiToolDef {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface XaiBridgeHandle {
    stop: () => void;
}

interface PendingFunctionCall {
    callId: string;
    name: string;
    arguments: string;
}

export function createXaiRealtimeBridge(
    participant: Participant,
    config: XaiBridgeConfig,
    executeTool: (name: string, argsJson: string) => Promise<ToolResult>,
): XaiBridgeHandle {
    const log = config.logger ?? createNoopLogger();
    let stopped = false;
    let ws: WebSocket | null = null;
    let responseActive = false;
    let greetingSent = false;
    let greetingPhase = false;
    let currentResponseId = '';
    let audioMonitor: AudioPipeMonitor | null = null;
    const pendingCalls: PendingFunctionCall[] = [];
    let toolNameMap = new Map<string, string>();

    const audioWriter = participant.getAudioWriter();
    // Track the last time the audio buffer drained so we can schedule post-drain
    // actions even when onceDrained fires before we register the callback.
    let lastDrainTime = 0;
    audioWriter.onDrained(() => { lastDrainTime = Date.now(); });

    const send = (obj: Record<string, unknown>) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const sendSessionUpdate = () => {
        const normalized = normalizeToolDefinitions(config.localTools, 'xai');
        toolNameMap = normalized.originalNameByName;
        const tools: Record<string, unknown>[] = normalized.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));

        const turnDetection: Record<string, unknown> = { type: 'server_vad' };
        if (config.vadSilenceDurationMs) {
            turnDetection.silence_duration_ms = config.vadSilenceDurationMs;
        }

        send({
            type: 'session.update',
            session: {
                voice: config.voice,
                instructions: config.instructions,
                tools,
                turn_detection: turnDetection,
                audio: {
                    input: { format: { type: 'audio/pcm', rate: 8000 } },
                    output: { format: { type: 'audio/pcm', rate: 8000 } },
                },
            },
        });

        log.systemPrompt(config.instructions);
        log.info(`SESSION_UPDATE | tools=${tools.length} (${tools.map((t) => t.name).join(', ')}) voice=${config.voice}`);
        console.log(chalk.cyan(`[xAI] session.update sent (${tools.length} tools, voice: ${config.voice})`));
    };

    const startAudioPipe = () => {
        audioMonitor = createAudioPipeMonitor(log);
        participant.getAudioStream().then((audioStream) => {
            audioStream.on('data', (chunk: Buffer) => {
                if (stopped) return;
                audioMonitor?.onChunk(chunk.length);
                send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
            });
            audioStream.on('end', () => audioMonitor?.onStreamEnd());
            audioStream.on('close', () => audioMonitor?.onStreamClose());
            audioStream.on('error', (err: Error) => {
                audioMonitor?.onStreamError(err);
                console.error(chalk.red('[xAI] audio stream error:'), err.message);
            });
        }).catch((err: Error) => {
            log.error(`AUDIO_PIPE_INIT_ERROR | error="${err.message}"`);
            console.error(chalk.red('[xAI] getAudioStream error:'), err.message);
        });
    };

    let agentTranscriptBuf = '';

    const handleEvent = (event: Record<string, unknown>) => {
        const type = event.type as string;

        switch (type) {
        case 'session.created':
            log.info('SESSION_CREATED');
            console.log(chalk.gray('[xAI] session.created'));
            break;

        case 'session.updated':
            log.info('SESSION_UPDATED');
            console.log(chalk.gray('[xAI] session.updated'));
            if (!greetingSent) {
                greetingSent = true;
                greetingPhase = true;
                send({
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: `[Call connected. Say exactly: "${config.openingLine}"]` }],
                    },
                });
                send({ type: 'response.create' });
                log.info(`GREETING_REQUESTED | "${config.openingLine}"`);
                console.log(chalk.cyan(`[xAI] opening greeting requested: "${config.openingLine}"`));
            }
            break;

        case 'response.audio.delta':
        case 'response.output_audio.delta': {
            const b64 = event.delta as string;
            if (b64 && !audioWriter.cancelled) {
                audioWriter.write(Buffer.from(b64, 'base64'));
            }
            break;
        }

        case 'response.output_audio_transcript.delta':
            agentTranscriptBuf += (event.delta as string) ?? '';
            break;

        case 'response.output_audio_transcript.done':
            if (agentTranscriptBuf) {
                log.transcript('agent', agentTranscriptBuf.trim());
                console.log(chalk.blueBright(`[Agent] "${agentTranscriptBuf.trim()}"`));
                agentTranscriptBuf = '';
            }
            break;

        case 'input_audio_buffer.speech_started':
            log.speechEvent('CALLER_SPEECH_START');
            if (greetingPhase) break;
            if (responseActive) {
                log.speechEvent('AGENT_INTERRUPTED');
                send({ type: 'response.cancel' });
            }
            console.log(chalk.gray('[xAI] barge-in'));
            audioWriter.clear();
            agentTranscriptBuf = '';
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

        case 'response.function_call_arguments.done': {
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
            responseActive = false;
            const status = (event.response as { status?: string } | undefined)?.status ?? 'completed';
            log.responseDone(currentResponseId, status);
            log.speechEvent('AGENT_SPEECH_STOP');
            if (greetingPhase) {
                greetingPhase = false;
                console.log(chalk.gray('[xAI] opening greeting complete'));
            }
            if (pendingCalls.length > 0) {
                handlePendingFunctionCalls();
            }
            break;
        }

        case 'error': {
            const errMsg = (event.error as { message?: string })?.message ?? '';
            // Ignore benign race: barge-in cancel arrives after response already completed.
            if (errMsg.includes('Cancellation failed')) break;
            log.error(`SERVER_ERROR | ${JSON.stringify(event)}`);
            console.error(chalk.red('[xAI] server error:'), JSON.stringify(event));
            break;
        }

        case 'response.audio.done':
        case 'response.output_audio.done':
        case 'response.text.delta':
        case 'response.text.done':
        case 'response.output_item.added':
        case 'response.output_item.done':
        case 'response.content_part.added':
        case 'response.content_part.done':
        case 'input_audio_buffer.committed':
        case 'input_audio_buffer.cleared':
        case 'conversation.item.created':
        case 'conversation.item.added':
        case 'conversation.created':
        case 'response.function_call_arguments.delta':
        case 'ping':
            break;

        default:
            console.log(chalk.gray(`[xAI] unhandled: ${type}`));
        }
    };

    const handlePendingFunctionCalls = async () => {
        const calls = [...pendingCalls];
        pendingCalls.length = 0;

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

                // If the tool result text names a follow-up tool (e.g.
                // 'call transfer_call("200")'), record it as a RULE_INJECTED
                // marker — strictly a record of OUR outbound text, not a
                // judgement about what the model will do next.
                for (const req of detectRequestedTools(result.content)) {
                    log.ruleInjected(req.tool, call.callId, result.content);
                }

                if (result.action) callAction = result;
            } catch (err) {
                const msg = (err as Error).message;
                log.error(`TOOL_EXEC_ERROR | tool=${toolName} call_id=${call.callId} error="${msg}"`);
                console.error(chalk.red(`[xAI] tool exec error (${toolName}):`), err);
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
            // Audio deltas arrive before function calls in xAI protocol, so by
            // response.done the buffer is already written and often fully drained.
            // onceDrained may not fire if audio drained before we registered it,
            // so we also use a short fallback delay.
            const action = callAction;
            let dispatched = false;
            const dispatch = () => {
                if (dispatched) return;
                dispatched = true;
                executeCallAction(action);
            };
            // Allow audio to propagate through network and PBX playback buffer.
            const PROPAGATION_MS = 150;
            if (audioWriter.bufferedBytes > 0) {
                // Audio still queued — fire when buffer drains + propagation margin.
                audioWriter.onceDrained(() => setTimeout(dispatch, PROPAGATION_MS));
            } else if (lastDrainTime > 0) {
                // Buffer already drained — wait for any remaining propagation time.
                const remaining = Math.max(0, PROPAGATION_MS - (Date.now() - lastDrainTime));
                setTimeout(dispatch, remaining);
            } else {
                // No audio was produced — execute immediately.
                dispatch();
            }
        } else {
            send({ type: 'response.create' });
        }
    };

    const executeCallAction = (result: ToolResult) => {
        const destination = result.destination ?? '';

        switch (result.action) {
        case 'connect':
            log.info(`SDK_ACTION | transfer destination=${destination}`);
            console.log(chalk.magentaBright(`[xAI] SDK transfer → ${destination}`));
            participant.transfer(destination)
                .then(() => stop())
                .catch((err: Error) => {
                    const hint = isUnavailableRouteError(err) ? 'unavailable' : 'failed';
                    log.warn(`SDK_TRANSFER_ERROR | hint=${hint} destination=${destination} error="${err.message}"`);
                    console.error(chalk.red(`[xAI] transfer error (${hint}):`), err.message);
                    log.info(`SDK_ACTION | voicemail (fallback) destination=${destination}`);
                    console.log(chalk.yellow(`[xAI] fallback to voicemail → ${destination}`));
                    participant.transferToVoiceMail(destination)
                        .then(() => stop())
                        .catch((vmErr: Error) => {
                            log.error(`SDK_VOICEMAIL_FALLBACK_ERROR | destination=${destination} error="${vmErr.message}"`);
                            console.error(chalk.red('[xAI] voicemail fallback error:'), vmErr.message);
                            if (config.speakOnRouteFailure) sendUserMessage(config.routeFailureUserReply);
                        });
                });
            break;

        case 'drop':
            log.info('SDK_ACTION | drop');
            console.log(chalk.magentaBright('[xAI] SDK drop'));
            participant.drop()
                .then(() => stop())
                .catch((err: Error) => {
                    log.error(`SDK_DROP_ERROR | error="${err.message}"`);
                    console.error(chalk.red('[xAI] drop error:'), err.message);
                });
            break;

        case 'voicemail':
            log.info(`SDK_ACTION | voicemail destination=${destination}`);
            console.log(chalk.magentaBright(`[xAI] SDK transferToVoiceMail → ${destination}`));
            participant.transferToVoiceMail(destination)
                .then(() => stop())
                .catch((err: Error) => {
                    log.error(`SDK_VOICEMAIL_ERROR | destination=${destination} error="${err.message}"`);
                    console.error(chalk.red('[xAI] voicemail error:'), err.message);
                    if (config.speakOnRouteFailure) sendUserMessage(config.routeFailureUserReply);
                });
            break;
        }
    };

    const sendUserMessage = (text: string) => {
        send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'input_text', text }],
            },
        });
        send({ type: 'response.create' });
        log.info(`SYSTEM_MESSAGE_SENT | "${text}"`);
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        audioMonitor?.dispose();
        audioWriter.cancel();
        if (ws) { ws.close(); ws = null; }
        log.info('BRIDGE_STOPPED');
        console.log(chalk.yellow('[xAI] bridge stopped'));
    };

    const wsUrl = `wss://api.x.ai/v1/realtime?model=${config.model ?? 'grok-voice-latest'}`;
    ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${config.xaiApiKey}` },
    });

    ws.on('upgrade', (res: IncomingMessage) => {
        log.info(`WS_UPGRADE | status=${res.statusCode}`);
        console.log(chalk.gray(`[xAI] HTTP upgrade: ${res.statusCode}`));
    });

    ws.on('unexpected-response', (_req: ClientRequest, res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
            log.error(`WS_REJECTED | status=${res.statusCode} body=${body}`);
            console.error(chalk.red(`[xAI] WebSocket rejected: ${res.statusCode}`));
            console.error(chalk.red(`[xAI] Response body: ${body}`));
        });
    });

    ws.on('open', () => {
        log.info('WS_OPEN');
        console.log(chalk.green('[xAI] WebSocket connected'));
        sendSessionUpdate();
        startAudioPipe();
    });

    ws.on('message', (data: WebSocket.RawData) => {
        if (stopped) return;
        try {
            handleEvent(JSON.parse(data.toString()));
        } catch (err) {
            log.error(`WS_PARSE_ERROR | error="${(err as Error).message}"`);
            console.error(chalk.red('[xAI] parse error:'), err);
        }
    });

    ws.on('close', (code: number, reason: Buffer) => {
        log.info(`WS_CLOSE | code=${code} reason="${reason.toString()}"`);
        console.log(chalk.yellow(`[xAI] WebSocket closed: ${code} ${reason.toString()}`));
        ws = null;
    });

    ws.on('error', (err: Error) => {
        log.error(`WS_ERROR | error="${err.message}"`);
        console.error(chalk.red('[xAI] WebSocket error:'), err.message);
    });

    return { stop };
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
