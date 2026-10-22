import { MediaPlayer } from './MediaPlayer';
const copy = {
  uk: {
    title: 'Подивіться, як побудований процес',
    play: 'Дивитися відео',
    process: '12 секунд · схема процесу',
    note: 'Коротка німа схема: {steps}. Це ілюстрація процесу, не запис готового продукту чи результату клієнта.',
    steps: {
      publisher: 'завдання → редакторська перевірка → публікація',
    },
    voice: 'Голосовий помічник: концепція',
    voiceNote:
      'Опублікована німа ілюстрація: запитання голосом, наступний крок, перебивання та Stop. Не запис робочого інтерфейсу; голосові функції залишаються в пілоті.',
    ad: 'Приклад рекламного концепту',
    adNote: 'Готовий короткий ролик із продуктом. Демонстраційний концепт, не замовлення бренду. Є звуковий супровід.',
  },
} as const;

export function MediaShowcase({ locale, product }: { locale: keyof typeof copy; product: string }) {
  const t = copy[locale];
  const steps = t.steps as Record<string, string>;
  const items =
    product === 'voice'
      ? [{ src: '/media/voice-concept.mp4', poster: '/media/voice-concept.jpg', title: t.process, description: t.note }]
      : [
          {
            src: `/media/${product}-process-${locale}.mp4`,
            poster: `/media/${product}-process-${locale}.jpg`,
            title: t.process,
            description: t.note.replace('{steps}', steps[product] ?? ''),
          },
          ...(product === 'ads'
            ? [
                {
                  src: '/media/product-concept.mp4',
                  poster: '/media/product-concept.jpg',
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
