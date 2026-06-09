const SYNC_ALARM = "epstudy-sync";
const COURSE_RESYNC_ALARM = "epstudy-course-resync";
const DEFAULT_CANVAS_HOST = "eastsideprep.instructure.com";
const FOCUS_RULE_START = 30000;
const TEAMSNAP_REMINDER_PREFIX = "epstudy-teamsnap-reminder:";
const TEAMSNAP_LINK_LIMIT = 12;
const TEAMSNAP_LINK_REFRESH_MS = 30 * 60 * 1000;
const TEAMSNAP_NOTIFY_WINDOW_MS = 48 * 60 * 60 * 1000;
const CANVAS_CARD_LIST_REFRESH_MS = 30 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 10 });
  chrome.alarms.create(COURSE_RESYNC_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 10 });
  chrome.alarms.create(COURSE_RESYNC_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAllSources();
  if (alarm.name === COURSE_RESYNC_ALARM) syncAllSources({ refreshCourses: true });
  if (alarm.name.startsWith(TEAMSNAP_REMINDER_PREFIX)) showTeamSnapReminder(alarm.name);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || "";
  if (sourceFromUrl(url) === "teamsnap") rememberTeamSnapLink(url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (sourceFromUrl(tab?.url || "") === "teamsnap") await rememberTeamSnapLink(tab.url);
  } catch {
    // The tab may have closed before Chrome returned it.
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "EPSTUDY_SOURCE_DATA") {
    mergeSourcePayload(message.source, message.payload, sender)
      .then(getCache)
      .then((cache) => broadcastToEpstudy(cache).then(() => sendResponse({ ok: true, payload: cache })))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "EPSTUDY_REQUEST_SYNC") {
    syncAllSources(message.config).then((payload) => sendResponse({ ok: true, payload })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "EPSTUDY_GET_CACHE") {
    notifyTeamSnapWithin48ForToday().then(getCache).then((payload) => sendResponse({ ok: true, payload }));
    return true;
  }

  if (message.type === "EPSTUDY_GET_HEALTH") {
    getHealthSnapshot().then((payload) => sendResponse({ ok: true, payload })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "EPSTUDY_OPEN_SOURCE") {
    openSourceTab(message.source).then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "EPSTUDY_OPEN_TASK") {
    openTaskTab(message.task).then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "EPSTUDY_VERSION_SELECTED") {
    const activeWebsiteVersion = normalizeWebsiteVersion(message.version);
    chrome.storage.local.set({
      activeWebsiteVersion,
      activeWebsiteVersionSource: String(message.source || ""),
      activeWebsiteVersionUpdatedAt: new Date().toISOString()
    }).then(() => sendResponse({ ok: true, activeWebsiteVersion }));
    return true;
  }

  if (message.type === "EPSTUDY_WEBSITE_TASKS") {
    const websiteVersion = normalizeWebsiteVersion(message.websiteVersion);
    const update = {
      websiteTasks: message.tasks || [],
      websiteTasksUpdatedAt: new Date().toISOString(),
      websiteTasksVersion: websiteVersion,
      activeWebsiteVersion: websiteVersion,
      activeWebsiteVersionUpdatedAt: new Date().toISOString()
    };
    if (Array.isArray(message.ignoredTaskKeys)) update.websiteIgnoredTaskKeys = normalizeIgnoredTaskKeys(message.ignoredTaskKeys);
    chrome.storage.local.set(update)
      .then(getCache)
      .then((cache) => broadcastToEpstudy(cache).then(() => sendResponse({ ok: true, payload: cache })))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "EPSTUDY_RESET_ALL") {
    resetEpstudyData().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "EPSTUDY_FOCUS_SHIELD") {
    updateFocusShield(Boolean(message.active), message.blockedSites || []).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "EPSTUDY_FETCH_TEXT") {
    fetchTextForWebsite(message.url).then((text) => sendResponse({ ok: true, text })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});

async function fetchTextForWebsite(url) {
  const parsed = new URL(String(url || ""));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported URL.");
  const response = await fetch(parsed.toString(), { cache: "no-store" });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return response.text();
}

function normalizeWebsiteVersion(version) {
  const value = String(version || "").toLowerCase();
  if (value === "simple") return "simple";
  if (["normal", "v2", "v3", "v4"].includes(value)) return "normal";
  return "normal";
}

async function resetEpstudyData() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.map(alarm => chrome.alarms.clear(alarm.name)));
  await chrome.storage.local.clear();
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 10 });
  await chrome.alarms.create(COURSE_RESYNC_ALARM, { periodInMinutes: 24 * 60 });
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id), addRules: [] });
  } catch {
    // Reset should still succeed if focus shield rules are already empty.
  }
}

async function getCache() {
  const data = await chrome.storage.local.get(["canvas", "teamsnap", "membean", "courses", "updatedAt", "sourceStatus", "teamSnapLinks", "websiteTasks", "websiteIgnoredTaskKeys"]);
  const ignoredTaskKeys = normalizeIgnoredTaskKeys(data.websiteIgnoredTaskKeys);
  return {
    canvas: applyWebsiteIgnores(mergeWebsiteCompletionIntoRows(normalizeRows(data.canvas || [], "canvas"), data.websiteTasks || [], "canvas"), ignoredTaskKeys, "canvas"),
    teamsnap: applyWebsiteIgnores(mergeWebsiteCompletionIntoRows(normalizeRows(data.teamsnap || [], "teamsnap"), data.websiteTasks || [], "teamsnap"), ignoredTaskKeys, "teamsnap"),
    membean: mergeWebsiteCompletionIntoRows(data.membean || [], data.websiteTasks || [], "membean"),
    courses: normalizeCanvasCourses(data.courses || []),
    teamSnapLinks: data.teamSnapLinks || [],
    updatedAt: data.updatedAt || null,
    sourceStatus: data.sourceStatus || {}
  };
}

