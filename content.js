(() => {
  "use strict";

  const EXT_ID = "chatgpt-history-jump-root";
  const PANEL_ID = "chatgpt-history-jump-panel";
  const LIST_ID = "chatgpt-history-jump-list";
  const SEARCH_ID = "chatgpt-history-jump-search";
  const TOGGLE_ID = "chatgpt-history-jump-toggle";
  const SETTINGS_ID = "chatgpt-history-jump-settings";
  const SETTINGS_KEY = "settings:v1";
  const SUPPORT_QR_PATH = "store-assets/wechat-support-author.jpg";
  const OFFICIAL_REPO_URL = "https://github.com/shimu-huang666/chatgpt-history-jump";
  const LONG_TEXT_THRESHOLD = 72;
  const PREVIEW_TEXT_LIMIT = 64;
  const SCROLL_TOP_OFFSET = 20;
  const LOCATE_SCAN_DELAY = 260;
  const LOCATE_MAX_STEPS = 350;
  const HEADING_WARMUP_LIMIT = 12;
  const HEADING_WARMUP_DELAY = 160;
  const DEFAULT_SETTINGS = {
    side: "right",
    width: "standard",
    density: "comfortable",
    theme: "system",
    stickyExpanded: true,
  };

  let questionItems = [];
  let activeQuestionId = null;
  let pageObserver = null;
  let activeIo = null;
  let lastQuestionSignature = "";
  let lastRenderSignature = "";
  let lastKnownHref = location.href;
  let activeConversationKey = getConversationKey();
  let conversationSwitchReadyAt = 0;
  let urlWatcherInstalled = false;
  let userSettings = { ...DEFAULT_SETTINGS };
  let nextQuestionIndex = 1;
  let locatingQuestionId = null;
  let headingWarmupTimer = null;
  const expandedQuestionIds = new Set();
  const expandedReplyHeadingIds = new Set();
  const expandedChildHeadingIds = new Set();
  const cachedReplyHeadingMap = new Map();
  const seenQuestionMap = new Map();

  function normalizeSettings(settings) {
    const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (!["left", "right"].includes(next.side)) next.side = DEFAULT_SETTINGS.side;
    if (!["narrow", "standard", "wide"].includes(next.width)) next.width = DEFAULT_SETTINGS.width;
    if (!["comfortable", "compact"].includes(next.density)) next.density = DEFAULT_SETTINGS.density;
    if (!["system", "light", "dark"].includes(next.theme)) next.theme = DEFAULT_SETTINGS.theme;
    if (typeof next.stickyExpanded !== "boolean") next.stickyExpanded = DEFAULT_SETTINGS.stickyExpanded;
    return next;
  }

  function applySettings(root) {
    if (!root) return;
    root.classList.toggle("cghj-side-left", userSettings.side === "left");
    root.classList.toggle("cghj-side-right", userSettings.side !== "left");
    root.classList.toggle("cghj-width-narrow", userSettings.width === "narrow");
    root.classList.toggle("cghj-width-standard", userSettings.width === "standard");
    root.classList.toggle("cghj-width-wide", userSettings.width === "wide");
    root.classList.toggle("cghj-density-compact", userSettings.density === "compact");
    root.classList.toggle("cghj-theme-system", userSettings.theme === "system");
    root.classList.toggle("cghj-theme-light", userSettings.theme === "light");
    root.classList.toggle("cghj-theme-dark", userSettings.theme === "dark");
  }

  function syncToggleState(root, collapsed) {
    const toggleBtn = root?.querySelector(`#${TOGGLE_ID}`);
    if (!toggleBtn) return;

    root.classList.toggle("is-collapsed", collapsed);
    toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggleBtn.setAttribute("aria-label", collapsed ? "\u5c55\u5f00\u76ee\u5f55" : "\u6536\u8d77\u76ee\u5f55");
    toggleBtn.setAttribute("title", collapsed ? "\u5c55\u5f00\u76ee\u5f55" : "\u6536\u8d77\u76ee\u5f55");
    toggleBtn.textContent = collapsed ? "<" : ">";
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

  function resetConversationState(nextKey = getConversationKey(), deferScan = false) {
    activeConversationKey = nextKey;
    lastKnownHref = location.href;
    conversationSwitchReadyAt = deferScan ? Date.now() + 900 : 0;
    lastQuestionSignature = "";
    lastRenderSignature = "";
    activeQuestionId = null;
    questionItems = [];
    nextQuestionIndex = 1;
    expandedQuestionIds.clear();
    expandedReplyHeadingIds.clear();
    expandedChildHeadingIds.clear();
    cachedReplyHeadingMap.clear();
    seenQuestionMap.clear();
    cancelHeadingWarmup();
    renderList(true);
  }

  function ensureConversationState() {
    const key = getConversationKey();
    if (key === activeConversationKey) return true;
    resetConversationState(key, true);
    return false;
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

  async function saveSettings(settings) {
    userSettings = normalizeSettings(settings);
    applySettings(document.getElementById(EXT_ID));
    if (!isContextValid()) return;
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: userSettings });
    } catch (err) {
      console.warn("[CGHJ] saveSettings failed:", err);
    }
  }

  async function loadSettings() {
    if (!isContextValid()) return { ...DEFAULT_SETTINGS };
    try {
      const res = await chrome.storage.local.get([SETTINGS_KEY]);
      return normalizeSettings(res[SETTINGS_KEY]);
    } catch (err) {
      console.warn("[CGHJ] loadSettings failed:", err);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getElementText(el) {
    if (!(el instanceof HTMLElement)) return "";
    const text = el.innerText;
    if (text && text.trim()) return text;
    return el.textContent || "";
  }

  function normalizeQuestionText(text) {
    return normalizeText(String(text || "").replace(/^You said:\s*/i, ""));
  }

  function shorten(text, max = 48) {
    if (!text) return "";
    return text.length <= max ? text : `${text.slice(0, max)}...`;
  }

  function shouldKeepAsQuestion(text, imageCount = 0) {
    if (imageCount > 0) return true;
    if (!text) return false;
    return text.trim().length > 0;
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

  function syncSettingsControls(root) {
    root?.querySelectorAll("[data-cghj-setting]").forEach((control) => {
      const key = control.getAttribute("data-cghj-setting");
      if (!key || !(key in userSettings)) return;
      if (control instanceof HTMLInputElement && control.type === "checkbox") {
        control.checked = userSettings[key];
      } else {
        control.value = userSettings[key];
      }
    });
  }

  function ensureRoot() {
    let root = document.getElementById(EXT_ID);
    if (root) return root;

    const supportQrUrl = chrome.runtime.getURL(SUPPORT_QR_PATH);

    root = document.createElement("div");
    root.id = EXT_ID;
    root.innerHTML = `
      <aside id="${PANEL_ID}">
        <div class="cghj-header">
          <div class="cghj-title">历史对话</div>
          <div class="cghj-actions">
            <button type="button" class="cghj-settings-toggle" aria-expanded="false" aria-controls="${SETTINGS_ID}" title="\u8bbe\u7f6e">&#9881;</button>
            <button type="button" class="cghj-refresh" title="\u5237\u65b0"><span class="cghj-refresh-icon">&#8635;</span></button>
          </div>
        </div>
        <div id="${SETTINGS_ID}" class="cghj-settings" hidden>
          <label class="cghj-setting-row">
            <span>\u4f4d\u7f6e</span>
            <select data-cghj-setting="side">
              <option value="right">\u53f3\u4fa7</option>
              <option value="left">\u5de6\u4fa7</option>
            </select>
          </label>
          <label class="cghj-setting-row">
            <span>\u5bbd\u5ea6</span>
            <select data-cghj-setting="width">
              <option value="narrow">\u7d27\u51d1</option>
              <option value="standard">\u6807\u51c6</option>
              <option value="wide">\u5bbd\u677e</option>
            </select>
          </label>
          <label class="cghj-setting-row">
            <span>\u5bc6\u5ea6</span>
            <select data-cghj-setting="density">
              <option value="comfortable">\u8212\u9002</option>
              <option value="compact">\u7d27\u51d1</option>
            </select>
          </label>
          <label class="cghj-setting-row">
            <span>\u4e3b\u9898</span>
            <select data-cghj-setting="theme">
              <option value="system">\u8ddf\u968f\u7cfb\u7edf</option>
              <option value="light">\u6d45\u8272</option>
              <option value="dark">\u6df1\u8272</option>
            </select>
          </label>
          <label class="cghj-setting-row">
            <span>\u5c55\u5f00\u9501\u5b9a</span>
            <input type="checkbox" data-cghj-setting="stickyExpanded" />
          </label>
          <div class="cghj-author">
            <div class="cghj-author-line">\u539f\u521b\u4f5c\u8005\uff1a<span>\u65f6\u6155</span></div>
          </div>
          <div class="cghj-support">
            <button type="button" class="cghj-support-toggle" aria-expanded="false">\u652f\u6301\u4f5c\u8005</button>
            <div class="cghj-support-panel" hidden>
              <img class="cghj-support-qr" src="${supportQrUrl}" alt="\u5fae\u4fe1\u652f\u4ed8" loading="lazy" />
            </div>
            <button type="button" class="cghj-repo-link">\u5b98\u65b9\u4ed3\u5e93</button>
          </div>
        </div>
        <input id="${SEARCH_ID}" type="text" placeholder="搜索历史对话..." />
        <div class="cghj-meta">
          <span class="cghj-count">0</span>
          <span>\u6761</span>
        </div>
        <div id="${LIST_ID}"></div>
      </aside>
      <button id="${TOGGLE_ID}" type="button" aria-expanded="true" aria-label="\u6536\u8d77\u76ee\u5f55" title="\u6536\u8d77\u76ee\u5f55">></button>
    `;

    document.body.appendChild(root);

    const refreshBtn = root.querySelector(".cghj-refresh");
    const settingsBtn = root.querySelector(".cghj-settings-toggle");
    const settingsPanel = root.querySelector(`#${SETTINGS_ID}`);
    const supportBtn = root.querySelector(".cghj-support-toggle");
    const supportPanel = root.querySelector(".cghj-support-panel");
    const repoBtn = root.querySelector(".cghj-repo-link");
    const searchInput = root.querySelector(`#${SEARCH_ID}`);
    const toggleBtn = root.querySelector(`#${TOGGLE_ID}`);

    applySettings(root);
    syncSettingsControls(root);

    refreshBtn?.addEventListener("click", () => {
      const icon = refreshBtn.querySelector(".cghj-refresh-icon");
      if (icon) {
        icon.classList.remove("spinning");
        void icon.offsetWidth;
        icon.classList.add("spinning");
      }
      refreshAll();
    });

    settingsBtn?.addEventListener("click", () => {
      const isOpen = !settingsPanel?.hidden;
      if (settingsPanel) settingsPanel.hidden = isOpen;
      settingsBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
    });

    supportBtn?.addEventListener("click", () => {
      if (!supportPanel) return;
      const isOpen = !supportPanel.hidden;
      supportPanel.hidden = isOpen;
      supportBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
    });

    repoBtn?.addEventListener("click", () => {
      window.open(OFFICIAL_REPO_URL, "_blank", "noopener,noreferrer");
    });

    settingsPanel?.addEventListener("change", async (event) => {
      const control = event.target;
      const key = control.getAttribute("data-cghj-setting");
      if (!key || !(key in userSettings)) return;
      const value = control instanceof HTMLInputElement && control.type === "checkbox"
        ? control.checked
        : control.value;
      await saveSettings({ ...userSettings, [key]: value });
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
    loadSettings().then((settings) => {
      userSettings = settings;
      applySettings(root);
      syncSettingsControls(root);
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

  function getMessageRole(el) {
    return el?.getAttribute?.("data-message-author-role") || "";
  }

  function compareNodeOrder(a, b) {
    if (a === b) return 0;
    const relation = a.compareDocumentPosition(b);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function getConversationMessageContainers() {
    const results = [];
    const seen = new Set();

    document.querySelectorAll("[data-message-author-role]").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (!el.closest("main, article")) return;

      const role = getMessageRole(el);
      if (role !== "user" && role !== "assistant") return;
      if (seen.has(el)) return;

      seen.add(el);
      results.push(el);
    });

    return results.sort(compareNodeOrder);
  }

  function findTurnBasedPairs() {
    const pairs = [];
    const seenUsers = new Set();

    document.querySelectorAll("[data-testid^='conversation-turn-']").forEach((turn) => {
      if (!(turn instanceof HTMLElement)) return;

      const userEl = turn.querySelector("[data-message-author-role='user']");
      const replyEls = [...turn.querySelectorAll("[data-message-author-role='assistant']")]
        .filter((el) => el instanceof HTMLElement);
      const replyEl = replyEls[replyEls.length - 1];

      if (!(userEl instanceof HTMLElement) || !(replyEl instanceof HTMLElement)) return;
      if (seenUsers.has(userEl)) return;

      seenUsers.add(userEl);
      pairs.push({ userEl, replyEl });
    });

    return pairs;
  }

  function findSequentialPairs() {
    const messages = getConversationMessageContainers();
    const pairs = [];

    for (let i = 0; i < messages.length; i += 1) {
      const userEl = messages[i];
      if (getMessageRole(userEl) !== "user") continue;

      let replyEl = null;
      for (let j = i + 1; j < messages.length; j += 1) {
        const nextEl = messages[j];
        const nextRole = getMessageRole(nextEl);

        if (nextRole === "assistant") {
          replyEl = nextEl;
          continue;
        }

        if (nextRole === "user") {
          break;
        }
      }

      pairs.push({ userEl, replyEl });
    }

    return pairs;
  }

  function findConversationPairs() {
    const sequentialPairs = findSequentialPairs();
    const turnPairMap = new Map(
      findTurnBasedPairs().map((pair) => [pair.userEl, pair.replyEl])
    );

    return sequentialPairs.map(({ userEl, replyEl }) => ({
      userEl,
      replyEl: replyEl || turnPairMap.get(userEl),
    }));
  }

  function assignQuestionAnchor(el, idx, existingId = "") {
    const id = existingId || `cghj-q-${idx + 1}`;
    el.dataset.cghjQuestionId = id;
    return id;
  }

  function assignHeadingAnchor(el, questionId, idx) {
    const id = `${questionId}-h-${idx + 1}`;
    el.dataset.cghjHeadingId = id;
    el.dataset.cghjQuestionId = questionId;
    return id;
  }

  function getReplyContentRoots(replyEl) {
    if (!(replyEl instanceof HTMLElement)) return [];

    const roots = [
      replyEl,
      ...replyEl.querySelectorAll("[class*='markdown'], [class*='prose']"),
    ].filter((el) => el instanceof HTMLElement);

    return roots.sort(compareNodeOrder);
  }

  function getFontWeightValue(weight) {
    if (typeof weight === "number") return weight;
    if (weight === "bold") return 700;
    const parsed = Number.parseInt(weight, 10);
    return Number.isFinite(parsed) ? parsed : 400;
  }

  function getHeadingMetrics(el, baseFontSize) {
    if (!(el instanceof HTMLElement)) {
      return {
        maxFontSize: baseFontSize,
        maxFontWeight: 400,
        strongCoverage: 0,
      };
    }

    const emphasisNodes = [el, ...el.querySelectorAll("strong, b")].filter(
      (node) => node instanceof HTMLElement
    );
    const metrics = emphasisNodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        fontSize: Number.parseFloat(style.fontSize) || baseFontSize,
        fontWeight: getFontWeightValue(style.fontWeight),
      };
    });
    const strongText = normalizeText(
      [...el.querySelectorAll("strong, b")]
        .map((node) => node.textContent || "")
        .join(" ")
    );
    const text = normalizeText(getElementText(el));

    return {
      maxFontSize: Math.max(...metrics.map((item) => item.fontSize)),
      maxFontWeight: Math.max(...metrics.map((item) => item.fontWeight)),
      strongCoverage: text ? strongText.length / text.length : 0,
    };
  }

  const THINKING_TEXT_RE = /^(?:\u6B63\u5728\u601D\u8003|\u601D\u8003\u4E2D|Thinking|Reasoning|Processing)[\s.\u2026]*$/i;

  function isHeadingLikeText(text) {
    if (!text) return false;
    if (text.length > 140) return false;
    if (THINKING_TEXT_RE.test(text.trim())) return false;
    if (/^[\-\*\u2022]/.test(text)) return false;
    if (/[\u3002\uFF01!]$/.test(text) && text.length > 24) return false;
    if (/[\uFF1F?]$/.test(text) && text.length > 36) return false;
    return true;
  }

  function getTextLines(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean);
  }

  function getPrimaryHeadingText(text) {
    const lines = getTextLines(text);
    if (!lines.length) return "";

    const preferredLine = lines.find((line) => isHeadingLikeText(line) && line.length <= 64);
    return preferredLine || lines[0] || "";
  }

  function getTextShapeSignals(text) {
    const normalized = normalizeText(text);
    return {
      isNumberedSection: /^(?:\d+\s*[\u3001.\uFF0E)]\s*|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+\s*[\u3001.\uFF0E]\s*|(?:\u65b9\u6848|\u7b2c)[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+)/u.test(normalized),
      endsWithColon: /[:\uFF1A]$/.test(normalized),
      isShortLabel: normalized.length <= 18,
      isQuestionHeading: /[\uFF1F?]$/.test(normalized) && normalized.length <= 32,
      isLikelySentence: /[,\uFF0C;\uFF1B]/.test(normalized) || (normalized.length > 30 && /[\u3002.!]/.test(normalized)),
    };
  }

  function hasDistinctNestedBlocks(el, text, selector) {
    if (!(el instanceof HTMLElement)) return false;

    return [...el.querySelectorAll(selector)].some((child) => {
      if (!(child instanceof HTMLElement) || child === el) return false;
      const childText = normalizeText(child.innerText);
      return !!childText && childText !== text;
    });
  }

  function getContextualHeadingBoost(el) {
    if (!(el instanceof HTMLElement)) return 0;

    let next = el.nextElementSibling;
    while (next instanceof HTMLElement) {
      const nextText = normalizeText(next.innerText);
      if (!nextText && !next.matches("pre, code, ul, ol, table")) {
        next = next.nextElementSibling;
        continue;
      }

      if (next.matches("pre, code, ul, ol, table")) return 30;
      if (nextText.length >= 30) return 24;
      if (nextText.length >= 12) return 12;
      break;
    }

    return 0;
  }

  function getVisualHeadingTier(textShape, metrics, baseFontSize, contextualBoost) {
    const isStrongTypographicHeading =
      metrics.maxFontSize >= baseFontSize * 1.16 ||
      metrics.maxFontWeight >= 650 ||
      metrics.strongCoverage >= 0.72;

    if (textShape.isNumberedSection) return 1;
    if (isStrongTypographicHeading && contextualBoost >= 20) return 1;
    if (textShape.endsWithColon || textShape.isQuestionHeading) return 2;
    if ((textShape.isShortLabel || metrics.strongCoverage >= 0.55) && contextualBoost >= 16) return 2;
    return 3;
  }

  function getElementDepth(el) {
    let depth = 0;
    let current = el;
    while (current instanceof HTMLElement && current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findBestHeadingElementForText(rootEl, text) {
    if (!(rootEl instanceof HTMLElement) || !text) return rootEl;

    const normalizedTarget = normalizeText(text);
    const candidates = [rootEl, ...rootEl.querySelectorAll("strong, b, span, p, li, div")]
      .filter((el) => el instanceof HTMLElement)
      .map((el) => ({
        element: el,
        text: normalizeText(getElementText(el)),
      }))
      .filter((item) =>
        item.text &&
        (item.text === normalizedTarget ||
          item.text.startsWith(`${normalizedTarget} `) ||
          item.text.startsWith(`${normalizedTarget}\n`) ||
          item.text.startsWith(`${normalizedTarget}:`) ||
          item.text.startsWith(`${normalizedTarget}\uFF1A`))
      )
      .sort((a, b) => {
        const textGap = a.text.length - b.text.length;
        if (textGap !== 0) return textGap;
        return getElementDepth(b.element) - getElementDepth(a.element);
      });

    return candidates[0]?.element || rootEl;
  }

  function findConnectedHeadingElementByText(rootEl, text) {
    if (!(rootEl instanceof HTMLElement) || !rootEl.isConnected || !text) return null;

    const normalizedTarget = normalizeText(text);
    const candidates = [...rootEl.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, p, li, div, span")]
      .filter((el) => el instanceof HTMLElement)
      .map((el) => ({
        element: el,
        text: normalizeText(getElementText(el)),
      }))
      .filter((item) =>
        item.text &&
        (item.text === normalizedTarget ||
          item.text.startsWith(`${normalizedTarget} `) ||
          item.text.startsWith(`${normalizedTarget}\n`) ||
          item.text.startsWith(`${normalizedTarget}:`) ||
          item.text.startsWith(`${normalizedTarget}\uFF1A`))
      )
      .sort((a, b) => {
        const textGap = a.text.length - b.text.length;
        if (textGap !== 0) return textGap;
        return getElementDepth(b.element) - getElementDepth(a.element);
      });

    return candidates[0]?.element || null;
  }

  function collectSemanticHeadingCandidates(rootEl, baseFontSize) {
    if (!(rootEl instanceof HTMLElement)) return [];

    return [...rootEl.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((el) => el instanceof HTMLElement)
      .map((el) => {
        const text = normalizeText(getElementText(el));
        if (!isHeadingLikeText(text)) return null;

        const metrics = getHeadingMetrics(el, baseFontSize);
        return {
          element: el,
          text,
          semanticLevel: Number(el.tagName.slice(1)),
          visualLevel: null,
          tier: Number(el.tagName.slice(1)) <= 3 ? 1 : 2,
          fontSize: metrics.maxFontSize,
          fontWeight: metrics.maxFontWeight,
          score: metrics.maxFontSize * 100 + metrics.maxFontWeight + (7 - Number(el.tagName.slice(1))) * 8,
        };
      })
      .filter(Boolean);
  }

  function collectVisualHeadingCandidates(rootEl, baseFontSize) {
    if (!(rootEl instanceof HTMLElement)) return [];

    const candidateSelectors = "p, div, blockquote, li";
    const seen = new Set();

    return [...rootEl.querySelectorAll(candidateSelectors)]
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => {
        if (el === rootEl) return false;
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      })
      .map((el) => {
        const elText = getElementText(el);
        const fullText = normalizeText(elText);
        const text = getPrimaryHeadingText(elText);
        if (!isHeadingLikeText(text)) return null;

        const lines = getTextLines(elText);
        if (lines.length > 3) return null;

        const metrics = getHeadingMetrics(el, baseFontSize);
        const textShape = getTextShapeSignals(text);
        const looksProminent =
          metrics.maxFontSize >= baseFontSize * 1.05 ||
          metrics.maxFontWeight >= 550 ||
          metrics.strongCoverage >= 0.25;
        const contextualBoost = getContextualHeadingBoost(el);
        const hasNestedBlocks = hasDistinctNestedBlocks(el, text, candidateSelectors);
        const hasInlineEmphasis = !!el.querySelector("strong, b");
        const firstLineIsHeadingLike = lines[0] && isHeadingLikeText(lines[0]) && lines[0].length <= 64;
        const titleLineIsStandalone = fullText === text || lines[0] === text || firstLineIsHeadingLike;
        const canBePlainHeading =
          textShape.isNumberedSection ||
          textShape.endsWithColon ||
          textShape.isQuestionHeading ||
          (textShape.isShortLabel && contextualBoost >= 20);

        if (hasNestedBlocks || !looksProminent) return null;
        if (textShape.isLikelySentence && !textShape.isNumberedSection && !textShape.endsWithColon) {
          return null;
        }
        if (!titleLineIsStandalone && !textShape.isNumberedSection) return null;
        if (!hasInlineEmphasis && metrics.maxFontSize < baseFontSize * 1.16 && !canBePlainHeading) {
          return null;
        }

        return {
          element: el,
          text,
          semanticLevel: null,
          visualLevel: Math.round(metrics.maxFontSize * 2) / 2,
          tier: getVisualHeadingTier(textShape, metrics, baseFontSize, contextualBoost),
          fontSize: metrics.maxFontSize,
          fontWeight: metrics.maxFontWeight,
          score:
            metrics.maxFontSize * 100 +
            metrics.maxFontWeight +
            contextualBoost +
            (textShape.isNumberedSection ? 24 : 0) +
            (textShape.endsWithColon ? 12 : 0) +
            (titleLineIsStandalone ? 8 : 0),
        };
      })
      .filter(Boolean);
  }

  function collectLineHeadingCandidates(rootEl, baseFontSize) {
    if (!(rootEl instanceof HTMLElement)) return [];

    const candidateSelectors = "p, div, blockquote, li";
    const seenKeys = new Set();

    return [...rootEl.querySelectorAll(candidateSelectors)]
      .filter((el) => el instanceof HTMLElement && el !== rootEl)
      .flatMap((el) => {
        const lines = getTextLines(getElementText(el));
        if (lines.length < 1 || lines.length > 8) return [];

        const contextualBoost = getContextualHeadingBoost(el);

        return lines.slice(0, 3).map((line) => {
          const text = normalizeText(line);
          if (!isHeadingLikeText(text)) return null;

          const textShape = getTextShapeSignals(text);
          const shouldConsider =
            textShape.isNumberedSection ||
            textShape.endsWithColon ||
            textShape.isQuestionHeading ||
            textShape.isShortLabel ||
            (text.length <= 32 && contextualBoost >= 8);

          if (!shouldConsider) return null;
          if (textShape.isLikelySentence && !textShape.isNumberedSection && !textShape.endsWithColon) {
            return null;
          }

          const anchorEl = findBestHeadingElementForText(el, text);
          const metrics = getHeadingMetrics(anchorEl, baseFontSize);
          const looksProminent =
            metrics.maxFontSize >= baseFontSize * 1.0 ||
            metrics.maxFontWeight >= 500 ||
            metrics.strongCoverage >= 0.2 ||
            textShape.isNumberedSection ||
            (textShape.endsWithColon && contextualBoost >= 8);

          if (!looksProminent) return null;

          const key = `${text}::${anchorEl.dataset.cghjHeadingId || getElementText(anchorEl).length}`;
          if (seenKeys.has(key)) return null;
          seenKeys.add(key);

          return {
            element: anchorEl,
            text,
            semanticLevel: null,
            visualLevel: Math.round(metrics.maxFontSize * 2) / 2,
            tier: getVisualHeadingTier(textShape, metrics, baseFontSize, contextualBoost),
            fontSize: metrics.maxFontSize,
            fontWeight: metrics.maxFontWeight,
            score:
              metrics.maxFontSize * 100 +
              metrics.maxFontWeight +
              contextualBoost +
              (textShape.isNumberedSection ? 26 : 0) +
              (textShape.endsWithColon ? 14 : 0) +
              (textShape.isQuestionHeading ? 10 : 0),
          };
        }).filter(Boolean);
      });
  }

  function collectTextLineHeadingCandidates(rootEl, baseFontSize) {
    if (!(rootEl instanceof HTMLElement)) return [];

    const lines = getTextLines(getElementText(rootEl));
    if (lines.length < 2) return [];

    const seenTexts = new Set();
    return lines.map((line, idx) => {
      const text = normalizeText(line.replace(/^#{1,6}\s+/, ""));
      if (!isHeadingLikeText(text)) return null;

      const textShape = getTextShapeSignals(text);
      const nextLine = lines.slice(idx + 1).find(Boolean) || "";
      const shouldConsider =
        textShape.isNumberedSection ||
        textShape.endsWithColon ||
        textShape.isQuestionHeading ||
        (textShape.isShortLabel && nextLine.length >= 10);

      if (!shouldConsider) return null;
      if (textShape.isLikelySentence && !textShape.isNumberedSection && !textShape.endsWithColon) {
        return null;
      }
      if (seenTexts.has(text)) return null;
      seenTexts.add(text);

      const anchorEl = findBestHeadingElementForText(rootEl, text);
      const metrics = getHeadingMetrics(anchorEl, baseFontSize);
      return {
        element: anchorEl,
        text,
        semanticLevel: null,
        visualLevel: Math.round(metrics.maxFontSize * 2) / 2,
        tier: getVisualHeadingTier(textShape, metrics, baseFontSize, textShape.isNumberedSection ? 24 : 12),
        fontSize: metrics.maxFontSize,
        fontWeight: metrics.maxFontWeight,
        score:
          metrics.maxFontSize * 100 +
          metrics.maxFontWeight +
          (textShape.isNumberedSection ? 32 : 0) +
          (textShape.endsWithColon ? 16 : 0) +
          (idx === 0 ? 8 : 0),
      };
    }).filter(Boolean);
  }

  function normalizeMarkdownHeadingText(text) {
    return normalizeText(String(text || "")
      .replace(/\s+#{1,6}\s*$/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .replace(/^__(.+)__$/, "$1")
      .replace(/^\*(.+)\*$/, "$1")
      .replace(/^_(.+)_$/, "$1"));
  }

  function parseMarkdownHeadingLine(line) {
    const raw = String(line || "").trim();
    const match = raw.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return null;

    const text = normalizeMarkdownHeadingText(match[2]);
    if (!isHeadingLikeText(text)) return null;

    return {
      markdownLevel: match[1].length,
      text,
    };
  }

  function isFallbackReplyHeading(heading) {
    return !!heading?.id && heading.id.endsWith("-reply-fallback");
  }

  function hasOnlyFallbackReplyHeading(headings) {
    return headings?.length === 1 && isFallbackReplyHeading(headings[0]);
  }

  function extractReplyHeadingsFromText(replyText, questionId) {
    const seenTexts = new Set();
    const candidates = String(replyText || "").split(/\n+/).map((line) => {
      const candidate = parseMarkdownHeadingLine(line);
      if (!candidate) return null;
      const text = candidate.text;
      if (seenTexts.has(text)) return null;
      seenTexts.add(text);
      return candidate;
    }).filter(Boolean);

    if (!candidates.length) return [];
    return buildMarkdownReplyHeadingTree(candidates, questionId);
  }

  function buildMarkdownReplyHeadingTree(candidates, questionId) {
    const topLevel = Math.min(...candidates.map((candidate) => candidate.markdownLevel));
    const topCandidates = candidates.filter((candidate) => candidate.markdownLevel === topLevel);

    return topCandidates.map((top, idx) => {
      const nextTop = topCandidates[idx + 1];
      const start = candidates.indexOf(top);
      const end = nextTop ? candidates.indexOf(nextTop) : candidates.length;
      const sectionCandidates = candidates.slice(start + 1, end < 0 ? candidates.length : end);
      const childLevel = sectionCandidates.length
        ? Math.min(...sectionCandidates.map((candidate) => candidate.markdownLevel))
        : null;
      const children = childLevel
        ? sectionCandidates
          .filter((candidate) => candidate.markdownLevel === childLevel)
          .map((child, childIdx) => ({
            id: `${questionId}-api-h-${idx + 1}-child-${childIdx + 1}`,
            text: child.text,
            short: shorten(child.text, PREVIEW_TEXT_LIMIT),
            level: 2,
            element: null,
            source: "markdown",
            children: [],
          }))
        : [];

      return {
        id: `${questionId}-api-h-${idx + 1}`,
        text: top.text,
        short: shorten(top.text, PREVIEW_TEXT_LIMIT),
        level: 1,
        element: null,
        source: "markdown",
        children,
      };
    });
  }

  function createReplyHeadingEntry(candidate, questionId, indexKey, children = []) {
    return {
      id: assignHeadingAnchor(candidate.element, questionId, indexKey),
      text: candidate.text,
      short: shorten(candidate.text, PREVIEW_TEXT_LIMIT),
      level: candidate.semanticLevel || 1,
      element: candidate.element,
      children,
    };
  }

  function getCandidateRange(candidates, current, next) {
    const start = candidates.indexOf(current);
    const end = next ? candidates.indexOf(next) : candidates.length;
    if (start < 0) return [];
    return candidates.slice(start + 1, end < 0 ? candidates.length : end);
  }

  function getDirectChildCandidates(candidates, top, nextTop, bestTier) {
    const sectionCandidates = getCandidateRange(candidates, top, nextTop);
    const semanticChildren = sectionCandidates.filter(
      (item) => item.semanticLevel && (!top.semanticLevel || item.semanticLevel > top.semanticLevel)
    );
    const childSemanticLevel = semanticChildren.length
      ? Math.min(...semanticChildren.map((item) => item.semanticLevel))
      : null;
    const visualChildren = sectionCandidates.filter((item) => !item.semanticLevel && (item.tier || 3) > bestTier);
    const childTier = visualChildren.length
      ? Math.min(...visualChildren.map((item) => item.tier || 3))
      : null;

    return sectionCandidates.filter((item) => {
      if (childSemanticLevel && item.semanticLevel === childSemanticLevel) return true;
      return !item.semanticLevel && childTier && (item.tier || 3) === childTier;
    });
  }

  function buildReplyHeadingTree(candidates, questionId) {
    const bestTier = Math.min(...candidates.map((item) => item.tier || 3));
    const tierCandidates = candidates.filter((item) => (item.tier || 3) === bestTier);
    const semanticTopCandidates = tierCandidates.filter((item) => item.semanticLevel);
    const topSemanticLevel = semanticTopCandidates.length
      ? Math.min(...semanticTopCandidates.map((item) => item.semanticLevel))
      : null;
    const topCandidates = tierCandidates.filter((item) => {
      if (item.semanticLevel) return item.semanticLevel === topSemanticLevel;
      return true;
    });

    return topCandidates.map((top, idx) => {
      const children = getDirectChildCandidates(candidates, top, topCandidates[idx + 1], bestTier)
        .map((child, childIdx) =>
          createReplyHeadingEntry(child, questionId, `${idx}-child-${childIdx}`)
        );

      return createReplyHeadingEntry(top, questionId, idx, children);
    });
  }

  function extractReplyHeadings(replyEl, questionId) {
    if (!(replyEl instanceof HTMLElement)) return [];

    const roots = getReplyContentRoots(replyEl);
    const baseFontSize = Number.parseFloat(getComputedStyle(replyEl).fontSize) || 16;
    const candidateItems = [];
    const addCandidate = (candidate) => {
      if (!candidate?.element || !candidate.text) return;
      if (candidateItems.some((item) => item.element === candidate.element && item.text === candidate.text)) return;
      candidateItems.push(candidate);
    };

    roots.forEach((rootEl) => {
      collectSemanticHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        addCandidate(candidate);
      });

      collectVisualHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        addCandidate(candidate);
      });

      collectLineHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        addCandidate(candidate);
      });

      collectTextLineHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        addCandidate(candidate);
      });
    });

    const candidates = candidateItems.sort((a, b) =>
      compareNodeOrder(a.element, b.element)
    );

    if (!candidates.length) return [];

    const dedupedCandidates = [];
    const seenTexts = new Set();
    candidates.forEach((candidate) => {
      const key = normalizeText(candidate.text);
      if (!key || seenTexts.has(key)) return;
      seenTexts.add(key);
      dedupedCandidates.push(candidate);
    });

    return buildReplyHeadingTree(dedupedCandidates, questionId);
  }

  function updateCount() {
    const root = ensureRoot();
    const countEl = root.querySelector(".cghj-count");
    if (countEl) countEl.textContent = String(questionItems.length);
  }

  function flattenReplyHeadings(headings) {
    return headings.flatMap((heading) => [
      heading,
      ...flattenReplyHeadings(heading.children || []),
    ]);
  }

  function countChildReplyHeadings(headings) {
    return headings.reduce(
      (count, heading) => count + (heading.children?.length || 0) + countChildReplyHeadings(heading.children || []),
      0
    );
  }

  function buildQuestionSignature(items) {
    return items
      .map((item) => {
        const headings = flattenReplyHeadings(item.replyHeadings)
          .map((heading) => `${heading.level}:${heading.text}`)
          .join("|");
        return [
          item.id,
          item.conversationKey || "",
          item.text,
        item.imageCount,
      item.isLong ? 1 : 0,
      item.isLoaded === false ? 0 : 1,
      locatingQuestionId === item.id ? 1 : 0,
      item.headingsLoaded ? 1 : 0,
        headings,
      ].join("~");
      })
      .join("||");
  }

  function getTurnCacheKey(userEl) {
    const turn = userEl?.closest?.("[data-testid^='conversation-turn-']");
    const turnId = turn?.getAttribute?.("data-testid");
    return turnId ? `turn:${turnId}` : "";
  }

  function getQuestionCacheKey(userEl, text, imageCount) {
    const turnKey = getTurnCacheKey(userEl);
    const conversationKey = activeConversationKey || getConversationKey();
    if (turnKey) return `${conversationKey}::${turnKey}`;
    return `${conversationKey}::text:${normalizeText(text).toLowerCase()}::images:${imageCount}`;
  }

  function buildCachedHeadingEntries(headings) {
    return headings.map((heading) => ({
      id: heading.id,
      text: heading.text,
      short: heading.short,
      level: heading.level,
      element: heading.element instanceof HTMLElement && heading.element.isConnected
        ? heading.element
        : null,
      children: buildCachedHeadingEntries(heading.children || []),
    }));
  }

  function getReplyHeadingSummary(item) {
    if (!item.headingsLoaded) return "\u70b9\u51fb\u89e3\u6790\u56de\u590d\u6807\u9898";

    const childCount = countChildReplyHeadings(item.replyHeadings);
    return childCount
      ? `${item.replyHeadings.length} \u4e2a\u4e00\u7ea7\u6807\u9898 · ${childCount} \u4e2a\u6b21\u7ea7`
      : `${item.replyHeadings.length} \u4e2a\u56de\u590d\u6807\u9898`;
  }

  function markCachedQuestionsUnloaded() {
    seenQuestionMap.forEach((item) => {
      if (!(item.element instanceof HTMLElement && item.element.isConnected)) {
        item.element = null;
        item.replyElement = null;
        item.isLoaded = false;
        item.replyHeadings = buildCachedHeadingEntries(item.replyHeadings || []);
        item.hasReplyHeadings = item.replyHeadings.length > 0;
        item.headingsLoaded = !!item.headingsLoaded;
      }
    });
  }

  function getCachedQuestionItems() {
    return [...seenQuestionMap.values()].sort((a, b) => a.index - b.index);
  }

  function buildQuestionTextQueues(items, conversationKey = activeConversationKey) {
    const queues = new Map();
    items.forEach((item) => {
      if (item.conversationKey !== conversationKey || !item.text) return;

      const textKey = normalizeText(item.text).toLowerCase();
      if (!queues.has(textKey)) queues.set(textKey, []);
      queues.get(textKey).push(item);
    });

    queues.forEach((queue) => queue.sort((a, b) => a.index - b.index));
    return queues;
  }

  function shiftQuestionTextQueue(queues, textKey) {
    const queue = queues.get(textKey);
    return queue?.shift() || null;
  }

  function renumberQuestionItems() {
    getCachedQuestionItems().forEach((item, idx) => {
      item.index = idx + 1;
      if (item.element instanceof HTMLElement && item.element.isConnected) {
        assignQuestionAnchor(item.element, idx, item.id);
      }
    });
    nextQuestionIndex = seenQuestionMap.size + 1;
  }

  function mergeReplyHeadings(cacheKey, freshHeadings) {
    const cachedHeadings = cachedReplyHeadingMap.get(cacheKey) || [];
    const connectedFreshHeadings = freshHeadings.filter(
      (heading) => heading.element instanceof HTMLElement && heading.element.isConnected
    );

    if (connectedFreshHeadings.length) {
      const nextCache = buildCachedHeadingEntries(connectedFreshHeadings);
      cachedReplyHeadingMap.set(cacheKey, nextCache);
      return connectedFreshHeadings;
    }

    if (cachedHeadings.length) {
      return cachedHeadings;
    }

    return freshHeadings;
  }

  function getReplyFallbackHeading(replyEl, questionId) {
    if (!(replyEl instanceof HTMLElement)) return [];

    const replyText = normalizeText(getMessageTextFromContainer(replyEl));
    if (THINKING_TEXT_RE.test(replyText.trim())) return [];
    const previewText = replyText
      ? shorten(replyText.split(/(?<=[.!?\u3002\uFF01\uFF1F])\s+|\n+/)[0], PREVIEW_TEXT_LIMIT)
      : "\u56de\u590d\u5185\u5bb9";

    return [{
      id: `${questionId}-reply-fallback`,
      text: previewText,
      short: previewText,
      level: 99,
      element: replyEl,
      children: [],
    }];
  }

  function scanQuestions() {
    if (!ensureConversationState()) return false;
    if (Date.now() < conversationSwitchReadyAt) return false;

    const pairs = findConversationPairs();
    markCachedQuestionsUnloaded();
    const batchKeys = [];

    // Match API-loaded items to DOM nodes by text occurrence order.
    const existingByText = buildQuestionTextQueues([...seenQuestionMap.values()]);

    pairs.forEach(({ userEl, replyEl }, idx) => {
      if (!(userEl instanceof HTMLElement)) return;

      const imageCount = getMessageImageCount(userEl);
      const rawText = getMessageTextFromContainer(userEl);
      const text = normalizeQuestionText(rawText) || (imageCount > 0 ? "[\u56fe\u7247\u95ee\u9898]" : "");

      if (!shouldKeepAsQuestion(text, imageCount)) return;

      const cacheKey = getQuestionCacheKey(userEl, text, imageCount);
      const textKey = normalizeText(text).toLowerCase();
      const previousByCacheKey = seenQuestionMap.get(cacheKey);
      if (previousByCacheKey) shiftQuestionTextQueue(existingByText, textKey);
      const previous = previousByCacheKey || shiftQuestionTextQueue(existingByText, textKey);

      // If an API-loaded entry matched by text with a different cache key,
      // update it in-place to preserve the original cacheKey reference
      // (locateAndJumpToQuestion holds a reference to the old cacheKey)
      if (previous && previous.cacheKey !== cacheKey) {
        previous.element = userEl;
        previous.replyElement = replyEl instanceof HTMLElement ? replyEl : null;
        previous.isLoaded = true;
        previous.imageCount = imageCount;
        previous.hasImage = imageCount > 0;
        previous.hasReplyHeadings = previous.replyElement instanceof HTMLElement || previous.replyHeadings.length > 0;
        batchKeys.push(previous.cacheKey);
        assignQuestionAnchor(userEl, previous.index - 1, previous.id);
        return;
      }

      batchKeys.push(cacheKey);
      const index = previous?.index || nextQuestionIndex;
      if (!previous) nextQuestionIndex += 1;

      const id = assignQuestionAnchor(userEl, index - 1, previous?.id);
      const isLong = text.length > LONG_TEXT_THRESHOLD;
      const hasReply = replyEl instanceof HTMLElement;
      const replyHeadings = buildCachedHeadingEntries(previous?.replyHeadings || []);
      const headingsLoaded = !!previous?.headingsLoaded;

      seenQuestionMap.set(cacheKey, {
        id,
        cacheKey,
        conversationKey: activeConversationKey,
        text,
        short: shorten(text, PREVIEW_TEXT_LIMIT),
        element: userEl,
        replyElement: hasReply ? replyEl : null,
        replyHeadings,
        hasReplyHeadings: hasReply || replyHeadings.length > 0,
        headingsLoaded,
        index,
        imageCount,
        hasImage: imageCount > 0,
        isLong,
        isLoaded: true,
      });
    });

    renumberQuestionItems();

    const results = getCachedQuestionItems();
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

    return questionItems.filter((item) => item.text.toLowerCase().includes(keyword));
  }

  function ensureReplyHeadings(item) {
    if (!item) return false;
    if (item.headingsLoaded && !hasOnlyFallbackReplyHeading(item.replyHeadings)) {
      return !!item.replyHeadings?.length;
    }
    if (!ensureConversationState()) return false;
    if (item.conversationKey && item.conversationKey !== activeConversationKey) return false;
    if (!(item.replyElement instanceof HTMLElement) || !item.replyElement.isConnected) {
      return !!item.replyHeadings?.length;
    }

    const freshHeadings = extractReplyHeadings(item.replyElement, item.id);
    const mergedHeadings = mergeReplyHeadings(item.cacheKey, freshHeadings);
    const replyHeadings = mergedHeadings.length
      ? mergedHeadings
      : getReplyFallbackHeading(item.replyElement, item.id);

    item.replyHeadings = replyHeadings;
    item.hasReplyHeadings = replyHeadings.length > 0;
    item.headingsLoaded = true;

    if (item.cacheKey && seenQuestionMap.has(item.cacheKey)) {
      const cachedItem = seenQuestionMap.get(item.cacheKey);
      cachedItem.replyHeadings = replyHeadings;
      cachedItem.hasReplyHeadings = item.hasReplyHeadings;
      cachedItem.headingsLoaded = true;
    }

    return replyHeadings.length > 0;
  }

  function cancelHeadingWarmup() {
    if (!headingWarmupTimer) return;
    clearTimeout(headingWarmupTimer);
    headingWarmupTimer = null;
  }

  function scheduleHeadingWarmup() {
    cancelHeadingWarmup();
    if (locatingQuestionId || Date.now() < conversationSwitchReadyAt) return;

    headingWarmupTimer = setTimeout(() => {
      headingWarmupTimer = null;
      if (locatingQuestionId || !ensureConversationState()) return;

      let parsedCount = 0;
      const loadedItems = getCachedQuestionItems().filter(
        (item) =>
          !item.headingsLoaded &&
          item.replyElement instanceof HTMLElement &&
          item.replyElement.isConnected &&
          item.conversationKey === activeConversationKey
      );

      for (const item of loadedItems) {
        if (parsedCount >= HEADING_WARMUP_LIMIT) break;
        ensureReplyHeadings(item);
        parsedCount += 1;
      }

      if (parsedCount > 0) {
        renderList(true);
        rebuildIntersectionObserver();
      }
    }, HEADING_WARMUP_DELAY);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function getConversationScrollContainer() {
    const main = document.querySelector("main");
    let node = main;

    while (node instanceof HTMLElement && node !== document.body) {
      const style = getComputedStyle(node);
      const canScroll = /(auto|scroll)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 80;
      if (canScroll) return node;
      node = node.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function getScrollTop(scroller) {
    return scroller === document.body || scroller === document.documentElement
      ? window.scrollY || scroller.scrollTop || 0
      : scroller.scrollTop;
  }

  function setScrollTop(scroller, top) {
    if (scroller === document.body || scroller === document.documentElement) {
      window.scrollTo({ top, behavior: "auto" });
      return;
    }
    scroller.scrollTop = top;
  }

  function getMaxScrollTop(scroller) {
    const scrollHeight = scroller === document.body || scroller === document.documentElement
      ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
      : scroller.scrollHeight;
    const clientHeight = scroller === document.body || scroller === document.documentElement
      ? window.innerHeight
      : scroller.clientHeight;
    return Math.max(0, scrollHeight - clientHeight);
  }

  function getScrollStep(scroller) {
    const clientHeight = scroller === document.body || scroller === document.documentElement
      ? window.innerHeight
      : scroller.clientHeight;
    return Math.max(420, Math.floor(clientHeight * 0.82));
  }

  function getItemByCacheKey(cacheKey) {
    return cacheKey ? seenQuestionMap.get(cacheKey) || null : null;
  }

  function isItemLoaded(item) {
    return !!(item?.element instanceof HTMLElement && item.element.isConnected);
  }

  async function tryLocateQuestionInDirection(item, scroller, direction, scanKey) {
    let stableSteps = 0;
    let previousTop = -1;

    for (let step = 0; step < LOCATE_MAX_STEPS; step += 1) {
      if (scanKey !== getConversationKey()) return null;

      runRefreshAll();
      const latest = getItemByCacheKey(item.cacheKey);
      if (isItemLoaded(latest)) return latest;

      const currentTop = getScrollTop(scroller);
      const maxTop = getMaxScrollTop(scroller);
      if ((direction < 0 && currentTop <= 4) || (direction > 0 && currentTop >= maxTop - 4)) {
        break;
      }

      const nextTop = direction < 0
        ? Math.max(0, currentTop - getScrollStep(scroller))
        : Math.min(maxTop, currentTop + getScrollStep(scroller));
      setScrollTop(scroller, nextTop);
      await sleep(LOCATE_SCAN_DELAY);

      const afterTop = getScrollTop(scroller);
      stableSteps = Math.abs(afterTop - previousTop) < 2 ? stableSteps + 1 : 0;
      previousTop = afterTop;
      if (stableSteps >= 6) break;
    }

    return null;
  }

  async function locateAndJumpToQuestion(item) {
    if (!item?.cacheKey || locatingQuestionId) return;
    if (!ensureConversationState()) return;

    locatingQuestionId = item.id;
    activeQuestionId = item.id;
    renderList(true);

    const scroller = getConversationScrollContainer();
    const originalTop = getScrollTop(scroller);
    const scanKey = activeConversationKey;

    try {
      // If we have API positional data, jump directly to proportional position
      if (typeof item.apiIndex === "number" && item.apiTotal > 0) {
        const maxTop = getMaxScrollTop(scroller);
        const ratio = item.apiIndex / item.apiTotal;
        const targetTop = Math.floor(ratio * maxTop);
        console.log(`[CGHJ] proportional scroll: apiIndex=${item.apiIndex}/${item.apiTotal} ratio=${ratio.toFixed(2)} target=${targetTop}/${maxTop}`);
        setScrollTop(scroller, Math.min(targetTop, maxTop));

        // Wait for virtual scroller to render, polling up to 3s
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          if (scanKey !== getConversationKey()) return null;
          runRefreshAll();
          const latest = getItemByCacheKey(item.cacheKey);
          if (i === 0) {
            console.log(`[CGHJ] poll #${i}: cacheKey=${item.cacheKey} inMap=${!!latest} isLoaded=${isItemLoaded(latest)} mapSize=${seenQuestionMap.size}`);
          }
          if (isItemLoaded(latest)) {
            console.log(`[CGHJ] item found after ${(i + 1) * 300}ms wait`);
            activeQuestionId = latest.id;
            jumpToElement(latest.element);
            return;
          }
        }

        // If still not found, try nudging scroll slightly (virtual scroller may need position change)
        const nudgeOffsets = [-200, 200, -500, 500];
        for (const offset of nudgeOffsets) {
          setScrollTop(scroller, Math.min(Math.max(0, targetTop + offset), maxTop));
          await sleep(400);
          if (scanKey !== getConversationKey()) return null;
          runRefreshAll();
          const latest = getItemByCacheKey(item.cacheKey);
          if (isItemLoaded(latest)) {
            console.log(`[CGHJ] item found with nudge offset ${offset}`);
            activeQuestionId = latest.id;
            jumpToElement(latest.element);
            return;
          }
        }

        // Restore to target position
        setScrollTop(scroller, Math.min(targetTop, maxTop));
        console.log("[CGHJ] proportional scroll + nudges failed, falling back to step search");
      }

      // Fallback: step-by-step search from current position
      const totalCount = questionItems.length;
      const isLowerHalf = item.index <= Math.ceil(totalCount / 2);
      const firstDir = isLowerHalf ? -1 : 1;
      const secondDir = -firstDir;
      const foundFirst = await tryLocateQuestionInDirection(item, scroller, firstDir, scanKey);
      const found = foundFirst || await tryLocateQuestionInDirection(item, scroller, secondDir, scanKey);

      if (found && isItemLoaded(found)) {
        activeQuestionId = found.id;
        jumpToElement(found.element);
        return;
      }

      setScrollTop(scroller, Math.min(originalTop, getMaxScrollTop(scroller)));
    } finally {
      locatingQuestionId = null;
      runRefreshAll();
    }
  }

  function jumpToElement(el) {
    if (!(el instanceof HTMLElement)) return;
    el.style.scrollMarginTop = `${SCROLL_TOP_OFFSET}px`;
    el.scrollIntoView({
      behavior: "auto",
      block: "start",
      inline: "nearest",
    });
  }

  function jumpToQuestion(item) {
    if (!(item?.element instanceof HTMLElement) || !item.element.isConnected) {
      activeQuestionId = item?.id || activeQuestionId;
      updateActiveListState();
      renderList(true);
      locateAndJumpToQuestion(item);
      return;
    }
    activeQuestionId = item.id;
    locatingQuestionId = item.id;
    updateActiveListState();
    jumpToElement(item.element);
    setTimeout(() => { locatingQuestionId = null; }, 600);
  }

  function resolveHeadingElement(item, heading) {
    if (heading?.element instanceof HTMLElement && heading.element.isConnected) {
      return heading.element;
    }

    if (!(item?.replyElement instanceof HTMLElement) || !item.replyElement.isConnected) {
      return null;
    }

    const resolved = findConnectedHeadingElementByText(item.replyElement, heading?.text);
    if (resolved) heading.element = resolved;
    return resolved;
  }

  function jumpToHeading(item, heading) {
    const headingElement = resolveHeadingElement(item, heading);
    if (headingElement) {
      activeQuestionId = item.id;
      locatingQuestionId = item.id;
      updateActiveListState();
      jumpToElement(headingElement);
      setTimeout(() => { locatingQuestionId = null; }, 600);
      return;
    }

    if (item?.replyElement instanceof HTMLElement && item.replyElement.isConnected) {
      activeQuestionId = item.id;
      locatingQuestionId = item.id;
      updateActiveListState();
      jumpToElement(item.replyElement);
      setTimeout(() => { locatingQuestionId = null; }, 600);
      return;
    }

    if (!heading?.element) return;
    activeQuestionId = item.id;
    locatingQuestionId = item.id;
    updateActiveListState();
    jumpToElement(heading.element);
    setTimeout(() => { locatingQuestionId = null; }, 600);
  }

  function updateActiveListState() {
    const root = document.getElementById(EXT_ID);
    if (!root) return;

    root.querySelectorAll(".cghj-item.active").forEach((card) => {
      card.classList.remove("active");
    });
    const activeCard = root.querySelector(`.cghj-item[data-question-id="${activeQuestionId}"]`);
    if (activeCard) activeCard.classList.add("active");
  }

  function createQuestionExpandButton(item, isExpanded) {
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = `cghj-tool cghj-expand${isExpanded ? " expanded" : ""}`;
    expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    expandBtn.setAttribute("aria-label", isExpanded ? "\u6536\u8d77\u95ee\u9898" : "\u5c55\u5f00\u95ee\u9898");
    expandBtn.setAttribute("title", isExpanded ? "\u6536\u8d77\u95ee\u9898" : "\u5c55\u5f00\u95ee\u9898");
    expandBtn.textContent = isExpanded ? "-" : "+";
    expandBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expandedQuestionIds.has(item.id)) {
        expandedQuestionIds.delete(item.id);
      } else {
        expandedQuestionIds.add(item.id);
      }
      renderList();
    });
    return expandBtn;
  }

  function createReplyExpandButton(item, isExpanded) {
    const expandBtn = document.createElement("button");
    const headingSummary = getReplyHeadingSummary(item);
    expandBtn.type = "button";
    expandBtn.className = `cghj-tool cghj-outline-toggle${isExpanded ? " expanded" : ""}`;
    expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    expandBtn.setAttribute(
      "aria-label",
      isExpanded ? "\u6536\u8d77\u56de\u590d\u6807\u9898" : "\u5c55\u5f00\u56de\u590d\u6807\u9898"
    );
    expandBtn.setAttribute(
      "title",
      `${isExpanded ? "\u6536\u8d77" : "\u5c55\u5f00"}\u56de\u590d\u6807\u9898 (${headingSummary})`
    );
    expandBtn.textContent = "#";
    expandBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expandedReplyHeadingIds.has(item.id)) {
        expandedReplyHeadingIds.delete(item.id);
      } else {
        ensureReplyHeadings(item);
        expandedReplyHeadingIds.add(item.id);
      }
      renderList();
    });
    return expandBtn;
  }

  function createHeadingPreview(item) {
    const panel = document.createElement("div");
    panel.className = "cghj-heading-panel";
    ensureReplyHeadings(item);

    const meta = document.createElement("div");
    meta.className = "cghj-heading-meta";
    const childCount = countChildReplyHeadings(item.replyHeadings);
    meta.textContent = childCount
      ? `\u4e00\u7ea7\u6807\u9898 (${item.replyHeadings.length}) · \u6b21\u7ea7\u6807\u9898 (${childCount})`
      : `\u56de\u590d\u6807\u9898 (${item.replyHeadings.length})`;
    panel.appendChild(meta);

    const list = document.createElement("div");
    list.className = "cghj-heading-list";

    item.replyHeadings.forEach((heading, idx) => {
      const group = document.createElement("div");
      group.className = "cghj-heading-group";

      const row = document.createElement("div");
      row.className = "cghj-heading-row";

      const headingBtn = document.createElement("button");
      headingBtn.type = "button";
      headingBtn.className = "cghj-heading-link";
      headingBtn.setAttribute("title", heading.text);
      headingBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        jumpToHeading(item, heading);
      });

      const text = document.createElement("span");
      text.className = "cghj-heading-text";
      text.textContent = heading.short;

      const order = document.createElement("span");
      order.className = "cghj-heading-order";
      order.textContent = String(idx + 1);

      headingBtn.append(text, order);
      row.appendChild(headingBtn);

      if (heading.children?.length) {
        const childToggle = document.createElement("button");
        const isChildExpanded = expandedChildHeadingIds.has(heading.id);
        childToggle.type = "button";
        childToggle.className = `cghj-heading-child-toggle${isChildExpanded ? " expanded" : ""}`;
        childToggle.setAttribute("aria-expanded", isChildExpanded ? "true" : "false");
        childToggle.setAttribute(
          "aria-label",
          isChildExpanded ? "\u6536\u8d77\u6b21\u7ea7\u6807\u9898" : "\u5c55\u5f00\u6b21\u7ea7\u6807\u9898"
        );
        childToggle.setAttribute(
          "title",
          `${isChildExpanded ? "\u6536\u8d77" : "\u5c55\u5f00"}\u6b21\u7ea7\u6807\u9898 (${heading.children.length})`
        );
        childToggle.textContent = isChildExpanded ? "-" : "+";
        childToggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expandedChildHeadingIds.has(heading.id)) {
            expandedChildHeadingIds.delete(heading.id);
          } else {
            expandedChildHeadingIds.add(heading.id);
          }
          renderList();
        });
        row.appendChild(childToggle);

        if (isChildExpanded) {
          const childList = document.createElement("div");
          childList.className = "cghj-child-heading-list";

          heading.children.forEach((child, childIdx) => {
            const childBtn = document.createElement("button");
            childBtn.type = "button";
            childBtn.className = "cghj-heading-link cghj-child-heading-link";
            childBtn.setAttribute("title", child.text);
            childBtn.addEventListener("click", (event) => {
              event.stopPropagation();
              jumpToHeading(item, child);
            });

            const childText = document.createElement("span");
            childText.className = "cghj-heading-text";
            childText.textContent = child.short;

            const childOrder = document.createElement("span");
            childOrder.className = "cghj-heading-order";
            childOrder.textContent = `${idx + 1}.${childIdx + 1}`;

            childBtn.append(childText, childOrder);
            childList.appendChild(childBtn);
          });

          group.appendChild(childList);
        }
      }

      group.prepend(row);
      list.appendChild(group);
    });

    panel.appendChild(list);
    return panel;
  }

  function renderList(force = false) {
    const root = ensureRoot();
    const list = root.querySelector(`#${LIST_ID}`);
    if (!list) return;

    const items = getFilteredItems();
    const keyword = root.querySelector(`#${SEARCH_ID}`)?.value?.trim().toLowerCase() || "";
    const expandedQuestionState = [...expandedQuestionIds].sort().join("|");
    const expandedReplyState = [...expandedReplyHeadingIds].sort().join("|");
    const expandedChildState = [...expandedChildHeadingIds].sort().join("|");
    const renderSignature = [
      keyword,
      activeQuestionId || "",
      expandedQuestionState,
      expandedReplyState,
      expandedChildState,
      ...items.map((item) => `${item.id}:${item.replyHeadings.length}`),
    ].join("::");

    if (!force && renderSignature === lastRenderSignature) return;
    lastRenderSignature = renderSignature;

    if (!items.length) {
      list.innerHTML = `<div class="cghj-empty">\u6ca1\u6709\u5339\u914d\u7684\u95ee\u9898</div>`;
      return;
    }

    list.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item) => {
      const isTextExpanded = expandedQuestionIds.has(item.id);
      const isReplyExpanded = expandedReplyHeadingIds.has(item.id);

      const card = document.createElement("div");
      card.className = `cghj-item${item.id === activeQuestionId ? " active" : ""}${item.isLoaded === false ? " unloaded" : ""}${locatingQuestionId === item.id ? " locating" : ""}${isReplyExpanded && userSettings.stickyExpanded ? " reply-expanded" : ""}`;
      card.dataset.questionId = item.id;

      const row = document.createElement("div");
      row.className = "cghj-row";

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "cghj-main";
      if (item.isLoaded === false) {
        mainBtn.setAttribute(
          "title",
          "\u8be5\u95ee\u9898\u6682\u672a\u5728\u5f53\u524d\u9875\u9762 DOM \u4e2d\u52a0\u8f7d\uff0c\u70b9\u51fb\u540e\u4f1a\u5c1d\u8bd5\u6eda\u52a8\u627e\u56de\u5e76\u8df3\u8f6c\u3002"
        );
      }
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
      textEl.className = `cghj-text${isTextExpanded ? " expanded" : ""}`;
      textEl.title = item.text;
      textEl.textContent = isTextExpanded ? item.text : item.short;
      contentEl.appendChild(textEl);

      if (item.hasImage) {
        const badgeEl = document.createElement("span");
        badgeEl.className = "cghj-badge";
        badgeEl.textContent = item.imageCount > 1
          ? `\u542b ${item.imageCount} \u56fe`
          : "\u542b\u56fe";
        contentEl.appendChild(badgeEl);
      }

      if (item.isLoaded === false) {
        const unloadedEl = document.createElement("span");
        unloadedEl.className = "cghj-state-badge";
        unloadedEl.textContent = locatingQuestionId === item.id ? "\u5b9a\u4f4d\u4e2d" : "\u672a\u52a0\u8f7d";
        contentEl.appendChild(unloadedEl);
      }

      mainBtn.append(indexEl, contentEl);
      row.appendChild(mainBtn);

      if (item.isLong) {
        row.appendChild(createQuestionExpandButton(item, isTextExpanded));
      }

      if (item.hasReplyHeadings) {
        row.appendChild(createReplyExpandButton(item, isReplyExpanded));
      }

      card.appendChild(row);

      if (isReplyExpanded && item.hasReplyHeadings) {
        card.appendChild(createHeadingPreview(item));
      }

      frag.appendChild(card);
    });

    list.appendChild(frag);
    updateStickyOffsets(list);
  }

  function updateStickyOffsets(list) {
    if (!userSettings.stickyExpanded) return;
    const expandedItems = list.querySelectorAll(".cghj-item.reply-expanded");
    expandedItems.forEach((item, index) => {
      if (index === expandedItems.length - 1) {
        item.classList.add("reply-sticky");
        item.style.top = "0";
      } else {
        item.classList.remove("reply-sticky");
        item.style.top = "";
      }
    });
    bindHeadingPanelWheelEvents(list);
  }

  function bindHeadingPanelWheelEvents(list) {
    list.querySelectorAll(".cghj-item.reply-sticky .cghj-heading-panel").forEach((panel) => {
      if (panel.dataset.wheelBound) return;
      panel.dataset.wheelBound = "true";
      let extraTop = 0;
      panel.addEventListener("wheel", (event) => {
        const item = panel.closest(".cghj-item");
        if (!item) return;
        const isAtBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
        const isAtTop = panel.scrollTop <= 0;
        if (event.deltaY > 0 && isAtBottom) {
          event.preventDefault();
          extraTop = Math.max(extraTop - event.deltaY, -item.offsetHeight);
          item.style.top = `${extraTop}px`;
        } else if (event.deltaY < 0 && extraTop < 0 && isAtTop) {
          event.preventDefault();
          extraTop = Math.min(extraTop - event.deltaY, 0);
          item.style.top = `${extraTop}px`;
        }
      }, { passive: false });
    });
  }

  function rebuildIntersectionObserver() {
    if (activeIo) {
      activeIo.disconnect();
      activeIo = null;
    }

    activeIo = new IntersectionObserver(
      (entries) => {
        if (locatingQuestionId) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (!visible.length) return;

        const target = visible[0].target;
        const id = target instanceof HTMLElement ? target.dataset.cghjQuestionId || null : null;

        if (id && id !== activeQuestionId) {
          activeQuestionId = id;
          updateActiveListState();
        }
      },
      {
        root: null,
        threshold: [0.2, 0.45, 0.7],
      }
    );

    questionItems.forEach((item) => {
      if (item.element instanceof HTMLElement) {
        activeIo.observe(item.element);
      }

      flattenReplyHeadings(item.replyHeadings).forEach((heading) => {
        if (heading.element instanceof HTMLElement) {
          activeIo.observe(heading.element);
        }
      });
    });
  }

  function runRefreshAll() {
    ensureRoot();
    ensureConversationState();
    const changed = scanQuestions();
    renderList(changed);
    rebuildIntersectionObserver();
    scheduleHeadingWarmup();
  }

  const refreshAll = debounce(runRefreshAll, 250);

  function isRelevantMutationNode(node) {
    if (!(node instanceof HTMLElement)) return false;

    const root = document.getElementById(EXT_ID);
    if (root?.contains(node)) return false;
    if (node.closest(`#${EXT_ID}`)) return false;

    return !!(
      node.matches("[data-message-author-role]") ||
      node.querySelector?.("[data-message-author-role]") ||
      node.matches("main, article, h1, h2, h3, h4, h5, h6") ||
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
    const nextKey = getConversationKey();
    if (location.href === lastKnownHref && nextKey === activeConversationKey) return;

    resetConversationState(nextKey, true);
    setTimeout(() => {
      refreshAll();
    }, 1800);
    setTimeout(async () => {
      await loadConversationFromApi();
    }, 3500);
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

  function getAssistantMessagesUntilNextUser(messages, startIndex) {
    const assistantMessages = [];

    for (let i = startIndex + 1; i < messages.length; i += 1) {
      const msg = messages[i];
      if (msg.role === "assistant") assistantMessages.push(msg);
      if (msg.role === "user") return assistantMessages;
    }

    return assistantMessages;
  }

  function getBestApiReplyHeadings(messages, questionId) {
    const headingSets = messages
      .map((msg) => extractReplyHeadingsFromText(msg.text || "", questionId))
      .filter((headings) => headings.length);

    return headingSets[headingSets.length - 1] || [];
  }

  async function loadConversationFromApi() {
    if (!window.__cghjApi) return false;
    if (!ensureConversationState()) return false;

    try {
      const result = await window.__cghjApi.loadFullConversation();
      if (!result?.messages?.length) return false;

      const conversationKey = activeConversationKey || getConversationKey();

      // Preserve DOM references by matching repeated text in occurrence order.
      const domItemsByText = buildQuestionTextQueues(
        getCachedQuestionItems().filter((item) => item.element instanceof HTMLElement && item.element.isConnected),
        conversationKey
      );

      // Clear and rebuild from API
      seenQuestionMap.clear();
      nextQuestionIndex = 1;

      const batchKeys = [];
      const apiUserMessages = result.messages.filter((m) => m.role === "user");
      const apiUserTotal = apiUserMessages.length;
      let filteredOut = 0;

      result.messages.forEach((msg, msgIndex) => {
        if (msg.role !== "user") return;

        const text = normalizeQuestionText(msg.text);
        if (!shouldKeepAsQuestion(text, 0)) {
          filteredOut++;
          console.log(`[CGHJ] filtered out user msg: "${text.slice(0, 60)}..." len=${text.length}`);
          return;
        }

        const textKey = normalizeText(text).toLowerCase();
        const domItem = shiftQuestionTextQueue(domItemsByText, textKey);
        const cacheKey = domItem?.cacheKey || `${conversationKey}::api:${msg.id}`;
        batchKeys.push(cacheKey);

        const index = nextQuestionIndex;
        nextQuestionIndex += 1;
        const id = `cghj-q-${index}`;
        const assistantMessages = getAssistantMessagesUntilNextUser(result.messages, msgIndex);
        const apiReplyHeadings = getBestApiReplyHeadings(assistantMessages, id);
        const domReplyHeadings = domItem?.replyHeadings || [];
        const shouldUseApiHeadings = apiReplyHeadings.length > 0;
        const replyHeadings = shouldUseApiHeadings ? apiReplyHeadings : domReplyHeadings;

        seenQuestionMap.set(cacheKey, {
          id,
          cacheKey,
          conversationKey,
          text,
          short: shorten(text, PREVIEW_TEXT_LIMIT),
          element: domItem?.element || null,
          replyElement: domItem?.replyElement || null,
          replyHeadings,
          hasReplyHeadings: replyHeadings.length > 0 || (domItem ? domItem.hasReplyHeadings : assistantMessages.length > 0),
          headingsLoaded: replyHeadings.length > 0 || (domItem ? domItem.headingsLoaded : false),
          index,
          imageCount: domItem?.imageCount || 0,
          hasImage: domItem?.hasImage || false,
          isLong: text.length > LONG_TEXT_THRESHOLD,
          isLoaded: !!domItem,
          source: domItem ? "merged" : "api",
          apiIndex: index - 1,
          apiTotal: apiUserTotal,
        });
      });

      console.log(`[CGHJ] API load complete: ${apiUserTotal} user messages from API, ${filteredOut} filtered, ${seenQuestionMap.size} in map`);

      renumberQuestionItems();

      const results = getCachedQuestionItems();
      const nextSignature = buildQuestionSignature(results);
      const changed = nextSignature !== lastQuestionSignature;
      questionItems = results;
      lastQuestionSignature = nextSignature;

      if (!questionItems.some((item) => item.id === activeQuestionId)) {
        activeQuestionId = questionItems[0]?.id || null;
      }

      updateCount();
      renderList(true);
      rebuildIntersectionObserver();
      return true;
    } catch (err) {
      console.warn("[CGHJ] loadConversationFromApi failed:", err);
      return false;
    }
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
      setTimeout(async () => {
        await loadConversationFromApi();
      }, 2500);
    };

    tryInit();
  }

  waitForAppReady();
})();
