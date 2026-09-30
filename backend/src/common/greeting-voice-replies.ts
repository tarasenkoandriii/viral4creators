/**
 * Реплики помощника на пяти языках интерфейса.
 *
 * Отдельный модуль — потому что это только текст: его правят
 * переводчики и редактор, не трогая логику, а проверка значений и ядро
 * разбора лишь берут отсюда готовые фразы. Модуль ни от чего в разборе
 * не зависит (только от списка языков), поэтому его может импортировать
 * любой слой без цикла. Внешний вход — `greeting-voice-intent.ts`.
 */

import { SupportedLocale } from './locale';

// ── Реплики помощника ───────────────────────────────────────────────────

interface Replies {
  notHeard: string;
  scriptMismatch: string;
  unavailable: string;
  budgetExhausted: string;
  notUnderstood: string;
  confirmQuestion: string;
  reask: (names: string[]) => string;
  noSuchOption: (name: string) => string;
  onlyForOther: (name: string, other: string) => string;
  tooLong: (name: string) => string;
  badDate: (name: string) => string;
  resolutionAbovePlan: (value: string, max: string) => string;
  toneMostSerious: string;
  toneMostLight: string;
  noJokesAlready: string;
  needSession: string;
  needScript: string;
  consentNeedsPhrase: (phrase: string) => string;
  consentUnsure: (phrase: string) => string;
  consentNeedsScript: string;
  accountLimit: string;
  loginRequired: string;
  transcriptTooLong: string;
  // K5 — элементы сессии.
  notOnScreen: (name: string) => string;
  alreadyOn: (name: string) => string;
  alreadyOff: (name: string) => string;
  alreadySelected: (name: string, value: string) => string;
  chooseVariant: (name: string, options: string[]) => string;
  stickerByHand: (name: string) => string;
  scenesMax: (name: string, max: number) => string;
  moderation: (name: string) => string;
  celebrity: (name: string, fragment: string) => string;
  contradiction: (names: string[]) => string;
  shorterByHand: string;
  noOtherMusic: (name: string) => string;
  /**
   * K4: вопрос о шаге, на который у помощника нет факта (тема вне
   * закрытого списка). Честное «не знаю» вместо выдумки, и куда смотреть:
   * клиент рядом показывает кнопку справки.
   */
  questionUnknown: string;
}

/** Перечень вариантов вслух: не больше шести, остальное — «…». */
function optionList(options: string[]): string {
  const shown = options.slice(0, 6).map((o) => `«${o}»`);
  return options.length > 6 ? `${shown.join(', ')}…` : shown.join(', ');
}

/**
 * Реплики — короткие: их слышат голосом, и абзац вслух — это минута.
 * Спокойные, без восклицаний: в траурном регистре помощник не бодрится
 * (§4А.4), а отдельного набора реплик на регистр заводить незачем, если
 * общий и так сдержан.
 */
