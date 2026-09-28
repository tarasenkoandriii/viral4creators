/**
 * AdminTutorialVoiceSettingsService — карточка «Озвучка обучающих
 * роликов» на вкладке /settings (ТЗ
 * `docs-tz/TZ-Tutorial-Video-Voiced.md`, этап B).
 *
 * Тонкая обёртка, ровно как `AdminAudioSeparationSettingsService`:
 * сама настройка и её грамматика живут в `tutorial-runner/
 * tutorial-voice.ts`, здесь только витрина для оператора.
 *
 * Витрина обязательна, а не желательна. §9 ТЗ требует её от каждой
 * новой настройки, и не ради единообразия: третий уровень отката —
 * «выключить озвучку **без деплоя**», и без экрана он неисполним.
 * Найдено аудитом этапа B: настройка существовала, включить её было
 * нечем, кроме прямой записи в таблицу.
 *
 * Показывает не только «включено ли», но и «а сработает ли»:
 * выключатель при ненастроенном провайдере синтеза выглядел бы
 * работающим и не делал бы ничего — та же мысль, что у карточки фона
 * при дубляже.
 */
import { Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import {
  parseRequireNarrationReview,
  parseTutorialCaptionsSetting,
  parseTutorialMotionSetting,
  parseTutorialPointerSetting,
  parseTutorialVoiceSetting,
  TUTORIAL_CAPTIONS_SETTING_KEY,
  TUTORIAL_MOTION_SETTING_KEY,
  TUTORIAL_POINTER_SETTING_KEY,
  tutorialMotionSettingValue,
  TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY,
  TUTORIAL_VOICE_SETTING_KEY,
  TutorialVoiceSetting,
} from '../tutorial-runner/tutorial-voice';
import type { SlideshowMotion } from '../tutorial-runner/tutorial-video-assembly';

export interface TutorialVoiceSettingsView extends TutorialVoiceSetting {
  /**
   * Требовать вычитку реплик перед озвучкой (§3-бис.5 ТЗ, этап D).
   *
   * Живёт в этой же карточке, а не в шестой рядом: оператор смотрит
   * сюда с вопросом «что прозвучит в ролике», и оба выключателя
   * отвечают на него — один «прозвучит ли вообще», второй «прозвучит
   * ли непрочитанное». Разведя их по карточкам, мы заставили бы
   * складывать два экрана в голове ровно там, где §9 требует
   * обратного.
   */
  requireNarrationReview: boolean;
  /**
   * Подписи на кадрах (§5 ТЗ, этап E) — ТРЕТИЙ выключатель той же
   * карточки и единственный включённый по умолчанию.
   *
   * Живёт здесь, а не отдельно, по тому же доводу, что и вычитка:
   * оператор смотрит сюда с вопросом «что увидит и услышит зритель».
   * Но от звука он НЕ зависит: §9 требует уметь выключить подписи
   * независимо, и немой ролик с подписями — рабочий исход, а не
   * недоразумение.
   */
  captions: boolean;
  /**
   * Движение в слайд-шоу (§6 ТЗ, этап G) — четвёртый выключатель той
   * же карточки, по умолчанию выключенный. Здесь по тому же доводу,
   * что подписи: оператор смотрит сюда с вопросом «что увидит
   * зритель», и от звука движение не зависит.
   */
  motion: SlideshowMotion;
  /**
   * Указатель клика (§6 ТЗ, этап H) — пятый выключатель карточки, по
   * умолчанию выключенный, по тому же доводу, что движение.
   */
  pointer: boolean;
  /** Ключ провайдера синтеза, который возьмут при следующей сборке. */
  provider: string;
  /** Настроен ли он: без ключа выключатель бессмыслен. */
  providerConfigured: boolean;
  /**
   * Что произойдёт при следующем ночном прогоне — одной фразой, чтобы
   * оператору не приходилось складывать два флага в голове.
   */
  effect: string;
  /** То же про подписи, отдельной фразой: они от звука не зависят. */
  captionsEffect: string;
  /** То же про движение. Говорит и о цене: зум заметно удлиняет
   *  работу внешнего ffmpeg, а переключение пересобирает весь набор. */
  motionEffect: string;
  /** То же про указатель клика. */
  pointerEffect: string;
}

/** Фраза витрины про движение — отдельной функцией, чтобы её можно
 *  было проверить на всех трёх режимах, не поднимая сервис. */
export function motionEffectText(motion: SlideshowMotion): string {
  switch (motion) {
    case 'fade+zoom':
      return 'Движение включено: плавные переходы между кадрами (0.3 с) и лёгкое приближение внутри кадра. Зум примерно втрое удлиняет работу внешнего ffmpeg над каждым роликом, поэтому у роликов длиннее трёх минут он снимается и остаются только переходы. Первая ночь после переключения пересобирает весь набор.';
    case 'fade':
      return 'Только переходы: кадры сменяются плавно (0.3 с), без приближения. Покадровая речь и подписи сдвигаются вместе с кадрами, и ролик становится короче на 0.3 с на каждом стыке; у ролика с одной дорожкой на все кадры длина берётся с запасом на стыки, чтобы конец речи не обрезался. Первая ночь после переключения пересобирает весь набор.';
    default:
      return 'Без движения: кадры сменяются резко, как в презентации. Обучалку по сайту заказчика этот выключатель не затрагивает.';
  }
}

@Injectable()
export class AdminTutorialVoiceSettingsService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly tts: TtsProviderResolverService,
  ) {}

  async view(): Promise<TutorialVoiceSettingsView> {
    const voice = parseTutorialVoiceSetting(
      await this.settings.get(TUTORIAL_VOICE_SETTING_KEY),
    );
    const requireNarrationReview = parseRequireNarrationReview(
      await this.settings.get(TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY),
    );
    const captions = parseTutorialCaptionsSetting(
      await this.settings.get(TUTORIAL_CAPTIONS_SETTING_KEY),
    );
    const motion = parseTutorialMotionSetting(
      await this.settings.get(TUTORIAL_MOTION_SETTING_KEY),
    );
    const pointer = parseTutorialPointerSetting(
      await this.settings.get(TUTORIAL_POINTER_SETTING_KEY),
    );
    const provider = await this.tts.resolve();
    const providerConfigured = provider.configured();
    return {
      ...voice,
      requireNarrationReview,
      captions,
      motion,
      motionEffect: motionEffectText(motion),
      pointer,
      pointerEffect: pointer
        ? 'Указатель клика включён: в последнюю секунду кадра оранжевое кольцо показывает кнопку, которую нажмёт следующий шаг. Кнопки, которой на снимке ещё нет, указатель не получает. Первая ночь после переключения пересобирает ролики, где есть щелчки.'
        : 'Без указателя клика: зритель сам ищет на кадре кнопку, о которой говорит диктор.',
      provider: provider.providerKey,
      providerConfigured,
      // Фраза про подписи ОТДЕЛЬНАЯ и идёт всегда, даже когда
      // озвучка выключена: подписи от неё не зависят, и приписав их
      // к любой из веток звука, мы бы сказали неправду в остальных.
      captionsEffect: captions
        ? 'Подписи на кадрах включены: реплика шага дублируется текстом. Ролик смотрят без звука чаще, чем со звуком. Где речи нет (озвучка выключена или дорожка шага не получилась), кадр держится столько, сколько нужно прочитать подпись, — ролик от этого длиннее.'
        : 'Подписи выключены: ролик без текста на кадрах. Без звука он ничего не объясняет.',
      effect: !providerConfigured
        ? `Провайдер синтеза (${provider.providerKey}) не настроен: ролики собираются немыми, как и раньше.`
        : !voice.enabled
          ? 'Озвучка выключена: ролики собираются немыми. Провайдер настроен — можно включить в любой момент.'
          : requireNarrationReview
            ? // Про запасной путь сказано ЯВНО: без этой фразы
              // оператор, включивший требование, ждёт немыми все
              // ролики, а немыми станут только те, у кого реплики
              // есть и не вычитаны.
              'Ролики собираются с закадровым голосом, но сценарии с НЕвычитанными репликами — немыми. Сценарии без реплик это не затрагивает: у них звучит текст шага обучалки, его писал человек.'
            : 'Ролики собираются с закадровым голосом. Где у шагов сценария есть реплики — звучат они, покадрово; где нет — одна дорожка из текста шага обучалки. Синтез кешируется и переиспользуется, пока текст не поменяется.',
    };
  }

  /**
   * `enabled` и `voiceId` приходят раздельно, а в базу ложатся одной
   * строкой грамматики `off` | `on` | `on:<id>` — оператору не нужно
   * знать про грамматику, а базе не нужна вторая колонка.
   */
  async set(
    input: {
      enabled: boolean;
      voiceId?: string | null;
      /**
       * ОБЯЗАТЕЛЬНОЕ поле, хотя настройка и необязательная. «Не
       * прислали — оставить как было» завело бы третье состояние у
       * выключателя: два вызывающих с разным пониманием умолчания
       * гасили бы правки друг друга молча. Вызывающий обязан
       * сказать, чего хочет.
       */
      requireNarrationReview: boolean;
      /** Обязательное по той же причине, что и выше. */
      captions: boolean;
      /** Движение (этап G). Обязательное по той же причине. */
      motion: SlideshowMotion;
      /** Указатель клика (этап H). Обязательное по той же причине. */
      pointer: boolean;
    },
    updatedBy?: string,
  ): Promise<TutorialVoiceSettingsView> {
    const voiceId = input.voiceId?.trim() ?? '';
    const value = !input.enabled
      ? 'off'
      : voiceId.length > 0
        ? `on:${voiceId}`
        : 'on';
    await this.settings.set(TUTORIAL_VOICE_SETTING_KEY, value, updatedBy);
    await this.settings.set(
      TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY,
      input.requireNarrationReview ? 'on' : 'off',
      updatedBy,
    );
    // `off` пишется ЯВНО, а `on` — тоже явно, хотя разбор считает
    // включённым всё, кроме `off`. Строка в базе должна читаться
    // человеком без знания правил разбора.
    await this.settings.set(
      TUTORIAL_CAPTIONS_SETTING_KEY,
      input.captions ? 'on' : 'off',
      updatedBy,
    );
    // Строку грамматики пишет модуль, который её разбирает, — витрина
    // её не знает.
    await this.settings.set(
      TUTORIAL_MOTION_SETTING_KEY,
      tutorialMotionSettingValue(input.motion),
      updatedBy,
    );
    await this.settings.set(
      TUTORIAL_POINTER_SETTING_KEY,
      input.pointer ? 'on' : 'off',
      updatedBy,
    );
    return this.view();
  }
}
