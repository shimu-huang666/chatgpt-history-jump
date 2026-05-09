# ChatGPT History Jump

A lightweight Chrome/Edge extension that adds a question index panel to the right side of the ChatGPT conversation page, making it much easier to revisit earlier prompts in long chats.

For Chinese documentation, see [README_CN.md](./README_CN.md).

## Features

- Automatically scans user prompts in the current ChatGPT conversation
- Builds a searchable history panel on the right side of the page
- Click any item to jump back to that prompt
- Highlights the prompt that is currently closest to the viewport
- Supports image-containing prompts with visual badges
- Collapses long prompts and lets you expand them on demand
- Extracts the highest-level headings from each paired GPT reply using standalone title-line, typography, and nearby-content heuristics, with nested secondary headings available on demand
- Adds a line-based heading pass so older replies with plain text section titles are still recognized
- Remembers panel collapsed state per conversation
- Lets you customize panel side, width, density, and theme locally
- Supports a manual deep scan for very long conversations that need older turns loaded by scrolling
- Auto deep scan after page load and conversation switch (can be disabled in settings)
- Parses reply headings lazily when opened so long conversations index faster
- Clears and guards cached questions/headings when switching conversations
- Attempts to restore unloaded cached prompts by scrolling before jumping to them
- Reorders cached prompts after deep scan according to their discovered page order
- Keeps numbered and visual top-level reply headings alongside semantic headings
- Warms up reply heading parsing for a small loaded batch after scans
- Watches page updates dynamically with DOM observers

## Supported Sites

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## Chrome Web Store Release

This repository is being prepared for a free Chrome Web Store release. The
extension does not include paid features, ads, analytics, remote licensing, or
any developer-operated backend service.

After the store listing is published, the Chrome Web Store installation link can
be added here.

## Installation

Until the Chrome Web Store listing is available, load the extension as an
unpacked browser extension.

### Chrome

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder
5. Open any ChatGPT conversation and refresh the page

### Edge

1. Open `edge://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder
5. Open any ChatGPT conversation and refresh the page

## Usage

After the extension is loaded:

1. Open a ChatGPT conversation
2. Look for the history panel on the right side
3. Use the search box to filter previous prompts
4. Click an item to jump to that message near the top of the viewport
5. Expand reply headings to preview top-level sections, then expand any nested secondary headings when needed
6. Use the gear button to adjust panel side, width, density, and theme
7. The extension auto-scans on page load and conversation switch; use the deep scan button to manually trigger if needed
8. Click an unloaded cached prompt to let the extension try to scroll it back into the DOM and jump to it
9. Collapse or expand the panel whenever needed

## How It Works

The extension is implemented as a Manifest V3 content script:

- `content.js` scans ChatGPT user message nodes and builds the question list
- `styles.css` renders the floating side panel and interaction states
- `chrome.storage.local` stores per-conversation collapsed state and local display settings
- `MutationObserver` tracks conversation updates
- `IntersectionObserver` keeps the active question in sync with scrolling
- Deep scan temporarily scrolls through the current conversation to let ChatGPT load older DOM nodes, then restores the previous scroll position
- Reply headings are parsed lazily when a heading preview is opened, keeping normal scans lightweight
- Conversation caches are keyed and reset by conversation path to avoid showing stale headings after navigation
- Cached prompts that are not currently loaded can be located by targeted scrolling when clicked
- Deep scan records prompts from top to bottom and reorders the cached index after scanning
- Reply heading extraction merges semantic headings with numbered/visual top-level headings instead of choosing only one source
- After normal scans, up to 12 loaded replies are parsed in the background to restore quick heading previews without blocking long scans
- Auto deep scan triggers after page load and conversation switch (can be disabled in settings), restoring the original scroll position when done

## Privacy

ChatGPT History Jump works locally in your browser. It reads the current ChatGPT
page only to build the in-page navigation panel and does not upload prompts,
replies, images, account details, or browsing activity to any external server.

See [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for the full policy.

## Project Structure

```text
.
|-- manifest.json
|-- content.js
|-- styles.css
|-- PRIVACY_POLICY.md
|-- LICENSE
|-- store-assets/
|-- README_CN.md
|-- icons/
```

## Development

There is no build step required right now. Edit the source files directly and reload the extension from the browser extensions page to test changes.

When changing behavior or UI, also update the README files and bump the extension version in `manifest.json`.

## Limitations

- The extension depends on the current ChatGPT DOM structure
- If ChatGPT changes its page layout, selectors may need to be updated
- It only indexes prompts from the currently open conversation
- Image detection is based on DOM elements rather than deep semantic analysis
- Very long conversations may require deep scan because ChatGPT can unload older DOM nodes until they are scrolled into view

## Version

Current version: `v0.2.43`

### Changelog

- **0.2.43** — Preserve API cacheKey through scanQuestions merge so locate jump works; add proportional scroll debug logging; optimize apiTotal computation
- **0.2.42** — Fix duplicate entries after API load (text-based dedup between API and DOM cache keys), fast proportional scroll jump for API-loaded items
- **0.2.41** — Fix conversationId extraction for GPT URLs (`/g/g-xxx/c/{id}`)
- **0.2.40** — Log actual pathname to debug conversationId extraction
- **0.2.39** — Add detailed API diagnostic logging to trace fetch failures
- **0.2.38** — Add Backend API data layer, load full conversation history via `/backend-api/conversation`, remove deep scan dependency
- **0.2.37** — Auto deep scan, optimized scan parameters (DEEP_SCAN_DELAY 350ms, MAX_STEPS 350)
- **0.2.36** — Fix README inconsistencies, remove unused backup file, optimize jump search strategy, deep scan progress indicator
- **0.2.35** — Deep scan, lazy reply heading parsing, conversation cache isolation, unloaded item locate-and-jump

## License

This project is licensed under the [MIT License](./LICENSE).
