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

export function isRouteNotTransferable(
    contact: PhonebookContact | undefined,
    checkAvailability: boolean,
): contact is PhonebookContact {
    return checkAvailability && contact !== undefined && contact.isAvailable === undefined;
}

export function availabilityUnknownHint(contact: PhonebookContact): string {
    return `Cannot connect to ${contact.displayName} — this person is likely in another department. `
        + 'Tell the caller you are unable to transfer them and ask if they would like to speak with someone else. '
        + 'Do not collect screening details, do not offer voicemail, do not transfer.';
}

export function blockIfAvailabilityUnknown(
    contact: PhonebookContact | undefined,
    destination: string,
): string | null {
    if (!contact || contact.extensionNumber !== destination) return null;
    if (contact.isAvailable !== undefined) return null;
    return availabilityUnknownHint(contact);
}

export function finalizePhonebookResult(
    raw: string,
    checkAvailability: boolean,
): { content: string; pendingRoute?: PhonebookContact } {
    const contacts = parsePhonebookContacts(raw);
    const pendingRoute = contacts.length === 1 ? contacts[0] : undefined;
    if (isRouteNotTransferable(pendingRoute, checkAvailability)) {
        return { content: availabilityUnknownHint(pendingRoute), pendingRoute };
    }
    return { content: raw, pendingRoute };
}
