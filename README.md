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
- Preserves Markdown `#` heading levels from API replies so `##` and `###` sections stay correctly nested
- Adds a line-based heading pass so older replies with plain text section titles are still recognized
- Remembers panel collapsed state per conversation
- Lets you customize panel side, width, density, and theme locally, including ChatGPT-adaptive dark and pink themes
- Parses reply headings lazily when opened so long conversations index faster
- Clears and guards cached questions/headings when switching conversations
- Attempts to restore unloaded cached prompts by scrolling before jumping to them
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
7. Click an unloaded cached prompt to let the extension try to scroll it back into the DOM and jump to it
9. Collapse or expand the panel whenever needed

## How It Works

The extension is implemented as a Manifest V3 content script:

- `content.js` scans ChatGPT user message nodes and builds the question list
- `styles.css` renders the floating side panel and interaction states
- `chrome.storage.local` stores per-conversation collapsed state and local display settings
- `MutationObserver` tracks conversation updates
- `IntersectionObserver` keeps the active question in sync with scrolling
- Reply headings are parsed lazily when a heading preview is opened, keeping normal scans lightweight
- Conversation caches are keyed and reset by conversation path to avoid showing stale headings after navigation
- Cached prompts that are not currently loaded can be located by targeted scrolling when clicked
- API reply heading extraction only trusts raw Markdown heading lines such as `##` and `###`; if a reply has no Markdown headings, the extension falls back to DOM-based heading detection
- DOM reply heading extraction merges semantic headings with numbered/visual top-level headings instead of choosing only one source
- After normal scans, up to 12 loaded replies are parsed in the background to restore quick heading previews without blocking long scans

### Reply Heading Recognition

Reply heading previews use two paths:

- Backend API text: raw Markdown heading lines are treated as authoritative. The smallest `#` level found in a reply becomes the top level, and the next deeper heading level becomes expandable child headings. For example, `##` headings are shown as top-level reply headings and `###` headings below them are nested children.
- Rendered DOM: when the API text has no Markdown headings, the extension reads the loaded ChatGPT reply DOM and falls back to semantic tags (`h1`-`h6`), numbered headings, and visual heading signals such as typography and nearby content.

Plain API text without any `#` heading markers is not guessed as a heading. This avoids promoting normal paragraphs or list items into reply headings.

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

## Version

Current version: `v3.2.14`

### Changelog

- **3.2.14** — Remove legacy pink theme files after folding the theme into the main extension files
- **3.2.13** — Add a playful author tease button in the settings support area
- **3.2.12** — Remove reply heading order numbers and keep only child heading expand controls
- **3.2.11** — Trust API Markdown reply headings and avoid mixing in DOM visual heading false positives
- **3.2.10** — Keep reply heading expand buttons inside narrow panels by letting heading rows reserve space for the toggle
- **3.2.7** — Fix reply headings jumping to reply container instead of the actual heading element inside it
- **3.2.6** — Remove "Sticky expanded" feature, simplify settings panel
- **3.2.5** — Fix card layout overflow when width is set to narrow; expand buttons no longer get pushed out
- **3.2.4** — Fold pink theme behavior and styles into the main extension files
- **3.2.3** — Add a separate ChatGPT-adaptive dark theme while preserving the original dark theme
- **3.2.2** — Simplify API reply heading parsing to raw Markdown headings only
- **3.2.1** — Prefer raw Markdown heading levels from API replies when building reply heading previews
- **3.2.0** — Only lock the last expanded item, fixing visual glitches with multiple expanded items
- **3.1.9** — After heading panel scrolls to bottom, continue scrolling to smoothly slide card up and hide
- **3.1.8** — Fix expanded item floating overlay issue; heading panel now has max-height with scroll
- **3.1.7** — Only lock the heading row instead of entire expanded panel, preventing scroll blocking when many headings exist
- **3.1.6** — Stack multiple expanded items sequentially at top instead of overlapping
- **3.1.5** — Add "Sticky expanded" toggle in settings to control whether expanded reply headings lock to top
- **3.1.4** — Lock expanded reply heading item to top of list when scrolling
- **3.1.3** — Add an official repository button to the settings support area
- **3.1.2** — Show the support section only after clicking the support author control
- **3.1.1** — Add original author attribution and a support section to the settings panel
- **3.1.0** — Fix repeated prompt indexing and reply heading extraction/jump behavior across API and DOM sources
- **3.0.7** — Resolve API-generated reply headings back to live DOM nodes before jumping
- **3.0.6** — Use the final assistant reply before the next user prompt when extracting reply headings
- **3.0.5** — Prefer numbered API reply headings over DOM paragraph false positives
- **3.0.4** — Build reply headings from Backend API assistant text when the reply DOM is unloaded or unreadable
- **3.0.3** — Extract reply headings from numbered text lines when ChatGPT does not expose separate heading nodes
- **3.0.2** — Preserve repeated identical user prompts by matching API and DOM items in occurrence order
- **3.0.1** — Remove minimum length filter for short messages; only filter empty messages
- **3.0.0** — Remove deep scan feature, Backend API as sole data source; remove heading summary line from cards for a more compact layout
- **0.2.44** — Poll for virtual scroller rendering after proportional scroll (up to 3s), add scroll nudges to trigger DOM rendering, add map diagnostic logging
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
