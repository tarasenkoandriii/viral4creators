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
