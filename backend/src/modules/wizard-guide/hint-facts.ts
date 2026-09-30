/**
 * Факты состояния для дайджеста — «Тонкая красная линия» §5.5, волна D.
 *
 * ## Почему это отдельный файл рядом с карточками
 *
 * Добавить сценарий в `SCENARIO_HINTS` и забыть про факты — ошибка,
 * которую невозможно заметить глазами и легко сделать: подсказки
 * появятся, тесты будут зелёными, а дайджест состояния окажется
 * ПОСТОЯННЫМ. Это значит один кеш на всех: «заполните повод» приедет
 * тому, кто его уже заполнил, и никакой признак на это не укажет.
 * Поэтому факты лежат в паре с карточками и сверяются тестом
 * (`hint-facts.spec.ts`): у каждого сценария из `SCENARIO_HINTS` обязан
 * быть свой набор.
 *
 * ## Почему факты — слова, а не значения
 *
 * «Повод задан», а не «повод = день рождения». Инъекция через поле
 * невозможна не потому, что мы её фильтруем, а потому, что значения
 * полей в промпт не попадают вовсе (§5.10). Это же делает кеш общим для
 * всех пользователей: в ключе нет ничего персонального.
 *
 * ## Почему и положительные, и отрицательные
 *
 * Без «-title» ситуации «заголовка нет» и «поле ещё не читали» дают
 * один дайджест, а это разные ситуации и разные советы.
 */

import type { FreeScenario } from '../../common/test-user-scenarios';
import type { SupportedLocale } from '../../common/locale';
import type { VoiceQuestionTopic } from '../../common/greeting-voice-contract';
import { ModerationStatus } from '../../common/types/prompt.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { AVATAR_PRESENTER } from '../../common/wizard-readiness.session';
import { referenceNeedsFaceConsent } from '../../common/greeting-persona';
import type { SceneAsset } from '../../common/types/reference.types';

/** Что известно о черновике обучалки. */
export interface ClientSiteState {
  rounds: number;
  title: string | null;
  status: string;
  hasCredentials: boolean;
  requiresLiveLoginReplay: boolean;
}

/** Что известно о сессии greeting. */
export interface GreetingState {
  occasion: string | null;
  customOccasionText: string | null;
  recipientName: string | null;
  senderName: string | null;
  usesAvatar: boolean;
  referenceImages: number;
  hasPrompt: boolean;
  promptFlagged: boolean;
  hasVideo: boolean;
  /**
   * K4: ролик именно ГОТОВ (а не запущен) и рендер идёт. В дайджест не
   * входят (`greetingFacts` их не читает — ключи кеша подсказок не
   * меняются), нужны только ответам на вопросы (`greetingAnswer`):
   * «сколько ждать?» при идущем рендере и при готовом ролике — разные
   * ответы, а `hasVideo` у поздравления — «ролик заведён», в том числе
   * ещё в работе.
   */
  videoReady?: boolean;
  renderInFlight?: boolean;
  /**
   * K4 (CONTRACT5): тоже только для ответов, в дайджест не входят.
   *
   * - `presenterIsPersona` — в кадре образ автора («вы в кадре»): фото
   *   ему портретом не нужны, и «без фото рендер откажет» было бы неправдой;
   * - `portraitPhotos` — фото, которые МОЖНО пустить в модель: лицо без
   *   подтверждённого согласия портретом не станет (`referenceNeedsFace
   *   Consent`), и «фото добавлено» для аватара без такого фото — не ответ;
   * - `photosAwaitingConsent` — фото с лицом, ждущие галочки согласия;
   * - `hasSession: false` — состояние прочитано из живого брифа ДО старта
   *   сессии: фото и сценария ещё не может быть, следующий шаг — сессия.
   */
  presenterIsPersona?: boolean;
  portraitPhotos?: number;
  photosAwaitingConsent?: number;
  hasSession?: boolean;
}

/**
 * Ровно те поля сессии поздравления, которые читают факты. Общая форма
 * для советника (`WizardHintService`) и голоса (`GreetingVoiceUnderstand
 * Service`, `ProactiveSpeechService`): одно чтение состояния на всех —
 * иначе подсказка и ответ голосом разошлись бы в том, что видят.
 */
