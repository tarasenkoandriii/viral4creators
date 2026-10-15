import { captureFormStructure } from "./capture.js";
const get = (id) => document.getElementById(id);
let snapshot = null;
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
    get("status").textContent = e.message || "Сбор не выполнен.";
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
  get("transfer-apply").disabled = true;
  get("transfer-diff").textContent = "";
};
get("transfer-file").addEventListener("change", async (e) => {
  clearReview();
  transferPlan = null;
  get("transfer-preview").disabled = true;
  get("transfer-status").textContent = "";
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    if (file.size > 30000) throw new Error("План больше 30 КБ.");
    transferPlan = JSON.parse(await file.text());
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
    get("transfer-status").textContent = e.message || "Сверка не выполнена.";
  } finally {
    get("transfer-preview").disabled = !transferPlan;
  }
});
get("transfer-apply").addEventListener("click", async () => {
  const preview = reviewed;
  if (!preview) return;
  reviewed = null;
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
    get("transfer-status").textContent = e.message || "Заполнение остановлено.";
  } finally {
    get("transfer-preview").disabled = !transferPlan;
  }
});
