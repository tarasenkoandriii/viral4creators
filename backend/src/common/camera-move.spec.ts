/**
 * Движение камеры (ТЗ §29, этап 46).
 *
 * Проверяем три вещи, каждая из которых ломает ролик по-своему:
 * нормализацию (в БД лежит TEXT, туда может попасть что угодно),
 * молчание при `none` (пустой бриф не должен добавлять в промпт пустую
 * строку и сбивать нумерацию секций) и уменьшенную амплитуду в неродном
 * формате (иначе товар уедет за границу центральной обрезки, §16.1).
 */
import {
  CAMERA_MOVES,
  DEFAULT_CAMERA_MOVE,
  cameraBriefText,
  isNativeFrame,
  normalizeCameraMove,
} from './camera-move';

describe('normalizeCameraMove', () => {
  it('принимает известные значения', () => {
    for (const move of CAMERA_MOVES) {
      expect(normalizeCameraMove(move)).toBe(move);
    }
  });

  it.each([
    ['  Push-In  ', 'push-in'],
    ['PUSH-IN', 'push-in'],
    ['NONE', 'none'],
  ])('чистит регистр и пробелы: %s', (input, expected) => {
    expect(normalizeCameraMove(input)).toBe(expected);
  });

  it.each<unknown>(['zoom', '', null, undefined, 42, { move: 'push-in' }])(
    'на мусор отдаёт значение по умолчанию (%s)',
    (input) => {
      // Колонка в БД — TEXT без CHECK: значение может прийти из старой
      // записи или из ручной правки, и промпт не должен требовать
      // от модели движение, которого никто не заказывал.
      expect(normalizeCameraMove(input)).toBe(DEFAULT_CAMERA_MOVE);
    },
  );

  it('по умолчанию камера стоит', () => {
    // Наезд — осознанный выбор бренда, а не поведение «из коробки»:
    // на статичной предметке он смотрится навязчиво.
    expect(DEFAULT_CAMERA_MOVE).toBe('none');
  });
});

describe('isNativeFrame', () => {
  it.each(['16:9', '9:16'])('%s — родной для Veo', (frame) => {
    expect(isNativeFrame(frame)).toBe(true);
  });

  it.each(['1:1', '4:5', '', undefined, null])(
    'остальное снимается под обрезку: %s',
    (frame) => {
      expect(isNativeFrame(frame)).toBe(false);
    },
  );
});

describe('cameraBriefText', () => {
  it('при none не добавляет в промпт ничего', () => {
    expect(cameraBriefText('none', '16:9')).toBe('');
  });

  it('в родном формате просит обычную амплитуду', () => {
    const brief = cameraBriefText('push-in', '9:16');
    expect(brief).toContain('push-in');
    expect(brief).toContain('10–15%');
    expect(brief).not.toContain('SMALL');
  });

  it('в неродном формате просит меньшую амплитуду и объясняет почему', () => {
    // Кадр снимается шире с запасом под центральную обрезку (§16.1);
    // наезд сужает безопасную зону второй раз.
    const brief = cameraBriefText('push-in', '1:1');
    expect(brief).toContain('SMALL');
    expect(brief).toContain('1:1');
    expect(brief).toContain('crop');
    expect(brief).not.toContain('10–15%');
  });

  it('без указанного формата считает кадр неродным', () => {
    // Неизвестный формат — это скорее обрезка, чем нет; ошибиться
    // в сторону меньшей амплитуды дешевле, чем срезать товар.
    expect(cameraBriefText('push-in', undefined)).toContain('SMALL');
  });

  it('запрещает подмену наезда монтажными приёмами', () => {
    // Без этого модель охотно отдаёт «движение» рывковым зумом или
    // склейкой — это читается как шаблон, а не как работа оператора.
    const brief = cameraBriefText('push-in', '16:9');
    expect(brief).toContain('No handheld shake');
    expect(brief).toContain('continuous');
  });
});