export interface GreetingSessionShape {
  greetingBriefSnapshot?: {
    occasion?: string;
    customOccasionText?: string | null;
    recipientName?: string;
    senderName?: string | null;
    presenterProvider?: string;
    resolvedPresenterProvider?: string;
    /** Образ персоны в кадре (этап G) — есть только у ведущего-персоны. */
    presenter?: { lookId?: string } | null;
  } | null;
  greetingReferenceImages?: unknown[] | null;
  generationPrompt?: {
    moderationStatus?: string | null;
  } | null;
  generatedVideo?: { status?: string } | null;
}

/** Состояние поздравления из сессии; нет сессии — `null`. */
export function greetingStateOf(
  session: GreetingSessionShape | null | undefined,
): GreetingState | null {
  if (!session) return null;
  const brief = session.greetingBriefSnapshot;
  const status = session.generatedVideo?.status;
  const images = (session.greetingReferenceImages ?? []) as SceneAsset[];
  // Лицо без подтверждённого согласия в модель не идёт (Г-8): такое фото
  // ни портретом, ни картинкой не считается.
  const awaiting = images.filter((img) =>
    referenceNeedsFaceConsent(img),
  ).length;
  return {
    occasion: brief?.occasion ?? null,
    customOccasionText: brief?.customOccasionText ?? null,
    recipientName: brief?.recipientName ?? null,
    senderName: brief?.senderName ?? null,
    usesAvatar:
      (brief?.resolvedPresenterProvider ?? brief?.presenterProvider) ===
      AVATAR_PRESENTER,
    referenceImages: session.greetingReferenceImages?.length ?? 0,
    hasPrompt: !!session.generationPrompt,
    // Через enum, а не строкой: значения там строчные, и литерал,
    // написанный по памяти, молча выключил бы факт.
    promptFlagged:
      session.generationPrompt?.moderationStatus === ModerationStatus.FLAGGED,
    hasVideo: !!session.generatedVideo,
    videoReady: status === GenerationStatus.COMPLETE,
    renderInFlight:
      status === GenerationStatus.PENDING ||
      status === GenerationStatus.PROCESSING,
    presenterIsPersona: !!brief?.presenter,
    portraitPhotos: images.length - awaiting,
    photosAwaitingConsent: awaiting,
    hasSession: true,
  };
}

/**
 * Состояние из ЖИВОГО брифа до старта сессии (K4, CONTRACT5): ответ «что
 * дальше?» на брифе обязан видеть то, что человек уже заполнил, а не
 * «сессии ещё нет». Строка брифа проекта — та, что на экране.
 */
export function greetingStateOfBrief(
  brief: {
    occasion: string;
    customOccasionText: string | null;
    recipientName: string | null;
    senderName: string | null;
    presenterProvider: string | null;
    presenterLookId?: string | null;
  } | null,
): GreetingState | null {
  if (!brief) return null;
  return {
    occasion: brief.occasion ?? null,
    customOccasionText: brief.customOccasionText,
    recipientName: brief.recipientName,
    senderName: brief.senderName,
    usesAvatar: brief.presenterProvider === AVATAR_PRESENTER,
    referenceImages: 0,
    hasPrompt: false,
    promptFlagged: false,
    hasVideo: false,
    presenterIsPersona: !!brief.presenterLookId,
    portraitPhotos: 0,
    photosAwaitingConsent: 0,
    hasSession: false,
  };
}

/** Что известно о прогоне товарки. */
export interface ProductState {
  hasReference: boolean;
  analysisComplete: boolean;
  /**
   * Сцена задана готовым приёмом, а не разбором чужого ролика (этап
   * 153; приёмы — TODO §III п.11).
   *
   * Без этого факта советник получал «референс не выбран, разбор не
   * завершён» и советовал человеку, сознательно обошедшемуся без
   * референса, пойти его искать и дождаться разбора, которого не будет.
   * Это третий случай одного класса подряд: ветку приёмов завели, а
   * места, читающие `videoAnalysis` на другом конце конвейера, не
   * прошли (первые два — `RelevancePanel` в аудите 150 и
   * `AbTestService` в аудите 152).
   */
  onSceneTemplate: boolean;
  hasProductInfo: boolean;
  hasProductImage: boolean;
  promptApproved: boolean;
  renderInFlight: boolean;
  hasVideo: boolean;
}

