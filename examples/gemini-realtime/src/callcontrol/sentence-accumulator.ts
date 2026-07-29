const MIN_FLUSH_LENGTH = 10;
const SENTENCE_END_RE = /[.?!](?:\s|(?=[A-Z]))/;
const FIRST_FLUSH_TIMEOUT_MS = 1200;


export class SentenceAccumulator {
    private buffer = '';
    private flushedOnce = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly onSentence: (text: string) => void;

    constructor(onSentence: (text: string) => void) {
        this.onSentence = onSentence;
    }

    push(delta: string): void {
        this.buffer += delta;

        if (!this.flushedOnce && !this.timer) {
            this.timer = setTimeout(() => this.forceFirstFlush(), FIRST_FLUSH_TIMEOUT_MS);
        }

        this.tryFlush();
    }

    end(): void {
        this.clearTimer();
        const text = this.buffer.trim();
        if (text.length > 0) {
            this.onSentence(text);
        }
        this.buffer = '';
    }

    private tryFlush(): void {
        let match: RegExpExecArray | null;
        while ((match = SENTENCE_END_RE.exec(this.buffer)) !== null) {
            const cutIndex = match.index + match[0].length;
            const sentence = this.buffer.slice(0, cutIndex).trim();
            this.buffer = this.buffer.slice(cutIndex);

            if (!this.flushedOnce || sentence.length >= MIN_FLUSH_LENGTH) {
                this.emitSentence(sentence);
            } else {
                this.buffer = sentence + ' ' + this.buffer;
                return;
            }
        }
    }

    private forceFirstFlush(): void {
        this.timer = null;
        if (this.flushedOnce) return;
        const text = this.buffer.trim();
        if (text.length > 0) {
            this.buffer = '';
            this.emitSentence(text);
        }
    }

    private emitSentence(text: string): void {
        if (!this.flushedOnce) {
            this.flushedOnce = true;
            this.clearTimer();
        }
        this.onSentence(text);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
