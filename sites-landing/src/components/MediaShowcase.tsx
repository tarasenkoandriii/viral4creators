import { MediaPlayer } from "./MediaPlayer";
const copy = {
  ru: {
    title: "Посмотрите, как устроен процесс",
    play: "Смотреть видео",
    process: "12 секунд · схема процесса",
    note: "Короткая немая схема: {steps}. Это иллюстрация процесса, не запись готового продукта или результата клиента.",
    steps: {
      qa: "сценарий → проверка результата → замечания и отчёт",
    },
    voice: "Голосовой помощник: концепция",
    voiceNote:
      "Опубликованная немая иллюстрация с английским текстом: вопрос голосом, следующий шаг, перебивание и Stop. Не запись работающего интерфейса; голосовые функции остаются в пилоте.",
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
      qa: "сценарій → перевірка результату → зауваження та звіт",
    },
    voice: "Голосовий помічник: концепція",
    voiceNote:
      "Опублікована німа ілюстрація з англійським текстом: запитання голосом, наступний крок, перебивання та Stop. Не запис робочого інтерфейсу; голосові функції залишаються в пілоті.",
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
      qa: "workflow → result check → findings and report",
    },
    voice: "Voice assistant concept",
    voiceNote:
      "Published silent concept with English on-screen text: a spoken question, next step, interruption and Stop. Not a live interface recording; voice features remain a pilot.",
    ad: "Product video concept",
    adNote:
      "A finished short product clip. A demonstration concept, not a brand commission. Includes sound.",
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
            title: t.voice,
            description: t.voiceNote,
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