export type ScenarioState =
  | { scenario: 'CLIENT_SITE'; state: ClientSiteState | null }
  | { scenario: 'GREETING_VIDEO'; state: GreetingState | null }
  | { scenario: 'PRODUCT_VIDEO'; state: ProductState | null };

export function clientSiteFacts(state: ClientSiteState | null): string[] {
  if (!state) return ['черновика ещё нет'];
  return [
    state.rounds > 0
      ? `записано шагов: ${state.rounds}`
      : 'не записано ни одного шага',
    state.title?.trim() ? 'название задано' : 'название не задано',
    state.status === 'DRAFTING'
      ? 'черновик редактируется'
      : `черновик в статусе ${state.status}`,
    state.hasCredentials
      ? 'вход на сайт уже пройден'
      : 'вход на сайт ещё не проходили',
    state.requiresLiveLoginReplay
      ? 'вход придётся повторить живой сессией'
      : 'повтор входа не требуется',
  ];
}

export function greetingFacts(state: GreetingState | null): string[] {
  if (!state) return ['сессия поздравления ещё не начата'];
  return [
    state.occasion ? 'повод задан' : 'повод не задан',
    state.occasion === 'OTHER'
      ? state.customOccasionText?.trim()
        ? 'свой повод описан'
        : 'свой повод не описан'
      : 'повод из списка',
    state.recipientName?.trim() ? 'получатель назван' : 'получатель не назван',
    state.senderName?.trim() ? 'отправитель назван' : 'отправитель не назван',
    state.usesAvatar ? 'ведущий — говорящий аватар' : 'ведущий — без аватара',
    state.referenceImages > 0
      ? `фото добавлено: ${state.referenceImages}`
      : 'фото не добавлено',
    state.hasPrompt ? 'сценарий собран' : 'сценарий не собран',
    state.promptFlagged
      ? 'сценарий помечен проверкой содержания'
      : 'претензий к сценарию нет',
    state.hasVideo ? 'ролик готов' : 'ролика ещё нет',
  ];
}

export function productFacts(state: ProductState | null): string[] {
  if (!state) return ['прогон ещё не начат'];
  // У сессии на приёме разбора нет и не будет. Строки «разбор не
  // завершён» здесь быть не должно вовсе: советник пишет по фактам, и
  // из этой строки он выведет совет подождать того, чего не случится.
  const source = state.onSceneTemplate
    ? ['сцена задана готовым приёмом, референс не нужен']
    : [
        state.hasReference ? 'референс выбран' : 'референс не выбран',
        state.analysisComplete ? 'разбор завершён' : 'разбор не завершён',
      ];
  return [
    ...source,
    state.hasProductInfo ? 'товар описан' : 'товар не описан',
    state.hasProductImage ? 'фото товара есть' : 'фото товара нет',
    state.promptApproved ? 'промпт одобрен' : 'промпт не одобрен',
    state.renderInFlight ? 'рендер идёт' : 'рендер не идёт',
    state.hasVideo ? 'ролик готов' : 'ролика ещё нет',
  ];
}

/**
 * Факты по сценарию. Ключи обязаны совпадать с `SCENARIO_HINTS` —
 * это и проверяет тест.
 */
export function factsOfScenario(input: ScenarioState): string[] {
  switch (input.scenario) {
    case 'CLIENT_SITE':
      return clientSiteFacts(input.state);
    case 'GREETING_VIDEO':
      return greetingFacts(input.state);
    case 'PRODUCT_VIDEO':
      return productFacts(input.state);
  }
}

