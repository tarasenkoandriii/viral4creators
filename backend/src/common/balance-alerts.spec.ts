import {
  balanceWatch,
  concernFingerprint,
  thresholdsFromEnv,
} from './balance-alerts';
import { ProviderBalance } from './xai-balance';

/**
 * Этап 143. Порог остатка — последний открытый кусок страницы
 * «Балансы» (TODO §III п.36).
 */
const at = new Date('2026-09-24T00:00:00Z').toISOString();
const row = (over: Partial<ProviderBalance>): ProviderBalance =>
  ({
    provider: 'GROK',
    state: 'ok',
    checkedAt: at,
    ...over,
  }) as ProviderBalance;

const limits = { usd: 10, units: { ELEVENLABS: 20_000, SERPAPI: 100 } };

describe('thresholdsFromEnv', () => {
  it('пустое окружение даёт умолчания, а не ноль', () => {
    // Ноль здесь значит «не сторожить»: умолчание в ноль означало бы,
    // что сторож по умолчанию выключен, — а его завели наоборот.
    const t = thresholdsFromEnv({} as NodeJS.ProcessEnv);
    expect(t.usd).toBeGreaterThan(0);
    expect(t.units.ELEVENLABS).toBeGreaterThan(0);
    expect(t.units.SERPAPI).toBeGreaterThan(0);
  });

  it('значения читаются из переменных', () => {
    const t = thresholdsFromEnv({
      BALANCE_ALERT_USD: '25',
      BALANCE_ALERT_ELEVENLABS_CHARACTERS: '5000',
      BALANCE_ALERT_SERPAPI_SEARCHES: '7',
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({
      usd: 25,
      units: { ELEVENLABS: 5000, SERPAPI: 7 },
    });
  });

  it('ноль — это «не сторожить», и он проходит', () => {
    // У провайдера с неровным расходом молчание лучше еженедельного
    // ложного крика.
    expect(
      thresholdsFromEnv({ BALANCE_ALERT_USD: '0' } as NodeJS.ProcessEnv).usd,
    ).toBe(0);
  });

  it('мусор откатывается к умолчанию, а не выключает сторожа', () => {
    // Опечатка, тихо выключившая сторожа, — худший исход: он есть,
    // настроен и молчит.
    const t = thresholdsFromEnv({
      BALANCE_ALERT_USD: 'десять',
      BALANCE_ALERT_SERPAPI_SEARCHES: '-5',
    } as NodeJS.ProcessEnv);
    expect(t.usd).toBe(10);
    expect(t.units.SERPAPI).toBe(100);
  });
});

describe('balanceWatch', () => {
  it('деньги ниже порога — повод, с обоими числами в тексте', () => {
    const {
      concerns: [c],
    } = balanceWatch([row({ amountMicroUsd: 4_120_000 })], limits);
    expect(c.kind).toBe('low');
    expect(c.text).toContain('$4.12');
    expect(c.text).toContain('$10.00');
  });

  it('денег ровно по порогу — не повод', () => {
    // Иначе порог $10 кричал бы на $10 ровно, и его пришлось бы
    // занижать, чтобы замолчал.
    expect(
      balanceWatch([row({ amountMicroUsd: 10_000_000 })], limits).concerns,
    ).toEqual([]);
  });

  it('единицы сравниваются со своим порогом, а не с долларовым', () => {
    const {
      concerns: [c],
    } = balanceWatch(
      [
        row({
          provider: 'ELEVENLABS',
          units: { left: 3_000, total: 100_000, label: 'символов' },
        }),
      ],
      limits,
    );
    expect(c.text).toContain('символов');
    expect(c.text).not.toContain('$');
  });

  it('нулевой порог выключает сторожа даже при уходе в минус', () => {
    // Именно в минус: с порогом ноль «меньше нуля» — единственное, что
    // без явного выключателя всё равно закричало бы.
    expect(
      balanceWatch([row({ amountMicroUsd: -5_000_000 })], {
        usd: 0,
        units: {},
      }).concerns,
    ).toEqual([]);
  });

  it('с прочитанным остатком сравнивается только прочитанный остаток', () => {
    // Форма нарочно противоречивая: сегодня её никто не создаёт, но
    // ровно её создаст первая же попытка показать последнее известное
    // число рядом с «прочитать не удалось». Сравнивать порог с
    // протухшим числом значит успокаивать вместо того, чтобы будить.
    expect(
      balanceWatch(
        [
          {
            provider: 'ELEVENLABS',
            state: 'not-configured',
            checkedAt: at,
            units: { left: 1, label: 'символов' },
          } as ProviderBalance,
        ],
        limits,
      ).concerns,
    ).toEqual([]);
  });

  it('«остаток не читается» — тоже повод, и причина в тексте', () => {
    // Сторож, переставший видеть, обязан сказать об этом сам: молчащая
    // проверка неотличима от проверки, у которой всё хорошо.
    const {
      concerns: [c],
    } = balanceWatch(
      [row({ state: 'error', detail: 'провайдер ответил 401' })],
      limits,
    );
    expect(c.kind).toBe('unreadable');
    expect(c.text).toContain('401');
  });

  it('«не настроено» и «остатка не отдаёт» поводом не считаются', () => {
    // Это известные состояния: они не меняются сами, и ежедневный крик
    // о них научит не читать канал.
    expect(
      balanceWatch(
        [
          row({ state: 'not-configured' }),
          row({ provider: 'HEDRA', state: 'unsupported' }),
        ],
        limits,
      ).concerns,
    ).toEqual([]);
  });

  it('достаточный остаток поводом не становится', () => {
    expect(
      balanceWatch(
        [
          row({ amountMicroUsd: 50_000_000 }),
          row({
            provider: 'SERPAPI',
            units: { left: 5_000, label: 'поисков' },
          }),
        ],
        limits,
      ).concerns,
    ).toEqual([]);
  });
});

describe('balanceWatch — после аудита этапа 143', () => {
  it('ноль выключает провайдера ЦЕЛИКОМ, включая крик «не читается»', () => {
    // Живой случай: у аккаунта xAI на постоплате предоплаченного
    // остатка нет вообще, и код прямо так и пишет. Прежняя редакция
    // нулём гасила только сравнение с порогом — и сторож слал бы про
    // это сообщение каждый день, вечно, про нечинимое.
    const items = [row({ state: 'error', detail: 'аккаунт на постоплате' })];
    expect(balanceWatch(items, { usd: 0, units: {} })).toEqual({
      watched: 0,
      concerns: [],
    });
    // А с ненулевым порогом — по-прежнему повод.
    expect(balanceWatch(items, limits).concerns).toHaveLength(1);
  });

  it('«сторожили и всё хорошо» отличимо от «не сторожили вовсе»', () => {
    // Иначе выключенный сторож выглядит в истории крона в точности как
    // здоровый: ноль поводов и там, и там.
    const fine = balanceWatch([row({ amountMicroUsd: 50_000_000 })], limits);
    const off = balanceWatch([row({ amountMicroUsd: 50_000_000 })], {
      usd: 0,
      units: {},
    });
    expect(fine.watched).toBe(1);
    expect(off.watched).toBe(0);
    expect(fine.concerns).toEqual(off.concerns);
  });

  it('те, у кого остатка не спрашивают, в число сторожимых не идут', () => {
    // Иначе «сторожим десятерых» было бы неправдой: семеро отвечают
    // «остатка не отдаю» и ни с чем не сравниваются.
    const { watched } = balanceWatch(
      [
        row({ provider: 'HEDRA', state: 'unsupported' }),
        row({ provider: 'OPENAI', state: 'not-configured' }),
        row({ amountMicroUsd: 50_000_000 }),
      ],
      limits,
    );
    expect(watched).toBe(1);
  });

  it('кредиты не сравниваются с долларовым порогом', () => {
    // Число получилось бы, а смысла в нём нет: провайдера без своего
    // порога не сторожим вовсе.
    const { watched, concerns } = balanceWatch(
      [row({ provider: 'HEDRA', units: { left: 1, label: 'кредитов' } })],
      limits,
    );
    expect(watched).toBe(0);
    expect(concerns).toEqual([]);
  });
});

describe('concernFingerprint', () => {
  it('в отпечатке нет переменных частей — иначе дедуп не сработает', () => {
    // Правило `TelegramNotifyService.alert`: сумма в отпечатке означала
    // бы новое сообщение на каждый доллар.
    const fp = concernFingerprint({
      provider: 'GROK',
      kind: 'low',
      text: 'Остаток GROK: $4.12 — ниже порога $10.00.',
    });
    expect(fp).toBe('balance-low:GROK');
    expect(fp).not.toContain('4.12');
  });

  it('повод и провайдер различаются: молчание про одно не прячет другое', () => {
    const low = concernFingerprint({ provider: 'GROK', kind: 'low', text: '' });
    const dead = concernFingerprint({
      provider: 'GROK',
      kind: 'unreadable',
      text: '',
    });
    expect(low).not.toBe(dead);
  });
});
