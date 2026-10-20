import { captureFormStructure } from "./capture.js";
const get = (id) => document.getElementById(id);
let snapshot = null;
let driftHandoff = null;
const readableError = (error, fallback) => {
  const message = error?.message || fallback;
  return /Cannot access a chrome:\/\/ URL|Cannot access contents of url.*chrome:\/\//i.test(
    message,
  )
    ? "Откройте HTTPS-страницу сайта (например sandbox.viral4creators.app), затем снова нажмите Q. Служебные страницы Chrome недоступны расширениям."
    : message;
};
function prepareDrift(result, plan) {
  driftHandoff = null;
  get("drift-open").disabled = true;
  if (!result?.blocked || !result.snapshot) return;
  const id = /^[a-zA-Z0-9_-]{1,100}$/;
  if (
    !id.test(plan?.source?.siteId ?? "") ||
    !id.test(plan?.source?.standId ?? "")
  )
    return;
  // Reconstruct structure only: never copy entries, values, labels or source credentials.
  const fields = (xs) =>
    xs.map((f) =>
      Object.fromEntries(
        ["id", "type", "required", "min", "max", "maxLength"]
          .filter((k) => f[k] !== undefined)
          .map((k) => [k, f[k]]),
      ),
    );
  const url = new URL(plan.target.url).origin + "/";
  const data = {
    standId: plan.source.standId,
    baseline: {
      url,
      version: "baseline-v1",
      fields: fields(plan.target.fields),
    },
    current: {
      url,
      version: "current-v1",
      fields: fields(result.snapshot.fields),
    },
  };
  const payload = JSON.stringify(data);
  if (payload.length > 30000) return;
  driftHandoff =
    "https://assist-app.viral4creators.app/#/sites/" +
    plan.source.siteId +
    "/qa-stands?handoff=" +
    encodeURIComponent(payload);
  if (driftHandoff.length > 59000) {
    driftHandoff = null;
    return;
  }
  get("drift-open").disabled = false;
}
get("drift-open").addEventListener("click", async () => {
  if (driftHandoff) await chrome.tabs.create({ url: driftHandoff });
});
get("capture").addEventListener("click", async () => {
  snapshot = null;
  get("save").disabled = true;
  get("preview").textContent = "";
  get("warnings").replaceChildren();
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("Откройте вкладку с формой.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureFormStructure,
      args: [Number(get("form-index").value)],
    });
    const result = results[0]?.result;
    if (result?.blocked && result.snapshot) {
      snapshot = result.snapshot;
      get("preview").textContent = JSON.stringify(snapshot, null, 2);
      get("save").disabled = false;
    }
    if (result?.error) throw new Error(result.error);
    if (!result?.snapshot) throw new Error("Не удалось получить снимок.");
    snapshot = result.snapshot;
    get("preview").textContent = JSON.stringify(snapshot, null, 2);
    get("status").textContent =
      `Форма ${result.formIndex}; всего форм ${result.formCount}. Полей ${snapshot.fields.length}. Проверьте снимок перед сохранением.`;
    for (const warning of result.warnings) {
      const li = document.createElement("li");
      li.textContent = warning;
      get("warnings").append(li);
    }
    get("save").disabled = false;
  } catch (e) {
    get("status").textContent = readableError(e, "Сбор не выполнен.");
  }
});
get("save").addEventListener("click", () => {
  if (!snapshot) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "qa-form-snapshot.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

let transferPlan = null,
  reviewed = null;
const clearReview = () => {
  reviewed = null;
  driftHandoff = null;
  get("drift-open").disabled = true;
  get("transfer-apply").disabled = true;
  get("transfer-diff").textContent = "";
};
get("transfer-file").addEventListener("change", async (e) => {
  clearReview();
  transferPlan = null;
  get("transfer-preview").disabled = true;
  get("transfer-status").textContent = "";
  get("transfer-loaded").textContent =
    "План не загружен. Выберите JSON плана из кабинета; архив расширения сюда не подходит.";
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    if (file.size > 30000) throw new Error("План больше 30 КБ.");
    if (/\.zip$/i.test(file.name))
      throw new Error(
        "Это архив расширения. Выберите JSON плана переноса из кабинета.",
      );
    const parsed = JSON.parse(await file.text());
    if (
      parsed?.version !== 1 ||
      !parsed.target ||
      !Array.isArray(parsed.target.fields) ||
      !Array.isArray(parsed.entries)
    )
      throw new Error(
        "Нужен JSON плана переноса, а не снимок формы. Экспортируйте выбранные данные из записи стенда.",
      );
    transferPlan = parsed;
    get("transfer-loaded").textContent =
      `План загружен: ${file.name}. Выбранных полей: ${parsed.entries.length}. Нажмите «Сверить и показать изменения».`;
    get("transfer-preview").disabled = false;
  } catch (e) {
    get("transfer-status").textContent =
      e.message || "Не удалось прочитать план.";
  }
});
get("transfer-preview").addEventListener("click", async () => {
  clearReview();
  get("transfer-preview").disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureFormStructure,
      args: [
        transferPlan?.target?.formIndex,
        { mode: "preview", plan: transferPlan },
      ],
    });
    const result = results[0]?.result;
    prepareDrift(result, transferPlan);
    if (result?.blocked && result.snapshot) {
      snapshot = result.snapshot;
      get("preview").textContent = JSON.stringify(snapshot, null, 2);
      get("save").disabled = false;
    }
    if (result?.error) throw new Error(result.error);
    if (!Array.isArray(result?.preview))
      throw new Error("Предпросмотр недоступен.");
    reviewed = {
      tabId: tab.id,
      revision: result.revision,
      plan: structuredClone(transferPlan),
    };
    get("transfer-diff").textContent =
      `Адрес: ${transferPlan.target.url}; форма ${transferPlan.target.formIndex}\nИсточник: ${transferPlan.source?.standId ?? "не указан"}, запись ${transferPlan.source?.recordId ?? "не указана"}, версия ${transferPlan.source?.recordVersion ?? "?"}\n\n` +
      result.preview
        .map(
          (x) =>
            `${x.sourceName} → ${x.label} (${x.id})\nБыло: ${x.before}\nБудет: ${x.after}`,
        )
        .join("\n\n");
    get("transfer-status").textContent =
      `Изменений: ${result.changes}. Проверьте адрес и все значения; запись не выполнялась.`;
    get("transfer-apply").disabled = !result.changes;
  } catch (e) {
    get("transfer-status").textContent = readableError(
      e,
      "Сверка не выполнена.",
    );
  } finally {
    get("transfer-preview").disabled = !transferPlan;
  }
});
get("transfer-apply").addEventListener("click", async () => {
  const preview = reviewed;
  if (!preview) return;
  reviewed = null;
  driftHandoff = null;
  get("drift-open").disabled = true;
  get("transfer-apply").disabled = true;
  get("transfer-preview").disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id !== preview.tabId)
      throw new Error("Активная вкладка изменилась. Повторите предпросмотр.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: preview.tabId },
      func: captureFormStructure,
      args: [
        preview.plan.target.formIndex,
        { mode: "apply", plan: preview.plan, expected: preview.revision },
      ],
    });
    const result = results[0]?.result;
    prepareDrift(result, preview.plan);
    if (result?.blocked && result.snapshot) {
      snapshot = result.snapshot;
      get("preview").textContent = JSON.stringify(snapshot, null, 2);
      get("save").disabled = false;
    }
    if (result?.error) throw new Error(result.error);
    if (!Number.isInteger(result?.applied))
      throw new Error("Заполнение не подтверждено.");
    get("transfer-status").textContent =
      `Заполнено полей: ${result.applied}. Кнопка отправки не нажималась. Проверьте результат на сайте.`;
  } catch (e) {
    get("transfer-status").textContent = readableError(
      e,
      "Заполнение остановлено.",
    );
  } finally {
    get("transfer-preview").disabled = !transferPlan;
  }
});

// The actual toolbar click grants activeTab. Mount a structure-only panel in
// the same authorized tab; no host permissions, messages or extra grants.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("Откройте HTTPS-страницу с формой.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["workbench.js"],
    });
    get("workbench-status").textContent =
      "Панель QA открыта на странице. Закройте popup, чтобы работать с ней. Старый режим переноса ниже сохранён.";
  } catch (e) {
    get("workbench-status").textContent = readableError(
      e,
      "Панель QA не открыта.",
    );
  }
})();
