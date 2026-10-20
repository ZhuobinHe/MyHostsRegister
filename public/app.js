const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const requestPreview = document.querySelector("#request-preview");
const responseMeta = document.querySelector("#response-meta");
const responseBody = document.querySelector("#response-body");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    panels.forEach((panel) => panel.classList.toggle("active", panel.id === `${tab.dataset.panel}-panel`));
  });
}

function requestFor(form) {
  const operation = form.dataset.operation;
  const values = new FormData(form);
  const url = new URL(`/${operation}`, location.origin);
  for (const [key, value] of values) url.searchParams.set(key, String(value));
  return { method: operation === "register" ? "POST" : "GET", url };
}

function curlCommand(method, url) {
  const methodArg = method === "GET" ? "" : ` -X ${method}`;
  return `curl -u USERNAME${methodArg} '${url}'`;
}

for (const form of document.querySelectorAll("form[data-operation]")) {
  const refresh = () => {
    const { method, url } = requestFor(form);
    requestPreview.textContent = `${method} ${url.pathname}${url.search}\n${curlCommand(method, url)}`;
  };
  form.addEventListener("input", refresh);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { method, url } = requestFor(form);
    refresh();
    const started = performance.now();
    responseMeta.textContent = "请求中…";
    responseBody.textContent = "";
    document.body.classList.add("loading");
    try {
      const response = await fetch(url, { method });
      const raw = await response.text();
      const elapsed = Math.round(performance.now() - started);
      responseMeta.textContent = `HTTP ${response.status} · ${elapsed} ms`;
      responseMeta.classList.toggle("error", !response.ok);
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json") && raw) {
        responseBody.textContent = JSON.stringify(JSON.parse(raw), null, 2);
      } else {
        responseBody.textContent = raw;
      }
    } catch (error) {
      responseMeta.textContent = "请求失败";
      responseMeta.classList.add("error");
      responseBody.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      document.body.classList.remove("loading");
    }
  });
  refresh();
}

async function copyFrom(selector) {
  const text = document.querySelector(selector).textContent || "";
  await navigator.clipboard.writeText(text);
}

document.querySelector("#copy-request").addEventListener("click", () => copyFrom("#request-preview"));
document.querySelector("#copy-response").addEventListener("click", () => copyFrom("#response-body"));
