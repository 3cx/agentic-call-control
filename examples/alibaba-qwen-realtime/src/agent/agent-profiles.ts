import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import Mustache from 'mustache';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

export interface PolicyConfig {
    action: 'endcall' | 'transfer';
    destination?: string;
}

export interface AgentProfile {
    role: string;
    prompt: string;
    greeting: string;
    voice?: string;
    callScreening?: boolean;
    checkAvailability?: boolean;
    mcpTools?: string[] | 'all';
    blockedExtensions?: string[];
    allowedExtensions?: string[];
    language?: string;
    policies?: {
        spam?: PolicyConfig;
        hostility?: PolicyConfig;
        nonCollaborative?: PolicyConfig;
    };
    maxCallDurationSec?: number;
    maxCallDurationMessage?: string;
    routeFailureUserReply?: string;
}

export interface CallContext {
    company_name: string;
    agent_name: string;
    caller_name: string;
    caller_number: string;
}

export function loadAgentProfile(profileName: string): AgentProfile {
    const profilePath = resolve(process.cwd(), 'agents', `${profileName}.yaml`);
    let raw: string;
    try {
        raw = readFileSync(profilePath, 'utf-8');
    } catch {
        throw new Error(`Agent profile not found: ${profilePath}`);
    }
    return load(raw) as AgentProfile;
}

function renderPolicyInstruction(label: string, policy?: PolicyConfig): string {
    if (!policy) return '';
    if (policy.action === 'endcall') {
        return `- ${label}: say a brief goodbye, then use drop_call.`;
    }
    if (policy.action === 'transfer' && policy.destination) {
        return `- ${label}: say a brief goodbye, then use transfer_call with destination "${policy.destination}".`;
    }
    return `- ${label}: say a brief goodbye, then use drop_call.`;
}

export function renderPrompt(
    profile: AgentProfile,
    ctx: CallContext,
    tools?: ChatCompletionFunctionTool[],
): string {
    const featureFlags: Record<string, boolean> = {};
    if (profile.callScreening) featureFlags.call_screening = true;
    if (profile.checkAvailability) featureFlags.check_availability = true;

    const policyLines: string[] = [];
    if (profile.policies) {
        const s = renderPolicyInstruction('Spam or robocall', profile.policies.spam);
        const h = renderPolicyInstruction('Hostile or abusive caller', profile.policies.hostility);
        const n = renderPolicyInstruction('Caller refuses to cooperate after two polite attempts', profile.policies.nonCollaborative);
        if (s) policyLines.push(s);
        if (h) policyLines.push(h);
        if (n) policyLines.push(n);
    }

    const lang = profile.language ?? '';
    if (lang) featureFlags.has_language = true;

    const toolLines = (tools ?? []).map(t =>
        `- ${t.function.name}: ${t.function.description}`
    );
    const toolList = toolLines.join('\n  ');

    const view = {
        ...ctx,
        ...featureFlags,
        has_policies: policyLines.length > 0,
        policy_rules: policyLines.join('\n  '),
        tool_list: toolList,
        agent_language: lang,
    };
    return Mustache.render(profile.prompt, view);
}
