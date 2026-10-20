import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SonioxStream, streamSignature } from '../src/soniox-stream';

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
    await until(() => messages.length === 2);
    expect(JSON.parse(messages[1]).tokens[0].confidence).toBe(0.3);
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
  it('overspeed PCM fails closed and is not forwarded', async () => {
    const { ws, messages } = await attach();
    await until(() => messages.length > 0);
    ws.send(Buffer.alloc(32_000));
    ws.send(Buffer.alloc(32_000));
    await once(ws, 'close');
    expect(upstreams[0].sent.filter(Buffer.isBuffer)).toHaveLength(1);
  });
});
