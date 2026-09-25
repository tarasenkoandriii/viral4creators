/**
 * SceneTemplateService — выбор готового приёма вместо референса (этап
 * 149, TODO §III п.11).
 *
 * Живёт в модуле разбора не по инерции: шаблон заменяет ровно тот шаг,
 * которым этот модуль и занимается, — «откуда берётся сцена». Развести
 * их по двум модулям значило бы дать один вопрос двум хозяевам.
 *
 * Сам каталог — чистый `common/scene-templates.ts`: здесь только
 * проверки и запись в сессию.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import {
  SCENE_TEMPLATE_IDS,
  SceneTemplateChoice,
  SceneTemplateId,
  isSceneTemplateId,
  sceneTemplate,
  speaksOnCamera,
} from '../../common/scene-templates';
import { normalizeVoiceMode, usesOwnVoice } from '../../common/voice-mode';

/** Одна карточка каталога. Подписи для человека — в словарях фронта. */
export interface SceneTemplateRow {
  id: SceneTemplateId;
  frame: string;
  presenter: string;
  beats: number;
  /**
   * Заговорит ли человек в кадре при ТЕКУЩЕМ режиме озвучки сессии.
   * Не запрет, а предупреждение: экран честно скажет, что слова несёт
   * наша дорожка (аудит этапа 149, А-1).
   */
  speaksOnCamera: boolean;
}

export interface SceneTemplateView {
  templates: SceneTemplateRow[];
  /** Что выбрано в этой сессии, если спрашивают про сессию. */
  chosen: SceneTemplateId | null;
  /**
   * Референс уже разобран — приём выбрать нельзя, и экран должен
   * сказать это до нажатия, а не после отказа.
   */
  analysed: boolean;
}

@Injectable()
export class SceneTemplateService {
  constructor(private readonly sessions: SessionService) {}

  /**
   * Каталог. Приёмы одинаковы для всех; зависит от сессии только
   * `speaksOnCamera` — поэтому без сессии считаем его по умолчанию
   * продукта (`DEFAULT_VOICE_MODE` — наша озвучка).
   */
  catalogue(ownVoice = true): SceneTemplateRow[] {
    return SCENE_TEMPLATE_IDS.map((id) => {
      const spec = sceneTemplate(id);
      return {
        id,
        frame: spec.frame,
        presenter: spec.presenter,
        beats: spec.beats.length,
        speaksOnCamera: speaksOnCamera(spec, ownVoice),
      };
    });
  }

  async get(sessionId: string): Promise<SceneTemplateView> {
    const session = await this.load(sessionId);
    const chosen = session.sceneTemplate?.templateId ?? null;
    return {
      templates: this.catalogue(
        usesOwnVoice(
          normalizeVoiceMode(session.brandManifestSnapshot?.voiceMode),
        ),
      ),
      chosen: isSceneTemplateId(chosen) ? chosen : null,
      // ЗАВЕРШЁННЫЙ разбор, а не любая запись (аудит этапа 149, А-5):
      // человек с провалившимся разбором — ровно тот, кому приём нужнее
      // всего, и закрывать ему выбор значит оставлять его ни с чем.
      analysed: session.videoAnalysis?.status === 'complete',
    };
  }

  /**
   * Выбрать приём или снять выбор (`null`).
   *
   * Три отказа, и каждый — про то, что иначе сломалось бы молча.
   */
  async put(
    sessionId: string,
    templateId: string | null,
  ): Promise<SceneTemplateView> {
    const session = await this.load(sessionId);

    if (templateId === null) {
      // `undefined`, а не `null`: у `updateSession` стирание ключа —
      // это именно `undefined` (оно пишется как `null` в JSON уже там).
      await this.sessions.updateSession(sessionId, {
        sceneTemplate: undefined,
      });
      return this.get(sessionId);
    }

    // Незнакомый приём — отказ, а не молчаливый пропуск. Иначе
    // опечатка записалась бы в сессию, промпт собрался бы вообще без
    // описания сцены, и узнать об этом можно было бы только по
    // готовому ролику (та же ошибка, что аудиты ловили в `locale` на
    // этапах 147 и 148).
    if (!isSceneTemplateId(templateId)) {
      throw new BadRequestException(`Приём: ${SCENE_TEMPLATE_IDS.join(', ')}`);
    }

    // Референс уже разобран — приём не выбирается. Не потому, что
    // нельзя передумать, а потому, что разбор в сборке промпта
    // сильнее: запись легла бы в сессию и не сделала бы ничего, а
    // человек считал бы, что снимает по выбранному приёму. Передумать
    // — это новый ролик, и это дёшево.
    //
    // Именно ЗАВЕРШЁННЫЙ (аудит этапа 149, А-5). Провалившийся разбор
    // не запрещает ничего: человек, у которого разбор не удался, —
    // первый, кому приём и нужен.
    if (session.videoAnalysis?.status === 'complete') {
      throw new ConflictException(
        'Референс этого ролика уже разобран — приём выбирается вместо референса, а не поверх него. Начните новый ролик.',
      );
    }

    // Запрета по режиму озвучки здесь БОЛЬШЕ НЕТ (аудит этапа 149,
    // А-1). Он отклонял отзыв при нашей озвучке — а `DEFAULT_VOICE_MODE`
    // это `voiceover`, и сессия без бренд-манифеста читается как «наша
    // озвучка». Приём оказывался закрыт почти для всех, и в первую
    // очередь для анонимного новичка, ради которого шаблоны и делались.
    // Сам конфликт был создан формулировкой кадров и снят её правкой;
    // экран вместо запрета получает `speaksOnCamera`.
    const choice: SceneTemplateChoice = {
      templateId,
      chosenAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, { sceneTemplate: choice });
    return this.get(sessionId);
  }

  private async load(sessionId: string) {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
