const EPSTUDY_ORIGIN = window.location.origin;
const TARGET_ORIGIN = EPSTUDY_ORIGIN === "null" || window.location.protocol === "file:" ? "*" : EPSTUDY_ORIGIN;

chrome.runtime.sendMessage({ type: "EPSTUDY_GET_CACHE" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.payload) {
    window.postMessage({ type: "EPSTUDY_EXTENSION_STATUS", message: "EPStudy extension connected." }, TARGET_ORIGIN);
    window.postMessage({ type: "EPSTUDY_EXTENSION_SYNC", payload: response.payload }, TARGET_ORIGIN);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "EPSTUDY_EXTENSION_SYNC") {
    window.postMessage({ type: "EPSTUDY_EXTENSION_SYNC", payload: message.payload || {} }, TARGET_ORIGIN);
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window || (TARGET_ORIGIN !== "*" && event.origin !== EPSTUDY_ORIGIN) || !event.data) return;
  if (event.data.type === "EPSTUDY_EXTENSION_REQUEST_SYNC") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_REQUEST_SYNC", config: event.data.config || {} }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ type: "EPSTUDY_EXTENSION_STATUS", message: "Extension sync failed. Check extension permissions." }, TARGET_ORIGIN);
        return;
      }
      if (response?.payload) window.postMessage({ type: "EPSTUDY_EXTENSION_SYNC", payload: response.payload }, TARGET_ORIGIN);
    });
  }
  if (event.data.type === "EPSTUDY_WEBSITE_TASKS") {
    const message = {
      type: "EPSTUDY_WEBSITE_TASKS",
      tasks: event.data.tasks || [],
      websiteVersion: event.data.websiteVersion || ""
    };
    if (Array.isArray(event.data.ignoredTaskKeys)) message.ignoredTaskKeys = event.data.ignoredTaskKeys;
    chrome.runtime.sendMessage(message);
  }
  if (event.data.type === "EPSTUDY_VERSION_SELECTED") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_VERSION_SELECTED", version: event.data.version || "", source: event.data.source || "" });
  }
  if (event.data.type === "EPSTUDY_RESET_ALL") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_RESET_ALL" }, () => {
      window.postMessage({ type: "EPSTUDY_RESET_ALL_DONE" }, TARGET_ORIGIN);
      window.postMessage({ type: "EPSTUDY_EXTENSION_STATUS", message: "Extension data cleared." }, TARGET_ORIGIN);
    });
  }
  if (event.data.type === "EPSTUDY_FOCUS_SHIELD") {
    chrome.runtime.sendMessage({
      type: "EPSTUDY_FOCUS_SHIELD",
      active: Boolean(event.data.active),
      blockedSites: event.data.blockedSites || []
    });
  }
  if (event.data.type === "EPSTUDY_FETCH_TEXT") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_FETCH_TEXT", url: event.data.url || "" }, (response) => {
      window.postMessage({
        type: "EPSTUDY_FETCH_TEXT_RESULT",
        requestId: event.data.requestId || "",
        ok: Boolean(response?.ok),
        text: response?.text || "",
        error: response?.error || chrome.runtime.lastError?.message || ""
      }, TARGET_ORIGIN);
    });
  }
  if (event.data.type === "EPSTUDY_EXTENSION_HEALTH_REQUEST") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_GET_HEALTH" }, (response) => {
      window.postMessage({
        type: "EPSTUDY_EXTENSION_HEALTH",
        payload: response?.payload || {},
        ok: Boolean(response?.ok),
        error: response?.error || chrome.runtime.lastError?.message || ""
      }, TARGET_ORIGIN);
    });
  }
  if (event.data.type === "EPSTUDY_OPEN_SOURCE") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_OPEN_SOURCE", source: event.data.source || "" }, (response) => {
      window.postMessage({
        type: "EPSTUDY_EXTENSION_STATUS",
        message: response?.ok ? `Opened ${event.data.source || "source"} tab from the extension.` : (response?.error || chrome.runtime.lastError?.message || "Could not open source tab.")
      }, TARGET_ORIGIN);
    });
  }
  if (event.data.type === "EPSTUDY_OPEN_TASK") {
    chrome.runtime.sendMessage({ type: "EPSTUDY_OPEN_TASK", task: event.data.task || {} }, (response) => {
      window.postMessage({
        type: "EPSTUDY_OPEN_TASK_RESULT",
        requestId: event.data.requestId || "",
        ok: Boolean(response?.ok),
        error: response?.error || chrome.runtime.lastError?.message || ""
      }, TARGET_ORIGIN);
    });
  }
});
