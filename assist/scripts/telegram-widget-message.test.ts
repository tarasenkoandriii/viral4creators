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

// Popup fallback accepts only the official envelope from its exact window.
const { readTelegramPopupMessage, telegramPopupUrl } =
  await import('../src/kit/telegram-widget-message');
const popup = {};
const popupEvent = {
  origin: 'https://oauth.telegram.org',
  source: popup,
  data: JSON.stringify({ event: 'auth_result', result: user }),
};
assert.deepEqual(readTelegramPopupMessage(popupEvent, popup), user);
assert.equal(readTelegramPopupMessage(popupEvent, {}), null);
assert.equal(
  readTelegramPopupMessage(
    { ...popupEvent, origin: 'https://evil.example' },
    popup
  ),
  null
);
assert.equal(readTelegramPopupMessage(event, frame), null);
assert.equal(readTelegramWidgetMessage(popupEvent, popup), null);
assert.equal(
  readTelegramPopupMessage(
    {
      ...popupEvent,
      data: JSON.stringify({ event: 'auth_result', result: false }),
    },
    popup
  ),
  null
);
const popupUrl = new URL(
  telegramPopupUrl('8927439906', 'https://assist-app.viral4creators.app')
);
assert.equal(popupUrl.origin, 'https://oauth.telegram.org');
assert.equal(
  popupUrl.searchParams.get('return_to'),
  'https://assist-app.viral4creators.app/'
);
assert.equal(popupUrl.searchParams.get('request_access'), null);
assert.throws(() =>
  telegramPopupUrl('evil', 'https://assist-app.viral4creators.app')
);
assert.throws(() =>
  telegramPopupUrl('8927439906', 'http://assist-app.viral4creators.app')
);
assert.throws(() =>
  telegramPopupUrl(
    '8927439906',
    'https://assist-app.viral4creators.app/?invite=secret'
  )
);
