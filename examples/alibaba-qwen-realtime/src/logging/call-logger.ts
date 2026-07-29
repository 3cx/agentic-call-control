import chalk from 'chalk';

const isProduction = process.env.NODE_ENV === 'production';

export interface CallLogger {
    turn(n: number, data: { caller: string; tools: string[]; action?: string; latencyMs: number }): void;
    toolCall(turn: number, name: string, durationMs: number): void;
    event(type: string, data?: Record<string, unknown>): void;
    end(reason: string, totalTurns: number, durationMs: number): void;
}

function localTime(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function emitJson(obj: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

export function createCallLogger(callId: string): CallLogger {
    const shortId = callId.split('-').slice(-1)[0];
    const tag = chalk.blue(`[Call:${shortId}]`);

    return {
        turn(n, { caller, tools, action, latencyMs }) {
            if (isProduction) {
                emitJson({ callId, event: 'turn', turn: n, caller: caller.substring(0, 80), tools, action: action ?? 'none', latencyMs });
                return;
            }
            const toolStr = tools.length ? chalk.cyan(tools.join(', ')) : chalk.gray('—');
            const actionStr = action ? chalk.yellowBright(action) : '';
            console.log(
                `${chalk.gray(localTime())} ${tag} turn ${chalk.white(String(n))} | ${chalk.green(`${latencyMs}ms`)} | tools: ${toolStr}${actionStr ? ` → ${actionStr}` : ''}`,
            );
        },

        toolCall(_turn, name, durationMs) {
            if (isProduction) {
                emitJson({ callId, event: 'tool', tool: name, durationMs });
                return;
            }
            console.log(
                `${chalk.gray(localTime())} ${tag} ${chalk.cyan(name)} ${chalk.green(`${durationMs}ms`)}`,
            );
        },

        event(type, data) {
            if (isProduction) {
                emitJson({ callId, event: type, ...data });
                return;
            }
            const extra = data ? ' ' + chalk.gray(Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')) : '';
            console.log(
                `${chalk.gray(localTime())} ${tag} ${chalk.magenta(type)}${extra}`,
            );
        },

        end(reason, totalTurns, durationMs) {
            if (isProduction) {
                emitJson({ callId, event: 'call_end', reason, totalTurns, durationMs });
                return;
            }
            const durSec = (durationMs / 1000).toFixed(1);
            console.log(
                `${chalk.gray(localTime())} ${tag} ${chalk.yellow('call_end')} ${chalk.white(reason)} | ${totalTurns} turns | ${chalk.green(`${durSec}s`)}`,
            );
        },
    };
}
