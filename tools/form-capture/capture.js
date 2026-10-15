/** Self-contained for chrome.scripting.executeScript; reads structure, never control values. */
export function captureFormStructure(formIndex = 0) {
  try {
    const url = new URL(location.href);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Откройте HTTPS-страницу с формой.");
    url.search = "";
    url.hash = "";
    // Avoid leaking identifiers embedded in URLs. Only origin is emitted until the user adds a safe path.
    const safeUrl = url.origin + "/";
    const forms = Array.from(document.forms);
    if (
      !Number.isInteger(formIndex) ||
      formIndex < 0 ||
      formIndex >= forms.length
    )
      throw new Error(`Форма не найдена. Доступно форм: ${forms.length}.`);
    const form = forms[formIndex];
    const controls = Array.from(form.elements).filter((el) =>
      ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName),
    );
    const fields = [],
      seen = new Set(),
      warnings = new Set([
        "Путь URL не включён. Перед сверкой укажите безопасный путь формы.",
        "Варианты select, подписи, скрытые поля, Shadow DOM и iframe не собираются.",
      ]);
    // Stable opaque local keys; do not export DOM identifiers that might embed user information.
    const key = (text) => {
      let h = 2166136261;
      for (let i = 0; i < text.length; i++)
        h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return "field_" + (h >>> 0).toString(16).padStart(8, "0");
    };
    for (const el of controls) {
      let type =
        el.tagName === "SELECT"
          ? "select"
          : el.tagName === "TEXTAREA"
            ? "text"
            : (el.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "reset", "button", "image"].includes(type))
        continue;
      if (type === "datetime-local") type = "datetime";
      if (
        ![
          "text",
          "number",
          "email",
          "url",
          "select",
          "checkbox",
          "date",
          "datetime",
          "password",
          "file",
        ].includes(type)
      )
        throw new Error(
          "Есть неподдержанный тип поля. Нужен ручной снимок: " + type,
        );
      const identity = el.getAttribute("id") || el.getAttribute("name");
      if (!identity)
        throw new Error(
          "У поля нет устойчивого id/name. Снимок требует ручной проверки.",
        );
      const id = key(identity);
      if (seen.has(id))
        throw new Error("Неоднозначные поля id/name. Нужен ручной снимок.");
      seen.add(id);
      const field = {
        id,
        type,
        required:
          el.hasAttribute("required") ||
          el.getAttribute("aria-required") === "true",
      };
      for (const attr of ["min", "max", "maxlength"]) {
        const raw = el.getAttribute(attr);
        if (raw === null || raw === "") continue;
        const number = Number(raw);
        if (
          Number.isFinite(number) &&
          Math.abs(number) <= 1e9 &&
          (attr !== "maxlength" || (Number.isInteger(number) && number >= 0))
        )
          field[attr === "maxlength" ? "maxLength" : attr] = number;
        else warnings.add("Часть ограничений не поддержана: " + attr);
      }
      if (
        el.hasAttribute("pattern") ||
        el.hasAttribute("disabled") ||
        el.hasAttribute("readonly")
      )
        warnings.add("Есть pattern/disabled/readonly: проверьте вручную.");
      fields.push(field);
      if (fields.length > 50)
        throw new Error("Более 50 полей: нужен отдельный адаптер.");
    }
    if (!fields.length) throw new Error("В форме нет поддержанных полей.");
    fields.sort((a, b) => a.id.localeCompare(b.id));
    return {
      snapshot: { url: safeUrl, version: "capture-v1", fields },
      formIndex,
      formCount: forms.length,
      warnings: [...warnings],
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Не удалось собрать структуру формы.",
    };
  }
}
