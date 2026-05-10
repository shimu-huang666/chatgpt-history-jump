(() => {
  "use strict";

  const EXT_ID = "chatgpt-history-jump-root";
  const SETTINGS_ID = "chatgpt-history-jump-settings";
  const PINK_THEME_KEY = "settings:girl-pink-theme:v1";
  const PINK_THEME_VALUE = "girl-pink";

  let observer = null;
  let installedRoot = null;

  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function loadPinkThemeEnabled() {
    if (!isContextValid()) return false;
    try {
      const res = await chrome.storage.local.get([PINK_THEME_KEY]);
      return !!res[PINK_THEME_KEY];
    } catch (err) {
      console.warn("[CGHJ] load pink theme failed:", err);
      return false;
    }
  }

  async function savePinkThemeEnabled(enabled) {
    if (!isContextValid()) return;
    try {
      await chrome.storage.local.set({ [PINK_THEME_KEY]: !!enabled });
    } catch (err) {
      console.warn("[CGHJ] save pink theme failed:", err);
    }
  }

  function getThemeSelect(root) {
    return root?.querySelector(`#${SETTINGS_ID} select[data-cghj-setting="theme"]`) || null;
  }

  function ensurePinkOption(select) {
    if (!select || select.querySelector(`option[value="${PINK_THEME_VALUE}"]`)) return;

    const option = document.createElement("option");
    option.value = PINK_THEME_VALUE;
    option.textContent = "少女粉";
    select.appendChild(option);
  }

  function setPinkTheme(root, select, enabled) {
    if (!root) return;
    root.classList.toggle("cghj-theme-girl-pink", !!enabled);

    if (select && enabled) {
      ensurePinkOption(select);
      select.value = PINK_THEME_VALUE;
    }
  }

  async function installForRoot(root) {
    if (!root || root === installedRoot) return;
    installedRoot = root;

    const select = getThemeSelect(root);
    ensurePinkOption(select);

    const enabled = await loadPinkThemeEnabled();
    setPinkTheme(root, select, enabled);

    // content.js may sync the select value after loading settings, so re-apply shortly.
    [120, 500, 1200].forEach((delay) => {
      window.setTimeout(async () => {
        const latestSelect = getThemeSelect(root);
        ensurePinkOption(latestSelect);
        setPinkTheme(root, latestSelect, await loadPinkThemeEnabled());
      }, delay);
    });

    root.addEventListener(
      "change",
      async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLSelectElement)) return;
        if (target.getAttribute("data-cghj-setting") !== "theme") return;

        const isPink = target.value === PINK_THEME_VALUE;
        await savePinkThemeEnabled(isPink);
        setPinkTheme(root, target, isPink);

        // content.js only accepts system/light/dark. Prevent it from normalizing girl-pink back to system.
        if (isPink) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
      },
      true
    );
  }

  function tryInstall() {
    const root = document.getElementById(EXT_ID);
    if (root) installForRoot(root);
  }

  tryInstall();
  observer = new MutationObserver(() => tryInstall());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
