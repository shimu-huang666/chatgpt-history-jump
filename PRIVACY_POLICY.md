# Privacy Policy

Effective date: May 9, 2026

ChatGPT History Jump is a free browser extension that adds a local question
index panel to supported ChatGPT conversation pages.

## Data Collection

The extension does not collect, sell, share, or transmit personal data. It does
not send ChatGPT conversation content, prompts, replies, images, account details,
or browsing activity to any external server.

## Local Page Access

To provide its core feature, the extension reads the current ChatGPT page DOM in
the browser. This local page access is used only to find user prompts, detect
basic image indicators, extract nearby reply headings, and build the in-page
navigation panel.

## Local Storage

The extension uses `chrome.storage.local` only to remember whether the history
panel is collapsed for each conversation path and to save local display
settings such as panel side, width, density, and theme. These values stay in the
user's browser unless the browser or user removes extension storage.

## Network Requests

The extension does not make network requests to the developer or to third-party
analytics, advertising, payment, or licensing services.

## Permissions

The extension requests:

- `storage`: remembers the panel collapsed state and display settings locally.
- `https://chatgpt.com/*` and `https://chat.openai.com/*`: runs the content
  script only on supported ChatGPT pages.

## Changes

This policy may be updated when the extension changes. Material changes will be
documented in the project repository and reflected in the Chrome Web Store
listing.

## Contact

For privacy questions, open an issue in the project repository:
https://github.com/shimu-huang666/chatgpt-history-jump
