/** Local, read-only heuristics. No values, text samples, paths or network requests. */
export function quickPageAudit() {
  if (location.protocol !== "https:")
    throw new Error("Откройте HTTPS-страницу.");
  const visible = (el) =>
    !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const elements = [...document.querySelectorAll("body *")];
  if (elements.length > 20000)
    throw new Error("Страница слишком большая для быстрого аудита.");
  const checks = [];
  const add = (id, title, count, action) =>
    checks.push({
      id,
      title,
      count,
      status: count ? "review" : "no-signal",
      action,
    });
  add(
    "title",
    "Отсутствует заголовок вкладки",
    document.title.trim() ? 0 : 1,
    "Укажите содержательный title страницы.",
  );
  add(
    "lang",
    "Не указан язык документа",
    document.documentElement.lang.trim() ? 0 : 1,
    "Укажите lang на элементе html.",
  );
  add(
    "viewport",
    "Нет настройки мобильного viewport",
    document.querySelector('meta[name="viewport" i]') ? 0 : 1,
    "Проверьте viewport и отображение на телефоне.",
  );
  const controls = [
    ...document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]),select,textarea',
    ),
  ].filter(visible);
  const hasName = (el) =>
    Boolean(
      el.getAttribute("aria-label")?.trim() ||
      el
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .some((id) => document.getElementById(id)?.textContent?.trim()) ||
      [...(el.labels || [])].some((label) => label.textContent?.trim()) ||
      el.getAttribute("title")?.trim(),
    );
  add(
    "labels",
    "Поля без очевидной подписи",
    controls.filter((el) => !hasName(el)).length,
    "Добавьте связанную label или доступное имя; placeholder не заменяет подпись. Проверить дерево доступности вручную.",
  );
  add(
    "alt",
    "Видимые изображения без alt",
    [...document.images].filter(
      (el) =>
        visible(el) &&
        !el.hasAttribute("alt") &&
        !["presentation", "none"].includes(el.getAttribute("role")),
    ).length,
    "Добавьте alt; для декоративных изображений используйте пустой alt.",
  );
  const ids = new Map();
  for (const el of elements)
    if (el.id) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  add(
    "duplicate-id",
    "Повторяющиеся ID в документе",
    [...ids.values()].filter((n) => n > 1).length,
    "Устраните неоднозначные ID; проверьте label и aria-labelledby.",
  );
  return {
    schemaVersion: 1,
    kind: "quick-page-audit",
    origin: location.origin,
    checkedAt: new Date().toISOString(),
    checks,
    limitations: [
      "Проверена только открытая страница и её обычный DOM в текущем состоянии.",
      "Не проверены отправка форм, бизнес-логика, безопасность, скорость сети, контраст, клавиатура, iframe и Shadow DOM.",
      "Это эвристические сигналы для ручной проверки, не полный аудит сайта и не сертификат соответствия.",
      "URL-путь, значения полей, подписи и содержимое страницы не включены. Серверу ничего не отправлено.",
    ],
  };
}
