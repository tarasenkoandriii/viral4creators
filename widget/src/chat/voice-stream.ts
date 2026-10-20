/** One explicit utterance. No reconnect, paid retry, storage or partial commands. */
export class VoiceStream {
  private ws: WebSocket | null = null;
  private queue: Blob[] = [];
  private bytes = 0;
  private ready = false;
  private finished = false;
  private closed = false;
  private grant = '';
  private timer: ReturnType<typeof setTimeout>;
  readonly result: Promise<{
    grant: string;
    receipt: string;
    signature: string;
  }>;
  private resolve!: (v: {
    grant: string;
    receipt: string;
    signature: string;
  }) => void;
  private reject!: (e: Error) => void;
  constructor(
    authorize: () => Promise<{ url: string; grant: string; signature: string }>,
    private readonly failed: () => void,
    private readonly Socket: typeof WebSocket = WebSocket
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Error may arrive during recording, before caller awaits the result.
    void this.result.catch(() => {});
    this.timer = setTimeout(() => this.stop(), 32_000);
    void authorize()
      .then((p) => {
        if (this.closed) return;
        const url = new URL(p.url);
        if (
          url.protocol !== 'wss:' ||
          url.username ||
          url.password ||
          url.pathname !== '/voice/stream'
        )
          throw Error('stream URL');
        this.grant = p.grant;
        const ws = (this.ws = new this.Socket(url.href));
        ws.onopen = () => {
          if (!this.closed)
            ws.send(JSON.stringify({ grant: p.grant, signature: p.signature }));
        };
        ws.onmessage = (e) => {
          if (this.closed) return;
          try {
            const r = JSON.parse(String(e.data));
            if (r.type === 'ready') {
              this.ready = true;
              this.flush();
            }
            if (
              r.type === 'final' &&
              this.finished &&
              typeof r.receipt === 'string' &&
              r.receipt.length <= 100_000 &&
              typeof r.signature === 'string'
            ) {
              this.resolve({
                grant: this.grant,
                receipt: r.receipt,
                signature: r.signature,
              });
              this.close();
            }
          } catch {
            this.stop();
          }
        };
        ws.onerror = () => this.stop();
        ws.onclose = () => {
          if (!this.closed) this.stop();
        };
      })
      .catch(() => this.stop());
  }
  audio(chunk: Blob) {
    if (this.closed) return;
    this.bytes += chunk.size;
    if (
      this.bytes > 1_000_000 ||
      this.queue.reduce((n, b) => n + b.size, 0) + chunk.size > 128_000
    )
      return this.stop();
    // Split PCM on even byte boundaries; preserve sample order.
    for (let p = 0; p < chunk.size; p += 32_000)
      this.queue.push(chunk.slice(p, p + 32_000));
    this.flush();
  }
  finish() {
    this.finished = true;
    this.flush();
    return this.result;
  }
  stop() {
    if (this.closed) return;
    this.reject(Error('stream stopped'));
    this.close();
    this.failed();
  }
  private flush() {
    if (!this.ready || !this.ws || this.closed) return;
    for (const chunk of this.queue) {
      if (this.ws.bufferedAmount > 128_000) return this.stop();
      this.ws.send(chunk);
    }
    this.queue = [];
    if (this.finished) {
      this.ws.send('');
      this.ready = false;
    }
  }
  private close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue = [];
    this.ws?.close();
  }
}
