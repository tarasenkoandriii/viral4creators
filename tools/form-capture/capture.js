/** Self-contained for chrome.scripting.executeScript; reads structure, never control values. */
export function captureFormStructure(formIndex = 0, transfer = null) {
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
    const nodes = new Map();
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
      nodes.set(id, el);
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
    if (transfer !== null) {
      const fail = (message) => {
        throw new Error(message);
      };
      const plan = transfer?.plan;
      if (
        !["preview", "apply"].includes(transfer?.mode) ||
        plan?.version !== 1 ||
        !plan.target ||
        !Array.isArray(plan.entries) ||
        !plan.entries.length ||
        plan.entries.length > 8
      )
        fail("Неверный план переноса.");
      const target = new URL(plan.target.url);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        target.href !== url.origin + url.pathname ||
        plan.target.formIndex !== formIndex
      )
        fail("Адрес или номер формы не совпадает с планом.");
      const baseline = plan.target.fields;
      const canonical = (items) =>
        items
          .map((f) => [
            f.id,
            f.type,
            f.required,
            f.min ?? null,
            f.max ?? null,
            f.maxLength ?? null,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (
        !Array.isArray(baseline) ||
        baseline.length !== fields.length ||
        baseline.some((f) => f.options?.length) ||
        JSON.stringify(canonical(baseline)) !==
          JSON.stringify(canonical(fields))
      ) {
        return {
          blocked: true,
          error:
            "Структура формы изменилась. Заполнение остановлено. Импортируйте новый снимок в QA для задачи на исправление мока.",
          snapshot: { url: safeUrl, version: "capture-v1", fields },
        };
      }
      if (form.querySelector('iframe,[contenteditable="true"]'))
        fail("Сложная форма или iframe: нужен отдельный адаптер.");
      const sensitive =
        /password|secret|token|cookie|credential|(?:client|api|access).?key|one.?time|(?:^|[_\s-])otp(?:$|[_\s-])|card.?number|credit.?card|cvv|cvc|iban|парол|секрет|токен|ключ|кред|однораз/i;
      const mapped = [],
        ids = new Set();
      for (const entry of plan.entries) {
        if (
          !entry ||
          typeof entry.targetId !== "string" ||
          ids.has(entry.targetId) ||
          typeof entry.sourceName !== "string" ||
          !entry.sourceName ||
          entry.sourceName.length > 60 ||
          sensitive.test(entry.sourceName) ||
          typeof entry.value !== "string" ||
          !entry.value ||
          entry.value.length > 500 ||
          /MOCK_|\bmock\b|placeholder|\.invalid\b|\.test\b|localhost|127\.0\.0\.1|^Bearer\s|^sk-[a-z0-9]/i.test(
            entry.value,
          )
        )
          fail("План содержит неподдержанные или служебные данные.");
        ids.add(entry.targetId);
        const field = fields.find((f) => f.id === entry.targetId),
          el = nodes.get(entry.targetId);
        if (
          !field ||
          !["text", "email", "url", "number"].includes(field.type) ||
          !el ||
          sensitive.test(
            (el.id || "") + " " + (el.getAttribute("name") || ""),
          ) ||
          /password|one-time-code|cc-|transaction-/i.test(
            el.getAttribute("autocomplete") || "",
          ) ||
          el.disabled ||
          el.matches(":disabled") ||
          el.closest('[hidden],[aria-hidden="true"]') ||
          !el.getClientRects().length ||
          getComputedStyle(el).visibility === "hidden" ||
          el.getAttribute("aria-disabled") === "true" ||
          el.getAttribute("aria-readonly") === "true" ||
          el.readOnly ||
          el.hasAttribute("pattern")
        )
          fail("Поле не разрешено для переноса.");
        const value = entry.value;
        if (field.maxLength !== undefined && value.length > field.maxLength)
          fail("Значение превышает ограничение длины.");
        if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          fail("Неверный email.");
        if (field.type === "url") {
          const u = new URL(value);
          if (
            u.protocol !== "https:" ||
            u.username ||
            u.password ||
            u.search ||
            u.hash
          )
            fail("Неверный HTTPS URL.");
        }
        if (
          field.type === "number" &&
          (!Number.isFinite(Number(value)) ||
            (field.min !== undefined && Number(value) < field.min) ||
            (field.max !== undefined && Number(value) > field.max))
        )
          fail("Число вне допустимых границ.");
        if (field.type === "number") {
          const raw = el.getAttribute("step");
          if (raw !== "any") {
            const step = Number(raw || 1),
              base = field.min ?? 0,
              ratio = (Number(value) - base) / step;
            if (
              !Number.isFinite(step) ||
              step <= 0 ||
              Math.abs(ratio - Math.round(ratio)) > 1e-8
            )
              fail("Число не соответствует шагу поля.");
          }
        }
        mapped.push({
          id: field.id,
          label: (
            el.labels?.[0]?.textContent?.trim() ||
            el.getAttribute("name") ||
            field.id
          ).slice(0, 80),
          sourceName: entry.sourceName,
          before: el.value,
          after: value,
        });
      }
      const revision = JSON.stringify({
        url: target.href,
        formIndex,
        structure: canonical(fields),
        mapped,
      });
      if (transfer.mode === "preview")
        return {
          preview: mapped,
          revision,
          changes: mapped.filter((x) => x.before !== x.after).length,
        };
      if (!transfer.expected || transfer.expected !== revision)
        fail(
          "Форма, данные или значения изменились после предпросмотра. Повторите сверку.",
        );
      // Native HTML fields only: no events, click, focus, submit or framework handlers.
      for (const item of mapped) nodes.get(item.id).value = item.after;
      return {
        applied: mapped.filter((x) => x.before !== x.after).length,
        submitted: false,
      };
    }
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
