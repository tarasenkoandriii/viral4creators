/**
 * Разбор SSE `event: <type>\ndata: <json>\n\n` (стык W1 ↔ W2, контракт §5)
 * по кускам произвольной длины: событие может разорваться на границе чанка.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buf = '';

  push(chunk: string): SseEvent[] {
    this.buf += chunk.replace(/\r\n?/g, '\n');
    const out: SseEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.charAt(0) === ':') continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        let value = c < 0 ? '' : line.slice(c + 1);
        if (value.charAt(0) === ' ') value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}
