# Chrome Web Store Listing Draft

This document is the source copy and checklist for the free Chrome Web Store
release of ChatGPT History Jump.

## Listing Copy

Name: ChatGPT History Jump

Short description:

Add a searchable question index to ChatGPT conversations so you can jump through
long chats faster.

Category: Productivity

Language: English

Detailed description:

ChatGPT History Jump adds a lightweight history panel to supported ChatGPT
conversation pages. It scans the current conversation locally, builds a
searchable index of your prompts, and lets you jump back to earlier messages
without endless scrolling.

Key features:

- Searchable question index for the current ChatGPT conversation
- One-click smooth jumping to earlier prompts
- Active prompt highlighting while scrolling
- Image prompt badges for messages that include images
- Collapsible long prompts
- Top-level reply heading previews with expandable secondary headings
- Per-conversation collapsed state saved locally
- Local display settings for panel side, width, density, and theme
- Lazy reply-heading parsing for faster indexing in long conversations
- Conversation-scoped caches to avoid stale entries after switching chats
- Targeted restore-and-jump for cached prompts that are temporarily unloaded
- Combined semantic and numbered/visual top-level reply heading detection
- Capped background reply-heading warmup for loaded conversations

Privacy note:

The extension works locally in your browser. It does not upload ChatGPT
conversation content, use analytics, show ads, or make network requests to the
developer.

## Single Purpose Statement

ChatGPT History Jump adds an in-page navigation index for supported ChatGPT
conversation pages so users can search and jump to earlier prompts and detected
reply headings in long chats.

## Permission Justifications

`storage`:

Used only to save the history panel collapsed state locally for each
conversation path and local display settings such as panel side, width, density,
and theme.

`https://chatgpt.com/*` and `https://chat.openai.com/*`:

Required so the content script can run on supported ChatGPT pages, read the
current page DOM locally, and render the history navigation panel.

## Privacy Practices Fields

Recommended data disclosure:

- The extension does not collect user data.
- The extension does not transmit user data off the device.
- The extension does not use user data for analytics, advertising, or
  personalization.
- The extension does not sell or share user data.

## Required Visual Assets

Existing icon files:

- `icon_16.png`
- `icon_32.png`
- `icon_48.png`
- `icon_128.png`

Screenshots to capture from the real extension UI:

- `screenshot-01-panel.png`: ChatGPT conversation with the history panel visible.
- `screenshot-02-search.png`: Search filtering active in the panel.
- `screenshot-03-reply-headings.png`: Reply heading preview expanded.
- `screenshot-04-collapsed.png`: Collapsed panel state.

Recommended screenshot size: 1280x800.

Promotional image to prepare:

- Small promo tile: 440x280.

Do not submit mocked or misleading screenshots. If a real ChatGPT session is not
available, leave screenshots as pending assets until they can be captured from
the running extension.

## Release Package Checklist

Include:

- `manifest.json`
- `content.js`
- `styles.css`
- `icon_16.png`
- `icon_32.png`
- `icon_48.png`
- `icon_128.png`
- `LICENSE`
- `PRIVACY_POLICY.md`
- `README.md`
- `README_CN.md`

Exclude:

- `.git/`
- `.claude/`
- `.codex`
- `AGENTS.md`
- `CLAUDE.md`
- temporary files
- local screenshots that are not intended for the store listing
