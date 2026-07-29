import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { AgentProfile } from './agent-profiles.ts';

export const TOOL_SAVE_CALLER_NAME: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_name',
        description: 'Record the caller\'s name into the system.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The caller\'s full name' },
            },
            required: ['name'],
        },
    },
};

export const TOOL_SAVE_CALLER_COMPANY: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_company',
        description: 'Record the caller\'s company into the system.',
        parameters: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'The company name' },
            },
            required: ['company'],
        },
    },
};

export const TOOL_SAVE_CALLER_REASON: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_reason',
        description: 'Record the reason for calling into the system.',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'The reason for calling' },
            },
            required: ['reason'],
        },
    },
};

export const TOOL_TRANSFER_CALL: ChatCompletionFunctionTool = {
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

export const TOOL_DROP_CALL: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'drop_call',
        description: 'Hang up the current call.',
        parameters: { type: 'object', properties: {} },
    },
};

export const TOOL_TRANSFER_TO_VOICEMAIL: ChatCompletionFunctionTool = {
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

export function buildLocalTools(opts?: { callScreening?: boolean }): ChatCompletionFunctionTool[] {
    const tools: ChatCompletionFunctionTool[] = [
        TOOL_TRANSFER_CALL,
        TOOL_DROP_CALL,
        TOOL_TRANSFER_TO_VOICEMAIL,
    ];
    if (opts?.callScreening) {
        tools.push(TOOL_SAVE_CALLER_NAME, TOOL_SAVE_CALLER_COMPANY, TOOL_SAVE_CALLER_REASON);
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
