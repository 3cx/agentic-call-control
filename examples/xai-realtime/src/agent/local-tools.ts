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
        description: 'Connect the caller to a specific extension number. If the person is unavailable, offer voicemail or transfer elsewhere',
        parameters: {
            type: 'object',
            properties: {
                extension_number: { type: 'string', description: 'Extension number from directory search result' },
            },
            required: ['extension_number'],
        },
    },
};

export const TOOL_LEAVE_VOICEMAIL: LocalToolDef = {
    type: 'function',
    function: {
        name: 'leave_voicemail',
        description: 'Send the caller to voicemail for the specified extension.',
        parameters: {
            type: 'object',
            properties: {
                extension_number: { type: 'string', description: 'Extension number whose voicemail to use' },
            },
            required: ['extension_number'],
        },
    },
};

export const TOOL_END_CALL: LocalToolDef = {
    type: 'function',
    function: {
        name: 'end_call',
        description: 'Hang up the call. Use only when the caller says goodbye or for policy violations.',
        parameters: { type: 'object', properties: {} },
    },
};

export function buildLocalTools(opts?: { callScreening?: boolean }): LocalToolDef[] {
    const tools: LocalToolDef[] = [TOOL_TRANSFER_CALL, TOOL_LEAVE_VOICEMAIL, TOOL_END_CALL];
    if (opts?.callScreening) {
        tools.push(TOOL_UPDATE_SCREENING);
    }
    return tools;
}

export function isExtensionAllowed(ext: string, profile: AgentProfile): boolean {
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
