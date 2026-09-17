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
  cameraBriefCorrection,
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

describe('поправка амплитуды под выбранный позже формат (В-1.9)', () => {
  it('референс родной, генерация в неродной — амплитуду урезаем', () => {
    // Ровно тот случай, ради которого параметр и различает форматы:
    // в промпт ушло «10–15 %», а ролик обрежут по центру, и наезд съест
    // безопасную зону второй раз.
    const fix = cameraBriefCorrection('push-in', '9:16', '4:5');
    expect(fix).toContain('SMALL');
    expect(fix).toContain('4:5');
    expect(fix).toContain('supersedes');
  });

  it('референс неродной, генерация родная — амплитуду возвращаем', () => {
    // Обратная половина: иначе движение напрасно урезано до дрожания.
    const fix = cameraBriefCorrection('push-in', '4:5', '16:9');
    expect(fix).toContain('10–15%');
    expect(fix).not.toContain('SMALL');
  });

  it('«неродность» не изменилась — поправлять нечего', () => {
    // Молчание здесь важнее краткости: лишняя строка «поверх сказанного»
    // в промпте заставляет модель искать противоречие там, где его нет.
    expect(cameraBriefCorrection('push-in', '9:16', '16:9')).toBe('');
    expect(cameraBriefCorrection('push-in', '4:5', '1:1')).toBe('');
    expect(cameraBriefCorrection('push-in', '9:16', '9:16')).toBe('');
  });

  it('без движения камеры поправки нет вовсе', () => {
    expect(cameraBriefCorrection('none', '9:16', '4:5')).toBe('');
  });

  it('формат референса неизвестен — считается неродным, как и в самом брифе', () => {
    // Тот же перекос в безопасную сторону, что у `cameraBriefText`:
    // неизвестное — скорее обрезка. Значит, при генерации в родном
    // формате поправка нужна.
    expect(cameraBriefCorrection('push-in', undefined, '9:16')).toContain(
      '10–15%',
    );
  });
});
