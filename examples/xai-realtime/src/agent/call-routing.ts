/**
 * Grok-specific enrichments for tool results.
 *
 * Grok (grok-voice-latest) has known reliability issues with autonomous tool calling —
 * it tends to announce actions in speech without actually invoking the tool.
 * These utilities inject explicit routing rules directly into MCP tool results so the
 * model receives them as structured data rather than system prompt instructions,
 * which significantly improves compliance.
 */
import type { PhonebookContact } from './call-state.ts';

export function parsePhonebookContacts(raw: string): PhonebookContact[] {
    try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data
            .filter((c) => c && typeof c.extensionNumber === 'string')
            .map((c) => ({
                extensionNumber: String(c.extensionNumber),
                displayName: String(c.displayName ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()),
                isAvailable: typeof c.isAvailable === 'boolean' ? c.isAvailable : undefined,
            }));
    } catch {
        return [];
    }
}

export function enrichPhonebookResult(raw: string, contacts: PhonebookContact[]): string {
    if (contacts.length === 0) {
        return `${raw}\n\nNo contacts found. Ask for a different name, extension, or email.`;
    }
    if (contacts.length === 1) {
        const c = contacts[0];
        if (c.isAvailable === false) {
            return `${raw}\n\n${c.displayName} (ext ${c.extensionNumber}) is UNAVAILABLE.\n`
                + `RULE: Say they are unavailable and offer voicemail or another destination. `
                + `If caller agrees, call leave_voicemail("${c.extensionNumber}").`;
        }
        if (c.isAvailable === true) {
            return `${raw}\n\n${c.displayName} (ext ${c.extensionNumber}) is AVAILABLE.\n`
                + `Inform the caller that the destination is available and call transfer_call("${c.extensionNumber}").`;
        }
        return `${availabilityUnknownHint(c)}\n`
            + `RULE: Do NOT call transfer_call, leave_voicemail, or collect screening.`;
    }
    const names = contacts.map((c) => {
        const avail = c.isAvailable === true ? 'available'
            : c.isAvailable === false ? 'unavailable'
                : 'availability unknown';
        return `${c.displayName} ext ${c.extensionNumber} (${avail})`;
    }).join('; ');
    return `${raw}\n\nMultiple matches: ${names}. Ask the caller which match to select for transfer. `
        + `Once the caller confirms, call transfer_call or leave_voicemail in that same response.`;
}

export function availabilityUnknownHint(contact: PhonebookContact): string {
    return `Cannot connect to ${contact.displayName} — this person is likely in another department. `
        + 'Tell the caller you are unable to transfer them and ask if they would like to speak with someone else. '
        + 'Do not collect screening details, do not offer voicemail, do not transfer.';
}

export function isRouteNotTransferable(
    contact: PhonebookContact | undefined,
    checkAvailability: boolean,
): contact is PhonebookContact {
    return checkAvailability && contact !== undefined && contact.isAvailable === undefined;
}

export function blockIfAvailabilityUnknown(
    contact: PhonebookContact | undefined,
    destination: string,
): string | null {
    if (!contact || contact.extensionNumber !== destination) return null;
    if (contact.isAvailable !== undefined) return null;
    return availabilityUnknownHint(contact);
}

/** Any SDK/PBX error that means the callee cannot take a live transfer. */
export function isUnavailableRouteError(err: unknown): boolean {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 424) return true;
    const msg = (err as { message?: string }).message?.toLowerCase() ?? '';
    return msg.includes('424') || msg.includes('unavailable') || msg.includes('busy');
}
