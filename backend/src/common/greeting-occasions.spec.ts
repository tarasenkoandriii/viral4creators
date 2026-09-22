/**
 * Каталог поводов (этап 2, фичи №1/№3 компаньон-ТЗ).
 *
 * Тесты проверяют не «мапа не пустая», а то единственное, ради чего
 * файл написан: что чувствительный повод нельзя сгенерировать как
 * праздник — ни тоном, ни инструкцией модели, ни запасным текстом.
 */
import {
  GREETING_OCCASIONS,
  GREETING_TONES,
  GreetingOccasion,
} from './types/greeting.types';
import {
  GREETING_OCCASION_SPECS,
  GREETING_TONE_LABELS,
  allowedTonesFor,
  defaultToneFor,
  fallbackMessage,
  toneAllowedFor,
} from './greeting-occasions';

/** Поводы, где неуместность — не вопрос вкуса (§3 компаньон-ТЗ). */
const SENSITIVE: GreetingOccasion[] = ['CONDOLENCE', 'GET_WELL', 'APOLOGY'];

describe('каталог поводов — полнота', () => {
  it('у каждого повода есть спецификация, лишних нет', () => {
    expect(Object.keys(GREETING_OCCASION_SPECS).sort()).toEqual(
      [...GREETING_OCCASIONS].sort(),
    );
  });

  it('у каждого тона есть подпись', () => {
    expect(Object.keys(GREETING_TONE_LABELS).sort()).toEqual(
      [...GREETING_TONES].sort(),
    );
  });

  it('поводов стало 20+ — цель фичи №1, а не «чуть больше семи»', () => {
    expect(GREETING_OCCASIONS.length).toBeGreaterThanOrEqual(20);
  });

  it('каждый повод несёт замысел и настроение сцены, а не только подпись', () => {
    for (const occasion of GREETING_OCCASIONS) {
      const spec = GREETING_OCCASION_SPECS[occasion];
      expect(spec.label.trim().length).toBeGreaterThan(0);
      // Инструкция модели — то, чем «20 поводов» отличаются от «20
      // меток» (находка 1.8 аудита): она должна быть предложением, а не
      // словом.
      expect(spec.intent.trim().length).toBeGreaterThan(20);
      expect(spec.sceneMood.trim().length).toBeGreaterThan(10);
    }
  });

  it('набор допустимых тонов непустой и не выдуман', () => {
    for (const occasion of GREETING_OCCASIONS) {
      const tones = allowedTonesFor(occasion);
      expect(tones.length).toBeGreaterThan(0);
      for (const tone of tones) expect(GREETING_TONES).toContain(tone);
    }
  });
});

describe('чувствительные поводы', () => {
  it('шутливый тон недопустим — и это проверяется, а не подразумевается', () => {
    for (const occasion of SENSITIVE) {
      expect(toneAllowedFor(occasion, 'FUNNY')).toBe(false);
    }
  });

  it('для обычного повода шутливый тон, наоборот, доступен', () => {
    expect(toneAllowedFor('BIRTHDAY', 'FUNNY')).toBe(true);
  });

  it('не праздничные — значит, декорации не праздничные ни при каком тоне', () => {
    for (const occasion of SENSITIVE) {
      const spec = GREETING_OCCASION_SPECS[occasion];
      expect(spec.festive).toBe(false);
      expect(spec.sceneMood).toMatch(/no decorations|no confetti/);
    }
  });

  it('инструкция модели прямо говорит не поздравлять', () => {
    for (const occasion of SENSITIVE) {
      expect(GREETING_OCCASION_SPECS[occasion].intent).toMatch(
        /[Нн]е поздравляй/,
      );
    }
  });
});

describe('defaultToneFor', () => {
  /**
   * Прежнее жёсткое 'WARM' для CONDOLENCE недопустимо — бриф-соболезнование
   * без явного тона упал бы на собственной валидации при первой правке.
   */
  it('умолчание всегда проходит собственную проверку повода', () => {
    for (const occasion of GREETING_OCCASIONS) {
      expect(toneAllowedFor(occasion, defaultToneFor(occasion))).toBe(true);
    }
  });

  it('для соболезнования умолчание — не WARM', () => {
    expect(defaultToneFor('CONDOLENCE')).not.toBe('WARM');
  });
});

describe('fallbackMessage — когда модель не ответила', () => {
  it('соболезнование, извинение и поддержка не поздравляют', () => {
    for (const occasion of SENSITIVE) {
      const text = fallbackMessage(occasion, 'Марина', 'повод');
      expect(text).not.toMatch(/поздравля/i);
      expect(text).not.toContain('!');
    }
  });

  /**
   * Не только «не поздравляет», но и говорит по делу. Мутация,
   * убравшая ветку соболезнования, оставляла нейтральное «эти слова —
   * для вас» и не роняла прежний тест: формально не поздравление, а по
   * сути — отписка в самый неподходящий момент.
   */
  it('каждый чувствительный повод говорит именно то, что нужно сказать', () => {
    expect(fallbackMessage('CONDOLENCE', 'Марина', 'повод')).toMatch(
      /соболезнован/i,
    );
    expect(fallbackMessage('APOLOGY', 'Марина', 'повод')).toMatch(
      /прост|жаль/i,
    );
    expect(fallbackMessage('GET_WELL', 'Марина', 'повод')).toMatch(
      /выздоровлен/i,
    );
  });

  it('ни один непраздничный повод не поздравляет', () => {
    for (const occasion of GREETING_OCCASIONS) {
      if (GREETING_OCCASION_SPECS[occasion].festive) continue;
      expect(fallbackMessage(occasion, 'Марина', 'повод')).not.toMatch(
        /поздравля/i,
      );
    }
  });

  it('праздничный повод по-прежнему поздравляет и зовёт по имени', () => {
    const text = fallbackMessage('BIRTHDAY', 'Марина', 'день рождения');
    expect(text).toMatch(/поздравля/i);
    expect(text).toContain('Марина');
  });
});
