import {
  parseElevenLabsBalance,
  parseSerpApiBalance,
  redactKey,
} from './unit-balance';

/**
 * Этап 142. Остаток, который не в деньгах. Разбор проверяется без сети
 * и без ключей: ключей у песочницы нет, а форма чужого ответа — ровно
 * то место, где ошибаются.
 */
describe('parseElevenLabsBalance', () => {
  it('остаток считается как лимит минус истраченное', () => {
    // Готовым он не приходит: провайдер отдаёт израсходованное и лимит.
    expect(
      parseElevenLabsBalance({
        character_count: 40_000,
        character_limit: 100_000,
      }),
    ).toEqual({ left: 60_000, total: 100_000, label: 'символов' });
  });

  it('перебор лимита остаётся отрицательным, а не приводится к нулю', () => {
    // У тарифов с `current_overage` лимит можно перебрать. «Осталось 0»
    // там, где правда «уже должны», — не осторожность, а неверное число.
    expect(
      parseElevenLabsBalance({
        character_count: 120_000,
        character_limit: 100_000,
      })?.left,
    ).toBe(-20_000);
  });

  it('дата сброса переводится из секунд, а не из миллисекунд', () => {
    // Поле у них так и названо — `_unix`. Миллисекунды дали бы 1970-й.
    const at = parseElevenLabsBalance({
      character_count: 0,
      character_limit: 10,
      next_character_count_reset_unix: 1_790_000_000,
    })?.resetsAt;
    expect(at).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it('нулевой срок сброса датой не становится', () => {
    // Ноль — это «сброса нет», а не «сброс был в 1970-м».
    expect(
      parseElevenLabsBalance({
        character_count: 0,
        character_limit: 10,
        next_character_count_reset_unix: 0,
      }),
    ).not.toHaveProperty('resetsAt');
  });

  it('ответ без чисел — null, а не остаток из воздуха', () => {
    expect(parseElevenLabsBalance({ character_count: 1 })).toBeNull();
    expect(parseElevenLabsBalance({ character_limit: 1 })).toBeNull();
    expect(
      parseElevenLabsBalance({ character_count: '40000', character_limit: 1 }),
    ).toBeNull();
    expect(parseElevenLabsBalance(null)).toBeNull();
    expect(parseElevenLabsBalance('нет')).toBeNull();
  });
});

describe('parseSerpApiBalance', () => {
  it('берётся общий остаток, а не только план', () => {
    // `total_searches_left` — план ПЛЮС докупленные кредиты, то есть
    // то, что действительно можно потратить.
    expect(
      parseSerpApiBalance({
        plan_searches_left: 100,
        total_searches_left: 350,
        this_month_usage: 900,
      }),
    ).toEqual({ left: 350, label: 'поисков' });
  });

  it('без общего остатка берётся план — это лучше, чем ничего', () => {
    expect(parseSerpApiBalance({ plan_searches_left: 100 })?.left).toBe(100);
  });

  it('ноль остатка — это остаток, а не отсутствие ответа', () => {
    // `?? `, а не `||`: ноль поисков — самая важная новость этого экрана.
    expect(parseSerpApiBalance({ total_searches_left: 0 })?.left).toBe(0);
  });

  it('ответ без чисел — null', () => {
    expect(parseSerpApiBalance({ account_email: 'a@b.c' })).toBeNull();
    expect(parseSerpApiBalance(undefined)).toBeNull();
  });
});

describe('redactKey (аудит этапа 142)', () => {
  it('убирает ключ из чужого текста', () => {
    expect(
      redactKey(
        'Failed to parse URL from https://serpapi.com/a?api_key=sk-1',
        'sk-1',
      ),
    ).toBe('Failed to parse URL from https://serpapi.com/a?api_key=…');
  });

  it('убирает и URL-кодированный вид', () => {
    // В адрес ключ попадает уже закодированным, и искать его сырым
    // значило бы не найти ровно там, где он и есть.
    expect(redactKey('…?api_key=a%2Bb%2Fc', 'a+b/c')).toBe('…?api_key=…');
  });

  it('пустой ключ текст не трогает', () => {
    // Иначе «разделить по пустой строке» разобрало бы сообщение по буквам.
    expect(redactKey('обычная ошибка', '')).toBe('обычная ошибка');
    expect(redactKey('обычная ошибка', undefined)).toBe('обычная ошибка');
  });
});
