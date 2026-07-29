import type { AgentProfile } from './agent-profiles.ts';

export interface LocalToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export const TOOL_UPDATE_SCREENING: LocalToolDef = {
    type: 'function',
    function: {
        name: 'update_screening',
        description: 'Save caller name, company, or reason for calling.',
        parameters: {
            type: 'object',
            properties: {
                field: { type: 'string', enum: ['name', 'company', 'reason'], description: 'Which field to set' },
                value: { type: 'string', description: 'The value for the field' },
            },
            required: ['field', 'value'],
        },
    },
};

export const TOOL_TRANSFER_CALL: LocalToolDef = {
    type: 'function',
    function: {
        name: 'transfer_call',
        description: 'Transfer the current call to an extension.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Extension number to transfer to' },
            },
            required: ['destination'],
        },
    },
};

export const TOOL_DROP_CALL: LocalToolDef = {
    type: 'function',
    function: {
        name: 'drop_call',
        description: 'Hang up the current call.',
        parameters: { type: 'object', properties: {} },
    },
};

export const TOOL_TRANSFER_TO_VOICEMAIL: LocalToolDef = {
    type: 'function',
    function: {
        name: 'transfer_to_voicemail',
        description: 'Send the current call to voicemail of the specified extension.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Extension number whose voicemail to send to' },
            },
            required: ['destination'],
        },
    },
};

export function buildLocalTools(opts?: { callScreening?: boolean }): LocalToolDef[] {
    const tools: LocalToolDef[] = [
        TOOL_TRANSFER_CALL,
        TOOL_DROP_CALL,
        TOOL_TRANSFER_TO_VOICEMAIL,
    ];
    if (opts?.callScreening) {
        tools.push(TOOL_UPDATE_SCREENING);
    }
    return tools;
}

export function isExtensionAllowed(
    ext: string,
    profile: AgentProfile,
): boolean {
    if (profile.allowedExtensions?.length) {
        return profile.allowedExtensions.some((rule) => matchExtensionRule(ext, rule));
    }
    if (profile.blockedExtensions?.length) {
        return !profile.blockedExtensions.some((rule) => matchExtensionRule(ext, rule));
    }
    return true;
}

function matchExtensionRule(ext: string, rule: string): boolean {
    if (rule.includes('-')) {
        const [lo, hi] = rule.split('-');
        const n = parseInt(ext, 10);
        return n >= parseInt(lo, 10) && n <= parseInt(hi, 10);
    }
    return ext === rule;
}