function taskForceIncomplete(task) {
  return Boolean(task?.canvasForceIncomplete || task?.forceIncomplete || task?.completionLockedIncomplete);
}

function mergeTaskCompletion(existing, incoming) {
  if (taskForceIncomplete(incoming)) return false;
  return Boolean(existing?.completed || incoming?.completed);
}

function normalizeIgnoredTaskKeys(keys) {
  return Array.from(new Set((Array.isArray(keys) ? keys : []).map(key => String(key || "").trim()).filter(Boolean))).slice(-2500);
}

function websiteIgnoreKeysForRow(row, source) {
  const keys = new Set();
  const externalKey = String(row?.externalKey || "").trim();
  const id = String(row?.id || "").trim();
  if (externalKey) keys.add(`external:${externalKey}`);
  if (id) keys.add(`id:${id}`);
  if (source === "canvas") {
    const assignmentId = canvasAssignmentId(row);
    if (assignmentId) keys.add(`canvas-assignment:${assignmentId}`);
  }
  const courseId = String(row?.courseId || "").trim();
  const dueDate = row?.dueDate || row?.due_at || row?.start_at || "";
  const parsedDueDate = new Date(dueDate || "");
  const dueKey = Number.isNaN(parsedDueDate.getTime()) ? String(dueDate || "") : parsedDueDate.toISOString();
  const title = normalizeAssignmentTitle(row?.title || row?.name || "");
  if (courseId && title && dueKey) keys.add(`fallback:${courseId}:${title}:${dueKey}`);
  rowAliases(row, source).forEach(alias => keys.add(`alias:${alias}`));
  return Array.from(keys);
}

function applyWebsiteIgnores(rows, ignoredKeys, source) {
  const ignored = new Set(normalizeIgnoredTaskKeys(ignoredKeys));
  if (!ignored.size) return rows;
  return (Array.isArray(rows) ? rows : []).filter(row => {
    if (taskForceIncomplete(row)) return true;
    return !websiteIgnoreKeysForRow(row, source).some(key => ignored.has(key));
  });
}

function mergeWebsiteCompletionIntoRows(rows, websiteTasks, source) {
  const websiteRows = normalizeRows((Array.isArray(websiteTasks) ? websiteTasks : [])
    .filter(task => String(task?.source || "").toLowerCase() === source), source);
  if (!websiteRows.length) return rows;
  const websiteByAlias = new Map();
  for (const task of websiteRows) {
    rowAliases(task, source).forEach(alias => websiteByAlias.set(alias, task));
  }
  return (Array.isArray(rows) ? rows : []).map(row => {
    const websiteTask = rowAliases(row, source).map(alias => websiteByAlias.get(alias)).find(Boolean);
    if (!websiteTask) return row;
    return {
      ...row,
      completed: mergeTaskCompletion(row, websiteTask),
      websiteCompletedAt: websiteTask.completed ? (websiteTask.completedAt || websiteTask.updatedAt || "") : (row.websiteCompletedAt || "")
    };
  });
}

async function getHealthSnapshot() {
  const [cache, local, rules, tabs] = await Promise.all([
    getCache(),
    chrome.storage.local.get(["websiteTasks", "websiteTasksUpdatedAt", "websiteTasksVersion", "activeWebsiteVersion", "activeWebsiteVersionSource", "activeWebsiteVersionUpdatedAt", "focusShieldActive", "focusShieldBlockedSites"]),
    chrome.declarativeNetRequest.getDynamicRules().catch(() => []),
    chrome.tabs.query({}).catch(() => [])
  ]);
  return {
    ...cache,
    activeWebsiteVersion: normalizeWebsiteVersion(local.activeWebsiteVersion),
    activeWebsiteVersionSource: local.activeWebsiteVersionSource || "",
    activeWebsiteVersionUpdatedAt: local.activeWebsiteVersionUpdatedAt || null,
    websiteTasksCount: Array.isArray(local.websiteTasks) ? local.websiteTasks.length : 0,
    websiteTasksUpdatedAt: local.websiteTasksUpdatedAt || null,
    websiteTasksVersion: normalizeWebsiteVersion(local.websiteTasksVersion || local.activeWebsiteVersion),
    focusShieldActive: Boolean(local.focusShieldActive),
    focusShieldBlockedSites: Array.isArray(local.focusShieldBlockedSites) ? local.focusShieldBlockedSites : [],
    focusShieldRuleCount: rules.filter(rule => rule.id >= FOCUS_RULE_START && rule.id < FOCUS_RULE_START + 500).length,
    openSources: {
      canvas: tabs.some(tab => sourceFromUrl(tab.url || "") === "canvas"),
      teamsnap: tabs.some(tab => sourceFromUrl(tab.url || "") === "teamsnap"),
      membean: tabs.some(tab => sourceFromUrl(tab.url || "") === "membean"),
      epstudy: tabs.some(tab => isEpstudyUrl(tab.url || ""))
    },
    checkedAt: new Date().toISOString()
  };
}

