export interface CallerInfo {
    name: string;
    number: string;
}

export interface CallScreening {
    name?: string;
    company?: string;
    reason?: string;
    tone?: string;
}

export interface PhonebookContact {
    extensionNumber: string;
    displayName: string;
    isAvailable?: boolean;
}

export interface CallState {
    callerInfo: CallerInfo;
    screening: CallScreening;
    /** Last single-match result from list_phonebook — used for unavailability guard. */
    pendingRoute?: PhonebookContact;
    /** Set to true once a route action has been committed — prevents double-fire. */
    routeCommitted?: boolean;
}

export function createCallState(callerName: string, callerNumber: string): CallState {
    return {
        callerInfo: { name: callerName, number: callerNumber },
        screening: {},
    };
}

export function formatScreening(s: CallScreening): string {
    return `Name: ${s.name ?? 'unknown'}, Company: ${s.company ?? 'unknown'}, Reason: ${s.reason ?? 'unknown'}, Tone: ${s.tone ?? 'neutral'}`;
}

export function isScreeningReady(s: CallScreening): boolean {
    return !!s.name && !!s.company && !!s.reason;
}

export function missingScreeningFields(s: CallScreening): string[] {
    const missing: string[] = [];
    if (!s.name) missing.push('name');
    if (!s.company) missing.push('company');
    if (!s.reason) missing.push('reason');
    return missing;
}
