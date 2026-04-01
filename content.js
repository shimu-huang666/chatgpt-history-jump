(() => {
  "use strict";

  const EXT_ID = "chatgpt-history-jump-root";
  const PANEL_ID = "chatgpt-history-jump-panel";
  const LIST_ID = "chatgpt-history-jump-list";
  const SEARCH_ID = "chatgpt-history-jump-search";
  const TOGGLE_ID = "chatgpt-history-jump-toggle";
  const LONG_TEXT_THRESHOLD = 72;
  const PREVIEW_TEXT_LIMIT = 64;

  let questionItems = [];
  let activeQuestionId = null;
  let pageObserver = null;
  let activeIo = null;
  let urlWatcher = null;
  const expandedQuestionIds = new Set();

  function debounce(fn, delay = 300) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fn.apply(this, args);
      }, delay);
    };
  }

  function getConversationKey() {
    return location.pathname || "default";
  }

  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function saveCollapsed(collapsed) {
    if (!isContextValid()) return;
    try {
      await chrome.storage.local.set({
        [`collapsed:${getConversationKey()}`]: collapsed,
      });
    } catch (err) {
      console.warn("[CGHJ] saveCollapsed failed:", err);
    }
  }

  async function loadCollapsed() {
    if (!isContextValid()) return false;
    try {
      const key = `collapsed:${getConversationKey()}`;
      const res = await chrome.storage.local.get([key]);
      return !!res[key];
    } catch (err) {
      console.warn("[CGHJ] loadCollapsed failed:", err);
      return false;
    }
  }

  function normalizeQuestionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^You said:\s*/i, "")
      .trim();
  }

  function shorten(text, max = 48) {
    if (!text) return "";
    return text.length <= max ? text : text.slice(0, max) + "...";
  }

  function shouldKeepAsQuestion(text, imageCount = 0) {
    if (imageCount > 0) return true;
    if (!text) return false;
    if (text.trim().length <= 3) return false;
    return true;
  }

  function getMessageImageCount(el) {
    if (!(el instanceof HTMLElement)) return 0;

    return [...el.querySelectorAll("img")].filter((img) => {
      if (!(img instanceof HTMLImageElement)) return false;

      const rect = img.getBoundingClientRect();
      const width = rect.width || img.naturalWidth || img.width || 0;
      const height = rect.height || img.naturalHeight || img.height || 0;
      const alt = (img.getAttribute("alt") || "").toLowerCase();

      if (width >= 28 || height >= 28) return true;
      return /upload|image|photo|picture|attachment|preview/.test(alt);
    }).length;
  }

  function ensureRoot() {
    let root = document.getElementById(EXT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = EXT_ID;
    root.innerHTML = `
      <button id="${TOGGLE_ID}" title="折叠/展开目录">≡</button>
      <aside id="${PANEL_ID}">
        <div class="cghj-header">
          <div class="cghj-title">历史问题</div>
          <button type="button" class="cghj-refresh" title="刷新">↻</button>
        </div>
        <input id="${SEARCH_ID}" type="text" placeholder="搜索历史问题..." />
        <div class="cghj-meta">
          <span class="cghj-count">0</span>
          <span>条</span>
        </div>
        <div id="${LIST_ID}"></div>
      </aside>
    `;

    document.body.appendChild(root);

    const refreshBtn = root.querySelector(".cghj-refresh");
    const searchInput = root.querySelector(`#${SEARCH_ID}`);
    const toggleBtn = root.querySelector(`#${TOGGLE_ID}`);

    refreshBtn?.addEventListener("click", () => {
      refreshAll();
    });

    searchInput?.addEventListener("input", () => {
      renderList();
    });

    toggleBtn?.addEventListener("click", async () => {
      const panel = root.querySelector(`#${PANEL_ID}`);
      if (!panel) return;
      panel.classList.toggle("collapsed");
      await saveCollapsed(panel.classList.contains("collapsed"));
    });

    loadCollapsed().then((collapsed) => {
      const panel = root.querySelector(`#${PANEL_ID}`);
      if (collapsed && panel) panel.classList.add("collapsed");
    });

    return root;
  }

  function getMessageTextFromContainer(el) {
    if (!(el instanceof HTMLElement)) return "";

    const candidates = [
      el.querySelector(".whitespace-pre-wrap"),
      el.querySelector("[class*='markdown']"),
      el.querySelector("[class*='prose']"),
      el,
    ];

    for (const node of candidates) {
      const text = node?.innerText?.trim();
      if (text) return text;
    }

    return "";
  }

  function findUserMessageContainers() {
    const results = [];
    const seen = new Set();

    const selectors = [
      "[data-message-author-role='user']",
      "main [data-message-author-role='user']",
      "article [data-message-author-role='user']",
      "[data-testid^='conversation-turn-'] [data-message-author-role='user']",
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        if (seen.has(el)) return;
        seen.add(el);
        results.push(el);
      });
    });

    return results;
  }

  function assignAnchor(el, idx) {
    const id = `cghj-q-${idx + 1}`;
    el.dataset.cghjQuestionId = id;
    return id;
  }

  function updateCount() {
    const root = ensureRoot();
    const countEl = root.querySelector(".cghj-count");
    if (countEl) countEl.textContent = String(questionItems.length);
  }

  function scanQuestions() {
    const containers = findUserMessageContainers();
    const results = [];
    const seenText = new Set();

    containers.forEach((el, idx) => {
      const imageCount = getMessageImageCount(el);
      const rawText = getMessageTextFromContainer(el);
      const text = normalizeQuestionText(rawText) || (imageCount > 0 ? "[图片问题]" : "");

      if (!shouldKeepAsQuestion(text, imageCount)) return;

      const dedupeKey = `${text.slice(0, 160)}|img:${imageCount > 0 ? 1 : 0}`;
      if (seenText.has(dedupeKey)) return;
      seenText.add(dedupeKey);

      const id = assignAnchor(el, idx);
      const isLong = text.length > LONG_TEXT_THRESHOLD;
      results.push({
        id,
        text,
        short: shorten(text, PREVIEW_TEXT_LIMIT),
        element: el,
        index: results.length + 1,
        imageCount,
        hasImage: imageCount > 0,
        isLong,
      });
    });

    questionItems = results;

    if (!questionItems.some((item) => item.id === activeQuestionId)) {
      activeQuestionId = questionItems[0]?.id || null;
    }

    updateCount();
  }

  function getFilteredItems() {
    const root = ensureRoot();
    const input = root.querySelector(`#${SEARCH_ID}`);
    const keyword = input?.value?.trim().toLowerCase() || "";

    if (!keyword) return questionItems;

    return questionItems.filter((item) =>
      item.text.toLowerCase().includes(keyword)
    );
  }

  function flashElement(el) {
    if (!(el instanceof HTMLElement)) return;
    el.classList.remove("cghj-flash");
    void el.offsetWidth;
    el.classList.add("cghj-flash");
    setTimeout(() => {
      el.classList.remove("cghj-flash");
    }, 1200);
  }

  function jumpToQuestion(item) {
    if (!item?.element) return;
    item.element.scrollIntoView({ behavior: "smooth", block: "center" });
    activeQuestionId = item.id;
    renderList();
    flashElement(item.element);
  }

  function renderList() {
    const root = ensureRoot();
    const list = root.querySelector(`#${LIST_ID}`);
    if (!list) return;

    const items = getFilteredItems();

    if (!items.length) {
      list.innerHTML = `<div class="cghj-empty">没有匹配的问题</div>`;
      return;
    }

    list.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item) => {
      const isExpanded = expandedQuestionIds.has(item.id);
      const card = document.createElement("div");
      card.className = `cghj-item${item.id === activeQuestionId ? " active" : ""}`;

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "cghj-main";
      mainBtn.addEventListener("click", () => jumpToQuestion(item));

      const indexEl = document.createElement("span");
      indexEl.className = "cghj-index";
      indexEl.textContent = String(item.index);

      const contentEl = document.createElement("span");
      contentEl.className = "cghj-content";

      const textEl = document.createElement("span");
      textEl.className = `cghj-text${isExpanded ? " expanded" : ""}`;
      textEl.title = item.text;
      textEl.textContent = isExpanded ? item.text : item.short;

      contentEl.appendChild(textEl);

      if (item.hasImage) {
        const badgeEl = document.createElement("span");
        badgeEl.className = "cghj-badge";
        badgeEl.textContent = item.imageCount > 1 ? `含${item.imageCount}图` : "含图";
        contentEl.appendChild(badgeEl);
      }

      mainBtn.append(indexEl, contentEl);
      card.appendChild(mainBtn);

      if (item.isLong) {
        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = `cghj-expand${isExpanded ? " expanded" : ""}`;
        expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
        expandBtn.setAttribute("aria-label", isExpanded ? "收起问题" : "展开问题");
        expandBtn.textContent = isExpanded ? "∧" : "∨";
        expandBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expandedQuestionIds.has(item.id)) {
            expandedQuestionIds.delete(item.id);
          } else {
            expandedQuestionIds.add(item.id);
          }
          renderList();
        });
        card.appendChild(expandBtn);
      }

      frag.appendChild(card);
    });

    list.appendChild(frag);
  }

  function rebuildIntersectionObserver() {
    if (activeIo) {
      activeIo.disconnect();
      activeIo = null;
    }

    activeIo = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (!visible.length) return;

        const target = visible[0].target;
        const id = target?.dataset?.cghjQuestionId || null;

        if (id && id !== activeQuestionId) {
          activeQuestionId = id;
          renderList();
        }
      },
      {
        root: null,
        threshold: [0.25, 0.5, 0.75],
      }
    );

    questionItems.forEach((item) => {
      if (item.element instanceof HTMLElement) {
        activeIo.observe(item.element);
      }
    });
  }

  const refreshAll = debounce(() => {
    ensureRoot();
    scanQuestions();
    renderList();
    rebuildIntersectionObserver();
  }, 250);

  function installPageObserver() {
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }

    pageObserver = new MutationObserver(() => {
      refreshAll();
    });

    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
  }

  function installUrlWatcher() {
    if (urlWatcher) clearInterval(urlWatcher);

    let lastHref = location.href;
    urlWatcher = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        setTimeout(() => {
          refreshAll();
        }, 300);
      }
    }, 800);
  }

  function waitForAppReady() {
    const tryInit = () => {
      const main = document.querySelector("main");
      if (!main) {
        setTimeout(tryInit, 500);
        return;
      }

      ensureRoot();
      refreshAll();
      installPageObserver();
      installUrlWatcher();
    };

    tryInit();
  }

  waitForAppReady();
})();
