/// <reference lib="dom" />
import { createHash, createHmac } from 'node:crypto';
import { VoiceStream } from '../../widget/src/chat/voice-stream';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SonioxStream, streamSignature } from '../src/soniox-stream';
import {
  signStreamGrant,
  readStreamFinal,
} from '../../sites-backend/src/modules/assist-site-voice/public/stream-grant';

const secret = 'mock-relay-secret';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (fn()) return;
    await pause(5);
  }
  throw Error('timeout');
}

class FakeUpstream extends EventEmitter {
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  terminated = false;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  terminate() {
    this.terminated = true;
    this.emit('close');
  }
}

describe('Soniox in the existing relay (no provider network)', () => {
  let relay: SonioxStream;
  let server: ReturnType<typeof createServer>;
  let url: string;
  let upstreams: FakeUpstream[];
  beforeEach(async () => {
    upstreams = [];
    relay = new SonioxStream(secret, 'fake-key', () => {
      const up = new FakeUpstream();
      upstreams.push(up);
      setTimeout(() => up.emit('open'), 5);
      return up as unknown as WebSocket;
    });
    server = createServer();
    server.on('upgrade', (req, socket, head) =>
      relay.upgrade(req, socket, head),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    url = `ws://127.0.0.1:${port}/voice/stream`;
  });
  afterEach(async () => {
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function grant(p: Record<string, unknown> = {}) {
    const g = Buffer.from(
      JSON.stringify({
        boot: relay.boot,
        id: 'reservation-1',
        expires: Date.now() + 5000,
        seconds: 5,
        ...p,
      }),
    ).toString('base64url');
    return { grant: g, signature: streamSignature(secret, g) };
  }
  async function attach(auth = grant()) {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    ws.on('message', (raw) => messages.push(raw.toString()));
    await once(ws, 'open');
    ws.send(JSON.stringify(auth));
    return { ws, messages };
  }
  it('streams fixed PCM, preserves confidence, Stop closes without retry', async () => {
    const { ws, messages } = await attach();
    await until(() => messages.length === 1);
    ws.send(Buffer.alloc(320));
    await until(() => upstreams[0].sent.length === 2);
    expect(JSON.parse(upstreams[0].sent[0] as string)).toMatchObject({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
    });
    upstreams[0].emit(
      'message',
      Buffer.from(
        '{"tokens":[{"text":"yes","confidence":0.3,"is_final":true}]}',
      ),
    );
    await pause(10);
    expect(messages).toHaveLength(1);
    ws.send('stop');
    await once(ws, 'close');
    expect(upstreams[0].terminated).toBe(true);
    expect(upstreams).toHaveLength(1);
  });
  it.each(['invalid', 'expired', 'old-boot'])(
    'rejects %s before any upstream',
    async (kind) => {
      const auth =
        kind === 'invalid'
          ? { grant: 'x', signature: 'bad' }
          : grant(
              kind === 'expired'
                ? { expires: Date.now() - 1 }
                : { boot: 'old' },
            );
      const { ws } = await attach(auth);
      await once(ws, 'close');
      expect(upstreams).toHaveLength(0);
    },
  );
  it('one grant cannot open duplicate or reconnect after Stop', async () => {
    const auth = grant();
    const a = await attach(auth);
    await until(() => a.messages.length > 0);
    const b = await attach(auth);
    await once(b.ws, 'close');
    expect(upstreams).toHaveLength(1);
    a.ws.send('stop');
    await once(a.ws, 'close');
    const c = await attach(auth);
    await once(c.ws, 'close');
    expect(upstreams).toHaveLength(1);
  });
  it('upstream failure stops client without reconnect or audio replay', async () => {
    const { ws, messages } = await attach();
    await until(() => messages.length > 0);
    upstreams[0].emit('error', Error('fake'));
    await once(ws, 'close');
    expect(upstreams).toHaveLength(1);
  });
  it('absolute grant deadline closes even silent connection', async () => {
    const { ws } = await attach(grant({ expires: Date.now() + 100 }));
    await once(ws, 'close');
    expect(upstreams[0].terminated).toBe(true);
  });
  it('stream seals only final tokens after finish, never partial text', async () => {
    const auth = grant();
    const { ws, messages } = await attach(auth);
    await until(() => messages.length === 1);
    ws.send(Buffer.alloc(320));
    upstreams[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          tokens: [{ text: 'wrong', is_final: false, confidence: 1 }],
        }),
      ),
    );
    upstreams[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          tokens: [{ text: 'hello', is_final: true, confidence: 0.95 }],
        }),
      ),
    );
    await pause(10);
    expect(messages).toHaveLength(1);
    ws.send('');
    await until(() => upstreams[0].sent.includes(''));
    upstreams[0].emit(
      'message',
      Buffer.from(JSON.stringify({ tokens: [], finished: true })),
    );
    await once(ws, 'close');
    const final = JSON.parse(messages[1]);
    const body = JSON.parse(Buffer.from(final.receipt, 'base64url').toString());
    expect(final.type).toBe('final');
    expect(body.tokens).toEqual([
      {
        text: 'hello',
        is_final: true,
        confidence: 0.95,
        is_audio_event: false,
      },
    ]);
    expect(body.grantHash).toBe(
      createHash('sha256').update(auth.grant).digest('hex'),
    );
    expect(final.signature).toBe(
      createHmac('sha256', secret)
        .update(`soniox-final-v1:${final.receipt}`)
        .digest('base64url'),
    );
  });

  it('accepts the backend grant and returns a receipt the backend validates', async () => {
    const auth = signStreamGrant(secret, {
      boot: relay.boot,
      id: 'backend-reservation',
      expires: Date.now() + 5000,
      seconds: 5,
      siteId: 'sandbox-site',
      visitorId: 'sandbox-visitor',
    });
    const { ws, messages } = await attach(auth);
    await until(() => messages.length === 1);
    ws.send(Buffer.alloc(320));
    ws.send('');
    await until(() => upstreams[0].sent.includes(''));
    upstreams[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          tokens: [
            { text: 'partial command', is_final: false, confidence: 1 },
            { text: 'Stop', is_final: true, confidence: 0.99 },
            { text: '<end>', is_final: true },
          ],
          finished: true,
        }),
      ),
    );
    await once(ws, 'close');
    const receipt = { ...JSON.parse(messages[1]), grant: auth.grant };
    const now = Date.now();
    const parsed = readStreamFinal(
      secret,
      receipt,
      'sandbox-site',
      'sandbox-visitor',
      now,
    );
    expect(parsed?.id).toBe('backend-reservation');
    expect(parsed?.tokens.map((t) => t.text)).toEqual(['Stop', '<end>']);
    expect(
      readStreamFinal(secret, receipt, 'other-site', 'sandbox-visitor', now),
    ).toBeNull();
    expect(
      readStreamFinal(secret, receipt, 'sandbox-site', 'other-visitor', now),
    ).toBeNull();
    expect(
      readStreamFinal(
        secret,
        { ...receipt, grant: receipt.grant + 'x' },
        'sandbox-site',
        'sandbox-visitor',
        now,
      ),
    ).toBeNull();
    expect(
      readStreamFinal(
        secret,
        receipt,
        'sandbox-site',
        'sandbox-visitor',
        now + 70_000,
      ),
    ).toBeNull();
    expect(upstreams).toHaveLength(1);
    expect(upstreams[0].terminated).toBe(true);
  });

  it('connects the real widget transport to relay and backend verifier, including Stop', async () => {
    const localUrl = url;
    // Only the socket URL is adapted: all wire messages use production code.
    class LocalSocket extends WebSocket {
      constructor() {
        super(localUrl);
      }
    }
    let failed = 0;
    let issued = 0;
    const authorize = async () => ({
      url: 'wss://relay.example/voice/stream',
      ...signStreamGrant(secret, {
        boot: relay.boot,
        id: `widget-${++issued}`,
        expires: Date.now() + 5000,
        seconds: 5,
        siteId: 'sandbox-site',
        visitorId: 'sandbox-visitor',
      }),
    });
    const widget = new VoiceStream(
      authorize,
      () => failed++,
      LocalSocket as unknown as typeof globalThis.WebSocket,
    );
    widget.audio(new Blob([new Uint8Array(320)]));
    const pending = widget.finish();
    await until(() => upstreams.length === 1 && upstreams[0].sent.includes(''));
    expect(upstreams[0].sent.filter(Buffer.isBuffer)).toHaveLength(1);
    upstreams[0].emit(
      'message',
      Buffer.from(
        JSON.stringify({
          tokens: [{ text: 'Стоп', confidence: 0.99, is_final: true }],
          finished: true,
        }),
      ),
    );
    const receipt = await pending;
    expect(
      readStreamFinal(
        secret,
        receipt,
        'sandbox-site',
        'sandbox-visitor',
        Date.now(),
      )?.tokens[0].text,
    ).toBe('Стоп');
    expect(failed).toBe(0);
    const stopped = new VoiceStream(
      authorize,
      () => failed++,
      LocalSocket as unknown as typeof globalThis.WebSocket,
    );
    await until(() => upstreams.length === 2);
    stopped.stop();
    await expect(stopped.result).rejects.toThrow('stream stopped');
    await until(() => upstreams[1].terminated);
    expect(failed).toBe(1);
    expect(issued).toBe(2);
    expect(upstreams).toHaveLength(2); // Each explicit session once; no retry.
  });

  it('overspeed PCM fails closed and is not forwarded', async () => {
    const { ws, messages } = await attach();
    await until(() => messages.length > 0);
    ws.send(Buffer.alloc(32_000));
    ws.send(Buffer.alloc(32_000));
    await once(ws, 'close');
    expect(upstreams[0].sent.filter(Buffer.isBuffer)).toHaveLength(1);
  });
});