async function openSourceTab(source, config = {}) {
  const safeSource = String(source || "").toLowerCase();
  if (safeSource === "canvas") {
    const host = String(config.canvasDomain || DEFAULT_CANVAS_HOST).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return chrome.tabs.create({ url: `https://${host || DEFAULT_CANVAS_HOST}/`, active: false });
  }
  if (safeSource === "membean") {
    return chrome.tabs.create({ url: "https://membean.com/dashboard", active: false });
  }
  if (safeSource === "teamsnap") {
    const data = await chrome.storage.local.get(["teamSnapLinks"]);
    const saved = Array.isArray(data.teamSnapLinks) ? data.teamSnapLinks.map(link => normalizeTeamSnapLink(link.url)).find(Boolean) : "";
    return chrome.tabs.create({ url: saved || "https://go.teamsnap.com/", active: false });
  }
  throw new Error("Unknown source.");
}

async function openTaskTab(task = {}) {
  const safeSource = String(task.source || "").toLowerCase();
  const directUrl = normalizeTaskUrl(task.url || task.eventUrl || task.canvasUrl || "");
  if (directUrl) {
    await chrome.tabs.create({ url: directUrl });
    return;
  }
  if (safeSource === "canvas" || safeSource === "teamsnap" || safeSource === "membean") {
    await openSourceTab(safeSource);
    return;
  }
  throw new Error("No source tab available for this calendar item.");
}

function normalizeTaskUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, `https://${DEFAULT_CANVAS_HOST}`);
    if (/\/courses\/\d+\/assignments\/\d+/i.test(parsed.pathname) && !parsed.hostname.endsWith("instructure.com")) {
      return `https://${DEFAULT_CANVAS_HOST}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return `https://${DEFAULT_CANVAS_HOST}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.hostname.endsWith("instructure.com")) parsed.protocol = "https:";
    if (!sourceFromUrl(parsed.toString())) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

async function mergeSourcePayload(source, payload, sender = null) {
  const safeSource = ["canvas", "teamsnap", "membean"].includes(source) ? source : null;
  if (!safeSource) return;
  if (safeSource === "teamsnap") {
    const senderUrl = sender?.tab?.url || payload?.teamSnap?.actualUrl || payload?.teamSnap?.url || payload?.url || "";
    await rememberTeamSnapLink(payload?.teamSnap?.url || senderUrl, payload?.teamSnap || {});
    if (!isTeamSnapScheduleUrl(senderUrl) && !payload?.teamSnap?.isSchedulePage) {
      await markTeamSnapWaitingForSchedule("TeamSnap is open, but EPStudy only reads TeamSnap schedule pages.");
      return;
    }
  }
  const rows = normalizeRows(Array.isArray(payload?.tasks) ? payload.tasks : [], safeSource);
  const incomingCourses = normalizeCanvasCourses(payload?.courses || []);
  const data = await chrome.storage.local.get(["canvas", "teamsnap", "membean", "courses", "sourceStatus"]);
  const sourceStatus = data.sourceStatus || {};
  const syncedAt = new Date().toISOString();

  if (safeSource === "canvas" && rows.length === 0 && incomingCourses.length === 0) {
    await chrome.storage.local.set({
      sourceStatus: {
        ...sourceStatus,
        canvas: {
          status: "waiting_for_readable_page",
          message: "Canvas was open, but no assignments or courses could be read. Keeping the last saved Canvas data.",
          attemptedAt: syncedAt,
          cachedTasks: Array.isArray(data.canvas) ? data.canvas.length : 0,
          cachedCourses: Array.isArray(data.courses) ? data.courses.length : 0
        }
      },
      updatedAt: syncedAt
    });
    return;
  }

  if (safeSource === "membean" && rows.length === 0) {
    await chrome.storage.local.set({
      sourceStatus: {
        ...sourceStatus,
        membean: {
          status: "waiting_for_progress",
          message: "Membean was opened, but training progress could not be read. Keeping the last saved Membean data.",
          attemptedAt: syncedAt,
          cachedTasks: Array.isArray(data.membean) ? data.membean.length : 0
        }
      },
      updatedAt: syncedAt
    });
    return;
  }

  const update = { updatedAt: new Date().toISOString() };
  const mergedTeamSnapRows = safeSource === "teamsnap" ? normalizeRows([...(Array.isArray(data.teamsnap) ? data.teamsnap : []), ...rows], "teamsnap") : rows;
  if (safeSource === "teamsnap") update.teamsnap = mergedTeamSnapRows;
  else if (safeSource !== "canvas" || rows.length > 0) update[safeSource] = rows;
  if (safeSource === "canvas") {
    if (incomingCourses.length > 0) update.courses = incomingCourses;
    update.sourceStatus = {
      ...sourceStatus,
      canvas: {
        status: rows.length > 0 ? "synced" : "waiting_for_assignments",
        message: rows.length > 0 ? "Canvas data saved." : "Canvas courses were saved. Keeping the last saved Canvas tasks until assignments can be read.",
        syncedAt,
        cachedTasks: rows.length || (Array.isArray(data.canvas) ? data.canvas.length : 0),
        cachedCourses: incomingCourses.length || (Array.isArray(data.courses) ? data.courses.length : 0)
      }
    };
  }
  await chrome.storage.local.set(update);
  if (safeSource === "canvas" && ["card", "list"].includes(payload?.canvasDashboardView) && !sender?.scrapeConfig?.canvasListRefresh) {
    await chrome.storage.local.set({
      canvasDashboardViewPreference: payload.canvasDashboardView,
      canvasDashboardViewPreferenceAt: new Date().toISOString()
    });
  }
  if (safeSource === "canvas" && payload?.canvasDashboardView === "card") {
    runCanvasCardModeListRefresh(sender?.tab?.url || "", {
      ...sender?.scrapeConfig,
      restoreDashboardView: true,
      originalDashboardView: payload.canvasDashboardView,
      sourceTabId: sender?.tab?.id || null
    }).catch(() => {});
  }
  if (safeSource === "teamsnap") {
    await chrome.storage.local.set({
      sourceStatus: {
        ...sourceStatus,
        teamsnap: {
          status: rows.length > 0 ? "synced" : "waiting_for_schedule",
          message: rows.length > 0 ? "TeamSnap schedule saved." : "TeamSnap was open, but no schedule events could be read.",
          syncedAt,
          cachedTasks: mergedTeamSnapRows.length
        }
      }
    });
    await scheduleTeamSnapReminders(mergedTeamSnapRows);
    await notifyTeamSnapWithin48ForToday();
  }
  if (safeSource === "membean") {
    await chrome.storage.local.set({
      sourceStatus: {
        ...sourceStatus,
        membean: {
          status: "synced",
          message: "Membean progress saved.",
          syncedAt,
          cachedTasks: rows.length
        }
      }
    });
  }
}

function normalizeAssignmentTitle(title) {
  return String(title || "")
    .replace(/^Calendar:\s*/i, "")
    .replace(/^Assignment\b:?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeamSnapTitle(title) {
  return String(title || "")
    .replace(/^TeamSnap\s+(?:Game|Event)\b:?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleKey(title) {
  return normalizeAssignmentTitle(normalizeTeamSnapTitle(title)).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rowDueKey(row) {
  const date = new Date(row?.dueDate || row?.due_at || row?.start_at || "");
  return Number.isNaN(date.getTime())
    ? String(row?.dueDate || row?.due_at || row?.start_at || "")
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function rowQuality(row) {
  let score = 0;
  if (row.courseId && !/course-other|undefined|unknown/i.test(String(row.courseId))) score += 20;
  if (/^canvas:[^:]+:[^:]+$/.test(String(row.externalKey || ""))) score += 8;
  if (!String(row.id || "").startsWith("canvas-x-")) score += 4;
  if (!/^Assignment\b:?\s*/i.test(String(row.title || ""))) score += 2;
  return score;
}

function canvasAssignmentId(row) {
  const keyMatch = String(row.externalKey || "").match(/^canvas:([^:]+):([^:]+)$/);
  if (keyMatch && /^\d+$/.test(keyMatch[2])) return keyMatch[2];
  const idMatch = String(row.id || "").match(/^canvas-[^-]+-(\d+)$/);
  if (idMatch) return idMatch[1];
  const urlMatch = String(row.canvasUrl || row.url || "").match(/\/assignments\/(\d+)/);
  return urlMatch?.[1] || "";
}

function rowAliases(row, source) {
  const title = titleKey(row.title);
  const due = rowDueKey(row);
  const exactTime = new Date(row?.dueDate || row?.due_at || row?.start_at || "").getTime();
  const course = String(row.courseId || "").replace(/^canvas-course-/, "") || "x";
  const aliases = [`${source}:title-day:${title}:${due}`];
  const externalKey = String(row.externalKey || "").trim();
  if (externalKey) aliases.unshift(`${source}:external:${externalKey}`);
  if (source === "canvas") {
    aliases.push(`${source}:title-course:${title}:${course}`);
    const assignmentId = canvasAssignmentId(row);
    if (assignmentId) aliases.push(`${source}:assignment:${assignmentId}`);
    const url = String(row.canvasUrl || row.url || "").replace(/\?.*$/, "");
    if (url) aliases.push(`${source}:url:${url}`);
  }
  if (source === "teamsnap") {
    if (Number.isFinite(exactTime)) aliases.push(`${source}:title-time:${title}:${exactTime}`);
    const url = String(row.eventUrl || row.url || row.canvasUrl || "").replace(/\?.*$/, "");
    if (url) aliases.push(`${source}:url:${url}`);
  }
  return aliases;
}

function normalizeRows(rows, source) {
  const byIdentity = new Map();
  const aliasToIdentity = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const title = source === "canvas"
      ? normalizeAssignmentTitle(row.title || row.name || "")
      : source === "teamsnap"
        ? normalizeTeamSnapTitle(row.title || row.name || "")
        : String(row.title || row.name || "").trim();
    if (!title) continue;
    if (source === "teamsnap" && /driver/i.test(`${title} ${row.description || ""} ${row.location || ""}`)) continue;
    const normalized = { ...row, title };
    if (source === "canvas") {
      const fixedUrl = normalizeTaskUrl(normalized.canvasUrl || normalized.url || "");
      if (fixedUrl) normalized.canvasUrl = fixedUrl;
    }
    if (source === "canvas" && (!normalized.courseId || /course-other|undefined|unknown/i.test(String(normalized.courseId)))) continue;
    if (source !== "canvas") {
      const aliases = rowAliases(normalized, source);
      const identity = aliases.map(alias => aliasToIdentity.get(alias)).find(Boolean) || aliases[0];
      const current = byIdentity.get(identity);
      byIdentity.set(identity, !current || rowQuality(normalized) > rowQuality(current) ? normalized : current);
      aliases.forEach(alias => aliasToIdentity.set(alias, identity));
      continue;
    }
    const aliases = rowAliases(normalized, source);
    const identity = aliases.map(alias => aliasToIdentity.get(alias)).find(Boolean) || aliases[0];
    const current = byIdentity.get(identity);
    byIdentity.set(identity, !current || rowQuality(normalized) > rowQuality(current) ? normalized : current);
    aliases.forEach(alias => aliasToIdentity.set(alias, identity));
  }
  return Array.from(byIdentity.values());
}

function normalizeCanvasCourses(courses) {
  const seen = new Set();
  return (Array.isArray(courses) ? courses : [])
    .map(course => {
      const rawId = String(course?.id || course?.course_id || "").trim();
      const name = String(course?.name || course?.course_code || "").replace(/\s+/g, " ").trim();
      const code = String(course?.course_code || course?.code || "").replace(/\s+/g, " ").trim();
      const period = normalizeCanvasCoursePeriod(course?.period || course?.course_period || course?.section || "");
      if (!rawId || !name) return null;
      if (!/^\d+$/.test(rawId)) return null;
      if (!isLikelyCanvasCourseName(name, code)) return null;
      const key = rawId.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return { id: rawId, name, course_code: code, period, source: "canvas" };
    })
    .filter(Boolean)
    .slice(0, 500);
}

function normalizeCanvasCoursePeriod(value) {
  const match = String(value || "").toUpperCase().match(/\b(?:PERIOD\s*)?([A-H])\b/);
  return match ? match[1] : "";
}

function mergeCanvasCourseLists(primaryCourses, extraCourses) {
  const byId = new Map();
  for (const course of normalizeCanvasCourses([...(primaryCourses || []), ...(extraCourses || [])])) {
    const current = byId.get(course.id);
    byId.set(course.id, {
      ...current,
      ...course,
      period: course.period || current?.period || ""
    });
  }
  return Array.from(byId.values());
}

function isLikelyCanvasCourseName(name, code = "") {
  const label = `${name} ${code}`.trim();
  if (!name || name.length > 120) return false;
  if (hasBlockedCanvasCourseKeyword(label)) return false;
  if (isCanvasNavigationLabel(name)) return false;
  if (name.includes(":")) return false;
  if (/^(hw|cw|qa|ma)\b\s*[-:]/i.test(name)) return false;
  if (/\b\d+\s*pts?\b|\bdue\b/i.test(label)) return false;
  if (/\/(assignments?|files|modules|pages|discussion_topics|quizzes)\//i.test(label)) return false;
  if (/\b(chapter\s*\d+|quiz|project|poem|worksheet|homework|classwork)\b/i.test(name)) return false;
  if (/\bassignment\b/i.test(name) && !/\bthinking|algebra|spanish|music|class\b/i.test(name)) return false;
  return true;
}

function hasBlockedCanvasCourseKeyword(value) {
  return /\b(assignments?|files?)\b/i.test(String(value || ""));
}

function isCanvasNavigationLabel(label) {
  return /^(announcements?|assignments?|assignment groups?|calendar|chat|collaborations?|conferences?|course details?|discussions?|files?|grades?|home|modules?|outcomes?|pages?|people|quizzes?|rubrics?|settings|syllabus|to do|recent feedback|show all)$/i.test(String(label || "").trim());
}

async function updateFocusShield(active, blockedSites) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules
    .filter(rule => rule.id >= FOCUS_RULE_START && rule.id < FOCUS_RULE_START + 500)
    .map(rule => rule.id);

  const domains = Array.from(new Set((blockedSites || []).map(normalizeDomain).filter(Boolean))).slice(0, 200);
  const addRules = active ? domains.map((domain, index) => ({
    id: FOCUS_RULE_START + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ["main_frame", "sub_frame", "script", "xmlhttprequest", "media"]
    }
  })) : [];

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  await chrome.storage.local.set({ focusShieldActive: active, focusShieldBlockedSites: domains });
}

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

async function syncAllSources(config = {}) {
  const initialTabs = await chrome.tabs.query({});
  const openedTabIds = new Set();
  try {
    const prepared = await ensureSourceTabsOpenForSync(initialTabs, config);
    let tabs = prepared.tabs;
    const hadCanvasTab = tabs.some((tab) => tab.url && sourceFromUrl(tab.url, config) === "canvas");
    prepared.openedTabIds.forEach(id => openedTabIds.add(id));
    await rememberOpenTeamSnapTabs(tabs);
    await scrapeOpenSourceTabs(tabs, config, "canvas");
    await scrapeOpenSourceTabs(tabs, config, "teamsnap");
    await scrapeOpenSourceTabs(tabs, config, "membean");
    await scrapeRememberedTeamSnapLinks(tabs, config);
    await scrapeMembeanProgress(tabs, config);
    if (!hadCanvasTab) await markCanvasWaitingForReadablePage("No Canvas tab is open. Keeping the last saved Canvas data.");
    const cache = await getCache();
    await broadcastToEpstudy(cache);
    return cache;
  } finally {
    await closeCreatedSyncTabs(openedTabIds);
  }
}

async function ensureSourceTabsOpenForSync(tabs, config = {}) {
  const sources = ["canvas", "teamsnap", "membean"];
  const opened = [];
  for (const source of sources) {
    const isOpen = (tabs || []).some(tab => sourceFromUrl(tab?.url || "", config) === source);
    if (isOpen) continue;
    try {
      const tab = await openSourceTab(source, config);
      if (tab?.id) opened.push(tab);
    } catch {
      // Source status handling below will report unreadable sources without blocking sync.
    }
  }
  await Promise.all(opened.map(tab => waitForTabLoad(tab.id, 15000)));
  return {
    tabs: await chrome.tabs.query({}),
    openedTabIds: opened.map(tab => tab.id).filter(id => Number.isInteger(id))
  };
}

async function closeCreatedSyncTabs(openedTabIds) {
  const ids = Array.from(openedTabIds || []).filter(id => Number.isInteger(id));
  if (!ids.length) return;
  await Promise.allSettled(ids.map(async id => {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) return;
    await chrome.tabs.remove(id).catch(() => {});
  }));
}

async function scrapeOpenSourceTabs(tabs, config, source) {
  const sourceTabs = (tabs || []).filter(tab => sourceFromUrl(tab?.url || "", config) === source);
  for (const tab of sourceTabs) {
    await askTabToScrape(tab, config).catch(() => {});
  }
}

async function scrapeMembeanProgress(openTabs, config = {}) {
  if (!config.membeanEnabled) return;
  const openMembeanTab = (openTabs || []).find(tab => sourceFromUrl(tab?.url || "", config) === "membean");
  if (openMembeanTab) return;
  let createdTab = null;
  try {
    createdTab = await chrome.tabs.create({ url: "https://membean.com/dashboard", active: false });
    await waitForTabLoad(createdTab.id, 15000);
    await askTabToScrape(await chrome.tabs.get(createdTab.id), config);
  } catch {
    await markMembeanWaitingForProgress("Membean could not be opened or read. Log in to Membean once, then sync again.").catch(() => {});
  } finally {
    if (createdTab?.id) chrome.tabs.remove(createdTab.id).catch(() => {});
  }
}

function canvasDashboardUrlFrom(url, config = {}) {
  try {
    const parsed = new URL(String(url || ""));
    if (sourceFromUrl(parsed.toString(), config) === "canvas") return `${parsed.origin}/`;
  } catch {
    // Fall back to the configured Canvas host below.
  }
  const canvasHost = String(config.canvasDomain || DEFAULT_CANVAS_HOST).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${canvasHost}/`;
}

async function runCanvasCardModeListRefresh(sourceUrl, config = {}) {
  const data = await chrome.storage.local.get(["canvasCardListRefreshInFlight", "canvasCardListRefreshAt", "canvasDashboardViewPreference"]);
  if (data.canvasCardListRefreshInFlight) return;
  const lastRefresh = data.canvasCardListRefreshAt ? new Date(data.canvasCardListRefreshAt).getTime() : 0;
  if (Number.isFinite(lastRefresh) && Date.now() - lastRefresh < CANVAS_CARD_LIST_REFRESH_MS) return;

  let createdTab = null;
  const restoreView = ["card", "list"].includes(config.originalDashboardView)
    ? config.originalDashboardView
    : (["card", "list"].includes(data.canvasDashboardViewPreference) ? data.canvasDashboardViewPreference : "card");
  await chrome.storage.local.set({ canvasCardListRefreshInFlight: true });
  try {
    createdTab = await chrome.tabs.create({ url: canvasDashboardUrlFrom(sourceUrl, config), active: false });
    await waitForTabLoad(createdTab.id, 15000);
    const loadedTab = await chrome.tabs.get(createdTab.id);
    await sendCanvasDashboardViewMessage(loadedTab, "list");
    await waitForTabLoad(createdTab.id, 5000);
    await askTabToScrape(await chrome.tabs.get(createdTab.id), { ...config, canvasListRefresh: true });
    await chrome.storage.local.set({ canvasCardListRefreshAt: new Date().toISOString() });
    const cache = await getCache();
    await broadcastToEpstudy(cache);
  } catch {
    // The normal card-view scrape remains available; retry after the cooldown window.
  } finally {
    await chrome.storage.local.set({ canvasCardListRefreshInFlight: false });
    if (createdTab?.id) chrome.tabs.remove(createdTab.id).catch(() => {});
    if (config.restoreDashboardView) {
      if (config.sourceTabId) {
        const sourceTab = await chrome.tabs.get(config.sourceTabId).catch(() => null);
        if (sourceTab) await sendCanvasDashboardViewMessage(sourceTab, restoreView).catch(() => {});
      }
      await restoreCanvasDashboardViewPreference(sourceUrl, config, restoreView).catch(() => {});
    }
  }
}

async function restoreCanvasDashboardViewPreference(sourceUrl, config = {}, view = "card") {
  const targetView = String(view || "").toLowerCase() === "list" ? "list" : "card";
  let restoreTab = null;
  try {
    restoreTab = await chrome.tabs.create({ url: canvasDashboardUrlFrom(sourceUrl, config), active: false });
    await waitForTabLoad(restoreTab.id, 15000);
    await sendCanvasDashboardViewMessage(await chrome.tabs.get(restoreTab.id), targetView);
    await waitForTabLoad(restoreTab.id, 3000).catch(() => {});
    await chrome.storage.local.set({
      canvasDashboardViewPreference: targetView,
      canvasDashboardViewPreferenceAt: new Date().toISOString()
    });
  } finally {
    if (restoreTab?.id) chrome.tabs.remove(restoreTab.id).catch(() => {});
  }
}

async function sendCanvasDashboardViewMessage(tab, view) {
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_FORCE_CANVAS_DASHBOARD_VIEW", view });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["source-scraper.js"] });
    return chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_FORCE_CANVAS_DASHBOARD_VIEW", view });
  }
}

function normalizeTeamSnapLink(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("teamsnap.com")) return "";
    if (/\/(login|signin|signup|users\/sign_in|oauth|auth)\b/i.test(parsed.pathname)) return "";
    const teamId = teamSnapTeamIdFromUrl(parsed.toString());
    if (!teamId) return "";
    return `https://go.teamsnap.com/${teamId}/schedule?mode=list&pageSize=30`;
  } catch {
    return "";
  }
}

function teamSnapTeamIdFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.match(/^\/(\d+)(?:\/|$)/)?.[1] || path.match(/\/teams?\/(\d+)/i)?.[1] || "";
  } catch {
    return "";
  }
}

function isTeamSnapScheduleUrl(url) {
  try {
    return /\/schedule(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function rememberTeamSnapLink(url, meta = {}) {
  const normalizedUrl = normalizeTeamSnapLink(url);
  if (!normalizedUrl) return;
  const data = await chrome.storage.local.get(["teamSnapLinks"]);
  const links = Array.isArray(data.teamSnapLinks) ? data.teamSnapLinks : [];
  const now = new Date().toISOString();
  const teamId = String(meta.teamId || teamSnapTeamIdFromUrl(normalizedUrl) || "").trim();
  const teamName = String(meta.teamName || "").trim();
  const next = [
    {
      url: normalizedUrl,
      teamId,
      teamName,
      firstSeenAt: links.find(link => link.url === normalizedUrl)?.firstSeenAt || now,
      lastSeenAt: now,
      lastScrapedAt: links.find(link => link.url === normalizedUrl)?.lastScrapedAt || null
    },
    ...links.filter(link => link.url !== normalizedUrl)
  ].slice(0, TEAMSNAP_LINK_LIMIT);
  await chrome.storage.local.set({ teamSnapLinks: next });
}

async function rememberOpenTeamSnapTabs(tabs) {
  await Promise.allSettled((tabs || [])
    .filter(tab => sourceFromUrl(tab?.url || "") === "teamsnap")
    .map(tab => rememberTeamSnapLink(tab.url)));
}

async function scrapeRememberedTeamSnapLinks(openTabs, config) {
  const data = await chrome.storage.local.get(["teamSnapLinks"]);
  const links = Array.isArray(data.teamSnapLinks) ? data.teamSnapLinks : [];
  const now = Date.now();
  for (const link of links) {
    const normalizedUrl = normalizeTeamSnapLink(link.url);
    if (!normalizedUrl) continue;
    const openTab = openTabs.find(tab => isTeamSnapScheduleUrl(tab.url || "") && normalizeTeamSnapLink(tab.url || "") === normalizedUrl);
    if (openTab) continue;
    const lastScraped = link.lastScrapedAt ? new Date(link.lastScrapedAt).getTime() : 0;
    if (Number.isFinite(lastScraped) && now - lastScraped < TEAMSNAP_LINK_REFRESH_MS) continue;
    let createdTab = null;
    try {
      createdTab = await chrome.tabs.create({ url: normalizedUrl, active: false });
      await waitForTabLoad(createdTab.id, 12000);
      const refreshedTab = await chrome.tabs.get(createdTab.id);
      await askTabToScrape(refreshedTab, config);
      link.lastScrapedAt = new Date().toISOString();
    } catch {
      // The saved TeamSnap link will be retried on a later sync.
    } finally {
      if (createdTab?.id) chrome.tabs.remove(createdTab.id).catch(() => {});
    }
  }
  await chrome.storage.local.set({ teamSnapLinks: links });
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function askTabToScrape(tab, config) {
  if (!tab.id || !tab.url || !isSourceUrl(tab.url, config)) return;
  if (sourceFromUrl(tab.url, config) === "teamsnap" && !isTeamSnapScheduleUrl(tab.url)) {
    await rememberTeamSnapLink(tab.url);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_SCRAPE_NOW", config });
    const payload = await enrichPayloadWithCanvasCoursesTray(tab, response?.payload, config);
    if (payload?.source) await mergeSourcePayload(payload.source, payload, { tab, scrapeConfig: config });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["source-scraper.js"] });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_SCRAPE_NOW", config });
    const payload = await enrichPayloadWithCanvasCoursesTray(tab, response?.payload, config);
    if (payload?.source) await mergeSourcePayload(payload.source, payload, { tab, scrapeConfig: config });
  }
}

async function enrichPayloadWithCanvasCoursesTray(tab, payload, config = {}) {
  if (!payload || sourceFromUrl(tab?.url || "", config) !== "canvas" || config.scheduleEnabled === false) return payload;
  try {
    const trayResponse = await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_READ_CANVAS_COURSES_TRAY", config });
    const trayCourses = trayResponse?.payload?.courses || [];
    if (!Array.isArray(trayCourses) || trayCourses.length === 0) return payload;
    return {
      ...payload,
      courses: mergeCanvasCourseLists(payload.courses || [], trayCourses),
      canvasCoursesTray: true
    };
  } catch {
    return payload;
  }
}

function isSourceUrl(url, config = {}) {
  return Boolean(sourceFromUrl(url, config));
}

function sourceFromUrl(url, config = {}) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const canvasHost = String(config.canvasDomain || DEFAULT_CANVAS_HOST).replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (host === canvasHost || host.endsWith(".instructure.com")) return "canvas";
  if (host.endsWith("teamsnap.com")) return "teamsnap";
  if (host.endsWith("membean.com")) return "membean";
  return null;
}

async function markCanvasWaitingForReadablePage(message) {
  const data = await chrome.storage.local.get(["canvas", "courses", "sourceStatus"]);
  const attemptedAt = new Date().toISOString();
  await chrome.storage.local.set({
    sourceStatus: {
      ...(data.sourceStatus || {}),
      canvas: {
        status: "waiting_for_readable_page",
        message,
        attemptedAt,
        cachedTasks: Array.isArray(data.canvas) ? data.canvas.length : 0,
        cachedCourses: Array.isArray(data.courses) ? data.courses.length : 0
      }
    },
    updatedAt: attemptedAt
  });
}

async function markTeamSnapWaitingForSchedule(message) {
  const data = await chrome.storage.local.get(["teamsnap", "sourceStatus"]);
  const attemptedAt = new Date().toISOString();
  await chrome.storage.local.set({
    sourceStatus: {
      ...(data.sourceStatus || {}),
      teamsnap: {
        status: "waiting_for_schedule",
        message,
        attemptedAt,
        cachedTasks: Array.isArray(data.teamsnap) ? data.teamsnap.length : 0
      }
    },
    updatedAt: attemptedAt
  });
}

async function markMembeanWaitingForProgress(message) {
  const data = await chrome.storage.local.get(["membean", "sourceStatus"]);
  const attemptedAt = new Date().toISOString();
  await chrome.storage.local.set({
    sourceStatus: {
      ...(data.sourceStatus || {}),
      membean: {
        status: "waiting_for_progress",
        message,
        attemptedAt,
        cachedTasks: Array.isArray(data.membean) ? data.membean.length : 0
      }
    },
    updatedAt: attemptedAt
  });
}

async function broadcastToEpstudy(payload) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !isEpstudyUrl(tab.url)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_EXTENSION_SYNC", payload });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["website-bridge.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "EPSTUDY_EXTENSION_SYNC", payload });
    }
  }));
}

