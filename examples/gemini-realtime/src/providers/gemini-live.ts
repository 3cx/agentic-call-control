import WebSocket from 'ws';
import chalk from 'chalk';
import type { Participant } from '@3cx/call-control-sdk';
import { normalizeToolDefinitions } from '@3cx-examples/mcp';
import type { ToolResult } from '../agent/tool-executor.ts';
import { upsample8kTo16k, downsample24kTo8k } from '../callcontrol/audio-utils.ts';
import { SentenceAccumulator } from '../callcontrol/sentence-accumulator.ts';
import { detectRequestedTools, createAudioPipeMonitor } from '@3cx-examples/logger';
import type { CallLogger, AudioPipeMonitor } from '@3cx-examples/logger';

export interface GeminiBridgeConfig {
    geminiApiKey: string;
    voice: string;
    instructions: string;
    model?: string;
    silenceDurationMs?: number;
    localTools: GeminiToolDef[];
    greeting: string;
    speakOnRouteFailure: boolean;
    routeFailureUserReply: string;
    logger?: CallLogger;
}

export interface GeminiToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface GeminiBridgeHandle {
    stop: () => void;
}

interface PendingFunctionCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export function createGeminiLiveBridge(
    participant: Participant,
    config: GeminiBridgeConfig,
    executeTool: (name: string, argsJson: string) => Promise<ToolResult>,
): GeminiBridgeHandle {
    const log = config.logger ?? createNoopLogger();
    let stopped = false;
    let callActionPending = false;
    let ws: WebSocket | null = null;
    let setupComplete = false;
    let audioMonitor: AudioPipeMonitor | null = null;
    const pendingCalls: PendingFunctionCall[] = [];

    const audioWriter = participant.getAudioWriter();

    const inputAccum = new SentenceAccumulator((text) => {
        log.transcript('caller', text);
        console.log(chalk.yellowBright(`[User] "${text}"`));
    });
    const outputAccum = new SentenceAccumulator((text) => {
        log.transcript('agent', text);
        console.log(chalk.blueBright(`[Agent] "${text}"`));
    });

    const send = (obj: Record<string, unknown>) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    const sendSetup = () => {
        const model = config.model ?? 'models/gemini-3.1-flash-live-preview';

        const normalized = normalizeToolDefinitions(config.localTools, 'gemini');
        const functionDeclarations = normalized.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));

        const systemText = config.instructions;

        send({
            setup: {
                model,
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: config.voice },
                        },
                    },
                },
                systemInstruction: {
                    parts: [{ text: systemText }],
                },
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
                        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                        silenceDurationMs: config.silenceDurationMs ?? 500,
                    },
                },
                tools: functionDeclarations.length > 0
                    ? [{ functionDeclarations }]
                    : [],
                inputAudioTranscription: {},
                outputAudioTranscription: {},
            },
        });

        log.systemPrompt(systemText);
        log.info(`SETUP_SENT | tools=${functionDeclarations.length} (${functionDeclarations.map((t) => t.name).join(', ')}) voice=${config.voice} model=${model}`);
        console.log(chalk.cyan(`[Gemini] setup sent (${functionDeclarations.length} tools, voice: ${config.voice}, model: ${model})`));
    };

    const startAudioPipe = () => {
        audioMonitor = createAudioPipeMonitor(log);
        participant.getAudioStream().then((audioStream) => {
            audioStream.on('data', (chunk: Buffer) => {
                if (stopped || !setupComplete || callActionPending) return;
                audioMonitor?.onChunk(chunk.length);
                const upsampled = upsample8kTo16k(chunk);
                send({
                    realtimeInput: {
                        audio: {
                            data: upsampled.toString('base64'),
                            mimeType: 'audio/pcm;rate=16000',
                        },
                    },
                });
            });
            audioStream.on('end', () => audioMonitor?.onStreamEnd());
            audioStream.on('close', () => audioMonitor?.onStreamClose());
            audioStream.on('error', (err: Error) => {
                audioMonitor?.onStreamError(err);
                console.error(chalk.red('[Gemini] audio stream error:'), err.message);
            });
        }).catch((err: Error) => {
            log.error(`AUDIO_PIPE_INIT_ERROR | error="${err.message}"`);
            console.error(chalk.red('[Gemini] getAudioStream error:'), err.message);
        });
    };

    const handleMessage = (msg: Record<string, unknown>) => {
        // Setup complete — start audio pipe and trigger greeting
        if (msg.setupComplete !== undefined) {
            setupComplete = true;
            log.info('SETUP_COMPLETE');
            console.log(chalk.green('[Gemini] setup complete'));
            startAudioPipe();

            // Trigger Gemini to speak the greeting by sending an initial turn
            const greetingInstruction = config.greeting
                ? `[Call connected. Say exactly: "${config.greeting}"]`
                : '[Call connected. Greet the caller now.]';
            send({
                clientContent: {
                    turns: [{
                        role: 'user',
                        parts: [{ text: greetingInstruction }],
                    }],
                    turnComplete: true,
                },
            });

            return;
        }

        // Server content (audio, transcription, interruption, turn complete)
        if (msg.serverContent) {
            const sc = msg.serverContent as Record<string, unknown>;

            // Barge-in / interruption
            if (sc.interrupted === true) {
                log.speechEvent('AGENT_INTERRUPTED');
                console.log(chalk.gray('[Gemini] interrupted — barge-in'));
                audioWriter.clear();
                return;
            }

            // Model audio output
            const modelTurn = sc.modelTurn as Record<string, unknown> | undefined;
            if (modelTurn?.parts) {
                const parts = modelTurn.parts as Record<string, unknown>[];
                for (const part of parts) {
                    const inlineData = part.inlineData as Record<string, unknown> | undefined;
                    if (inlineData?.data && !audioWriter.cancelled) {
                        const pcm24k = Buffer.from(inlineData.data as string, 'base64');
                        const pcm8k = downsample24kTo8k(pcm24k);
                        audioWriter.write(pcm8k);
                    }
                }
            }

            // Input transcription (user speech)
            const inputTranscription = sc.inputTranscription as Record<string, unknown> | undefined;
            if (inputTranscription?.text) {
                inputAccum.push(inputTranscription.text as string);
            }

            // Output transcription (agent speech)
            const outputTranscription = sc.outputTranscription as Record<string, unknown> | undefined;
            if (outputTranscription?.text) {
                outputAccum.push(outputTranscription.text as string);
            }

            // Turn complete — flush accumulators and process any pending tool calls
            if (sc.turnComplete === true) {
                inputAccum.end();
                outputAccum.end();
                if (pendingCalls.length > 0) {
                    handlePendingFunctionCalls();
                }
            }

            return;
        }

        // Tool calls
        if (msg.toolCall) {
            const tc = msg.toolCall as Record<string, unknown>;
            const functionCalls = tc.functionCalls as Record<string, unknown>[] | undefined;
            if (functionCalls) {
                for (const fc of functionCalls) {
                    const argsObj = (fc.args as Record<string, unknown>) ?? {};
                    pendingCalls.push({
                        id: fc.id as string,
                        name: fc.name as string,
                        args: argsObj,
                    });
                    log.toolCalled(fc.name as string, fc.id as string, JSON.stringify(argsObj));
                    console.log(chalk.cyan(`[Tool] ${fc.name}(${JSON.stringify(argsObj).substring(0, 200)})`));
                }
                handlePendingFunctionCalls();
            }
            return;
        }

        // Tool call cancellation
        if (msg.toolCallCancellation) {
            const tcc = msg.toolCallCancellation as Record<string, unknown>;
            const ids = tcc.ids as string[] | undefined;
            if (ids) {
                log.warn(`TOOL_CALL_CANCELLED | ids=${ids.join(',')}`);
                console.log(chalk.gray(`[Gemini] tool call cancelled: ${ids.join(', ')}`));
                // Remove cancelled calls from pending
                for (const id of ids) {
                    const idx = pendingCalls.findIndex((c) => c.id === id);
                    if (idx >= 0) pendingCalls.splice(idx, 1);
                }
            }
            return;
        }

        // Go away (server disconnecting)
        if (msg.goAway) {
            log.warn('SERVER_GO_AWAY | session ending');
            console.log(chalk.yellow('[Gemini] server sent goAway — session ending'));
            return;
        }
    };

    const handlePendingFunctionCalls = async () => {
        const calls = [...pendingCalls];
        pendingCalls.length = 0;

        let callAction: ToolResult | null = null;
        const functionResponses: Record<string, unknown>[] = [];

        for (const call of calls) {
            try {
                const result = await executeTool(call.name, JSON.stringify(call.args));

                functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { result: result.content },
                });

                log.toolResult(call.name, call.id, result.content);
                for (const req of detectRequestedTools(result.content)) {
                    log.ruleInjected(req.tool, call.id, result.content);
                }

                if (result.action) {
                    callAction = result;
                }
            } catch (err) {
                const msg = (err as Error).message;
                log.error(`TOOL_EXEC_ERROR | tool=${call.name} call_id=${call.id} error="${msg}"`);
                console.error(chalk.red(`[Gemini] tool exec error (${call.name}):`), err);
                functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { error: `Error: ${msg}` },
                });
                log.toolResult(call.name, call.id, `Error: ${msg}`);
            }
        }

        // Send all tool responses at once
        send({
            toolResponse: { functionResponses },
        });

        if (callAction) {
            callActionPending = true;
            audioWriter.onceDrained(() => executeCallAction(callAction!));
        }
        // Gemini auto-generates response after tool response — no explicit trigger needed
    };

    const executeCallAction = (result: ToolResult) => {
        const destination = result.destination ?? '';

        switch (result.action) {
            case 'transfer':
                log.info(`SDK_ACTION | transfer destination=${destination}`);
                console.log(chalk.magentaBright(`[Gemini] SDK transfer → ${destination}`));
                participant.transfer(destination)
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_TRANSFER_ERROR | destination=${destination} error="${err.message}"`);
                        console.error(chalk.red('[Gemini] transfer error:'), err.message);
                        callActionPending = false;
                        if (config.speakOnRouteFailure) {
                            sendClientMessage(config.routeFailureUserReply);
                        }
                    });
                break;

            case 'drop':
                log.info('SDK_ACTION | drop');
                console.log(chalk.magentaBright('[Gemini] SDK drop'));
                participant.drop()
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_DROP_ERROR | error="${err.message}"`);
                        console.error(chalk.red('[Gemini] drop error:'), err.message);
                        callActionPending = false;
                    });
                break;

            case 'transfer_voicemail':
                log.info(`SDK_ACTION | voicemail destination=${destination}`);
                console.log(chalk.magentaBright(`[Gemini] SDK transferToVoiceMail → ${destination}`));
                participant.transferToVoiceMail(destination)
                    .then(() => stop())
                    .catch((err: Error) => {
                        log.error(`SDK_VOICEMAIL_ERROR | destination=${destination} error="${err.message}"`);
                        console.error(chalk.red('[Gemini] voicemail error:'), err.message);
                        callActionPending = false;
                        if (config.speakOnRouteFailure) {
                            sendClientMessage(config.routeFailureUserReply);
                        }
                    });
                break;
        }
    };

    const sendClientMessage = (text: string) => {
        send({
            clientContent: {
                turns: [{
                    role: 'user',
                    parts: [{ text: `[System: Say the following to the caller: "${text}"]` }],
                }],
                turnComplete: true,
            },
        });
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        audioMonitor?.dispose();
        audioWriter.cancel();
        if (ws) {
            ws.close();
            ws = null;
        }
        log.info('BRIDGE_STOPPED');
        console.log(chalk.yellow('[Gemini] bridge stopped'));
    };

    // Connect
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.geminiApiKey}`;

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        log.info('WS_OPEN');
        console.log(chalk.green('[Gemini] WebSocket connected'));
        sendSetup();
    });

    ws.on('message', (data: WebSocket.RawData) => {
        if (stopped) return;
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(msg);
        } catch (err) {
            log.error(`WS_PARSE_ERROR | error="${(err as Error).message}"`);
            console.error(chalk.red('[Gemini] parse error:'), err);
        }
    });

    ws.on('close', (code, reason) => {
        log.info(`WS_CLOSE | code=${code} reason="${reason.toString()}"`);
        console.log(chalk.yellow(`[Gemini] WebSocket closed: ${code} ${reason.toString()}`));
        ws = null;
    });

    ws.on('error', (err) => {
        log.error(`WS_ERROR | error="${err.message}"`);
        console.error(chalk.red('[Gemini] WebSocket error:'), err.message);
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