/** Сценарии, у которых факты есть. Для сверки с карточками. */
export const SCENARIOS_WITH_FACTS: readonly FreeScenario[] = [
  'CLIENT_SITE',
  'GREETING_VIDEO',
  'PRODUCT_VIDEO',
];

// ── Ответы на вопросы о шаге (ТЗ Greeting 2.0 §4А.2 п.5, этап K4) ─────

/**
 * Фразы ответов на пяти языках. Каждая — факт, который уже написан в
 * карточке шага (`hint-scenarios.ts`) или на экране мастера («обычно это
 * занимает несколько минут» — строка шага «Видео»): помощник не знает
 * ничего сверх того, что знает советник, и ответ голосом не может
 * пообещать то, чего не обещает экран.
 *
 * Короткие и спокойные, без восклицаний: их слышат в том числе на
 * соболезновании (`textFitsRegister`, §4А.4). Поэтому и «свой текст», а
 * не «текст поздравления»: слово «поздравление» — примета праздника для
 * фильтра регистра, и ответ о помеченном сценарии молча не прозвучал бы
 * именно там, где он нужнее всего.
 */
interface AnswerTexts {
  photoAvatar: string;
  photoAvatarMissing: string;
  photoAvatarNeedsConsent: string;
  photoPersona: string;
  photoConsentPending: string;
  nextStartSession: string;
  photoOptional: string;
  photoLimit: string;
  videoReady: string;
  renderRunning: string;
  renderTakes: string;
  needScriptFirst: string;
  nextBrief: string;
  nextOccasion: string;
  nextCustomOccasion: string;
  nextRecipient: string;
  nextAvatarPhoto: string;
  nextScript: string;
  nextFixFlagged: string;
  nextRender: string;
  nextDone: string;
  flagged: string;
  notFlagged: string;
  noScript: string;
}