async function scheduleTeamSnapReminders(rows) {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter(alarm => alarm.name.startsWith(TEAMSNAP_REMINDER_PREFIX)).map(alarm => chrome.alarms.clear(alarm.name)));
  const payloads = {};
  const now = Date.now();
  for (const row of normalizeRows(rows, "teamsnap")) {
    if (/driver/i.test(`${row.title || ""} ${row.description || ""} ${row.location || ""}`)) continue;
    const startsAt = new Date(row.dueDate || row.start_at || row.date || "").getTime();
    if (!Number.isFinite(startsAt) || startsAt <= now) continue;
    const key = String(row.externalKey || row.id || `${row.title}:${startsAt}`).replace(/[^a-z0-9:_-]/gi, "-").slice(0, 120);
    for (const offsetMinutes of [60, 0]) {
      const when = startsAt - offsetMinutes * 60 * 1000;
      if (when <= now) continue;
      const alarmName = `${TEAMSNAP_REMINDER_PREFIX}${key}:${offsetMinutes}`;
      payloads[alarmName] = {
        title: row.title || "TeamSnap event",
        startsAt,
        offsetMinutes,
        eventUrl: row.eventUrl || row.url || ""
      };
      chrome.alarms.create(alarmName, { when });
    }
  }
  await chrome.storage.local.set({ teamSnapReminderPayloads: payloads });
}

function extensionLocalDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function notifyTeamSnapWithin48ForToday() {
  const data = await chrome.storage.local.get(["teamsnap", "teamSnapDailyNoticeDate"]);
  const todayKey = extensionLocalDateKey();
  if (data.teamSnapDailyNoticeDate === todayKey) return;
  const now = Date.now();
  const upcoming = normalizeRows(data.teamsnap || [], "teamsnap")
    .map(row => ({ row, startsAt: new Date(row.dueDate || row.start_at || row.date || "").getTime() }))
    .filter(item => Number.isFinite(item.startsAt) && item.startsAt > now && item.startsAt - now <= TEAMSNAP_NOTIFY_WINDOW_MS)
    .sort((a, b) => a.startsAt - b.startsAt);
  if (!upcoming.length) return;
  await chrome.storage.local.set({ teamSnapDailyNoticeDate: todayKey });
  const first = upcoming[0];
  const starts = new Date(first.startsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const more = upcoming.length > 1 ? ` + ${upcoming.length - 1} more` : "";
  chrome.notifications.create(`${TEAMSNAP_REMINDER_PREFIX}daily:${todayKey}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "TeamSnap in the next 2 days",
    message: `${first.row.title || "TeamSnap event"} at ${starts}${more}`
  }).catch(() => {});
}

async function showTeamSnapReminder(alarmName) {
  const data = await chrome.storage.local.get(["teamSnapReminderPayloads"]);
  const reminder = data.teamSnapReminderPayloads?.[alarmName];
  if (!reminder) return;
  const starts = new Date(reminder.startsAt);
  const time = Number.isNaN(starts.getTime()) ? "" : starts.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const message = reminder.offsetMinutes > 0 ? `Starts in ${reminder.offsetMinutes} minutes${time ? ` at ${time}` : ""}.` : "Starts now.";
  chrome.notifications.create(alarmName, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "TeamSnap reminder",
    message: `${reminder.title}\n${message}`
  }).catch(() => {});
}

function isEpstudyUrl(url) {
  if (String(url || "").startsWith("file:")) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0") return true;
    return parsed.protocol === "https:"
      && ((parsed.hostname === "sillywaffle-4.github.io" && parsed.pathname.startsWith("/Epstudy/"))
        || parsed.hostname.endsWith("github.io")
        || parsed.hostname.endsWith("netlify.app")
        || parsed.hostname.endsWith("vercel.app"));
  } catch {
    return false;
  }
}
