import {
  HANDOFF_LIMITS,
  defaultHandoffConfig,
  effectiveHandoffConfig,
  isWithinHours,
  parseHandoffConfig,
} from './handoff-config';

describe('parseHandoffConfig — строгий разбор настроек передачи (H)', () => {
  it('пусто — умолчание (выключено), частичный ввод дополняется умолчаниями', () => {
    expect(parseHandoffConfig({})).toEqual({
      ok: true,
      config: defaultHandoffConfig(),
    });
    const r = parseHandoffConfig({
      enabled: true,
      waitMinutes: 10,
      hours: {
        mon: [
          { from: '09:00', to: '13:00' },
          { from: '14:00', to: '18:00' },
        ],
      },
      etaText: { uk: '  ~10 хвилин  ', en: '' },
      templates: [{ id: 'hi', title: ' Привіт ', text: ' Добрий день! ' }],
      escalation: { wholesale: true },
      operatorLang: 'ru',
    });
    expect(r).toEqual({
      ok: true,
      config: {
        ...defaultHandoffConfig(),
        enabled: true,
        waitMinutes: 10,
        hours: {
          mon: [
            { from: '09:00', to: '13:00' },
            { from: '14:00', to: '18:00' },
          ],
        },
        etaText: { uk: '~10 хвилин' },
        templates: [{ id: 'hi', title: 'Привіт', text: 'Добрий день!' }],
        escalation: { ...defaultHandoffConfig().escalation, wholesale: true },
        operatorLang: 'ru',
      },
    });
  });

  it.each<[unknown, Array<{ path: string; code: string }>]>([
    [null, [{ path: '', code: 'type' }]],
    [[], [{ path: '', code: 'type' }]],
    [{ secret: 'x' }, [{ path: 'secret', code: 'unknown' }]],
    [{ schema: 2 }, [{ path: 'schema', code: 'value' }]],
    [{ enabled: 'true' }, [{ path: 'enabled', code: 'type' }]],
    [{ waitMinutes: 0 }, [{ path: 'waitMinutes', code: 'range' }]],
    [{ waitMinutes: 61 }, [{ path: 'waitMinutes', code: 'range' }]],
    [{ maxReminders: 1.5 }, [{ path: 'maxReminders', code: 'type' }]],
    [{ idleCloseHours: 73 }, [{ path: 'idleCloseHours', code: 'range' }]],
    [{ operatorLang: 'de' }, [{ path: 'operatorLang', code: 'value' }]],
    [{ hours: { monday: [] } }, [{ path: 'hours.monday', code: 'unknown' }]],
    [
      { hours: { mon: [{ from: '9:00', to: '18:00' }] } },
      [{ path: 'hours.mon.0.from', code: 'time' }],
    ],
    [
      { hours: { mon: [{ from: '24:00', to: '24:00' }] } },
      [{ path: 'hours.mon.0.from', code: 'time' }],
    ],
    [
      { hours: { mon: [{ from: '09:00', to: '25:00' }] } },
      [{ path: 'hours.mon.0.to', code: 'time' }],
    ],
    [
      { hours: { mon: [{ from: '22:00', to: '02:00' }] } },
      [{ path: 'hours.mon.0', code: 'order' }],
    ],
    [
      { hours: { mon: [{ from: '09:00', to: '12:00', tz: 'x' }] } },
      [{ path: 'hours.mon.0.tz', code: 'unknown' }],
    ],
    [
      {
        hours: {
          mon: [
            { from: '09:00', to: '13:00' },
            { from: '12:00', to: '18:00' },
          ],
        },
      },
      [{ path: 'hours.mon', code: 'overlap' }],
    ],
    [
      {
        hours: {
          tue: [
            { from: '01:00', to: '02:00' },
            { from: '03:00', to: '04:00' },
            { from: '05:00', to: '06:00' },
            { from: '07:00', to: '08:00' },
          ],
        },
      },
      [{ path: 'hours.tue', code: 'too_many' }],
    ],
    [{ etaText: { de: 'x' } }, [{ path: 'etaText.de', code: 'unknown' }]],
    [
      { etaText: { uk: 'я'.repeat(HANDOFF_LIMITS.etaText + 1) } },
      [{ path: 'etaText.uk', code: 'too_long' }],
    ],
    [
      { templates: [{ id: 'a b', title: 't', text: 'x' }] },
      [{ path: 'templates.0.id', code: 'value' }],
    ],
    [
      {
        templates: [
          { id: 'a', title: 't', text: 'x' },
          { id: 'a', title: 't', text: 'y' },
        ],
      },
      [{ path: 'templates.1.id', code: 'duplicate' }],
    ],
    [
      { templates: [{ id: 'a', title: '', text: 'x' }] },
      [{ path: 'templates.0.title', code: 'required' }],
    ],
    [
      {
        templates: [
          {
            id: 'a',
            title: 't',
            text: 'я'.repeat(HANDOFF_LIMITS.templateText + 1),
          },
        ],
      },
      [{ path: 'templates.0.text', code: 'too_long' }],
    ],
    [
      {
        templates: Array.from({ length: 11 }, (_, i) => ({
          id: `t${i}`,
          title: 't',
          text: 'x',
        })),
      },
      [{ path: 'templates', code: 'too_many' }],
    ],
    [
      { escalation: { anger: true } },
      [{ path: 'escalation.anger', code: 'unknown' }],
    ],
    [
      { escalation: { refund: 'no' } },
      [{ path: 'escalation.refund', code: 'type' }],
    ],
  ])('%j → ошибки %j', (input, errors) => {
    expect(parseHandoffConfig(input)).toEqual({ ok: false, errors });
  });

  it('из базы: битое/пустое — умолчание (выключено), а не исключение', () => {
    expect(effectiveHandoffConfig(null)).toEqual(defaultHandoffConfig());
    expect(effectiveHandoffConfig({ enabled: 'yes' })).toEqual(
      defaultHandoffConfig(),
    );
    expect(effectiveHandoffConfig('мусор')).toEqual(defaultHandoffConfig());
    expect(effectiveHandoffConfig({ enabled: true }).enabled).toBe(true);
    expect(defaultHandoffConfig().enabled).toBe(false);
  });
});