const ANSWERS: Readonly<Record<SupportedLocale, AnswerTexts>> = {
  ru: {
    photoAvatar:
      'Ведущий у вас — говорящий аватар: первое фото станет его портретом.',
    photoAvatarMissing: 'Без фото рендер откажет.',
    photoAvatarNeedsConsent:
      'Фото с лицом без подтверждённого согласия портретом не станет: подтвердите согласие или добавьте другое фото.',
    photoPersona:
      'В кадре — вы, ваш образ. Фото необязательны: они влияют на картинку ролика.',
    photoConsentPending:
      'Фото с лицом без подтверждённого согласия в ролик не пойдёт.',
    nextStartSession: 'Бриф заполнен — начните сессию, дальше фото и сценарий.',
    photoOptional:
      'Фото необязательно: оно влияет на картинку ролика, но без него ролик тоже получится.',
    photoLimit: 'Можно добавить до семи фото.',
    videoReady: 'Ролик уже готов.',
    renderRunning: 'Ролик генерируется — обычно это занимает несколько минут.',
    renderTakes: 'Ролик обычно генерируется несколько минут.',
    needScriptFirst: 'Сначала нужен собранный сценарий.',
    nextBrief: 'Заполните бриф: повод, тон, кому и от кого — и начните сессию.',
    nextOccasion: 'Выберите повод.',
    nextCustomOccasion: 'Опишите свой повод словами.',
    nextRecipient: 'Назовите получателя.',
    nextAvatarPhoto: 'Добавьте фото — оно станет портретом аватара.',
    nextScript: 'Соберите сценарий.',
    nextFixFlagged:
      'Исправьте текст на шаге «Сценарий» и сохраните его заново: сценарий помечен проверкой.',
    nextRender: 'Запустите генерацию ролика.',
    nextDone: 'Ролик готов — его можно посмотреть и отправить.',
    flagged:
      'Сценарий помечен автоматической проверкой содержания и не отрендерится. Исправьте текст на шаге «Сценарий» и сохраните его заново — повтор не поможет.',
    notFlagged: 'Претензий к сценарию нет.',
    noScript: 'Сценарий ещё не собран.',
  },
  uk: {
    photoAvatar:
      'Ведучий у вас — говорючий аватар: перше фото стане його портретом.',
    photoAvatarMissing: 'Без фото рендер відмовить.',
    photoAvatarNeedsConsent:
      'Фото з обличчям без підтвердженої згоди не стане портретом: підтвердьте згоду або додайте інше фото.',
    photoPersona:
      "У кадрі — ви, ваш образ. Фото необов'язкові: вони впливають на картинку ролика.",
    photoConsentPending:
      'Фото з обличчям без підтвердженої згоди до ролика не потрапить.',
    nextStartSession: 'Бриф заповнено — почніть сесію, далі фото і сценарій.',
    photoOptional:
      "Фото необов'язкове: воно впливає на картинку ролика, але без нього ролик теж вийде.",
    photoLimit: 'Можна додати до семи фото.',
    videoReady: 'Ролик уже готовий.',
    renderRunning: 'Ролик генерується — зазвичай це займає кілька хвилин.',
    renderTakes: 'Ролик зазвичай генерується кілька хвилин.',
    needScriptFirst: 'Спершу потрібен зібраний сценарій.',
    nextBrief:
      'Заповніть бриф: привід, тон, кому і від кого — і почніть сесію.',
    nextOccasion: 'Оберіть привід.',
    nextCustomOccasion: 'Опишіть свій привід словами.',
    nextRecipient: 'Назвіть отримувача.',
    nextAvatarPhoto: 'Додайте фото — воно стане портретом аватара.',
    nextScript: 'Зберіть сценарій.',
    nextFixFlagged:
      'Виправте текст на кроці «Сценарій» і збережіть його знову: сценарій позначено перевіркою.',
    nextRender: 'Запустіть генерацію ролика.',
    nextDone: 'Ролик готовий — його можна переглянути й надіслати.',
    flagged:
      'Сценарій позначено автоматичною перевіркою вмісту, і він не відрендериться. Виправте текст на кроці «Сценарій» і збережіть його знову — повтор не допоможе.',
    notFlagged: 'До сценарію претензій немає.',
    noScript: 'Сценарій ще не зібрано.',
  },
  en: {
    photoAvatar:
      'Your presenter is a talking avatar: the first photo becomes its portrait.',
    photoAvatarMissing: 'Without a photo the render will be refused.',
    photoAvatarNeedsConsent:
      'A photo with a face becomes the portrait only after you confirm consent: confirm it or add another photo.',
    photoPersona:
      'You are on screen, as your look. Photos are optional: they shape the look of the video.',
    photoConsentPending:
      'A photo with a face goes into the video only after you confirm consent.',
    nextStartSession:
      'The brief is filled in — start the session, then photos and the script.',
    photoOptional:
      'A photo is optional: it shapes the look of the video, but the video works without it too.',
    photoLimit: 'You can add up to seven photos.',
    videoReady: 'The video is already ready.',
    renderRunning:
      'The video is being generated — this usually takes a few minutes.',
    renderTakes: 'Generating the video usually takes a few minutes.',
    needScriptFirst: 'First you need a finished script.',
    nextBrief:
      'Fill in the brief: occasion, tone, to whom and from whom — then start the session.',
    nextOccasion: 'Choose the occasion.',
    nextCustomOccasion: 'Describe your occasion in words.',
    nextRecipient: 'Name the recipient.',
    nextAvatarPhoto: "Add a photo — it becomes the avatar's portrait.",
    nextScript: 'Build the script.',
    nextFixFlagged:
      'Fix the text in the «Script» step and save it again: the script was flagged by the check.',
    nextRender: 'Start generating the video.',
    nextDone: 'The video is ready — you can watch and send it.',
    flagged:
      'The script was flagged by the automatic content check and will not render. Fix the text in the «Script» step and save it again — retrying will not help.',
    notFlagged: 'The script has no issues.',
    noScript: 'The script has not been built yet.',
  },
  de: {
    photoAvatar:
      'Ihr Moderator ist ein sprechender Avatar: Das erste Foto wird sein Porträt.',
    photoAvatarMissing: 'Ohne Foto wird das Rendern abgelehnt.',
    photoAvatarNeedsConsent:
      'Ein Foto mit Gesicht wird erst nach bestätigter Einwilligung zum Porträt: Bestätigen Sie sie oder fügen Sie ein anderes Foto hinzu.',
    photoPersona:
      'Im Bild sind Sie, als Ihr Look. Fotos sind optional: Sie prägen das Bild des Videos.',
    photoConsentPending:
      'Ein Foto mit Gesicht kommt erst nach bestätigter Einwilligung ins Video.',
    nextStartSession:
      'Das Briefing ist ausgefüllt — starten Sie die Sitzung, dann folgen Fotos und Skript.',
    photoOptional:
      'Ein Foto ist optional: Es prägt das Bild des Videos, aber das Video gelingt auch ohne.',
    photoLimit: 'Sie können bis zu sieben Fotos hinzufügen.',
    videoReady: 'Das Video ist bereits fertig.',
    renderRunning:
      'Das Video wird generiert — das dauert normalerweise ein paar Minuten.',
    renderTakes: 'Das Generieren dauert normalerweise ein paar Minuten.',
    needScriptFirst: 'Zuerst braucht es ein fertiges Skript.',
    nextBrief:
      'Füllen Sie das Briefing aus: Anlass, Ton, an wen und von wem — und starten Sie die Sitzung.',
    nextOccasion: 'Wählen Sie den Anlass.',
    nextCustomOccasion: 'Beschreiben Sie Ihren Anlass in Worten.',
    nextRecipient: 'Nennen Sie den Empfänger.',
    nextAvatarPhoto:
      'Fügen Sie ein Foto hinzu — es wird das Porträt des Avatars.',
    nextScript: 'Erstellen Sie das Skript.',
    nextFixFlagged:
      'Korrigieren Sie den Text im Schritt «Skript» und speichern Sie ihn erneut: Das Skript wurde von der Prüfung markiert.',
    nextRender: 'Starten Sie die Generierung des Videos.',
    nextDone: 'Das Video ist fertig — Sie können es ansehen und senden.',
    flagged:
      'Das Skript wurde von der automatischen Inhaltsprüfung markiert und wird nicht gerendert. Korrigieren Sie den Text im Schritt «Skript» und speichern Sie ihn erneut — ein erneuter Versuch hilft nicht.',
    notFlagged: 'Am Skript gibt es nichts auszusetzen.',
    noScript: 'Das Skript ist noch nicht erstellt.',
  },
  es: {
    photoAvatar:
      'Tu presentador es un avatar parlante: la primera foto será su retrato.',
    photoAvatarMissing: 'Sin foto, el renderizado se rechazará.',
    photoAvatarNeedsConsent:
      'Una foto con cara solo será el retrato tras confirmar el consentimiento: confírmalo o añade otra foto.',
    photoPersona:
      'En pantalla estás tú, con tu imagen. Las fotos son opcionales: influyen en la imagen del vídeo.',
    photoConsentPending:
      'Una foto con cara solo entra en el vídeo tras confirmar el consentimiento.',
    nextStartSession:
      'El briefing está completo — empieza la sesión; luego fotos y guion.',
    photoOptional:
      'La foto es opcional: influye en la imagen del vídeo, pero sin ella el vídeo también sale.',
    photoLimit: 'Puedes añadir hasta siete fotos.',
    videoReady: 'El vídeo ya está listo.',
    renderRunning:
      'El vídeo se está generando — normalmente tarda unos minutos.',
    renderTakes: 'Generar el vídeo normalmente tarda unos minutos.',
    needScriptFirst: 'Primero hace falta un guion terminado.',
    nextBrief:
      'Rellena el briefing: ocasión, tono, para quién y de quién — y empieza la sesión.',
    nextOccasion: 'Elige la ocasión.',
    nextCustomOccasion: 'Describe tu ocasión con palabras.',
    nextRecipient: 'Indica el destinatario.',
    nextAvatarPhoto: 'Añade una foto — será el retrato del avatar.',
    nextScript: 'Crea el guion.',
    nextFixFlagged:
      'Corrige el texto en el paso «Guion» y guárdalo de nuevo: el guion fue marcado por la revisión.',
    nextRender: 'Inicia la generación del vídeo.',
    nextDone: 'El vídeo está listo — puedes verlo y enviarlo.',
    flagged:
      'La revisión automática de contenido marcó el guion y no se renderizará. Corrige el texto en el paso «Guion» y guárdalo de nuevo — repetir no ayudará.',
    notFlagged: 'El guion no tiene problemas.',
    noScript: 'El guion aún no está creado.',
  },
};

