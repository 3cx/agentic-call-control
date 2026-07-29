import chalk from 'chalk';
import type { AppConfig } from '../app-config.ts';

const DEFAULT_FIRST_UTTERANCE_DELAY_MS = 400;

export function firstUtteranceDelayMs(config: AppConfig): number {
    return config.voiceBehavior?.firstUtteranceDelayMs ?? DEFAULT_FIRST_UTTERANCE_DELAY_MS;
}

export async function waitForFirstUtteranceDelay(config: AppConfig, logPrefix: string): Promise<void> {
    const ms = firstUtteranceDelayMs(config);
    if (ms <= 0) return;
    console.log(chalk.gray(`${logPrefix} first utterance delay ${ms}ms`));
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
