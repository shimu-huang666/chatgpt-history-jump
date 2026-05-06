(() => {
  "use strict";

  const EXT_ID = "chatgpt-history-jump-root";
  const PANEL_ID = "chatgpt-history-jump-panel";
  const LIST_ID = "chatgpt-history-jump-list";
  const SEARCH_ID = "chatgpt-history-jump-search";
  const TOGGLE_ID = "chatgpt-history-jump-toggle";
  const LONG_TEXT_THRESHOLD = 72;
  const PREVIEW_TEXT_LIMIT = 64;
  const SCROLL_TOP_OFFSET = 20;

  let questionItems = [];
  let activeQuestionId = null;
  let pageObserver = null;
  let activeIo = null;
  let lastQuestionSignature = "";
  let lastRenderSignature = "";
  let lastKnownHref = location.href;
  let urlWatcherInstalled = false;
  const expandedQuestionIds = new Set();
  const expandedReplyHeadingIds = new Set();
  const cachedReplyHeadingMap = new Map();

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

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
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
    return text.trim().length > 3;
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
          <div class="cghj-title">\u5386\u53f2\u95ee\u9898</div>
          <button type="button" class="cghj-refresh" title="\u5237\u65b0">&#8635;</button>
        </div>
        <input id="${SEARCH_ID}" type="text" placeholder="\u641c\u7d22\u5386\u53f2\u95ee\u9898..." />
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
      const replyEl = turn.querySelector("[data-message-author-role='assistant']");

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
          break;
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
      replyEl: turnPairMap.get(userEl) || replyEl,
    }));
  }

  function assignQuestionAnchor(el, idx) {
    const id = `cghj-q-${idx + 1}`;
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
    const text = normalizeText(el.innerText);

    return {
      maxFontSize: Math.max(...metrics.map((item) => item.fontSize)),
      maxFontWeight: Math.max(...metrics.map((item) => item.fontWeight)),
      strongCoverage: text ? strongText.length / text.length : 0,
    };
  }

  function isHeadingLikeText(text) {
    if (!text) return false;
    if (text.length > 140) return false;
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
        text: normalizeText(el.innerText),
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

  function collectSemanticHeadingCandidates(rootEl, baseFontSize) {
    if (!(rootEl instanceof HTMLElement)) return [];

    return [...rootEl.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((el) => el instanceof HTMLElement)
      .map((el) => {
        const text = normalizeText(el.innerText);
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
        const fullText = normalizeText(el.innerText);
        const text = getPrimaryHeadingText(el.innerText);
        if (!isHeadingLikeText(text)) return null;

        const lines = getTextLines(el.innerText);
        if (lines.length > 3) return null;

        const metrics = getHeadingMetrics(el, baseFontSize);
        const textShape = getTextShapeSignals(text);
        const looksProminent =
          metrics.maxFontSize >= baseFontSize * 1.1 ||
          metrics.maxFontWeight >= 600 ||
          metrics.strongCoverage >= 0.45;
        const contextualBoost = getContextualHeadingBoost(el);
        const hasNestedBlocks = hasDistinctNestedBlocks(el, text, candidateSelectors);
        const hasInlineEmphasis = !!el.querySelector("strong, b");
        const titleLineIsStandalone = fullText === text || lines[0] === text;
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
        const lines = getTextLines(el.innerText);
        if (lines.length < 2 || lines.length > 8) return [];

        const contextualBoost = getContextualHeadingBoost(el);

        return lines.slice(0, 3).map((line) => {
          const text = normalizeText(line);
          if (!isHeadingLikeText(text)) return null;

          const textShape = getTextShapeSignals(text);
          const shouldConsider =
            textShape.isNumberedSection ||
            textShape.endsWithColon ||
            textShape.isQuestionHeading ||
            (textShape.isShortLabel && contextualBoost >= 12);

          if (!shouldConsider) return null;
          if (textShape.isLikelySentence && !textShape.isNumberedSection && !textShape.endsWithColon) {
            return null;
          }

          const anchorEl = findBestHeadingElementForText(el, text);
          const metrics = getHeadingMetrics(anchorEl, baseFontSize);
          const looksProminent =
            metrics.maxFontSize >= baseFontSize * 1.02 ||
            metrics.maxFontWeight >= 560 ||
            metrics.strongCoverage >= 0.35 ||
            textShape.isNumberedSection ||
            (textShape.endsWithColon && contextualBoost >= 12);

          if (!looksProminent) return null;

          const key = `${text}::${anchorEl.dataset.cghjHeadingId || anchorEl.innerText.length}`;
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

  function extractReplyHeadings(replyEl, questionId) {
    if (!(replyEl instanceof HTMLElement)) return [];

    const roots = getReplyContentRoots(replyEl);
    const baseFontSize = Number.parseFloat(getComputedStyle(replyEl).fontSize) || 16;
    const candidateMap = new Map();

    roots.forEach((rootEl) => {
      collectSemanticHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        if (candidateMap.has(candidate.element)) return;
        candidateMap.set(candidate.element, candidate);
      });

      collectVisualHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        if (candidateMap.has(candidate.element)) return;
        candidateMap.set(candidate.element, candidate);
      });

      collectLineHeadingCandidates(rootEl, baseFontSize).forEach((candidate) => {
        if (candidateMap.has(candidate.element)) return;
        candidateMap.set(candidate.element, candidate);
      });
    });

    const candidates = [...candidateMap.values()].sort((a, b) =>
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

    const bestTier = Math.min(...dedupedCandidates.map((item) => item.tier || 3));
    const tierCandidates = dedupedCandidates.filter((item) => (item.tier || 3) === bestTier);
    const bestTierFontSize = Math.max(...tierCandidates.map((item) => item.fontSize));
    const bestTierScore = Math.max(...tierCandidates.map((item) => item.score));
    const highestLevelCandidates = tierCandidates.filter((item) => {
      if (item.semanticLevel) return true;
      const sameVisualBand = Math.abs(item.fontSize - bestTierFontSize) <= 1.25;
      const closeScore = item.score >= bestTierScore - 120;
      return sameVisualBand || closeScore;
    });

    return highestLevelCandidates
      .map((item, idx) => ({
        id: assignHeadingAnchor(item.element, questionId, idx),
        text: item.text,
        short: shorten(item.text, PREVIEW_TEXT_LIMIT),
        level: item.semanticLevel || 1,
        element: item.element,
      }));
  }

  function updateCount() {
    const root = ensureRoot();
    const countEl = root.querySelector(".cghj-count");
    if (countEl) countEl.textContent = String(questionItems.length);
  }

  function buildQuestionSignature(items) {
    return items
      .map((item) => {
        const headings = item.replyHeadings
          .map((heading) => `${heading.level}:${heading.text}`)
          .join("|");
        return [
          item.id,
          item.text,
          item.imageCount,
          item.isLong ? 1 : 0,
          headings,
        ].join("~");
      })
      .join("||");
  }

  function getQuestionCacheKey(text, index) {
    return `${index}::${normalizeText(text)}`;
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
    }));
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
    const previewText = replyText
      ? shorten(replyText.split(/(?<=[.!?\u3002\uFF01\uFF1F])\s+|\n+/)[0], PREVIEW_TEXT_LIMIT)
      : "\u56de\u590d\u5185\u5bb9";

    return [{
      id: `${questionId}-reply-fallback`,
      text: previewText,
      short: previewText,
      level: 99,
      element: replyEl,
    }];
  }

  function scanQuestions() {
    const pairs = findConversationPairs();
    const results = [];

    pairs.forEach(({ userEl, replyEl }, idx) => {
      if (!(userEl instanceof HTMLElement)) return;

      const imageCount = getMessageImageCount(userEl);
      const rawText = getMessageTextFromContainer(userEl);
      const text = normalizeQuestionText(rawText) || (imageCount > 0 ? "[\u56fe\u7247\u95ee\u9898]" : "");

      if (!shouldKeepAsQuestion(text, imageCount)) return;

      const id = assignQuestionAnchor(userEl, idx);
      const cacheKey = getQuestionCacheKey(text, results.length + 1);
      const mergedHeadings = mergeReplyHeadings(
        cacheKey,
        extractReplyHeadings(replyEl, id)
      );
      const replyHeadings = mergedHeadings.length
        ? mergedHeadings
        : getReplyFallbackHeading(replyEl, id);
      const isLong = text.length > LONG_TEXT_THRESHOLD;
      const hasReply = replyEl instanceof HTMLElement;

      results.push({
        id,
        text,
        short: shorten(text, PREVIEW_TEXT_LIMIT),
        element: userEl,
        replyElement: hasReply ? replyEl : null,
        replyHeadings,
        hasReplyHeadings: hasReply && replyHeadings.length > 0,
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

    return questionItems.filter((item) => item.text.toLowerCase().includes(keyword));
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
    if (!item?.element) return;
    activeQuestionId = item.id;
    updateActiveListState();
    jumpToElement(item.element);
  }

  function jumpToHeading(item, heading) {
    if (heading?.element instanceof HTMLElement && heading.element.isConnected) {
      activeQuestionId = item.id;
      updateActiveListState();
      jumpToElement(heading.element);
      return;
    }

    if (item?.replyElement instanceof HTMLElement && item.replyElement.isConnected) {
      activeQuestionId = item.id;
      updateActiveListState();
      jumpToElement(item.replyElement);
      return;
    }

    if (!heading?.element) return;
    activeQuestionId = item.id;
    updateActiveListState();
    jumpToElement(heading.element);
  }

  function updateActiveListState() {
    const root = document.getElementById(EXT_ID);
    if (!root) return;

    root.querySelectorAll(".cghj-item").forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      card.classList.toggle("active", card.dataset.questionId === activeQuestionId);
    });
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
    expandBtn.type = "button";
    expandBtn.className = `cghj-tool cghj-outline-toggle${isExpanded ? " expanded" : ""}`;
    expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    expandBtn.setAttribute(
      "aria-label",
      isExpanded ? "\u6536\u8d77\u56de\u590d\u6807\u9898" : "\u5c55\u5f00\u56de\u590d\u6807\u9898"
    );
    expandBtn.setAttribute(
      "title",
      `${isExpanded ? "\u6536\u8d77" : "\u5c55\u5f00"}\u56de\u590d\u6807\u9898 (${item.replyHeadings.length})`
    );
    expandBtn.textContent = "#";
    expandBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expandedReplyHeadingIds.has(item.id)) {
        expandedReplyHeadingIds.delete(item.id);
      } else {
        expandedReplyHeadingIds.add(item.id);
      }
      renderList();
    });
    return expandBtn;
  }

  function createHeadingPreview(item) {
    const panel = document.createElement("div");
    panel.className = "cghj-heading-panel";

    const meta = document.createElement("div");
    meta.className = "cghj-heading-meta";
    meta.textContent = `\u56de\u590d\u6807\u9898 (${item.replyHeadings.length})`;
    panel.appendChild(meta);

    const list = document.createElement("div");
    list.className = "cghj-heading-list";

    item.replyHeadings.forEach((heading, idx) => {
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
      list.appendChild(headingBtn);
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
    const renderSignature = [
      keyword,
      activeQuestionId || "",
      expandedQuestionState,
      expandedReplyState,
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
      card.className = `cghj-item${item.id === activeQuestionId ? " active" : ""}`;
      card.dataset.questionId = item.id;

      const row = document.createElement("div");
      row.className = "cghj-row";

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

      if (item.hasReplyHeadings) {
        const summaryEl = document.createElement("span");
        summaryEl.className = "cghj-outline-summary";
        summaryEl.textContent = `${item.replyHeadings.length} \u4e2a\u56de\u590d\u6807\u9898`;
        contentEl.appendChild(summaryEl);
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

      item.replyHeadings.forEach((heading) => {
        if (heading.element instanceof HTMLElement) {
          activeIo.observe(heading.element);
        }
      });
    });
  }

  const refreshAll = debounce(() => {
    ensureRoot();
    const changed = scanQuestions();
    renderList(changed);
    rebuildIntersectionObserver();
  }, 250);

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
    if (location.href === lastKnownHref) return;
    lastKnownHref = location.href;
    lastQuestionSignature = "";
    lastRenderSignature = "";
    activeQuestionId = null;
    expandedQuestionIds.clear();
    expandedReplyHeadingIds.clear();
    cachedReplyHeadingMap.clear();

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
