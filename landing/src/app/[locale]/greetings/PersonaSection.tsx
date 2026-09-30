import Image from 'next/image';
import type { Dictionary } from '../../../lib/get-dictionary';
import { greetingPersonaScheme } from '../../../lib/greeting-frames';

/**
 * Секция «Вы в кадре» (этап J ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5.2 п.5, §4).
 *
 * Серверный компонент, без `'use client'` и без пакетов: ему нечего
 * делать в браузере, а тексты режима не должны попадать в клиентские
 * данные страницы (см. `clientDictionary` в `lib/get-dictionary.ts`).
 *
 * Страница рисует его ТОЛЬКО через `greetingSectionOrder()`: пока
 * `PERSONA_SECTION_ENABLED` выключена, идентификатора `persona` в списке
 * нет, и этого компонента в HTML нет вовсе, а не «спрятан стилем».
 *
 * Что сказано и почему именно так — каждое утверждение сверено с кодом
 * режима «Я в кадре» (`backend/src/modules/persona`, `persona-looks`,
 * `common/greeting-persona.ts`, `frontend/src/features/persona`):
 *
 *  - «образы по образцу, а не обученная модель; сходство не
 *    гарантировано» — режим строится на референс-изображениях (§4
 *    вступление, строка AI-ACTORS в таблице ТЗ): обещать «то же лицо в
 *    каждом кадре» или «цифрового двойника» нельзя;
 *  - «защита от чужого фото, а не проверка личности» — живость проверяет
 *    модель, это не KYC (Т-16); слов «личность подтверждена» нет нигде;
 *  - маркировки ИИ-контента в текстах НЕТ сознательно: это В-6, решает
 *    юрист в шлюзе §4.10 (TBD). Пообещать пометку, которой в роликах нет,
 *    так же неправда, как пообещать её отсутствие.
 *
 * Схема справа — Уровень 1 обучалки: без текста и без настоящего лица,
 * силуэт и плитки образов. `alt` пустой: смысл несут шаги слева.
 */
export function PersonaSection({
  texts,
}: {
  texts: Dictionary['greetingsLanding']['persona'];
}) {
  const scheme = greetingPersonaScheme();
  return (
    <section className="persona" id="persona">
      <div className="wrap">
        <h2>{texts.title}</h2>
        <p className="section-lead">{texts.lead}</p>
        <div className="persona-grid">
          {/* Путь по порядку экрана `#/persona`: согласие → съёмка →
              допуск по возрасту → образы. Порядок — часть обещания
              («камера только после галочки»), поэтому это `ol`. */}
          <ol className="persona-steps">
            {texts.steps.map((step, index) => (
              <li className="persona-step" key={step.title}>
                <span className="persona-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="persona-shot frame-shot">
            <Image
              src={scheme.src}
              alt=""
              aria-hidden
              width={scheme.width}
              height={scheme.height}
              unoptimized
            />
          </div>
        </div>
        {/* Оговорка о сходстве — отдельным абзацем, не мелким шрифтом в
            карточке: это главное ограничение режима, его читают до
            того, как снимать селфи. */}
        <p className="persona-likeness">{texts.likeness}</p>
        <div className="login-grid">
          {texts.items.map((item) => (
            <article className="login-card" key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
