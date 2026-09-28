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
  parseTutorialVoiceSetting,
  TUTORIAL_REQUIRE_NARRATION_REVIEW_KEY,
  TUTORIAL_VOICE_SETTING_KEY,
  TutorialVoiceSetting,
} from '../tutorial-runner/tutorial-voice';

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
  /** Ключ провайдера синтеза, который возьмут при следующей сборке. */
  provider: string;
  /** Настроен ли он: без ключа выключатель бессмыслен. */
  providerConfigured: boolean;
  /**
   * Что произойдёт при следующем ночном прогоне — одной фразой, чтобы
   * оператору не приходилось складывать два флага в голове.
   */
  effect: string;
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
    const provider = await this.tts.resolve();
    const providerConfigured = provider.configured();
    return {
      ...voice,
      requireNarrationReview,
      provider: provider.providerKey,
      providerConfigured,
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
    return this.view();
  }
}
