const SOURCE_HOST = window.location.hostname;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EPSTUDY_FORCE_CANVAS_DASHBOARD_VIEW" || message?.type === "EPSTUDY_FORCE_CANVAS_LIST_VIEW") {
    const view = message.type === "EPSTUDY_FORCE_CANVAS_LIST_VIEW" ? "list" : message.view;
    forceCanvasDashboardView(view).then((result) => {
      sendResponse({ ok: true, result });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "EPSTUDY_READ_CANVAS_COURSES_TRAY") {
    readCanvasCoursesTray().then((payload) => {
      sendResponse({ ok: true, payload });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "EPSTUDY_SCRAPE_NOW") return false;
  scrapeAndSendCurrentPage().then((payload) => {
    sendResponse({ ok: true, payload });
  }).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

scrapeAndSendCurrentPage().catch(() => {});

if (SOURCE_HOST.endsWith("instructure.com")) {
  [1200, 3200, 7000, 12000].forEach(delay => setTimeout(() => scrapeAndSendCurrentPage().catch(() => {}), delay));
  observeCanvasDashboard();
}

if (SOURCE_HOST.endsWith("teamsnap.com") && isTeamSnapScheduleUrl(window.location.href)) {
  [2500, 8000].forEach(delay => {
    setTimeout(() => scrapeAndSendCurrentPage().catch(() => {}), delay);
  });
}

async function scrapeAndSendCurrentPage() {
  const payload = await scrapeCurrentPage();
  if (payload.source && (payload.source !== "teamsnap" || payload.teamSnap?.isSchedulePage)) {
    chrome.runtime.sendMessage({ type: "EPSTUDY_SOURCE_DATA", source: payload.source, payload });
  }
  return payload;
}

async function scrapeCurrentPage() {
  if (SOURCE_HOST.endsWith("instructure.com")) {
    const canvasDashboardView = detectCanvasDashboardView();
    const tasks = await scrapeCanvasTasks(canvasDashboardView);
    const courses = await ensureCoursesForCanvasTasks(tasks, await scrapeCanvasCourses());
    return { source: "canvas", tasks, courses, canvasDashboardView };
  }
  if (SOURCE_HOST.endsWith("teamsnap.com")) {
    const teamSnap = getTeamSnapPageMeta();
    if (!teamSnap.isSchedulePage) return { source: "teamsnap", tasks: [], teamSnap };
    return { source: "teamsnap", tasks: scrapeTeamSnapTasks(teamSnap), teamSnap };
  }
  if (SOURCE_HOST.endsWith("membean.com")) return { source: "membean", tasks: scrapeMembeanTasks() };
  return { source: null, tasks: [] };
}

function observeCanvasDashboard() {
  if (!document.documentElement || typeof MutationObserver === "undefined") return;
  let rescrapeTimer = null;
  const observer = new MutationObserver((mutations) => {
    const shouldRescrape = mutations.some(mutation => {
      return Array.from(mutation.addedNodes || []).some(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        return node.matches?.("a[href*='/courses/'], .ic-DashboardCard, [class*='DashboardCard'], [class*='PlannerItem'], [class*='todo'], [class*='ToDo'], aside")
          || node.querySelector?.("a[href*='/courses/'], .ic-DashboardCard, [class*='DashboardCard'], [class*='PlannerItem'], [class*='todo'], [class*='ToDo'], aside");
      });
    });
    if (!shouldRescrape) return;
    clearTimeout(rescrapeTimer);
    rescrapeTimer = setTimeout(() => scrapeAndSendCurrentPage().catch(() => {}), 900);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function forceCanvasDashboardView(view) {
  if (!SOURCE_HOST.endsWith("instructure.com")) return { changed: false, reason: "not-canvas" };
  const targetView = String(view || "").toLowerCase() === "card" ? "card" : "list";
  if (detectCanvasDashboardView() === targetView) return { changed: false, view: targetView };

  const directOption = findCanvasDashboardViewOption(`${targetView} view`);
  if (directOption) {
    clickCanvasElement(directOption);
    await sleep(1200);
    return { changed: true, view: detectCanvasDashboardView() };
  }

  const menuButton = findCanvasDashboardMenuButton();
  if (menuButton) {
    clickCanvasElement(menuButton);
    await sleep(450);
    const openedOption = findCanvasDashboardViewOption(`${targetView} view`);
    if (openedOption) {
      clickCanvasElement(openedOption);
      await sleep(1200);
      return { changed: true, view: detectCanvasDashboardView() };
    }
  }

  return { changed: false, view: detectCanvasDashboardView(), reason: `${targetView}-option-not-found` };
}

async function readCanvasCoursesTray() {
  if (!SOURCE_HOST.endsWith("instructure.com")) return { source: "canvas", tasks: [], courses: [], canvasCoursesTray: false };

  let courses = scrapeCanvasCoursesTrayCourses();
  let opened = false;
  if (courses.length === 0) {
    const coursesButton = findCanvasCoursesButton();
    if (coursesButton) {
      clickCanvasElement(coursesButton);
      opened = true;
      await sleep(1400);
      courses = scrapeCanvasCoursesTrayCourses();
    }
  }

  if (opened) closeCanvasCoursesTray();
  return {
    source: "canvas",
    tasks: [],
    courses: dedupeCourses(courses),
    canvasCoursesTray: true,
    canvasDashboardView: detectCanvasDashboardView()
  };
}

function findCanvasCoursesButton() {
  const explicit = document.querySelector("#global_nav_courses_link, a[href='/courses'], a[href$='/courses']");
  if (explicit && isVisibleElement(explicit)) return explicit;
  return Array.from(document.querySelectorAll("a, button, [role='button']"))
    .find(node => isVisibleElement(node) && /^courses$/i.test(text(node))) || null;
}

function canvasCoursesTrayRoots() {
  const roots = Array.from(document.querySelectorAll([
    "#nav-tray-portal",
    "#global_nav_tray_container",
    "[aria-label='Courses']",
    "[class*='Tray']",
    "[class*='tray']"
  ].join(","))).filter(root => {
    const rootText = text(root);
    return root.querySelector?.("a[href*='/courses/']") && /\b(All Courses|Period\s+[A-H]|Term:|Welcome to your courses)\b/i.test(rootText);
  });
  return roots.length ? roots : [];
}

function scrapeCanvasCoursesTrayCourses() {
  const roots = canvasCoursesTrayRoots();
  const links = roots.flatMap(root => Array.from(root.querySelectorAll("a[href*='/courses/']")));
  return links.map(link => {
    const courseId = canvasCourseIdFromCourseHomeHref(link.getAttribute?.("href") || "");
    if (!courseId) return null;
    const courseLabel = canvasCourseLabelFromLink(link);
    const name = cleanCanvasCourseName(courseLabel.name);
    const code = cleanCanvasCourseName(courseLabel.code);
    if (!isLikelyCanvasCourseName(name) || hasBlockedCanvasCourseKeyword(`${name} ${code}`)) return null;
    return {
      id: courseId,
      name,
      course_code: code,
      period: normalizeCanvasCoursePeriod(courseLabel.period || text(link.closest?.("li, [role='listitem'], [class*='course']"))),
      source: "canvas"
    };
  }).filter(Boolean);
}

function closeCanvasCoursesTray() {
  const roots = canvasCoursesTrayRoots();
  const closeButton = roots.flatMap(root => Array.from(root.querySelectorAll("button, a, [role='button']")))
    .find(node => {
      const label = `${text(node)} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("title") || ""}`.trim();
      return isVisibleElement(node) && /^(close|x|×)$/i.test(label);
    });
  if (closeButton) {
    clickCanvasElement(closeButton);
    return;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

function findCanvasDashboardViewOption(label) {
  const wanted = String(label || "").toLowerCase();
  const candidates = Array.from(document.querySelectorAll("button, a, [role='menuitem'], [role='option'], li, span, div"));
  for (const node of candidates) {
    if (text(node).toLowerCase() !== wanted) continue;
    const clickable = node.closest?.("button, a, [role='menuitem'], [role='option'], li") || node;
    if (clickable && isVisibleElement(clickable)) return clickable;
  }
  return null;
}

function findCanvasDashboardMenuButton() {
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
  return buttons.find(button => {
    if (!isVisibleElement(button)) return false;
    const label = `${text(button)} ${button.getAttribute?.("aria-label") || ""} ${button.getAttribute?.("title") || ""}`.toLowerCase();
    if (/dashboard.*(options|view|menu)|more options|dashboard view/.test(label)) return true;
    return button.getAttribute?.("aria-haspopup") === "menu" && /dashboard/i.test(text(button.closest?.("main, [role='main'], body") || document.body));
  }) || null;
}

function clickCanvasElement(element) {
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click?.();
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect?.();
  const style = window.getComputedStyle?.(element);
  return Boolean(rect && rect.width >= 0 && rect.height >= 0 && style?.display !== "none" && style?.visibility !== "hidden");
}

async function fetchCanvasApiPages(initialUrl) {
  const rows = [];
  try {
    let url = initialUrl;
    let guard = 0;
    while (url && guard < 20) {
      guard++;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) break;
      const pageRows = await response.json();
      if (Array.isArray(pageRows)) rows.push(...pageRows);
      const linkHeader = response.headers.get("Link") || "";
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/) || linkHeader.match(/<([^>]+)>.*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }
  } catch {
    // Fall back to the visible page scrape when Canvas API access is unavailable.
  }
  return rows;
}

async function scrapeCanvasCourses() {
  const courses = [];
  const currentFavoriteCourses = await fetchCanvasCurrentFavoriteCourses();
  const currentFavoriteIds = new Set(currentFavoriteCourses.map(course => String(course.id || "")));
  try {
    const rows = await fetchCanvasApiPages(`${window.location.origin}/api/v1/courses?enrollment_state=active&per_page=500`);
    for (const row of rows) {
      if (!row?.id || row.access_restricted_by_date) continue;
      const normalized = normalizeCanvasCourseRecord(row);
      if (normalized) courses.push(normalized);
    }
    const cards = await fetchCanvasApiPages(`${window.location.origin}/api/v1/dashboard/dashboard_cards?per_page=100`);
    courses.push(...dashboardCoursesFromApiCards(cards));
  } catch {
    // The visible page scrape below is still useful if Canvas API access is unavailable.
  }

  const visibleCourses = [
    ...canvasCoursesFromEnv(),
    ...scrapeCanvasDashboardCardCourses(),
    ...Array.from(document.querySelectorAll("a[href*='/courses/']"))
    .map(node => {
      const courseLabel = canvasCourseLabelFromLink(node);
      if (hasBlockedCanvasCourseKeyword(`${courseLabel.name} ${courseLabel.code}`)) return null;
      const label = cleanCanvasCourseName(courseLabel.name);
      const courseId = canvasCourseIdFromCourseHomeHref(node.getAttribute?.("href") || "");
      if (!courseId || !isLikelyCanvasCourseName(label)) return null;
      return { id: courseId, name: label, course_code: cleanCanvasCourseName(courseLabel.code), period: courseLabel.period || "", source: "canvas" };
    })
    .filter(Boolean)
  ];

  const deduped = dedupeCourses([...currentFavoriteCourses, ...courses, ...visibleCourses]);
  const filtered = currentFavoriteIds.size
    ? deduped.filter(course => currentFavoriteIds.has(String(course.id || "")))
    : deduped;
  return enrichCanvasCoursePeriodsFromAnalytics(filtered);
}

function normalizeCanvasCourseRecord(course, idOverride = "") {
  const id = String(idOverride || course?.id || course?.course_id || course?.assetString?.match?.(/course_(\d+)/)?.[1] || "").trim();
  const rawName = course?.shortName || course?.originalName || course?.name || course?.longName || course?.courseCode || course?.course_code || "";
  const rawCode = course?.courseCode || course?.course_code || course?.code || "";
  const rawPeriod = course?.period || course?.course_period || course?.section || extractCanvasCoursePeriod(`${course?.subtitle || ""} ${course?.term || ""}`);
  if (hasBlockedCanvasCourseKeyword(`${rawName} ${rawCode}`)) return null;
  const name = cleanCanvasCourseName(rawName);
  if (!id || !isLikelyCanvasCourseName(name)) return null;
  return {
    id,
    name,
    course_code: cleanCanvasCourseName(rawCode),
    period: normalizeCanvasCoursePeriod(rawPeriod),
    source: "canvas"
  };
}

function canvasCoursesFromEnv() {
  const env = window.ENV || {};
  const rows = [
    ...(Array.isArray(env.STUDENT_PLANNER_COURSES) ? env.STUDENT_PLANNER_COURSES : []),
    ...(Array.isArray(env.COURSES) ? env.COURSES : []),
    ...(Array.isArray(env.courses) ? env.courses : [])
  ];
  return rows.map(course => normalizeCanvasCourseRecord(course)).filter(Boolean);
}

async function fetchCanvasCurrentFavoriteCourses() {
  try {
    const response = await fetch(`${window.location.origin}/courses`, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    if (!response.ok) return [];
    const html = await response.text();
    return scrapeCanvasCurrentFavoriteCoursesFromHtml(html);
  } catch {
    return [];
  }
}

function scrapeCanvasCurrentFavoriteCoursesFromHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = [];
  let enrollmentSection = "current";
  for (const node of Array.from(doc.body?.querySelectorAll("h1, h2, h3, table") || [])) {
    if (/past enrollments/i.test(text(node))) {
      enrollmentSection = "past";
      continue;
    }
    if (/future enrollments/i.test(text(node))) {
      enrollmentSection = "future";
      continue;
    }
    if (node.tagName !== "TABLE" || enrollmentSection !== "current") continue;
    rows.push(...scrapeCanvasCurrentFavoriteCoursesFromTable(node));
  }
  return dedupeCourses(rows);
}

function scrapeCanvasCurrentFavoriteCoursesFromTable(table) {
  return Array.from(table.querySelectorAll("tbody tr, tr")).map(row => {
    const link = Array.from(row.querySelectorAll("a[href*='/courses/']"))
      .find(node => canvasCourseIdFromCourseHomeHref(node.getAttribute?.("href") || ""));
    const id = canvasCourseIdFromCourseHomeHref(link?.getAttribute?.("href") || "");
    if (!id) return null;
    const cells = Array.from(row.querySelectorAll("td, th"));
    if (!isCurrentFavoriteCourseRow(row, cells)) return null;
    const label = canvasCourseLabelFromLink(link);
    const name = cleanCanvasCourseName(label.name || text(link));
    if (!isLikelyCanvasCourseName(name) || hasBlockedCanvasCourseKeyword(name)) return null;
    const term = tableCellTextByHeader(row, "term") || text(cells[3]);
    return {
      id,
      name,
      course_code: cleanCanvasCourseName(label.code),
      period: normalizeCanvasCoursePeriod(label.period || text(row)),
      term,
      source: "canvas"
    };
  }).filter(Boolean);
}

function isCurrentFavoriteCourseRow(row, cells) {
  const rowText = text(row);
  if (!/\bstudent\b/i.test(rowText)) return false;
  if (/\bno\b/i.test(tableCellTextByHeader(row, "published") || text(cells[cells.length - 1] || ""))) return false;
  if (/past enrollments|future enrollments/i.test(rowText)) return false;
  return isFavoritedCanvasCourseRow(row, cells[0]);
}

function tableCellTextByHeader(row, headerName) {
  const wanted = String(headerName || "").toLowerCase();
  const table = row.closest?.("table");
  const headers = Array.from(table?.querySelectorAll("thead th, tr:first-child th") || []).map(th => text(th).toLowerCase());
  const index = headers.findIndex(header => header.includes(wanted));
  if (index < 0) return "";
  return text(Array.from(row.querySelectorAll("td, th"))[index]);
}

function isFavoritedCanvasCourseRow(row, favoriteCell) {
  const scope = favoriteCell || row;
  const labels = Array.from(scope.querySelectorAll("*"))
    .map(node => `${node.getAttribute?.("title") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("data-tooltip") || ""} ${node.className || ""}`)
    .join(" ");
  const favoriteText = `${text(scope)} ${labels}`;
  if (/unfavorite|remove.*favorite|currently.*favorite|favorite.*true|starred/i.test(favoriteText)) return true;
  if (/add.*favorite|mark.*favorite|not.*favorite|favorite.*false/i.test(favoriteText)) return false;
  const filledStar = scope.querySelector?.(".icon-star:not(.icon-star-light), .icon-star-full, [class*='starred']");
  if (filledStar) return true;
  return /★|★|orange/i.test(favoriteText);
}

async function enrichCanvasCoursePeriodsFromAnalytics(courses) {
  const rows = Array.isArray(courses) ? courses : [];
  const missingPeriodRows = rows
    .filter(course => /^\d+$/.test(String(course?.id || "")) && !normalizeCanvasCoursePeriod(course?.period))
    .slice(0, 40);
  if (!missingPeriodRows.length) return rows;

  const periodPairs = await Promise.all(missingPeriodRows.map(async course => {
    const period = await fetchCanvasCourseAnalyticsPeriod(course.id);
    return [course.id, period];
  }));
  const periodsById = new Map(periodPairs.filter(([, period]) => period));
  if (!periodsById.size) return rows;
  return rows.map(course => {
    const period = periodsById.get(String(course?.id || ""));
    return period ? { ...course, period } : course;
  });
}

async function fetchCanvasCourseAnalyticsPeriod(courseIdRaw) {
  const courseId = String(courseIdRaw || "").trim();
  if (!/^\d+$/.test(courseId)) return "";
  try {
    const response = await fetch(`${window.location.origin}/courses/${courseId}/external_tools/1069735`, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    if (!response.ok) return "";
    const html = await response.text();
    return extractCanvasCourseAnalyticsPeriod(html);
  } catch {
    return "";
  }
}

function extractCanvasCourseAnalyticsPeriod(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const mainText = text(doc.querySelector("#content, main, [role='main']")) || text(doc.body);
  return normalizeCanvasCoursePeriod(mainText.match(/\bPeriod\s+[A-H]\b/i)?.[0] || "");
}

function canvasCourseLabelFromLink(link) {
  const card = link?.closest?.(".ic-DashboardCard, [class*='DashboardCard'], [data-testid='draggable-card']");
  if (card) {
    const title = text(card.querySelector?.([
      ".ic-DashboardCard__header-title",
      "[data-testid='dashboard-card-title']",
      "[class*='DashboardCard__header-title']",
      "h2",
      "h3"
    ].join(",")));
    const code = text(card.querySelector?.(".ic-DashboardCard__header-subtitle, [class*='DashboardCard__header-subtitle']"));
    if (title) return { name: title, code, period: extractCanvasCoursePeriod(text(card)) };
  }
  const courseListItem = link?.closest?.("li, .course-list-item, [role='listitem'], [class*='course']");
  const scopeText = text(courseListItem) || text(link?.parentElement) || text(link);
  return {
    name: text(link?.querySelector?.(".ellipsible, [data-testid='dashboard-card-title'], h2, h3")) || text(link),
    code: "",
    period: extractCanvasCoursePeriod(scopeText)
  };
}

function dashboardCoursesFromApiCards(cards) {
  return (Array.isArray(cards) ? cards : [])
    .map(card => {
      const id = String(card?.id || card?.course_id || "").trim();
      const rawName = card?.shortName || card?.originalName || card?.name || card?.courseCode || "";
      const rawCode = card?.courseCode || card?.assetString || "";
      if (hasBlockedCanvasCourseKeyword(`${rawName} ${rawCode}`)) return null;
      const name = cleanCanvasCourseName(rawName);
      if (!id || !isLikelyCanvasCourseName(name)) return null;
      return {
        id,
        name,
        course_code: String(rawCode),
        period: normalizeCanvasCoursePeriod(card?.period || card?.course_period || card?.section || ""),
        source: "canvas"
      };
    })
    .filter(Boolean);
}

function cleanCanvasCourseName(value) {
  return String(value || "")
    .replace(/\b(Announcements|Assignments|Discussions|Files|Grades|Modules|Pages|Syllabus|People|Quizzes)\b/gi, " ")
    .replace(/\b(Sandbox|Published|Unpublished)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyCanvasCourseName(label) {
  const clean = String(label || "").trim();
  if (!clean || clean.length < 2 || clean.length > 120) return false;
  if (hasBlockedCanvasCourseKeyword(clean)) return false;
  if (isCanvasNavigationLabel(clean)) return false;
  if (clean.includes(":")) return false;
  if (/^(hw|cw|qa|ma)\b\s*[-:]/i.test(clean)) return false;
  if (/\b\d+\s*pts?\b|\bdue\b/i.test(clean)) return false;
  if (/\b(chapter\s*\d+|quiz|project|poem|worksheet|homework|classwork)\b/i.test(clean)) return false;
  if (/\bassignment\b/i.test(clean) && !/\bthinking|algebra|spanish|music|class\b/i.test(clean)) return false;
  return true;
}

function hasBlockedCanvasCourseKeyword(value) {
  return /\b(assignments?|files?)\b/i.test(String(value || ""));
}

function isCanvasNavigationLabel(label) {
  return /^(announcements?|assignments?|assignment groups?|calendar|chat|collaborations?|conferences?|course details?|dashboard|discussions?|files?|grades?|help|history|home|inbox|modules?|outcomes?|pages?|people|quizzes?|rubrics?|settings|syllabus|to do|recent feedback|show all|courses?|all courses?)$/i.test(String(label || "").trim());
}

function canvasCourseIdFromCourseHomeHref(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, window.location.origin);
    const normalizedPath = parsed.pathname.replace(/\/$/, "");
    if (slashCount(`${parsed.origin}${normalizedPath}`) > 4) return "";
    const match = normalizedPath.match(/^\/courses\/(\d+)$/);
    return match?.[1] || "";
  } catch {
    const normalizedRaw = raw.replace(/\/$/, "");
    if (slashCount(normalizedRaw) > 2) return "";
    return normalizedRaw.match(/^\/courses\/(\d+)$/)?.[1] || "";
  }
}

function slashCount(value) {
  return (String(value || "").match(/\//g) || []).length;
}

function scrapeCanvasDashboardCardCourses() {
  const cards = Array.from(document.querySelectorAll([
    ".ic-DashboardCard",
    "[class*='DashboardCard']",
    "[data-testid*='dashboard-card']"
  ].join(",")));

  return cards.map(card => {
    const courseLink = Array.from(card.querySelectorAll?.("a[href*='/courses/']") || [])
      .find(link => canvasCourseIdFromCourseHomeHref(link.getAttribute?.("href") || ""));
    const href = courseLink?.getAttribute?.("href") || "";
    const id = canvasCourseIdFromCourseHomeHref(href) || card.getAttribute?.("data-course-id") || "";
    const fallbackLine = text(card).split(/\s{2,}|(?=Announcements|Assignments|Discussions|Files)/i)[0];
    const ariaLabel = card.getAttribute?.("aria-label") || courseLink?.getAttribute?.("aria-label") || courseLink?.getAttribute?.("title") || "";
    const cardLabel = canvasCourseLabelFromLink(courseLink);
    const rawName = cardLabel.name || ariaLabel.replace(/^course:?\s*/i, "") || fallbackLine;
    if (hasBlockedCanvasCourseKeyword(rawName)) return null;
    const name = cleanCanvasCourseName(rawName);
    if (!id || !isLikelyCanvasCourseName(name)) return null;
    return {
      id,
      name,
      course_code: cleanCanvasCourseName(cardLabel.code),
      period: cardLabel.period || extractCanvasCoursePeriod(text(card)),
      source: "canvas"
    };
  }).filter(Boolean);
}

function normalizeCanvasCoursePeriod(value) {
  const match = String(value || "").toUpperCase().match(/\b(?:PERIOD\s*)?([A-H])\b/);
  return match ? match[1] : "";
}

function extractCanvasCoursePeriod(value) {
  return normalizeCanvasCoursePeriod(String(value || "").match(/\bPeriod\s+[A-H]\b/i)?.[0] || value);
}

async function ensureCoursesForCanvasTasks(tasks, courses) {
  const resolvedCourses = [...(Array.isArray(courses) ? courses : [])];
  const knownCourseIds = new Set(resolvedCourses.map(course => String(course?.id || "")));
  const missingCourseIds = Array.from(new Set((Array.isArray(tasks) ? tasks : [])
    .map(task => String(task?.courseId || "").replace(/^canvas-course-/, "").trim())
    .filter(courseId => /^\d+$/.test(courseId) && !knownCourseIds.has(courseId))))
    .slice(0, 50);

  for (const courseId of missingCourseIds) {
    const task = tasks.find(row => String(row?.courseId || "") === `canvas-course-${courseId}`);
    const course = await fetchCanvasCourseForTask(courseId, task);
    if (!course) continue;
    resolvedCourses.push(course);
    knownCourseIds.add(course.id);
  }

  return dedupeCourses(resolvedCourses);
}

async function fetchCanvasCourseForTask(courseIdRaw, task) {
  return await fetchCanvasCourseFromApi(courseIdRaw) || await fetchCanvasCourseFromAssignmentPage(courseIdRaw, task);
}

async function fetchCanvasCourseFromApi(courseIdRaw) {
  if (!/^\d+$/.test(String(courseIdRaw || ""))) return null;
  try {
    const response = await fetch(`${window.location.origin}/api/v1/courses/${courseIdRaw}`, {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids, application/json" }
    });
    if (!response.ok) return null;
    const course = await response.json();
    return normalizeCanvasCourseRecord(course, courseIdRaw);
  } catch {
    return null;
  }
}

async function fetchCanvasCourseFromAssignmentPage(courseIdRaw, task) {
  const assignmentId = canvasAssignmentId(task || {});
  if (!/^\d+$/.test(String(courseIdRaw || "")) || !/^\d+$/.test(String(assignmentId || ""))) return null;
  const url = absoluteCanvasUrl(task?.canvasUrl || `/courses/${courseIdRaw}/assignments/${assignmentId}`);
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return extractCanvasCourseFromAssignmentPage(courseIdRaw, html, doc);
  } catch {
    return null;
  }
}

function extractCanvasCourseFromAssignmentPage(courseIdRaw, html, doc) {
  const courseId = String(courseIdRaw || "").trim();
  const envCourse = canvasCurrentContextCourseFromHtml(courseId, html);
  if (envCourse) return envCourse;

  const breadcrumbLink = exactCanvasCourseLinks(doc, courseId)
    .find(link => link.closest?.("#breadcrumbs, nav[aria-label='breadcrumbs']"));
  const breadcrumbName = text(breadcrumbLink?.querySelector?.(".ellipsible")) || text(breadcrumbLink);
  const breadcrumbCourse = normalizeCanvasCourseRecord({ id: courseId, name: breadcrumbName }, courseId);
  if (breadcrumbCourse) return breadcrumbCourse;

  for (const link of exactCanvasCourseLinks(doc, courseId)) {
    const firstLine = text(link.querySelector?.(".ellipsible, div, span")) || text(link);
    const course = normalizeCanvasCourseRecord({ id: courseId, name: firstLine }, courseId);
    if (course) return course;
  }

  return null;
}

function canvasCurrentContextCourseFromHtml(courseIdRaw, html) {
  const courseId = String(courseIdRaw || "").trim();
  const raw = String(html || "");
  const contextMatch = raw.match(/"current_context"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"[^}]*"name"\s*:\s*"((?:\\.|[^"\\])*)"[^}]*"type"\s*:\s*"Course"/);
  if (!contextMatch || contextMatch[1] !== courseId) return null;
  try {
    const name = JSON.parse(`"${contextMatch[2]}"`);
    return normalizeCanvasCourseRecord({ id: courseId, name }, courseId);
  } catch {
    return null;
  }
}

function exactCanvasCourseLinks(doc, courseIdRaw) {
  const courseId = String(courseIdRaw || "").trim();
  if (!doc || !/^\d+$/.test(courseId)) return [];
  return Array.from(doc.querySelectorAll(`a[href*="/courses/${courseId}"]`))
    .filter(link => {
      try {
        return new URL(link.getAttribute("href") || "", window.location.origin).pathname.replace(/\/$/, "") === `/courses/${courseId}`;
      } catch {
        return false;
      }
    });
}

function text(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function normalizeAssignmentTitle(title) {
  return String(title || "")
    .replace(/^Calendar:\s*/i, "")
    .replace(/^Assignment\b:?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleKey(title) {
  return normalizeAssignmentTitle(title).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(normalizeDateString(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDateString(value) {
  return String(value || "")
    .replace(/\bat\b/gi, " ")
    .replace(/(\d)(AM|PM)\b/gi, "$1 $2")
    .replace(/(^|[^\d:])(\d{1,2})\s*(AM|PM)\b/gi, "$1$2:00 $3")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateFromText(value) {
  const raw = String(value || "");
  if (/\btoday\b/i.test(raw)) return dateWithTimeFromRelativeDay(0, raw);
  if (/\btomorrow\b/i.test(raw)) return dateWithTimeFromRelativeDay(1, raw);
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}(?:[T ][0-9:.-]+Z?)?/);
  if (isoMatch) return parseDate(isoMatch[0]);
  const monthMatch = raw.match(/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)?\.?,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM))?/i);
  if (monthMatch) return parseDate(withYearIfMissing(monthMatch[0].replace(/\b(st|nd|rd|th)\b/gi, "")));
  const numericMatch = raw.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/i);
  if (numericMatch) return parseDate(withYearIfMissing(numericMatch[0]));
  const dueMatch = raw.match(/(?:due|starts?|game|practice)\D{0,12}([A-Z][a-z]{2,8}\.? \d{1,2}(?:,\s*\d{4})?(?:[^A-Za-z0-9]\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i);
  if (dueMatch) return parseDate(dueMatch[1]);
  return parseDate(raw);
}

function dateWithTimeFromRelativeDay(dayOffset, raw) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(9, 0, 0, 0);
  const timeMatch = String(raw || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (timeMatch) {
    let hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2] || 0);
    const meridiem = timeMatch[3].toUpperCase();
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    date.setHours(hours, minutes, 0, 0);
  }
  return date;
}

function withYearIfMissing(value) {
  const textValue = normalizeDateString(value);
  if (/\b\d{4}\b/.test(textValue)) return textValue;
  const timeMatch = textValue.match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/i);
  if (!timeMatch) return `${textValue} ${new Date().getFullYear()}`;
  const datePart = textValue.replace(timeMatch[0], "").replace(/\s+/g, " ").trim();
  return `${datePart} ${new Date().getFullYear()} ${normalizeDateString(timeMatch[0])}`;
}

function stableId(source, title, date) {
  return `${source}:${normalizeAssignmentTitle(title)}:${date?.toISOString?.() || ""}`.toLowerCase().replace(/[^a-z0-9:_-]/g, "-").slice(0, 180);
}

function absoluteCanvasUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.hostname.endsWith("instructure.com")) {
      parsed.protocol = "https:";
      return parsed.toString();
    }
    if (/\/courses\/\d+\/assignments\/\d+/i.test(parsed.pathname)) {
      return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Ignore malformed links from Canvas markup.
  }
  return "";
}

function dueDayKey(value) {
  const date = parseDate(value);
  if (!date) return String(value || "");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function canvasAssignmentId(row) {
  const keyMatch = String(row.externalKey || "").match(/^canvas:([^:]+):([^:]+)$/);
  if (keyMatch && /^\d+$/.test(keyMatch[2])) return keyMatch[2];
  const idMatch = String(row.id || "").match(/^canvas-[^-]+-(\d+)$/);
  if (idMatch) return idMatch[1];
  const urlMatch = String(row.canvasUrl || row.url || "").match(/\/assignments\/(\d+)/);
  return urlMatch?.[1] || "";
}

function rowAliases(row) {
  const source = row.source || "";
  const title = titleKey(row.title);
  const due = dueDayKey(row.dueDate);
  const exactTime = parseDate(row.dueDate)?.getTime();
  const course = String(row.courseId || "").replace(/^canvas-course-/, "") || "x";
  const assignmentId = canvasAssignmentId(row);
  const aliases = [`${source}:title-day:${title}:${due}`];
  const externalKey = String(row.externalKey || "").trim();
  if (externalKey) aliases.unshift(`${source}:external:${externalKey}`);
  if (source === "canvas") {
    aliases.push(`${source}:title-course:${title}:${course}`);
    if (assignmentId) aliases.push(`${source}:assignment:${assignmentId}`);
    const url = String(row.canvasUrl || row.url || "").replace(/\?.*$/, "");
    if (url) aliases.push(`${source}:url:${url}`);
  }
  if (source === "teamsnap") {
    if (Number.isFinite(exactTime)) aliases.push(`${source}:title-time:${title}:${exactTime}`);
    const url = String(row.eventUrl || row.url || "").replace(/\?.*$/, "");
    if (url) aliases.push(`${source}:url:${url}`);
  }
  return aliases;
}

function rowQuality(row) {
  let score = 0;
  if (row.courseId && !/course-other|undefined|unknown/i.test(String(row.courseId))) score += 20;
  if (/^canvas:[^:]+:[^:]+$/.test(String(row.externalKey || "")) && !String(row.externalKey).includes("stableid")) score += 8;
  if (!String(row.id || "").startsWith("canvas-x-")) score += 4;
  if (!/^Assignment\b:?\s*/i.test(String(row.title || ""))) score += 2;
  return score;
}

async function normalizeCanvasApiTask(item) {
  const assignment = item?.assignment || item?.plannable || item;
  const title = normalizeAssignmentTitle(assignment?.name || assignment?.title || item?.title || item?.context_name || "");
  const dueDate = parseDate(assignment?.due_at || assignment?.todo_date || item?.due_at || item?.todo_date || item?.end_at);
  if (!title || !dueDate) return null;
  const courseIdRaw = String(assignment?.course_id || item?.course_id || item?.course_id_raw || item?.context_code?.replace(/^course_/, "") || "").trim();
  if (!courseIdRaw) return null;
  const assignmentId = String(assignment?.id || item?.assignment_id || item?.plannable_id || stableId("canvas", title, dueDate)).trim();
  const submission = await fetchSubmissionStatus(courseIdRaw, assignmentId);
  return {
    id: `canvas-${courseIdRaw || "x"}-${assignmentId}`,
    title,
    dueDate: dueDate.toISOString(),
    estimatedMinutes: 30,
    source: "canvas",
    courseId: courseIdRaw ? `canvas-course-${courseIdRaw}` : undefined,
    externalKey: `canvas:${courseIdRaw || "x"}:${assignmentId}`,
    canvasUrl: absoluteCanvasUrl(assignment?.html_url || item?.html_url || item?.url || `/courses/${courseIdRaw}/assignments/${assignmentId}`),
    completed: submission.forceIncomplete ? false : Boolean(submission.completed || item?.submitted || item?.completed || item?.workflow_state === "completed"),
    canvasForceIncomplete: Boolean(submission.forceIncomplete),
    forceIncompleteReason: submission.forceIncompleteReason || "",
    canvasGrade: submission.grade || "",
    canvasScore: submission.score,
    canvasPointsPossible: submission.pointsPossible,
    submissionState: submission.submissionState || item?.workflow_state || "",
    comments: submission.comments || [],
    comment: submission.comment || ""
  };
}

async function fetchSubmissionStatus(courseIdRaw, assignmentId) {
  if (!/^\d+$/.test(String(courseIdRaw || "")) || !/^\d+$/.test(String(assignmentId || ""))) return {};
  try {
    const url = `${window.location.origin}/api/v1/courses/${courseIdRaw}/assignments/${assignmentId}/submissions/self?include[]=submission_comments`;
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return {};
    const submission = await response.json();
    const comments = Array.isArray(submission?.submission_comments)
      ? submission.submission_comments.map(c => ({ author: c.author_name || c.author?.display_name || "Canvas", comment: String(c.comment || "").trim(), createdAt: c.created_at || "" })).filter(c => c.comment)
      : [];
    const gradeMeta = canvasSubmissionGradeMeta(submission);
    const submitted = Boolean(
      submission?.submitted_at ||
      submission?.workflow_state === "submitted" ||
      submission?.workflow_state === "graded" ||
      submission?.attempt ||
      gradeMeta.completedByGrade
    );
    return {
      completed: gradeMeta.forceIncomplete ? false : submitted,
      forceIncomplete: gradeMeta.forceIncomplete,
      forceIncompleteReason: gradeMeta.forceIncompleteReason,
      grade: gradeMeta.grade,
      score: gradeMeta.score,
      pointsPossible: gradeMeta.pointsPossible,
      submissionState: submission?.workflow_state || "",
      comments,
      comment: comments[0]?.comment || ""
    };
  } catch {
    return {};
  }
}

function canvasSubmissionGradeMeta(submission = {}) {
  const grade = String(submission?.grade ?? submission?.entered_grade ?? "").trim();
  const gradeLower = grade.toLowerCase();
  const rawScore = submission?.score ?? submission?.entered_score;
  const score = Number(rawScore);
  const pointsPossible = Number(submission?.assignment?.points_possible ?? submission?.points_possible);
  const hasScore = rawScore !== null && rawScore !== undefined && rawScore !== "" && Number.isFinite(score);
  const hasPositivePossible = Number.isFinite(pointsPossible) ? pointsPossible > 0 : true;
  const gradeSaysDash = /^[-–—]\s*(?:\/|$)/.test(gradeLower);
  const gradeSaysComplete = /\bcomplete\b/i.test(gradeLower) && !/\bincomplete\b/i.test(gradeLower);
  const scoreSaysZero = hasScore && score === 0 && hasPositivePossible && Boolean(submission?.graded_at || grade || submission?.workflow_state === "graded" || submission?.missing);
  const forceIncomplete = Boolean(scoreSaysZero || gradeSaysDash);
  return {
    forceIncomplete,
    forceIncompleteReason: scoreSaysZero ? "Canvas grade is 0" : gradeSaysDash ? "Canvas grade is -/points" : "",
    completedByGrade: Boolean(gradeSaysComplete || (hasScore && score > 0)),
    grade,
    score: hasScore ? score : null,
    pointsPossible: Number.isFinite(pointsPossible) ? pointsPossible : null
  };
}

async function normalizeCanvasAssignment(row, courseIdOverride = "") {
  const title = normalizeAssignmentTitle(row?.name || row?.title || "");
  const dueDate = parseDate(row?.due_at || row?.lock_at || row?.unlock_at || row?.todo_date);
  if (!title || !dueDate) return null;
  const courseIdRaw = String(courseIdOverride || row?.course_id || row?.context_code?.replace(/^course_/, "") || "").trim();
  if (!courseIdRaw) return null;
  const assignmentId = String(row?.id || stableId("canvas", title, dueDate)).trim();
  const submission = await fetchSubmissionStatus(courseIdRaw, assignmentId);
  return {
    id: `canvas-${courseIdRaw || "x"}-${assignmentId}`,
    title,
    dueDate: dueDate.toISOString(),
    estimatedMinutes: Math.max(10, Math.min(180, Number(row?.points_possible) ? Math.round(Number(row.points_possible) * 1.5) : 30)),
    source: "canvas",
    courseId: courseIdRaw ? `canvas-course-${courseIdRaw}` : undefined,
    externalKey: `canvas:${courseIdRaw || "x"}:${assignmentId}`,
    canvasUrl: absoluteCanvasUrl(row?.html_url || `/courses/${courseIdRaw}/assignments/${assignmentId}`),
    completed: submission.forceIncomplete ? false : Boolean(submission.completed),
    canvasForceIncomplete: Boolean(submission.forceIncomplete),
    forceIncompleteReason: submission.forceIncompleteReason || "",
    canvasGrade: submission.grade || "",
    canvasScore: submission.score,
    canvasPointsPossible: submission.pointsPossible,
    submissionState: submission.submissionState || "",
    comments: submission.comments || [],
    comment: submission.comment || ""
  };
}

async function extractDashboardCardTasks(cards) {
  const rows = [];
  for (const card of cards || []) {
    const courseIdRaw = String(card?.id || card?.course_id || "").trim();
    for (const item of card?.assignments || card?.todo || card?.items || []) {
      const normalized = await normalizeCanvasAssignment(item, courseIdRaw);
      if (normalized) rows.push(normalized);
    }
  }
  return rows;
}

async function scrapeCanvasApiTasks() {
  const rows = [];
  const todoRows = await fetchCanvasApiPages(`${window.location.origin}/api/v1/users/self/todo?per_page=100`);
  const plannerRows = await fetchCanvasApiPages(`${window.location.origin}/api/v1/planner/items?per_page=100`);
  for (const item of [...todoRows, ...plannerRows]) {
    const normalized = await normalizeCanvasApiTask(item);
    if (normalized) rows.push(normalized);
  }

  const cards = await fetchCanvasApiPages(`${window.location.origin}/api/v1/dashboard/dashboard_cards?per_page=100`);
  rows.push(...(await extractDashboardCardTasks(cards)));

  const courses = await fetchCanvasApiPages(`${window.location.origin}/api/v1/courses?enrollment_state=active&per_page=100`);
  for (const course of courses.slice(0, 30)) {
    if (!course?.id || course.access_restricted_by_date) continue;
    const assignments = await fetchCanvasApiPages(`${window.location.origin}/api/v1/courses/${course.id}/assignments?bucket=upcoming&per_page=100`);
    for (const assignment of assignments) {
      const normalized = await normalizeCanvasAssignment(assignment, String(course.id));
      if (normalized) rows.push(normalized);
    }
  }

  return rows;
}

function scrapeVisibleCanvasTasks() {
  const rows = [];
  const selectors = [
    ".planner-item",
    "[class*='PlannerItem']",
    "[class*='Planner__item']",
    "[class*='PlannerItem-styles']",
    ".todo-list li",
    "[data-testid*='todo']",
    "[data-testid*='planner']",
    "[data-testid*='assignment']",
    ".ig-row",
    ".assignment",
    "[class*='assignment']",
    "li",
    "tr"
  ];
  const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
  for (const node of nodes) {
    const row = canvasTaskFromNode(node);
    if (row) rows.push(row);
  }
  return rows;
}

function isCanvasAssignmentDetailHref(href) {
  return /\/courses\/\d+\/assignments\/\d+(?:[/?#]|$)/i.test(String(href || ""));
}

function isInsideCanvasDashboardCard(node) {
  return Boolean(node?.closest?.(".ic-DashboardCard, [class*='DashboardCard'], [data-testid='draggable-card']"));
}

function isInsideCanvasRecentFeedback(node) {
  return Boolean(node?.closest?.(".recent_feedback, [class*='recent_feedback'], .events_list.recent_feedback"));
}

function isCanvasDashboardCardActionLink(link) {
  const href = String(link?.getAttribute?.("href") || "");
  return /\/courses\/\d+\/(?:assignments|files|discussion_topics|announcements|modules|grades|pages|people|quizzes)\/?(?:[?#].*)?$/i.test(href)
    || Boolean(link?.closest?.(".ic-DashboardCard__action-container, [class*='DashboardCard__action']"));
}

function isIgnoredCanvasTaskRegion(node) {
  return isInsideCanvasDashboardCard(node) || isInsideCanvasRecentFeedback(node);
}

function scrapeCanvasAssignmentLinkTasks(root = document) {
  const rows = [];
  const links = Array.from(root.querySelectorAll([
    "a[href*='/courses/'][href*='/assignments/']",
    "a[href*='/assignments/']"
  ].join(",")));
  for (const link of links) {
    const href = link.getAttribute?.("href") || "";
    if (!isCanvasAssignmentDetailHref(href) || isCanvasDashboardCardActionLink(link) || isIgnoredCanvasTaskRegion(link)) continue;
    const row = canvasTaskFromNode(taskContainerForAssignmentLink(link));
    if (row) rows.push(row);
  }
  return rows;
}

function detectCanvasDashboardView() {
  const activeViewText = text(document.querySelector(
    "[aria-checked='true'], [aria-selected='true'], .ui-state-selected, .active, [class*='selected']"
  ));
  if (/\bcard view\b/i.test(activeViewText)) return "card";
  if (/\blist view\b/i.test(activeViewText)) return "list";
  if (document.querySelector(".ic-DashboardCard, [class*='DashboardCard'], [data-testid*='dashboard-card']")) return "card";
  if (document.querySelector(".planner-item, [class*='PlannerItem'], [class*='PlannerEmpty'], [class*='planner']")) return "list";
  return "unknown";
}

function canvasTaskFromNode(node) {
  if (!node) return null;
  if (isIgnoredCanvasTaskRegion(node)) return null;
  const titleNode = node.querySelector?.("a[href*='/assignments/'], a, .title, .ig-title, [data-testid*='title'], h2, h3") || node;
  const assignmentLink = titleNode.matches?.("a[href*='/assignments/']")
    ? titleNode
    : node.querySelector?.("a[href*='/assignments/']");
  const href = assignmentLink?.getAttribute?.("href") || titleNode.getAttribute?.("href") || "";
  if (!isCanvasAssignmentDetailHref(href)) return null;
  const courseMatch = href.match(/\/courses\/(\d+)/);
  const assignmentMatch = href.match(/\/assignments\/(\d+)/);
  const courseIdRaw = courseMatch?.[1] || "";
  if (!courseIdRaw || !assignmentMatch) return null;

  const title = normalizeAssignmentTitle(text(assignmentLink || titleNode));
  if (!title || title.length < 3 || /dashboard|calendar|inbox|account|recent feedback/i.test(title)) return null;
  const timeNode = node.querySelector?.("time, [datetime], .due, .date, .todo-date, [class*='Due'], [class*='due'], [class*='date']");
  const date = parseDate(timeNode?.getAttribute?.("datetime")) || parseDateFromText(text(timeNode) || text(node));
  if (!date) return null;

  const assignmentId = assignmentMatch?.[1] || stableId("canvas", title, date);
  return {
    id: `canvas-${courseIdRaw}-${assignmentId}`,
    title,
    dueDate: date.toISOString(),
    estimatedMinutes: 30,
    source: "canvas",
    courseId: `canvas-course-${courseIdRaw}`,
    externalKey: assignmentMatch ? `canvas:${courseIdRaw}:${assignmentId}` : stableId("canvas", title, date),
    canvasUrl: absoluteCanvasUrl(href || `/courses/${courseIdRaw}/assignments/${assignmentId}`)
  };
}

function taskContainerForAssignmentLink(link) {
  let current = link;
  for (let depth = 0; current && depth < 8; depth++) {
    const label = text(current);
    if (label.length > 8 && label.length < 900 && parseDateFromText(label)) return current;
    current = current.parentElement;
  }
  return link.closest("li, tr, [class*='ToDo'], [class*='todo'], [class*='PlannerItem'], [class*='assignment']") || link.parentElement;
}

function findCanvasDashboardTodoScopes() {
  const scopes = [];
  Array.from(document.querySelectorAll([
    ".Sidebar__TodoListContainer",
    "[data-testid='ToDoSidebar']",
    "[data-testid*='todo-sidebar']",
    "[class*='TodoListContainer']",
    "[class*='ToDoSidebar']"
  ].join(","))).forEach(scope => {
    if (scope.querySelector?.("a[href*='/assignments/']") && !scopes.includes(scope)) scopes.push(scope);
  });
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, [role='heading']"));
  for (const heading of headings) {
    const label = text(heading);
    if (!/^(to do|coming up)$/i.test(label)) continue;
    let scope = heading.closest("aside, section, [class*='Sidebar'], [class*='right-side'], [class*='right_side']");
    let current = heading.parentElement;
    while (!scope && current && current !== document.body) {
      if (current.querySelector?.("a[href*='/courses/'][href*='/assignments/']")) scope = current;
      current = current.parentElement;
    }
    if (scope && !scopes.includes(scope)) scopes.push(scope);
  }
  if (!scopes.length) Array.from(document.querySelectorAll("aside, #right-side, .right-side-wrapper, [class*='ToDo'], [class*='todo']")).forEach(scope => {
    if (scope.querySelector?.("a[href*='/assignments/']") && !scopes.includes(scope)) scopes.push(scope);
  });
  return scopes;
}

function scrapeCanvasDashboardCardTasks() {
  const scopes = findCanvasDashboardTodoScopes();
  const rows = [];
  for (const scope of scopes) {
    rows.push(...scrapeCanvasAssignmentLinkTasks(scope));
  }
  return rows;
}

async function scrapeCanvasTasks(canvasDashboardView = detectCanvasDashboardView()) {
  const apiRows = await scrapeCanvasApiTasks();
  const visibleRows = canvasDashboardView === "card"
    ? scrapeCanvasDashboardCardTasks()
    : [...scrapeCanvasAssignmentLinkTasks(), ...scrapeVisibleCanvasTasks(), ...scrapeCanvasDashboardCardTasks()];
  return dedupe([...apiRows, ...visibleRows]);
}

function getTeamSnapPageMeta() {
  const teamName = text(document.querySelector("[class*='team'] h1, h1, .team-name, [data-testid*='team']")) || "Team";
  const teamId = teamSnapTeamIdFromUrl(window.location.href);
  const url = normalizeTeamSnapUrl(window.location.href);
  return { url, actualUrl: window.location.href, teamId, teamName, isSchedulePage: isTeamSnapScheduleUrl(window.location.href) };
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

function normalizeTeamSnapUrl(url) {
  try {
    const parsed = new URL(url);
    const teamId = teamSnapTeamIdFromUrl(parsed.toString());
    if (parsed.hostname.endsWith("teamsnap.com") && teamId) return `https://go.teamsnap.com/${teamId}/schedule?mode=list&pageSize=30`;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function teamSnapRowCells(row) {
  return Array.from(row.querySelectorAll(".Panel-cell[role='cell']")).map(cell => text(cell));
}

function teamSnapCellText(cells, index) {
  return String(cells[index] || "").replace(/\s+/g, " ").trim();
}

function parseTeamSnapDateTime(dateText, timeText) {
  const cleanTime = String(timeText || "").trim();
  const timeForDate = /^TBD$/i.test(cleanTime) || !cleanTime ? "11:59 PM" : cleanTime.split(/\s*-\s*/)[0].trim();
  return parseDate(`${dateText} ${timeForDate}`) || parseDate(dateText);
}

function teamSnapDurationMinutes(timeText, fallback = 60) {
  const parts = String(timeText || "").split(/\s*-\s*/);
  if (parts.length < 2 || /^TBD$/i.test(timeText)) return fallback;
  const start = parseDate(`Jan 1, 2026 ${parts[0].trim()}`);
  const end = parseDate(`Jan 1, 2026 ${parts[1].trim()}`);
  if (!start || !end) return fallback;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return minutes > 0 ? minutes : fallback;
}

function scrapeTeamSnapTasks(meta = getTeamSnapPageMeta()) {
  const rows = [];
  const teamName = meta.teamName || "Team";
  const panelRows = Array.from(document.querySelectorAll(".Panel-row.Panel-row--withCells"));
  for (const [index, row] of panelRows.entries()) {
    if (index === 0) continue;
    const rowText = text(row);
    if (/driver/i.test(rowText)) continue;
    const cells = teamSnapRowCells(row);
    if (cells.length < 3) continue;
    const titleLink = row.querySelector("[data-testid^='event-title-'], a[href*='/schedule/view_']");
    const titleText = text(titleLink) || teamSnapCellText(cells, 0);
    const dateText = teamSnapCellText(cells, 1);
    const timeText = teamSnapCellText(cells, 2) || "TBD";
    const location = teamSnapCellText(cells, 3);
    const locationDetails = cells.slice(4).join(" ");
    const date = parseTeamSnapDateTime(dateText, timeText);
    if (!titleText || !date) continue;
    const link = titleLink?.href || row.querySelector?.("a[href]")?.href || meta.url;
    const id = stableId("teamsnap", `${meta.teamId || teamName}-${titleText}`, date);
    rows.push({
      id,
      title: titleText,
      dueDate: date.toISOString(),
      estimatedMinutes: teamSnapDurationMinutes(timeText, 60),
      source: "teamsnap",
      courseId: "course-sports",
      completed: false,
      location,
      description: locationDetails,
      eventUrl: link,
      externalKey: `teamsnap:${meta.teamId || teamName}:${id}`
    });
  }
  return dedupe(rows);
}

function scrapeMembeanTasks() {
  const pageText = text(document.body || document.documentElement || document.body);
  if (isMembeanLoginOrUnreadablePage(pageText)) return [];

  let completedSessions = 0;
  let requiredSessions = 3;

  // Primary strategy: Find the "Training Expectations" panel
  let panel = Array.from(document.querySelectorAll("section, article, div")).find(el => /training expectations|total minutes of training|days trained had 10\+ min|days with 10\+ minutes/i.test(text(el)));
  
  if (!panel) {
    // Fallback: look for a heading with "Training Expectations" or "Membean"
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, .panel h2, .panel h3"));
    for (const h of headings) {
      const htxt = text(h);
      if (/training expectations/i.test(htxt)) { 
        panel = h.closest("article, section, div"); 
        break; 
      }
    }
  }

  if (panel) {
    const pText = text(panel);
    
    // Extract required days: "3 days with 10+ minutes of training"
    const reqDaysMatch = pText.match(/(\d+)\s*days?\s*(?:with)?\s*10\+\s*minutes?/i);
    if (reqDaysMatch) requiredSessions = Number(reqDaysMatch[1]);

    // Primary: Extract missing days from "Train X more day(s) for 10+ min"
    // This handles grammar variations: "Train 1 more days" or "Train 2 more days"
    const missingDaysMatch = pText.match(/Train\s+(\d+)\s+more\s+days?\s+for\s+10\+\s*min/i);
    if (missingDaysMatch) {
      const missingDays = Number(missingDaysMatch[1]);
      completedSessions = Math.max(0, requiredSessions - missingDays);
    } else {
      // Fallback 1: Fractional style "1/3 days trained had 10+ min"
      const fracMatch = pText.match(/(\d+)\s*\/\s*(\d+)\s*days?\s*(?:trained|had)/i);
      if (fracMatch) {
        completedSessions = Number(fracMatch[1]);
        if (!reqDaysMatch) requiredSessions = Number(fracMatch[2]);
      } else {
        // Fallback 2: Minutes-based "Train X more minutes" + "Y total minutes"
        const missingMinutesMatch = pText.match(/Train\s+(\d+)\s+more\s+minutes?/i);
        const totalMinutesMatch = pText.match(/(\d+)\s*total\s*minutes?/i);
        if (missingMinutesMatch) {
          const missingMinutes = Number(missingMinutesMatch[1]);
          const totalMinutes = totalMinutesMatch ? Number(totalMinutesMatch[1]) : (requiredSessions * 10);
          const completedMinutes = Math.max(0, totalMinutes - missingMinutes);
          completedSessions = Math.min(requiredSessions, Math.floor(completedMinutes / 10));
        }
      }
    }
  } else {
    // Last resort: Check for explicit dashboard indicators like "3 days down" or "goals met"
    const dayDownMatch = pageText.match(/(\d+)\s*days?\s*(?:down|complete|in a row)/i);
    const goalsMetMatch = pageText.match(/(?:all\s+)?goals?\s*(?:met|complete|achieved)/i) || pageText.match(/you.*have.*completed/i);

    if (dayDownMatch) {
      completedSessions = Math.min(requiredSessions, Number(dayDownMatch[1] || 0));
    } else if (goalsMetMatch) {
      completedSessions = requiredSessions;
    }
  }

  completedSessions = Math.max(0, Math.min(requiredSessions, Number(completedSessions) || 0));
  const missingSessions = Math.max(0, requiredSessions - completedSessions);
  const due = nextSaturdayMorning();

  // Return a progress row, not a homework task. Canvas usually already has the actual Membean assignment.
  return [{
    id: `membean-weekly-${weekKey(new Date())}`,
    kind: "progress",
    title: "Membean weekly progress",
    dueDate: due.toISOString(),
    estimatedMinutes: 0,
    source: "membean",
    completed: missingSessions <= 0,
    externalKey: `membean:weekly:${weekKey(new Date())}`,
    progress: { completedSessions, requiredSessions, minutesPerSession: 10 }
  }];
}

function isMembeanLoginOrUnreadablePage(pageText) {
  const path = String(window.location.pathname || "");
  if (/\/(?:login|signin|sign_in|users\/sign_in)\b/i.test(path)) return true;
  const hasPassword = Boolean(document.querySelector("input[type='password']"));
  const hasTrainingSignals = /training expectations|total minutes of training|days trained had 10\+ min|days with 10\+ minutes|train\s+\d+\s+more/i.test(pageText);
  return hasPassword && !hasTrainingSignals;
}

function inferMembeanSessions(minutes) {
  if (!minutes.length) return 0;
  // Count sessions that are 10+ minutes, or estimate from total minutes
  const completeSessions = minutes.filter(value => value >= 10).length;
  if (completeSessions > 0) return Math.min(3, completeSessions);
  const totalMinutes = minutes.reduce((sum, val) => sum + val, 0);
  return Math.min(3, Math.floor(totalMinutes / 10));
}

function nextSaturdayMorning() {
  const date = new Date();
  const daysUntilSaturday = (6 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysUntilSaturday);
  date.setHours(8, 0, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 7);
  return date;
}

function weekKey(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dedupe(rows) {
  const byIdentity = new Map();
  const aliasToIdentity = new Map();
  for (const row of rows) {
    if (!row?.title) continue;
    const cleaned = { ...row, title: normalizeAssignmentTitle(row.title) };
    if (String(cleaned.source || "").toLowerCase() === "canvas" && !cleaned.courseId) continue;
    if (String(cleaned.source || "").toLowerCase() === "teamsnap" && /driver/i.test(`${cleaned.title || ""} ${cleaned.description || ""} ${cleaned.location || ""}`)) continue;
    const aliases = rowAliases(cleaned);
    const identity = aliases.map(alias => aliasToIdentity.get(alias)).find(Boolean) || aliases[0];
    const current = byIdentity.get(identity);
    const keeper = !current || rowQuality(cleaned) > rowQuality(current) ? cleaned : current;
    byIdentity.set(identity, keeper);
    aliases.forEach(alias => aliasToIdentity.set(alias, identity));
  }
  return Array.from(byIdentity.values()).slice(0, 100);
}

function dedupeCourses(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.id || "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10000);
}
