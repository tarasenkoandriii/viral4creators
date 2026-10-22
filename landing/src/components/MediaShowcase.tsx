import { MediaPlayer } from "./MediaPlayer";
const copy = {
  ru: {
    title: "Посмотрите, как устроен процесс",
    play: "Смотреть видео",
    process: "12 секунд · схема процесса",
    note: "Короткая немая схема: {steps}. Это иллюстрация процесса, не запись готового продукта или результата клиента.",
    steps: {
      ads: "продукт → сюжет → короткий ролик",
      greetings: "повод → личное пожелание → видеопоздравление",
      stories: "библиотека сказок → рассказчик и голос → просмотр и проверка",
      tutorial: "одна задача → запись экрана → проверка результата",
    },
    voice: "Голосовой помощник: концепция",
    voiceNote:
      "Опубликованная немая иллюстрация: вопрос голосом, следующий шаг, перебивание и Stop. Не запись работающего интерфейса; голосовые функции остаются в пилоте.",
    ad: "Пример рекламного концепта",
    adNote:
      "Готовый короткий ролик с продуктом. Демонстрационный концепт, не заказ бренда. Есть звуковое сопровождение.",
  },
  uk: {
    title: "Подивіться, як побудований процес",
    play: "Дивитися відео",
    process: "12 секунд · схема процесу",
    note: "Коротка німа схема: {steps}. Це ілюстрація процесу, не запис готового продукту чи результату клієнта.",
    steps: {
      ads: "продукт → сюжет → короткий ролик",
      greetings: "привід → особисте побажання → відеопривітання",
      stories: "бібліотека казок → оповідач і голос → перегляд і перевірка",
      tutorial: "одне завдання → запис екрана → перевірка результату",
    },
    voice: "Голосовий помічник: концепція",
    voiceNote:
      "Опублікована німа ілюстрація: запитання голосом, наступний крок, перебивання та Stop. Не запис робочого інтерфейсу; голосові функції залишаються в пілоті.",
    ad: "Приклад рекламного концепту",
    adNote:
      "Готовий короткий ролик із продуктом. Демонстраційний концепт, не замовлення бренду. Є звуковий супровід.",
  },
  en: {
    title: "See the process in motion",
    play: "Play video",
    process: "12 seconds · process overview",
    note: "A short silent overview: {steps}. This illustrates the process, not a recording of a finished product or a client result.",
    steps: {
      ads: "product → story → short video",
      greetings: "occasion → personal message → video greeting",
      stories: "story library → narrator and voice → review",
      tutorial: "one task → screen recording → verification",
    },
    voice: "Voice assistant concept",
    voiceNote:
      "Published silent concept: a spoken question, next step, interruption and Stop. Not a live interface recording; voice features remain a pilot.",
    ad: "Product video concept",
    adNote:
      "A finished short product clip. A demonstration concept, not a brand commission. Includes sound.",
  },
  de: {
    title: "So funktioniert der Ablauf",
    play: "Video ansehen",
    process: "12 Sekunden · Prozessübersicht",
    note: "Eine kurze stumme Übersicht: {steps}. Eine Prozessillustration, keine Aufnahme eines fertigen Produkts oder Kundenergebnisses.",
    steps: {
      ads: "Produkt → Geschichte → kurzes Video",
      greetings: "Anlass → persönliche Nachricht → Videogruß",
      stories: "Märchenbibliothek → Erzähler und Stimme → Prüfung",
      tutorial: "eine Aufgabe → Bildschirmaufnahme → Prüfung",
    },
    ad: "Produktvideo als Konzept",
    adNote:
      "Ein fertiger kurzer Produktclip. Demonstrationskonzept, kein Markenauftrag. Mit Ton.",
  },
  es: {
    title: "Mira cómo funciona el proceso",
    play: "Ver vídeo",
    process: "12 segundos · resumen del proceso",
    note: "Un breve esquema sin sonido: {steps}. Ilustra el proceso, no una grabación del producto terminado ni del resultado de un cliente.",
    steps: {
      ads: "producto → historia → vídeo corto",
      greetings: "ocasión → mensaje personal → saludo en vídeo",
      stories: "biblioteca de cuentos → narrador y voz → revisión",
      tutorial: "una tarea → grabación de pantalla → verificación",
    },
    ad: "Concepto de vídeo de producto",
    adNote:
      "Un clip de producto terminado. Concepto de demostración, no un encargo de marca. Incluye sonido.",
  },
} as const;

export function MediaShowcase({
  locale,
  product,
}: {
  locale: keyof typeof copy;
  product: string;
}) {
  const t = copy[locale];
  const steps = t.steps as Record<string, string>;
  const items =
    product === "voice"
      ? [
          {
            src: "/media/voice-concept.mp4",
            poster: "/media/voice-concept.jpg",
            title: t.process,
            description: t.note,
          },
        ]
      : [
          {
            src: `/media/${product}-process-${locale}.mp4`,
            poster: `/media/${product}-process-${locale}.jpg`,
            title: t.process,
            description: t.note.replace("{steps}", steps[product] ?? ""),
          },
          ...(product === "ads"
            ? [
                {
                  src: "/media/product-concept.mp4",
                  poster: "/media/product-concept.jpg",
                  title: t.ad,
                  description: t.adNote,
                },
              ]
            : []),
        ];
  return (
    <section className="media-section" id="watch">
      <div className="wrap">
        <h2>{t.title}</h2>
        <MediaPlayer items={items} play={t.play} />
      </div>
    </section>
  );
}
