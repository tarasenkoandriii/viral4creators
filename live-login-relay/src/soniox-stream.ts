/** Optional voice transport on the existing VPS server. No budget DB or new service.
 * Grants are issued ONLY after sites-backend has charged its existing SiteBudget.
 * A process-specific boot id prevents grant replay after a VPS restart.
 */
import { randomUUID, createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { safeEqual } from './auth';

export interface StreamGrant {
  boot: string;
  id: string;
  expires: number;
  seconds: number;
}
export function streamSignature(secret: string, grant: string): string {
  return createHmac('sha256', secret)
    .update(`soniox-stream-v1:${grant}`)
    .digest('base64url');
}

export class SonioxStream {
  readonly boot = randomUUID();
  private readonly used = new Map<string, number>();
  private readonly active = new Set<() => void>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32_000,
    perMessageDeflate: false,
  });

  constructor(
    private readonly secret: string,
    private readonly apiKey: string,
    private readonly connect: () => WebSocket = () =>
      new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: 5000,
        maxPayload: 128 * 1024,
      }),
  ) {
    this.wss.on('connection', (client) => this.attach(client));
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Unauthenticated sockets are bounded too; no upstream before grant validation.
    if (this.wss.clients.size >= 8) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.wss.emit('connection', ws),
    );
  }

  close(): void {
    for (const stop of this.active) stop();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private attach(client: WebSocket): void {
    let upstream: WebSocket | undefined;
    let ended = false;
    let ready = false;
    let bytes = 0;
    let started = 0;
    let maxBytes = 0;
    let deadline: ReturnType<typeof setTimeout>;
    const send = (data: string) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 128 * 1024) return stop();
      client.send(data);
    };
    const stop = () => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      clearTimeout(auth);
      upstream?.terminate();
      client.close();
      this.active.delete(stop);
    };
    const auth = setTimeout(stop, 3000);
    this.active.add(stop);
    client.on('error', stop);
    client.on('close', stop);
    client.on('message', (data, binary) => {
      if (ended) return;
      if (!upstream) {
        try {
          if (binary) return stop();
          const p = JSON.parse(data.toString()) as {
            grant: string;
            signature: string;
          };
          if (
            typeof p.grant !== 'string' ||
            typeof p.signature !== 'string' ||
            !safeEqual(p.signature, streamSignature(this.secret, p.grant))
          )
            return stop();
          const g = JSON.parse(
            Buffer.from(p.grant, 'base64url').toString(),
          ) as StreamGrant;
          const now = Date.now();
          for (const [id, expiry] of this.used) {
            if (expiry <= now) this.used.delete(id);
          }
          if (
            g.boot !== this.boot ||
            typeof g.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(g.id) ||
            !Number.isSafeInteger(g.seconds) ||
            g.seconds < 1 ||
            g.seconds > 30 ||
            !Number.isSafeInteger(g.expires) ||
            g.expires <= now ||
            g.expires > now + 35_000 ||
            this.used.has(g.id) ||
            this.used.size >= 10_000 ||
            this.active.size > 4
          )
            return stop();
          this.used.set(g.id, g.expires);
          clearTimeout(auth);
          started = now;
          maxBytes = g.seconds * 32_000;
          // Absolute deadline includes connect/drain; silence cannot run up a bill.
          deadline = setTimeout(
            stop,
            Math.min(g.seconds * 1000, g.expires - now),
          );
          upstream = this.connect();
          const up = upstream;
          up.on('error', stop);
          up.on('close', stop);
          up.on('open', () => {
            if (ended) return up.terminate();
            up.send(
              JSON.stringify({
                model: 'stt-rt-v5',
                audio_format: 'pcm_s16le',
                sample_rate: 16000,
                num_channels: 1,
                enable_endpoint_detection: true,
                client_reference_id: g.id,
              }),
            );
            ready = true;
            send(JSON.stringify({ type: 'ready' }));
          });
          up.on('message', (raw) => {
            if (ended) return;
            try {
              const result = JSON.parse(raw.toString()) as {
                error_code?: number;
                error_type?: string;
                finished?: boolean;
              };
              // Don't leak provider diagnostic text, keys or request content.
              if (result.error_code || result.error_type) return stop();
              send(raw.toString());
              if (result.finished) stop();
            } catch {
              stop();
            }
          });
        } catch {
          stop();
        }
        return;
      }
      if (!binary) {
        // Stop is immediate; finish allows provider to flush within original deadline.
        if (data.toString() === 'stop') return stop();
        if (data.toString() === '' && ready) {
          ready = false;
          upstream.send('');
          return;
        }
        return stop();
      }
      const chunk = Buffer.from(data as Buffer);
      bytes += chunk.length;
      if (
        !ready ||
        !chunk.length ||
        chunk.length % 2 ||
        bytes > maxBytes ||
        bytes > (Date.now() - started + 1000) * 32 ||
        upstream.bufferedAmount > 64_000
      )
        return stop();
      upstream.send(chunk);
    });
  }
}
