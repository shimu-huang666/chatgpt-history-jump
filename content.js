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
  let lastQuestionSignature = "";
  let lastRenderSignature = "";
  let lastObservedSignature = "";
  let lastKnownHref = location.href;
  let urlWatcherInstalled = false;
  const expandedQuestionIds = new Set();

  function syncToggleState(root, collapsed) {
    const toggleBtn = root?.querySelector(`#${TOGGLE_ID}`);
    if (!toggleBtn) return;

    root.classList.toggle("is-collapsed", collapsed);
    toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggleBtn.setAttribute("aria-label", collapsed ? "展开目录" : "收起目录");
    toggleBtn.setAttribute("title", collapsed ? "展开目录" : "收起目录");
    toggleBtn.textContent = collapsed ? "‹" : "›";
  }

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
      <button id="${TOGGLE_ID}" type="button" aria-expanded="true" aria-label="收起目录" title="收起目录">›</button>
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
      const collapsed = panel.classList.contains("collapsed");
      syncToggleState(root, collapsed);
      await saveCollapsed(collapsed);
    });

    loadCollapsed().then((collapsed) => {
      const panel = root.querySelector(`#${PANEL_ID}`);
      if (collapsed && panel) panel.classList.add("collapsed");
      syncToggleState(root, !!collapsed);
    });

    syncToggleState(root, false);

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

  function buildQuestionSignature(items) {
    return items
      .map((item) => `${item.id}|${item.text}|${item.imageCount}|${item.isLong ? 1 : 0}`)
      .join("||");
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

    const nextSignature = buildQuestionSignature(results);
    const changed = nextSignature !== lastQuestionSignature;
    questionItems = results;
    lastQuestionSignature = nextSignature;

    if (!questionItems.some((item) => item.id === activeQuestionId)) {
      activeQuestionId = questionItems[0]?.id || null;
    }

    updateCount();
    return changed;
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

  function jumpToQuestion(item) {
    if (!item?.element) return;
    activeQuestionId = item.id;
    updateActiveListState();
    item.element.scrollIntoView({ behavior: "auto", block: "center" });
  }

  function updateActiveListState() {
    const root = document.getElementById(EXT_ID);
    if (!root) return;

    root.querySelectorAll(".cghj-item").forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      card.classList.toggle("active", card.dataset.questionId === activeQuestionId);
    });
  }

  function renderList(force = false) {
    const root = ensureRoot();
    const list = root.querySelector(`#${LIST_ID}`);
    if (!list) return;

    const items = getFilteredItems();
    const keyword = root.querySelector(`#${SEARCH_ID}`)?.value?.trim().toLowerCase() || "";
    const expandedState = [...expandedQuestionIds].sort().join("|");
    const renderSignature = [
      keyword,
      activeQuestionId || "",
      expandedState,
      ...items.map((item) => item.id),
    ].join("::");

    if (!force && renderSignature === lastRenderSignature) return;
    lastRenderSignature = renderSignature;

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
      card.dataset.questionId = item.id;

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "cghj-main";
      mainBtn.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        jumpToQuestion(item);
      });
      mainBtn.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        jumpToQuestion(item);
      });

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
    const observedSignature = questionItems.map((item) => item.id).join("|");
    if (activeIo && observedSignature === lastObservedSignature) return;

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
          updateActiveListState();
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

    lastObservedSignature = observedSignature;
  }

  const refreshAll = debounce(() => {
    ensureRoot();
    const changed = scanQuestions();

    if (changed) {
      renderList(true);
      rebuildIntersectionObserver();
      return;
    }

    renderList();
  }, 250);

  function isRelevantMutationNode(node) {
    if (!(node instanceof HTMLElement)) return false;

    const root = document.getElementById(EXT_ID);
    if (root?.contains(node)) return false;
    if (node.closest(`#${EXT_ID}`)) return false;

    return !!(
      node.matches("[data-message-author-role]") ||
      node.querySelector?.("[data-message-author-role]") ||
      node.matches("main, article") ||
      node.closest("main, article")
    );
  }

  function shouldRefreshFromMutations(records) {
    for (const record of records) {
      const target = record.target;
      const root = document.getElementById(EXT_ID);

      if (target instanceof HTMLElement && root?.contains(target)) {
        continue;
      }

      for (const node of record.addedNodes) {
        if (isRelevantMutationNode(node)) return true;
      }

      for (const node of record.removedNodes) {
        if (isRelevantMutationNode(node)) return true;
      }
    }

    return false;
  }

  function installPageObserver() {
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }

    pageObserver = new MutationObserver((records) => {
      if (!shouldRefreshFromMutations(records)) return;
      refreshAll();
    });

    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
  }

  function handleUrlChange() {
    if (location.href === lastKnownHref) return;
    lastKnownHref = location.href;
    lastQuestionSignature = "";
    lastRenderSignature = "";
    lastObservedSignature = "";

    setTimeout(() => {
      refreshAll();
    }, 300);
  }

  function installUrlWatcher() {
    if (urlWatcherInstalled) return;
    urlWatcherInstalled = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      handleUrlChange();
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      handleUrlChange();
      return result;
    };

    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
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