describe('isWithinHours — рабочие часы по поясу сайта', () => {
  const cfg = (hours: object) => ({
    ...defaultHandoffConfig(),
    enabled: true,
    hours,
  });
  // 2026-10-05 — понедельник. Киев в октябре — UTC+3 (до 25.10).
  const at = (iso: string) => new Date(iso);

  it('пустая неделя — круглосуточно', () => {
    expect(
      isWithinHours(cfg({}), 'Europe/Kyiv', at('2026-10-05T02:00:00Z')),
    ).toBe(true);
    expect(
      isWithinHours(
        cfg({ mon: [] }),
        'Europe/Kyiv',
        at('2026-10-05T02:00:00Z'),
      ),
    ).toBe(true);
  });

  it('интервал в поясе сайта; конец не включён; другой день — нет', () => {
    const c = cfg({ mon: [{ from: '09:00', to: '18:00' }] });
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T06:00:00Z'))).toBe(
      true,
    ); // 09:00 Киев
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T05:59:00Z'))).toBe(
      false,
    ); // 08:59
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T15:00:00Z'))).toBe(
      false,
    ); // 18:00
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-06T07:00:00Z'))).toBe(
      false,
    ); // вторник
    // Тот же момент в Нью-Йорке — 02:00 понедельника.
    expect(
      isWithinHours(c, 'America/New_York', at('2026-10-05T06:00:00Z')),
    ).toBe(false);
  });

  it('через полночь — двумя интервалами; 24:00 — конец суток; неизвестный пояс — Киев', () => {
    const c = cfg({
      mon: [{ from: '22:00', to: '24:00' }],
      tue: [{ from: '00:00', to: '02:00' }],
    });
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T20:30:00Z'))).toBe(
      true,
    ); // пн 23:30
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T22:30:00Z'))).toBe(
      true,
    ); // вт 01:30
    expect(isWithinHours(c, 'Europe/Kyiv', at('2026-10-05T23:30:00Z'))).toBe(
      false,
    ); // вт 02:30
    expect(isWithinHours(c, 'Mars/Olympus', at('2026-10-05T20:30:00Z'))).toBe(
      true,
    );
    // Переход на зимнее время (25.10): 09:00 Киева — уже 07:00 UTC.
    const w = cfg({ mon: [{ from: '09:00', to: '10:00' }] });
    expect(isWithinHours(w, 'Europe/Kyiv', at('2026-10-26T07:00:00Z'))).toBe(
      true,
    );
    expect(isWithinHours(w, 'Europe/Kyiv', at('2026-10-26T06:30:00Z'))).toBe(
      false,
    );
  });
});