/**
 * Пригодные для портрета фото. Состояние без этого поля (прочитано не
 * `greetingStateOf`) — все фото, как до волны G.
 */
function portraitsOf(state: GreetingState): number {
  return state.portraitPhotos ?? state.referenceImages;
}

/** Первое, чего не хватает, — по тем же фактам, что у дайджеста. */
function nextOf(state: GreetingState | null, t: AnswerTexts): string {
  if (!state) return t.nextBrief;
  if (!state.occasion) return t.nextOccasion;
  if (state.occasion === 'OTHER' && !state.customOccasionText?.trim()) {
    return t.nextCustomOccasion;
  }
  if (!state.recipientName?.trim()) return t.nextRecipient;
  // До сессии фото и сценария не бывает — следующий шаг сама сессия.
  if (state.hasSession === false) return t.nextStartSession;
  // Портрет нужен только аватару без образа персоны, и только из фото,
  // которое можно пустить в модель (лицо — с подтверждённым согласием).
  if (
    state.usesAvatar &&
    !state.presenterIsPersona &&
    portraitsOf(state) === 0
  ) {
    return state.referenceImages > 0
      ? t.photoAvatarNeedsConsent
      : t.nextAvatarPhoto;
  }
  if (!state.hasPrompt) return t.nextScript;
  if (state.promptFlagged) return t.nextFixFlagged;
  if (state.videoReady) return t.nextDone;
  if (state.renderInFlight) return t.renderRunning;
  return t.nextRender;
}

