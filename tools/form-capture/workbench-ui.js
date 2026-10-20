/** Runs only in the extension's isolated world after toolbar activeTab grant.
 * Structure-only: no page field values, business entries, credentials or network.
 */
(() => {
  if (location.protocol !== "https:") throw new Error("Откройте HTTPS-страницу с формой.");
  const previous = globalThis.__qaStructureWorkbench;
  if (previous?.isConnected) return;
  const host = document.createElement("aside");
  globalThis.__qaStructureWorkbench = host;
  host.id = "qa-form-structure-workbench";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;right:12px;top:12px;z-index:2147483647;width:420px;max-width:calc(100vw - 24px);font:14px/1.5 system-ui;color:#d4d8de}section{background:#0e1621;border:2px solid #5288c1;border-radius:12px;padding:16px;max-height:85vh;overflow:auto;box-shadow:0 8px 32px #0008}h2{margin:0;font-size:18px}label{display:block;margin:10px 0}button,a{display:inline-block;padding:8px;margin:5px 4px 5px 0;border:1px solid #5288c1;border-radius:6px;color:inherit;background:#172534}button:disabled{opacity:.5}input{box-sizing:border-box;max-width:100%;color:inherit;background:#172534;border:1px solid #5288c1;padding:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}p{margin:8px 0}[hidden]{display:none!important}`;
  root.append(style);
  const panel = document.createElement("section");
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "QA: структура формы — панель расширения");
  // Constant markup only. User/page/file strings are assigned with textContent.
  panel.innerHTML = `<h2>QA Form Capture · 0.2.3</h2><button type="button" id="close">Закрыть панель QA</button><p>Панель открыта через Q. Только структура: без значений полей, заполнения и отправки формы. Сайт может видеть содержимое панели; не загружайте секреты.</p><label>Номер формы QA (с нуля)<input id="index" type="number" min="0" max="99" value="0"></label><button type="button" id="capture">Собрать структуру в панели</button><label>План для сверки структуры QA<input id="file" type="file" accept=".json,application/json"></label><p id="loaded"></p><button type="button" id="compare" disabled>Сверить структуру в панели</button><p id="status" role="status"></p><pre id="preview"></pre><a id="handoff" hidden target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Открыть QA со структурными изменениями</a><p>В QA сначала проверьте снимки. Открытие ссылки ничего не создаёт. Адрес содержит только origin; для нескольких форм уточните безопасный путь в кабинете. Не передаются варианты select, подписи, скрытые поля, iframe и Shadow DOM.</p>`;
  root.append(panel);
  document.documentElement.append(host);
  const get = (id) => root.getElementById(id);
  let plan = null;
  let fileGeneration = 0;
  const clear = () => {
    get("handoff").hidden = true;
    get("handoff").removeAttribute("href");
    get("preview").textContent = "";
    get("status").textContent = "";
  };
  const fail = (message) => {
    throw new Error(message);
  };
  const fields = (input) => {
    if (!Array.isArray(input) || input.length > 100)
      fail("Нужно до 100 полей.");
    const seen = new Set();
    return input
      .map((f) => {
        if (
          !f ||
          !/^field_[0-9a-f]{8}$/.test(f.id) ||
          seen.has(f.id) ||
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
          ].includes(f.type) ||
          typeof f.required !== "boolean"
        )
          fail("Некорректная структура полей.");
        seen.add(f.id);
        const out = { id: f.id, type: f.type, required: f.required };
        for (const k of ["min", "max", "maxLength"]) {
          if (f[k] !== undefined) {
            if (
              typeof f[k] !== "number" ||
              !Number.isFinite(f[k]) ||
              (k === "maxLength" && (!Number.isInteger(f[k]) || f[k] < 0))
            )
              fail("Некорректное ограничение поля.");
            out[k] = f[k];
          }
        }
        return out;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  };
  function collect(index) {
    if (!Number.isInteger(index) || index < 0 || index > 99)
      fail("Укажите номер формы от 0 до 99.");
    const result = captureFormStructure(index);
    if (result.error || !result.snapshot)
      fail(result.error || "Снимок не получен.");
    return {
      url: result.snapshot.url,
      version: "current-v1",
      fields: fields(result.snapshot.fields),
    };
  }
  get("close").onclick = () => {
    fileGeneration++;
    host.remove();
    plan = null;
    globalThis.__qaStructureWorkbench = null;
  };
  get("index").oninput = clear;
  get("capture").onclick = () => {
    clear();
    try {
      const current = collect(Number(get("index").value));
      get("preview").textContent = JSON.stringify(current, null, 2);
      get("status").textContent =
        `Структура собрана: ${current.fields.length} полей. Значения не читались.`;
    } catch (e) {
      get("status").textContent = e.message;
    }
  };
  get("file").onchange = async (event) => {
    const generation = ++fileGeneration;
    clear();
    plan = null;
    get("compare").disabled = true;
    get("loaded").textContent = "";
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 30000 || /\.zip$/i.test(file.name))
        fail("Нужен JSON плана до 30 КБ, не ZIP.");
      const content = await file.text();
      if (generation !== fileGeneration || !host.isConnected) return;
      const raw = JSON.parse(content);
      const url = new URL(raw?.target?.url);
      if (
        raw?.version !== 1 ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.origin !== location.origin ||
        !Number.isInteger(raw.target.formIndex) ||
        raw.target.formIndex < 0 ||
        raw.target.formIndex > 99
      )
        fail("План должен относиться к этому HTTPS-сайту и форме.");
      for (const k of ["siteId", "standId"])
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw.source?.[k] ?? ""))
          fail("В плане нет корректного сайта/стенда QA.");
      // Deliberately discard entries, labels, record data, paths and all unknown properties.
      plan = {
        siteId: raw.source.siteId,
        standId: raw.source.standId,
        formIndex: raw.target.formIndex,
        baseline: {
          url: url.origin + "/",
          version: "baseline-v1",
          fields: fields(raw.target.fields),
        },
      };
      get("index").value = String(plan.formIndex);
      get("loaded").textContent =
        `Структура плана загружена: форма ${plan.formIndex}, ${plan.baseline.fields.length} полей. Бизнес-значения отброшены.`;
      get("compare").disabled = false;
    } catch (e) {
      get("status").textContent = e.message;
    }
  };
  get("compare").onclick = () => {
    clear();
    try {
      if (!plan || Number(get("index").value) !== plan.formIndex)
        fail("Номер формы отличается от плана.");
      const current = collect(plan.formIndex);
      if (
        JSON.stringify(plan.baseline.fields) === JSON.stringify(current.fields)
      ) {
        get("status").textContent =
          "Изменений структуры нет. Замечание не создаётся.";
        return;
      }
      const payload = JSON.stringify({
        standId: plan.standId,
        baseline: plan.baseline,
        current,
      });
      const href =
        "https://assist-app.viral4creators.app/#/sites/" +
        plan.siteId +
        "/qa-stands?handoff=" +
        encodeURIComponent(payload);
      if (payload.length > 30000 || href.length > 59000)
        fail("Снимок слишком большой для передачи.");
      get("preview").textContent = payload;
      get("status").textContent =
        "Есть структурные изменения. Заполнение заблокировано; передаются только структура и ограничения.";
      get("handoff").href = href;
      get("handoff").hidden = false;
    } catch (e) {
      get("status").textContent = e.message;
    }
  };
})();
