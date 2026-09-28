/**
 * AdminTutorialLocalesSettingsService — карточка «Языки обучающих
 * роликов» на вкладке /settings (ТЗ
 * `docs-tz/TZ-Tutorial-Video-Voiced.md`, этап C).
 *
 * Пятый уровень отката §9: «локали ломаются — сузить до `['ru']`, без
 * деплоя». Значит экран обязателен, а не желателен: без него откат
 * неисполним. Урок аудита этапа B, где настройка приехала без
 * витрины и включить её было нечем.
 *
 * Витрина показывает не только «что приняли», но и «что прислали» —
 * тот же приём, что у каталога музыки (`AdminMusicCatalogService`):
 * разбор терпимый, негодный код отбрасывается молча, и оператор
 * должен увидеть разницу, а не гадать.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  isSupportedLocale,
  SUPPORTED_LOCALES,
  SupportedLocale,
} from '../../common/locale';
import {
  parseTutorialLocales,
  readLocaleCandidates,
  serializeTutorialLocales,
  TUTORIAL_LOCALES_SETTING_KEY,
} from '../tutorial-scenario/tutorial-locales';

export interface TutorialLocalesSettingsView {
  /** Что реально будет генерироваться. */
  locales: SupportedLocale[];
  /** Из чего выбирать. */
  supported: readonly string[];
  /** Сколько кодов оператор прислал и сколько из них приняли. */
  submitted: number;
  accepted: number;
  /**
   * Коды, которые отброшены, — списком, а не числом. Числа мало:
   * «отброшено 2 из 3» не говорит, что именно не так, а причин две
   * (код не поддерживается или это дубль), и путать их нельзя.
   */
  rejectedCodes: string[];
  /**
   * `true`, когда ни один присланный код не принят и подставлено
   * умолчание. Без этого признака витрина показывала принятый `ru`
   * там, где оператор прислал `fr`, — и он получал ноль сигналов о
   * том, что его ввод отвергнут (находка аудита этапа C).
   */
  fellBackToDefault: boolean;
  /** Одной фразой — что будет на следующем ночном прогоне. */
  effect: string;
}

/** Ввод оператора длиннее этого — почти наверняка вставлено не то.
 * Пять кодов по две буквы не требуют и сотни символов. */
const MAX_RAW_LENGTH = 512;

@Injectable()
export class AdminTutorialLocalesSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async get(): Promise<TutorialLocalesSettingsView> {
    const raw = await this.settings.get(TUTORIAL_LOCALES_SETTING_KEY);
    return this.view(raw);
  }

  async set(
    raw: string,
    updatedBy?: string,
  ): Promise<TutorialLocalesSettingsView> {
    if (raw.length > MAX_RAW_LENGTH) {
      throw new BadRequestException(
        `Слишком длинное значение (${raw.length} символов): ожидаются коды локалей, например ru, en`,
      );
    }
    const locales = parseTutorialLocales(raw);
    // В базу ложится канонический JSON, а не сырой ввод: список
    // читает генератор, и разбирать «ru, EN » второй раз на каждом
    // прогоне незачем. Но `submitted`/`rejected` витрина считает по
    // тому, что прислали, — иначе «приняли 2 из 3» не показать.
    await this.settings.set(
      TUTORIAL_LOCALES_SETTING_KEY,
      serializeTutorialLocales(locales),
      updatedBy,
    );
    return this.view(raw);
  }

  private view(raw: string | null): TutorialLocalesSettingsView {
    const locales = parseTutorialLocales(raw);
    const submittedCodes = splitCodes(raw);
    // Что приняли — считается по ПРИСЛАННОМУ, а не по итоговому
    // списку: при полном отказе разбора в итоговом лежит подставленный
    // `ru`, которого оператор не присылал, и «отброшено 0 из 1»
    // выглядело подтверждением (находка аудита этапа C).
    const accepted: string[] = [];
    const rejectedCodes: string[] = [];
    const seen = new Set<string>();
    for (const code of submittedCodes) {
      const norm = code.trim().toLowerCase();
      if (isSupportedLocale(norm) && !seen.has(norm)) {
        seen.add(norm);
        accepted.push(norm);
      } else {
        rejectedCodes.push(code.trim());
      }
    }
    const fellBackToDefault =
      submittedCodes.length > 0 && accepted.length === 0;
    return {
      locales,
      supported: SUPPORTED_LOCALES,
      submitted: submittedCodes.length,
      accepted: accepted.length,
      rejectedCodes,
      fellBackToDefault,
      effect: fellBackToDefault
        ? `Ни один присланный код не распознан — осталось умолчание (${locales.join(', ')}). Поддерживаются только ${SUPPORTED_LOCALES.join(', ')}.`
        : locales.length === 1
          ? `Новые сценарии генерируются только на одном языке (${locales[0]}). Уже снятые ролики других языков остаются, но не обновляются и больше не исполняются.`
          : `Новые сценарии генерируются на ${locales.length} языках (${locales.join(', ')}). Каждый язык — свой прогон генерации, свои ролики и своя озвучка.`,
    };
  }
}

/**
 * Коды в том виде, в каком их прислал оператор, — ДО фильтрации.
 *
 * Разбор ОДИН и тот же, что у генератора (`readLocaleCandidates`).
 * Своя копия здесь уже была и уже разошлась: на вводе `{"a":1}` она
 * возвращала пустой список, витрина показывала «прислали 0,
 * отброшено 0» и не рендерила предупреждение вовсе, хотя ввод был
 * отвергнут целиком (находка сквозного аудита A+B+C). Два парсера
 * одного ввода расходятся всегда, вопрос только когда.
 *
 * `null` от разбора — «ввод есть, кодов из него не достать»:
 * показываем его как один отброшенный код, чтобы оператор увидел
 * отказ, а не пустоту.
 */
function splitCodes(raw: string | null): string[] {
  const text = (raw ?? '').trim();
  if (text.length === 0) return [];
  const candidates = readLocaleCandidates(text);
  if (candidates === null) return [text];
  return candidates
    .map((item) => (typeof item === 'string' ? item : String(item)))
    .filter((item) => item.trim().length > 0);
}
