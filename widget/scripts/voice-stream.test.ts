import assert from 'node:assert/strict';
import { VoiceStream } from '../src/chat/voice-stream';
class Socket {
  static all: Socket[] = [];
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed = false;
  onopen = () => {};
  onclose = () => {};
  onerror = () => {};
  onmessage = (_e: { data: string }) => {};
  constructor(readonly url: string) {
    Socket.all.push(this);
  }
  send(v: unknown) {
    this.sent.push(v);
  }
  close() {
    this.closed = true;
  }
  message(v: unknown) {
    this.onmessage({ data: JSON.stringify(v) });
  }
}
const auth = async () => ({
  url: 'wss://relay.example/voice/stream',
  grant: 'grant',
  signature: 'signature',
});
const tick = () => new Promise((r) => setTimeout(r, 0));
async function main() {
  let failed = 0;
  const stream = new VoiceStream(
    auth,
    () => failed++,
    Socket as unknown as typeof WebSocket
  );
  stream.audio(new Blob(['header']));
  await tick();
  const ws = Socket.all.at(-1)!;
  ws.onopen();
  ws.message({ type: 'ready' });
  assert.equal(ws.sent.length, 2);
  assert.ok(ws.sent[1] instanceof Blob);
  // Provisional text never resolves the final; only a signed server receipt does.
  ws.message({ tokens: [{ text: 'yes', is_final: false }] });
  const result = stream.finish();
  assert.equal(ws.sent.at(-1), '');
  // Capture has ended: late PCM or repeated ready/finish must not corrupt
  // the drain phase or send a second provider terminator.
  stream.audio(new Blob(['late audio']));
  stream.finish();
  ws.message({ type: 'ready' });
  assert.equal(ws.sent.filter((v) => v === '').length, 1);
  assert.equal(ws.sent.length, 3);
  ws.message({ type: 'final', receipt: 'receipt', signature: 'signed' });
  assert.deepEqual(await result, {
    grant: 'grant',
    receipt: 'receipt',
    signature: 'signed',
  });
  ws.onclose();
  assert.equal(failed, 0);
  const count = Socket.all.length;
  const cancelled = new VoiceStream(
    auth,
    () => failed++,
    Socket as unknown as typeof WebSocket
  );
  cancelled.stop();
  await tick();
  assert.equal(Socket.all.length, count);
  assert.equal(failed, 1);
  const broken = new VoiceStream(
    auth,
    () => failed++,
    Socket as unknown as typeof WebSocket
  );
  await tick();
  const last = Socket.all.at(-1)!;
  last.onerror();
  last.onclose();
  await tick();
  assert.equal(failed, 2);
  assert.equal(Socket.all.length, count + 1);
  last.message({ type: 'final', receipt: 'late', signature: 'late' });
  broken.audio(new Blob(['late']));
  assert.equal(last.sent.length, 0);
  const overflow = new VoiceStream(
    auth,
    () => failed++,
    Socket as unknown as typeof WebSocket
  );
  overflow.audio(new Blob([new Uint8Array(128001)]));
  await tick();
  assert.equal(failed, 3);
  console.log(
    'stream: ordered chunks, final-only receipt, Stop, no reconnect, bounded queue — ok'
  );
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