/**
 * Ответ на вопрос о шаге — из фактов состояния, без модели (§4А.2 п.5).
 *
 * `state: null` — сессии ещё нет (бриф до старта): ответы, которые от
 * сессии не зависят, всё равно есть. `null` на выходе — факта нет, и
 * помощник говорит «не знаю, посмотрите справку»; сейчас каждая тема
 * закрытого списка отвечена, но контракт держит место под тему, у
 * которой факта может не оказаться.
 */
export function greetingAnswer(
  topic: VoiceQuestionTopic,
  state: GreetingState | null,
  locale: SupportedLocale,
): string | null {
  const t = ANSWERS[locale];
  switch (topic) {
    case 'why-photo': {
      const pending = state?.photosAwaitingConsent
        ? t.photoConsentPending
        : null;
      if (state?.presenterIsPersona) {
        return [t.photoPersona, pending, t.photoLimit]
          .filter(Boolean)
          .join(' ');
      }
      if (state?.usesAvatar) {
        const portraits = portraitsOf(state);
        return [
          t.photoAvatar,
          portraits > 0
            ? null
            : state.referenceImages > 0
              ? t.photoAvatarNeedsConsent
              : t.photoAvatarMissing,
          portraits > 0 ? pending : null,
          t.photoLimit,
        ]
          .filter(Boolean)
          .join(' ');
      }
      return [t.photoOptional, pending, t.photoLimit].filter(Boolean).join(' ');
    }
    case 'how-long':
      if (state?.videoReady) return t.videoReady;
      if (state?.renderInFlight) return t.renderRunning;
      return state?.hasPrompt
        ? t.renderTakes
        : `${t.renderTakes} ${t.needScriptFirst}`;
    case 'what-next':
      return nextOf(state, t);
    case 'script-flagged':
      // Совет — тот же, что в отказе `startVideo` («исправьте текст на
      // шаге «Сценарий» и сохраните заново»): раньше ведущий советовал
      // править бриф, а кнопка рендера — текст, и человек слышал два
      // разных пути из одной беды.
      if (!state?.hasPrompt) return t.noScript;
      return state.promptFlagged ? t.flagged : t.notFlagged;
    default:
      return null;
  }
}
