/**
 * Per-call file logger shared across realtime voice-agent examples.
 *
 * Captures structured evidence of tool dispatch vs tool execution so we can
 * file detailed bug reports with model providers about ignored tool
 * instructions. Each call gets its own UTF-8 log file with timestamps;
 * chalk-coloured terminal output from the rest of the code continues to
 * print as before.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const BANNER_TOP = '╔══════════════════════════════════════════════════════════════╗';
const BANNER_BOT = '╚══════════════════════════════════════════════════════════════╝';
const PROMPT_TOP = '━━━ SYSTEM PROMPT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const PROMPT_BOT = '━━━ END SYSTEM PROMPT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export type SpeechEvent =
    | 'CALLER_SPEECH_START'
    | 'CALLER_SPEECH_STOP'
    | 'AGENT_SPEECH_START'
    | 'AGENT_SPEECH_STOP'
    | 'AGENT_INTERRUPTED';

export interface CallLoggerOptions {
    /** Directory to write log files into. Defaults to `<cwd>/logs`. */
    logDir?: string;
    /** Tag shown on chalk lines mirrored to the terminal (e.g. `xAI`, `Gemini`, `Qwen`). */
    tag?: string;
}

export interface CallLogger {
    readonly callId: number | string;
    callStart(callerName: string, callerNumber: string): void;
    callEnd(): void;
    systemPrompt(prompt: string): void;
    transcript(side: 'caller' | 'agent', text: string): void;
    speechEvent(event: SpeechEvent): void;
    responseCreated(responseId: string, step?: string): void;
    responseDone(responseId: string, status: string): void;
    /**
     * Factual marker: we appended a rule to a tool result asking the model
     * to call `toolName` as a follow-up. Records WHAT WE SENT, not what the
     * model did. Pair with subsequent toolCalled() lines to assess behaviour.
     */
    ruleInjected(toolName: string, callId: string | undefined, instruction: string): void;
    /** Wire-truth: the model fired a tool. This is the headline event. */
    toolCalled(toolName: string, callId: string, args: string): void;
    toolResult(toolName: string, callId: string, output: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    close(): void;
}

const loggers = new Map<string, CallLogger>();

function pad(n: number, w = 2): string {
    return String(n).padStart(w, '0');
}

function tsFile(): string {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
        + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function tsLine(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function escapeLine(s: string): string {
    return s.replace(/\r?\n/g, ' \\n ');
}

export function getCallLogger(callId: number | string, options: CallLoggerOptions = {}): CallLogger {
    const key = String(callId);
    const existing = loggers.get(key);
    if (existing) return existing;

    const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');
    const tag = options.tag ?? 'Logger';

    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, `call-${key}-${tsFile()}.log`);
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    let startedAt: number | null = null;
    let closed = false;

    const write = (level: string, line: string) => {
        if (closed) return;
        stream.write(`${tsLine()} | ${level} | {call: ${key}} ${escapeLine(line)}\n`);
    };

    const writeRaw = (level: string, multiline: string) => {
        for (const line of multiline.split('\n')) write(level, line);
    };

    const logger: CallLogger = {
        callId,

        callStart(name, number) {
            startedAt = Date.now();
            const ts = tsLine();
            const header = `║  CALL START  id=${key}  caller=${name} ${number}  ${ts}    ║`;
            write('INFO', BANNER_TOP);
            write('INFO', header);
            write('INFO', BANNER_BOT);
            console.log(chalk.greenBright(BANNER_TOP));
            console.log(chalk.greenBright(header));
            console.log(chalk.greenBright(BANNER_BOT));
        },

        callEnd() {
            const duration = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
            const ts = tsLine();
            const header = `║  CALL END    id=${key}  duration=${duration}s  ${ts}             ║`;
            write('INFO', BANNER_TOP);
            write('INFO', header);
            write('INFO', BANNER_BOT);
            console.log(chalk.greenBright(BANNER_TOP));
            console.log(chalk.greenBright(header));
            console.log(chalk.greenBright(BANNER_BOT));
            logger.close();
        },

        systemPrompt(prompt) {
            write('INFO', PROMPT_TOP);
            writeRaw('INFO', prompt);
            write('INFO', PROMPT_BOT);
        },

        transcript(side, text) {
            if (side === 'caller') write('INFO', `[CALLER] → "${text}"`);
            else write('INFO', `[AGENT]  ← "${text}"`);
        },

        speechEvent(event) {
            write('INFO', event);
        },

        responseCreated(responseId, step) {
            write('INFO', `RESPONSE_CREATED | response_id=${responseId}${step ? ` step=${step}` : ''}`);
        },

        responseDone(responseId, status) {
            write('INFO', `RESPONSE_DONE    | response_id=${responseId} status=${status}`);
        },

        ruleInjected(toolName, reqCallId, instruction) {
            write('INFO',
                `RULE_INJECTED  | follow_up_tool=${toolName} call_id=${reqCallId ?? '<none>'} `
                + `note="rule appended to tool result, NOT a model action" instruction="${escapeLine(instruction)}"`);
        },

        toolCalled(toolName, callIdArg, args) {
            write('INFO', '────────────────  MODEL FIRED TOOL  ────────────────');
            write('INFO', `TOOL_CALLED    | tool=${toolName} call_id=${callIdArg} args=${args}`);
            console.log(chalk.green.bold(`[${tag}] ► TOOL_CALLED  ${toolName}(${args})`));
        },

        toolResult(toolName, callIdArg, output) {
            write('INFO', `TOOL_RESULT    | tool=${toolName} call_id=${callIdArg} output=${output}`);
        },

        info(message) { write('INFO', message); },
        warn(message) { write('WARN', message); },
        error(message) { write('ERROR', message); },

        close() {
            if (closed) return;
            closed = true;
            stream.end();
            loggers.delete(key);
        },
    };

    loggers.set(key, logger);
    return logger;
}

/** Scan a tool result for the rule pattern that names a follow-up tool to call. */
export function detectRequestedTools(output: string): { tool: string; arg: string }[] {
    const matches: { tool: string; arg: string }[] = [];
    const re = /call\s+(\w+)\(\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
        matches.push({ tool: m[1], arg: m[2] });
    }
    return matches;
}
