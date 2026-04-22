# ChatGPT History Jump

A lightweight Chrome/Edge extension that adds a question index panel to the right side of the ChatGPT conversation page, making it much easier to revisit earlier prompts in long chats.

For Chinese documentation, see [README_CN.md](./README_CN.md).

## Features

- Automatically scans user prompts in the current ChatGPT conversation
- Builds a searchable history panel on the right side of the page
- Click any item to smoothly jump back to that prompt
- Highlights the prompt that is currently closest to the viewport
- Supports image-containing prompts with visual badges
- Collapses long prompts and lets you expand them on demand
- Remembers panel collapsed state per conversation
- Watches page updates dynamically with DOM observers

## Supported Sites

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## Installation

This project is currently designed to be loaded as an unpacked browser extension.

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
4. Click an item to jump to that message
5. Collapse or expand the panel whenever needed

## How It Works

The extension is implemented as a Manifest V3 content script:

- `content.js` scans ChatGPT user message nodes and builds the question list
- `styles.css` renders the floating side panel and interaction states
- `chrome.storage.local` stores per-conversation collapsed state
- `MutationObserver` tracks conversation updates
- `IntersectionObserver` keeps the active question in sync with scrolling

## Project Structure

```text
.
|-- manifest.json
|-- content.js
|-- styles.css
|-- README_CN.md
|-- icons/
```

## Development

There is no build step required right now. Edit the source files directly and reload the extension from the browser extensions page to test changes.

## Limitations

- The extension depends on the current ChatGPT DOM structure
- If ChatGPT changes its page layout, selectors may need to be updated
- It only indexes prompts from the currently open conversation
- Image detection is based on DOM elements rather than deep semantic analysis

## Version

Current version: `v0.2.6`

## License

No license file is included yet. Add one if you plan to distribute this project publicly.
