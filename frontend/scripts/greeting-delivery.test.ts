/**
 * Каналы вручения (фича №26) — сборка адресов шаринга.
 *
 * Проверяется чистая часть; React-экран не поднимается, DOM-тестов в
 * проекте нет. Ценность именно здесь: ошибка в кодировании параметра
 * не падает и не видна — ссылка просто приходит получателю обрезанной
 * по первому `&` или `#`, и узнают об этом от него.
 *
 * Проверено «обратным ходом»: без `encodeURIComponent` падают три
 * проверки из четырёх, с потерянным пробелом в WhatsApp — своя.
 *
 * Запуск: `npm test` во frontend.
 */
import assert from 'node:assert/strict';
import {
  deliveryMessage,
  mailtoUrl,
  oneYearLater,
  reminderIcs,
  telegramShareUrl,
  whatsappShareUrl,
} from '../src/features/projects/greeting-delivery';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('greeting-delivery (№26)');

// Настоящая ссылка Blob: в ней есть и параметры, и дефис, и точки —
// то есть всё, на чём ломается наивная конкатенация.
const URL_WITH_PARAMS =
  'https://blob.example.com/sessions/abc/video.mp4?download=1&v=2';

it('адрес ролика кодируется целиком — иначе получатель увидит обрезок', () => {
  const t = telegramShareUrl(URL_WITH_PARAMS, 'привет');
  // После кодирования внутри значения не должно остаться ни одного
  // «живого» & — он разделяет параметры самой ссылки шаринга.
  const value = t.slice(t.indexOf('url=') + 4, t.indexOf('&text='));
  assert.ok(!value.includes('&'), `амперсанд уцелел: ${value}`);
  assert.equal(decodeURIComponent(value), URL_WITH_PARAMS);
});

it('текст с переносом строки и кириллицей переживает mailto', () => {
  const m = mailtoUrl('Поздравление', 'Марина, это для тебя', URL_WITH_PARAMS);
  const body = decodeURIComponent(m.slice(m.indexOf('&body=') + 6));
  assert.ok(body.includes('Марина, это для тебя'));
  assert.ok(body.includes(URL_WITH_PARAMS));
  assert.ok(body.includes('\n'), 'перенос строки потерялся');
});

it('WhatsApp кладёт текст и ссылку в один параметр, не склеивая слова', () => {
  const w = whatsappShareUrl(URL_WITH_PARAMS, 'Марина, это для тебя');
  const text = decodeURIComponent(w.slice(w.indexOf('text=') + 5));
  assert.equal(text, `Марина, это для тебя ${URL_WITH_PARAMS}`);
});

it('имя отправителя необязательно — без него не остаётся висящего «от»', () => {
  const template = '{recipient}, это для тебя ({sender})';
  assert.equal(
    deliveryMessage(template, 'Марина', 'Андрей'),
    'Марина, это для тебя (Андрей)'
  );
  assert.equal(
    deliveryMessage(template, 'Марина', null),
    'Марина, это для тебя'
  );
  assert.equal(
    deliveryMessage(template, 'Марина', '   '),
    'Марина, это для тебя'
  );
});

it('слишком длинное имя не уносит сообщение за предел Telegram', () => {
  const long = 'Я'.repeat(400);
  const msg = deliveryMessage('{recipient}, это для тебя', long, null);
  assert.ok(msg.length <= 200, `длина ${msg.length}`);
  assert.ok(msg.endsWith('…'), 'обрезка без многоточия читается как сбой');
});

/**
 * Фича №25 в переформулировке аудита (находка 1.10): напоминание
 * ОТПРАВИТЕЛЮ, а не «календарь получателя».
 *
 * Проверено «обратным ходом»: с `\n` вместо CRLF падает проверка
 * переносов, без экранирования — проверка запятой, с `setFullYear`
 * вместо UTC — проверка 29 февраля.
 */
it('високосный день не уезжает на сутки при переносе на год', () => {
  // 29 февраля 2028 → 2029 года нет такой даты; UTC-конструктор даёт
  // 1 марта, локальный — может дать 28 февраля или 1 марта в
  // зависимости от часового пояса машины сборки.
  const leap = new Date(Date.UTC(2028, 1, 29));
  const next = oneYearLater(leap);
  assert.equal(next.getUTCFullYear(), 2029);
  assert.equal(next.toISOString().slice(0, 10), '2029-03-01');
  // Обычная дата переносится ровно.
  assert.equal(
    oneYearLater(new Date(Date.UTC(2026, 8, 22)))
      .toISOString()
      .slice(0, 10),
    '2027-09-22'
  );
});

it('ics — переносы строк CRLF, как требует RFC 5545', () => {
  const ics = reminderIcs({
    summary: 'Поздравить Марину',
    description: 'Сделать ролик',
    date: new Date(Date.UTC(2027, 8, 22)),
  });
  const lines = ics.split('\r\n');
  assert.ok(lines.length > 10, 'файл не разбился по CRLF');
  assert.ok(!ics.includes('\n\n'), 'остались одиночные переводы строки');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
});

it('ics — событие на весь день на нужную дату и напоминание за неделю', () => {
  const ics = reminderIcs({
    summary: 'Поздравить Марину',
    description: 'Сделать ролик',
    date: new Date(Date.UTC(2027, 8, 22)),
  });
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20270922'), 'дата начала неверна');
  assert.ok(
    ics.includes('DTEND;VALUE=DATE:20270923'),
    'день должен закрываться следующим'
  );
  assert.ok(ics.includes('TRIGGER:-P7D'), 'напоминание не за неделю');
});

it('ics — запятая в имени не разрывает поле', () => {
  // Запятая в VCALENDAR разделяет значения: неэкранированная превращает
  // одну тему в список из двух, и календарь показывает обрывок.
  const ics = reminderIcs({
    summary: 'Поздравить Марину, снова',
    description: 'Сделать ролик; как в прошлом году',
    date: new Date(Date.UTC(2027, 8, 22)),
  });
  assert.ok(ics.includes('SUMMARY:Поздравить Марину\\, снова'));
  assert.ok(ics.includes('DESCRIPTION:Сделать ролик\\; как в прошлом году'));
});

console.log(`\n${passed} проверок пройдено`);
