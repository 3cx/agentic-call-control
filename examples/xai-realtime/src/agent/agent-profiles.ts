import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import Mustache from 'mustache';

export interface PolicyConfig {
    action: 'endcall' | 'transfer';
    destination?: string;
}

export interface AgentProfile {
    role: string;
    prompt: string;
    greeting?: string;
    voice?: string;
    callScreening?: boolean;
    checkAvailability?: boolean;
    allowedActions: string[];
    mcpTools?: string[] | 'all';
    blockedExtensions?: string[];
    allowedExtensions?: string[];
    policies?: {
        spam?: PolicyConfig;
        hostility?: PolicyConfig;
        nonCollaborative?: PolicyConfig;
    };
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
    if (policy.action === 'transfer' && policy.destination) {
        return `- ${label}: call transfer_call("${policy.destination}").`;
    }
    return `- ${label}: call end_call.`;
}

export function renderPrompt(profile: AgentProfile, ctx: CallContext): string {
    const actionFlags: Record<string, boolean> = {};
    for (const action of profile.allowedActions) {
        actionFlags[`allow_${action}`] = true;
    }

    const featureFlags: Record<string, boolean> = {};
    if (profile.callScreening) featureFlags.call_screening = true;
    if (profile.checkAvailability) featureFlags.check_availability = true;

    const policyLines: string[] = [];
    if (profile.policies) {
        const s = renderPolicyInstruction('Spam/robocall', profile.policies.spam);
        const h = renderPolicyInstruction('Hostile or abusive', profile.policies.hostility);
        const n = renderPolicyInstruction('Uncooperative after 2 polite attempts', profile.policies.nonCollaborative);
        if (s) policyLines.push(s);
        if (h) policyLines.push(h);
        if (n) policyLines.push(n);
    }

    const view = {
        ...ctx,
        ...actionFlags,
        ...featureFlags,
        has_policies: policyLines.length > 0,
        policy_rules: policyLines.join('\n'),
    };
    return Mustache.render(profile.prompt, view);
}
