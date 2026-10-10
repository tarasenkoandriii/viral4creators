import assert from 'node:assert/strict';
import { readTelegramWidgetMessage } from '../src/kit/telegram-widget-message';
const frame = {};
const user = {
  id: 123,
  auth_date: 1700000000,
  hash: 'a'.repeat(64),
  first_name: 'Demo',
};
const event = {
  origin: 'https://oauth.telegram.org',
  source: frame,
  data: JSON.stringify({ event: 'auth_user', auth_data: user }),
};
assert.deepEqual(readTelegramWidgetMessage(event, frame), user);
assert.equal(
  readTelegramWidgetMessage(
    { ...event, origin: 'https://evil.example' },
    frame
  ),
  null
);
assert.equal(readTelegramWidgetMessage({ ...event, source: {} }, frame), null);
assert.equal(readTelegramWidgetMessage(event, null), null);
assert.equal(
  readTelegramWidgetMessage({ ...event, data: 'not json' }, frame),
  null
);
assert.equal(
  readTelegramWidgetMessage(
    { ...event, data: JSON.stringify({ event: 'resize', auth_data: user }) },
    frame
  ),
  null
);
assert.equal(
  readTelegramWidgetMessage(
    {
      ...event,
      data: JSON.stringify({
        event: 'auth_user',
        auth_data: { ...user, hash: 'bad' },
      }),
    },
    frame
  ),
  null
);
console.log(
  'Telegram login message: trusted iframe accepted; spoofed and malformed messages rejected'
);