export const REPLIES: Readonly<Record<SupportedLocale, Replies>> = {
  ru: {
    notHeard: 'Не расслышал. Повторите, пожалуйста.',
    scriptMismatch: 'Похоже, я расслышал неточно. Повторите, пожалуйста.',
    unavailable:
      'Голосовой ввод сейчас недоступен. Заполните, пожалуйста, руками.',
    budgetExhausted:
      'Голос на сегодня выключен: дневной лимит исчерпан. Мастер работает как обычно, руками.',
    notUnderstood:
      'Не понял. Скажите, например: «повод — день рождения, кому — мама».',
    confirmQuestion: 'Всё верно? Скажите «да» или «нет».',
    reask: (n) => `Не расслышал: ${n.join(', ')}. Повторите, пожалуйста.`,
    noSuchOption: (n) => `${n}: такого варианта нет.`,
    onlyForOther: (n, o) => `${n} — только для повода «${o}».`,
    tooLong: (n) => `${n}: слишком длинно для этого поля.`,
    badDate: (n) => `${n}: не понял дату. Назовите день, месяц и год.`,
    resolutionAbovePlan: (v, m) =>
      `Качество ${v} недоступно на вашем тарифе, максимум — ${m}.`,
    toneMostSerious: 'Тон уже самый сдержанный из доступных.',
    toneMostLight: 'Тон уже самый лёгкий.',
    noJokesAlready: 'Тон и так без шуток.',
    needSession: 'Сначала начните сборку ролика.',
    needScript: 'Сценария ещё нет — сначала соберите его.',
    consentNeedsPhrase: (p) =>
      `Чтобы запустить генерацию, скажите ясно: «${p}».`,
    consentUnsure: (p) =>
      `Не уверен, что расслышал согласие. Повторите: «${p}».`,
    consentNeedsScript: 'Генерировать пока нечего: сначала соберите сценарий.',
    accountLimit:
      'Дневной лимит вашего аккаунта исчерпан, поэтому голос сейчас недоступен. Лимит обновится завтра; мастер работает руками.',
    loginRequired:
      'Голосом — после входа через Telegram. Пока заполните, пожалуйста, руками.',
    transcriptTooLong:
      'Слишком длинно для одной реплики. Продиктуйте короче или введите руками.',
    notOnScreen: (n) => `${n}: сейчас этого нет на экране.`,
    alreadyOn: (n) => `${n}: уже выбрано.`,
    alreadyOff: (n) => `${n}: и так не выбрано.`,
    alreadySelected: (n, v) => `${n}: уже «${v}».`,
    chooseVariant: (n, o) =>
      o.length
        ? `${n}: назовите вариант — ${optionList(o)}.`
        : `${n}: вариантов сейчас нет.`,
    stickerByHand: (n) =>
      `${n}: картинку выберите на экране. Голосом могу вписать, что искать.`,
    scenesMax: (n, m) => `${n}: для этого повода — от 1 до ${m}.`,
    moderation: (n) =>
      `${n}: текст не прошёл автоматическую проверку. Измените его.`,
    celebrity: (n, f) =>
      `${n}: не получится сделать ролик, похожий на конкретного реального человека («${f}»). Уберите это из текста.`,
    contradiction: (n) =>
      `Противоречие: ${n.join(', ')} — скажите что-то одно.`,
    shorterByHand:
      'Сократить голосом пока нельзя — отредактируйте текст сценария или соберите его заново.',
    noOtherMusic: (n) => `${n}: других тем для этого повода нет.`,
    questionUnknown: 'Этого я не знаю. Посмотрите справку.',
  },
  uk: {
    notHeard: 'Не розчув. Повторіть, будь ласка.',
    scriptMismatch: 'Здається, я розчув неточно. Повторіть, будь ласка.',
    unavailable:
      'Голосове введення зараз недоступне. Заповніть, будь ласка, вручну.',
    budgetExhausted:
      'Голос на сьогодні вимкнено: денний ліміт вичерпано. Майстер працює як звичайно, вручну.',
    notUnderstood:
      'Не зрозумів. Скажіть, наприклад: «привід — день народження, кому — мама».',
    confirmQuestion: 'Усе правильно? Скажіть «так» або «ні».',
    reask: (n) => `Не розчув: ${n.join(', ')}. Повторіть, будь ласка.`,
    noSuchOption: (n) => `${n}: такого варіанта немає.`,
    onlyForOther: (n, o) => `${n} — лише для приводу «${o}».`,
    tooLong: (n) => `${n}: задовго для цього поля.`,
    badDate: (n) => `${n}: не зрозумів дату. Назвіть день, місяць і рік.`,
    resolutionAbovePlan: (v, m) =>
      `Якість ${v} недоступна на вашому тарифі, максимум — ${m}.`,
    toneMostSerious: 'Тон уже найстриманіший із доступних.',
    toneMostLight: 'Тон уже найлегший.',
    noJokesAlready: 'Тон і так без жартів.',
    needSession: 'Спершу почніть збірку ролика.',
    needScript: 'Сценарію ще немає — спершу зберіть його.',
    consentNeedsPhrase: (p) =>
      `Щоб запустити генерацію, скажіть чітко: «${p}».`,
    consentUnsure: (p) => `Не впевнений, що розчув згоду. Повторіть: «${p}».`,
    consentNeedsScript: 'Генерувати поки нічого: спершу зберіть сценарій.',
    accountLimit:
      'Денний ліміт вашого акаунта вичерпано, тож голос зараз недоступний. Ліміт оновиться завтра; майстер працює вручну.',
    loginRequired:
      'Голосом — після входу через Telegram. Поки заповніть, будь ласка, вручну.',
    transcriptTooLong:
      'Задовго для однієї репліки. Продиктуйте коротше або введіть вручну.',
    notOnScreen: (n) => `${n}: зараз цього немає на екрані.`,
    alreadyOn: (n) => `${n}: уже вибрано.`,
    alreadyOff: (n) => `${n}: і так не вибрано.`,
    alreadySelected: (n, v) => `${n}: уже «${v}».`,
    chooseVariant: (n, o) =>
      o.length
        ? `${n}: назвіть варіант — ${optionList(o)}.`
        : `${n}: варіантів зараз немає.`,
    stickerByHand: (n) =>
      `${n}: картинку виберіть на екрані. Голосом можу вписати, що шукати.`,
    scenesMax: (n, m) => `${n}: для цього приводу — від 1 до ${m}.`,
    moderation: (n) =>
      `${n}: текст не пройшов автоматичну перевірку. Змініть його.`,
    celebrity: (n, f) =>
      `${n}: не вийде зробити ролик, схожий на конкретну реальну людину («${f}»). Приберіть це з тексту.`,
    contradiction: (n) => `Суперечність: ${n.join(', ')} — скажіть щось одне.`,
    shorterByHand:
      'Скоротити голосом поки не можна — відредагуйте текст сценарію або зберіть його заново.',
    noOtherMusic: (n) => `${n}: інших тем для цього приводу немає.`,
    questionUnknown: 'Цього я не знаю. Перегляньте довідку.',
  },
  en: {
    notHeard: "I didn't catch that. Please say it again.",
    scriptMismatch: 'I may have misheard. Please say it again.',
    unavailable: 'Voice input is unavailable right now. Please type instead.',
    budgetExhausted:
      'Voice is off for today: the daily limit is used up. The wizard works as usual, by hand.',
    notUnderstood:
      'I didn\'t understand. Try, for example: "occasion — birthday, to — Mom".',
    confirmQuestion: 'Is that right? Say "yes" or "no".',
    reask: (n) => `I didn't catch: ${n.join(', ')}. Please say it again.`,
    noSuchOption: (n) => `${n}: there is no such option.`,
    onlyForOther: (n, o) => `${n} — only for the "${o}" occasion.`,
    tooLong: (n) => `${n}: too long for this field.`,
    badDate: (n) =>
      `${n}: I didn't understand the date. Please say the day, month and year.`,
    resolutionAbovePlan: (v, m) =>
      `${v} quality isn't available on your plan; the maximum is ${m}.`,
    toneMostSerious: 'The tone is already the most restrained available.',
    toneMostLight: 'The tone is already the lightest.',
    noJokesAlready: 'The tone already has no jokes.',
    needSession: 'Start building the video first.',
    needScript: "There's no script yet — build it first.",
    consentNeedsPhrase: (p) => `To start generation, say clearly: "${p}".`,
    consentUnsure: (p) =>
      `I'm not sure I heard your consent. Please repeat: "${p}".`,
    consentNeedsScript:
      'There is nothing to generate yet: build the script first.',
    accountLimit:
      "Your account's daily limit is used up, so voice is unavailable right now. The limit resets tomorrow; the wizard works by hand.",
    loginRequired:
      'Voice control is available after signing in with Telegram. For now, please fill in by hand.',
    transcriptTooLong:
      'That is too long for one phrase. Please say it shorter or type it in.',
    notOnScreen: (n) => `${n}: that isn't on the screen right now.`,
    alreadyOn: (n) => `${n}: already selected.`,
    alreadyOff: (n) => `${n}: nothing is selected anyway.`,
    alreadySelected: (n, v) => `${n}: already "${v}".`,
    chooseVariant: (n, o) =>
      o.length
        ? `${n}: please name an option — ${optionList(o)}.`
        : `${n}: there are no options right now.`,
    stickerByHand: (n) =>
      `${n}: pick the picture on the screen. By voice I can fill in what to search for.`,
    scenesMax: (n, m) => `${n}: for this occasion, from 1 to ${m}.`,
    moderation: (n) =>
      `${n}: the text did not pass the automatic check. Please change it.`,
    celebrity: (n, f) =>
      `${n}: we can't make a video resembling a specific real person ("${f}"). Please remove that from the text.`,
    contradiction: (n) =>
      `That's a contradiction: ${n.join(', ')} — please say just one.`,
    shorterByHand:
      "Shortening by voice isn't available yet — edit the script text or build it again.",
    noOtherMusic: (n) => `${n}: there are no other themes for this occasion.`,
    questionUnknown: "I don't know that. Please check the help.",
  },
  de: {
    notHeard: 'Das habe ich nicht verstanden. Bitte noch einmal.',
    scriptMismatch:
      'Ich habe es vielleicht falsch verstanden. Bitte noch einmal.',
    unavailable:
      'Die Spracheingabe ist gerade nicht verfügbar. Bitte von Hand ausfüllen.',
    budgetExhausted:
      'Die Sprachsteuerung ist für heute aus: Das Tageslimit ist erreicht. Der Assistent funktioniert wie gewohnt von Hand.',
    notUnderstood:
      'Nicht verstanden. Sagen Sie zum Beispiel: „Anlass — Geburtstag, an — Mama“.',
    confirmQuestion: 'Stimmt das? Sagen Sie „ja“ oder „nein“.',
    reask: (n) => `Nicht verstanden: ${n.join(', ')}. Bitte noch einmal.`,
    noSuchOption: (n) => `${n}: Diese Option gibt es nicht.`,
    onlyForOther: (n, o) => `${n} — nur für den Anlass „${o}“.`,
    tooLong: (n) => `${n}: zu lang für dieses Feld.`,
    badDate: (n) =>
      `${n}: Datum nicht verstanden. Bitte Tag, Monat und Jahr nennen.`,
    resolutionAbovePlan: (v, m) =>
      `Qualität ${v} ist in Ihrem Tarif nicht verfügbar, maximal ${m}.`,
    toneMostSerious: 'Der Ton ist bereits der zurückhaltendste verfügbare.',
    toneMostLight: 'Der Ton ist bereits der leichteste.',
    noJokesAlready: 'Der Ton ist bereits ohne Witze.',
    needSession: 'Starten Sie zuerst die Erstellung des Videos.',
    needScript: 'Es gibt noch kein Skript — erstellen Sie es zuerst.',
    consentNeedsPhrase: (p) =>
      `Um die Generierung zu starten, sagen Sie deutlich: „${p}“.`,
    consentUnsure: (p) =>
      `Ich bin nicht sicher, ob ich Ihre Zustimmung gehört habe. Bitte wiederholen: „${p}“.`,
    consentNeedsScript:
      'Noch gibt es nichts zu generieren: Erstellen Sie zuerst das Skript.',
    accountLimit:
      'Das Tageslimit Ihres Kontos ist erreicht, deshalb ist die Sprachsteuerung gerade nicht verfügbar. Das Limit wird morgen zurückgesetzt; der Assistent funktioniert von Hand.',
    loginRequired:
      'Sprachsteuerung gibt es nach der Anmeldung über Telegram. Bitte vorerst von Hand ausfüllen.',
    transcriptTooLong:
      'Zu lang für einen Satz. Bitte kürzer sprechen oder von Hand eingeben.',
    notOnScreen: (n) => `${n}: Das ist gerade nicht auf dem Bildschirm.`,
    alreadyOn: (n) => `${n}: bereits ausgewählt.`,
    alreadyOff: (n) => `${n}: Es ist ohnehin nichts ausgewählt.`,
    alreadySelected: (n, v) => `${n}: bereits „${v}“.`,
    chooseVariant: (n, o) =>
      o.length
        ? `${n}: Bitte eine Option nennen — ${optionList(o)}.`
        : `${n}: Gerade gibt es keine Optionen.`,
    stickerByHand: (n) =>
      `${n}: Das Bild bitte auf dem Bildschirm auswählen. Per Sprache kann ich den Suchbegriff eintragen.`,
    scenesMax: (n, m) => `${n}: für diesen Anlass von 1 bis ${m}.`,
    moderation: (n) =>
      `${n}: Der Text hat die automatische Prüfung nicht bestanden. Bitte ändern.`,
    celebrity: (n, f) =>
      `${n}: Ein Video, das einer bestimmten realen Person ähnelt („${f}“), ist nicht möglich. Bitte aus dem Text entfernen.`,
    contradiction: (n) =>
      `Widerspruch: ${n.join(', ')} — bitte nur eines sagen.`,
    shorterByHand:
      'Kürzen per Sprache geht noch nicht — bearbeiten Sie den Skripttext oder erstellen Sie ihn neu.',
    noOtherMusic: (n) =>
      `${n}: Für diesen Anlass gibt es keine anderen Themen.`,
    questionUnknown: 'Das weiß ich nicht. Bitte sehen Sie in der Hilfe nach.',
  },
  es: {
    notHeard: 'No te he oído bien. Repítelo, por favor.',
    scriptMismatch: 'Puede que no lo haya oído bien. Repítelo, por favor.',
    unavailable:
      'La entrada por voz no está disponible ahora. Rellénalo a mano, por favor.',
    budgetExhausted:
      'La voz está desactivada por hoy: se agotó el límite diario. El asistente funciona como siempre, a mano.',
    notUnderstood:
      'No lo he entendido. Di, por ejemplo: «ocasión — cumpleaños, para — mamá».',
    confirmQuestion: '¿Es correcto? Di «sí» o «no».',
    reask: (n) => `No he oído bien: ${n.join(', ')}. Repítelo, por favor.`,
    noSuchOption: (n) => `${n}: no existe esa opción.`,
    onlyForOther: (n, o) => `${n}: solo para la ocasión «${o}».`,
    tooLong: (n) => `${n}: demasiado largo para este campo.`,
    badDate: (n) =>
      `${n}: no he entendido la fecha. Di el día, el mes y el año.`,
    resolutionAbovePlan: (v, m) =>
      `La calidad ${v} no está disponible en tu plan; el máximo es ${m}.`,
    toneMostSerious: 'El tono ya es el más sobrio disponible.',
    toneMostLight: 'El tono ya es el más ligero.',
    noJokesAlready: 'El tono ya no tiene bromas.',
    needSession: 'Primero empieza a montar el vídeo.',
    needScript: 'Todavía no hay guion: créalo primero.',
    consentNeedsPhrase: (p) =>
      `Para iniciar la generación, di claramente: «${p}».`,
    consentUnsure: (p) =>
      `No estoy seguro de haber oído tu consentimiento. Repite: «${p}».`,
    consentNeedsScript:
      'Todavía no hay nada que generar: crea primero el guion.',
    accountLimit:
      'Se agotó el límite diario de tu cuenta, así que la voz no está disponible ahora. El límite se renueva mañana; el asistente funciona a mano.',
    loginRequired:
      'El control por voz está disponible después de iniciar sesión con Telegram. Por ahora, rellénalo a mano.',
    transcriptTooLong:
      'Es demasiado largo para una frase. Dilo más corto o escríbelo a mano.',
    notOnScreen: (n) => `${n}: eso no está en la pantalla ahora.`,
    alreadyOn: (n) => `${n}: ya está elegido.`,
    alreadyOff: (n) => `${n}: no hay nada elegido.`,
    alreadySelected: (n, v) => `${n}: ya es «${v}».`,
    chooseVariant: (n, o) =>
      o.length
        ? `${n}: di una opción — ${optionList(o)}.`
        : `${n}: ahora no hay opciones.`,
    stickerByHand: (n) =>
      `${n}: elige la imagen en la pantalla. Por voz puedo escribir qué buscar.`,
    scenesMax: (n, m) => `${n}: para esta ocasión, de 1 a ${m}.`,
    moderation: (n) =>
      `${n}: el texto no pasó la revisión automática. Cámbialo.`,
    celebrity: (n, f) =>
      `${n}: no se puede hacer un vídeo que se parezca a una persona real concreta («${f}»). Quítalo del texto.`,
    contradiction: (n) =>
      `Es una contradicción: ${n.join(', ')} — di solo una cosa.`,
    shorterByHand:
      'Todavía no se puede acortar por voz: edita el texto del guion o vuelve a montarlo.',
    noOtherMusic: (n) => `${n}: no hay otros temas para esta ocasión.`,
    questionUnknown: 'Eso no lo sé. Consulta la ayuda.',
  },
};
