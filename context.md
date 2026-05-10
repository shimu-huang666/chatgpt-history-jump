# ChatGPT History Jump — 开发上下文 (2026-05-09)

## 背景

ChatGPT History Jump 是一个 Chrome/Edge 浏览器扩展，在 ChatGPT 会话页面右侧生成"历史问题目录"面板，支持快速跳转、搜索、回复标题预览等功能。

## 本次会话核心任务

从 DOM 抓取架构迁移到 ChatGPT Backend API 作为主数据源，消除深度扫描依赖，解决超长对话加载不全的问题。

---

## 架构迁移：DOM 抓取 → Backend API

### 原有问题

- ChatGPT 虚拟滚动只渲染 ~10-20 条消息，深度扫描需要 30-120 秒才能覆盖完整对话
- DOM 选择器 (`[data-message-author-role]`) 脆弱，ChatGPT 改版即失效
- `innerText` 提取有损，代码块/格式会丢失

### 技术方案

#### API 调用链

1. `GET /api/auth/session` → 获取 `accessToken`（内容脚本自动携带 cookie）
2. `GET /backend-api/conversation/{id}` → 获取完整对话 JSON
3. 不需要额外权限，不需要 MAIN world，不需要 `webRequest`

#### 数据源分层

| 层 | 数据源 | 覆盖范围 | 时机 |
|---|--------|----------|------|
| 主 | Backend API | 完整对话历史 | 页面加载 / 对话切换时 |
| 兜底 | DOM 抓取 (现有) | API 失败时 | fallback |

#### API 响应结构

```json
{
  "mapping": {
    "node-id-1": {
      "id": "node-id-1",
      "message": {
        "author": { "role": "user" },
        "content": { "parts": ["问题文本"], "content_type": "text" },
        "create_time": 1234567890,
        "id": "msg-id-1"
      },
      "parent": "parent-node-id",
      "children": ["child-node-id"]
    }
  },
  "current_node": "latest-node-id",
  "conversation_id": "69df17cd-...",
  "title": "对话标题"
}
```

#### 关键实现：对话树遍历

`current_node` 指向对话树中最新的节点。通过 `parent` 指针向上遍历到根，得到 active path。只有在 active path 上的消息才是当前对话分支的有效消息，其他分支（regeneration 等）被跳过。

---

## 新增/修改文件

### api.js（新文件）

Backend API 数据层，通过 manifest.json 在 content.js 之前加载。

关键函数：
- `getAccessToken()`: GET /api/auth/session → 返回 accessToken，带缓存和过期检查
- `fetchConversation(conversationId)`: GET /backend-api/conversation/{id}
- `getConversationId()`: 从 `location.pathname` 提取，支持 `/c/{id}` 和 `/g/g-xxx/c/{id}` 格式
- `getActiveNodePath(mapping, currentNodeId)`: 从 current_node 向上遍历到根
- `parseConversationMessages(apiResponse)`: 解析 mapping，提取 user/assistant 消息，按 create_time 排序
- `loadFullConversation()`: 组合函数，返回 `{conversationId, messages, raw}`

暴露：`window.__cghjApi`

### content.js（修改）

#### 核心改动：`loadConversationFromApi()`

1. 调用 `window.__cghjApi.loadFullConversation()` 获取完整对话
2. 用文本匹配保留 DOM 元素引用（`domItemsByText`）
3. 清空 `seenQuestionMap`，从 API 数据重建
4. 每个条目包含 `apiIndex` 和 `apiTotal` 字段，用于比例滚动定位

#### 核心改动：`scanQuestions()` 去重逻辑

`scanQuestions()` 是 DOM 扫描函数，由 MutationObserver 触发。API 加载后，DOM 扫描会再次运行，需要避免重复条目。

**关键修复**：当 `scanQuestions` 通过文本匹配找到已有的 API 条目时，**原地更新**该条目（保留原始 cacheKey），而不是创建新条目。这确保了 `locateAndJumpToQuestion` 持有的 cacheKey 引用始终有效。

```js
// 如果 API 条目通过文本匹配被找到，原地更新
if (previous && previous.cacheKey !== cacheKey) {
  previous.element = userEl;
  previous.replyElement = replyEl instanceof HTMLElement ? replyEl : null;
  previous.isLoaded = true;
  // ... 保留 apiIndex, apiTotal, cacheKey 不变
  return;
}
```

#### 核心改动：`locateAndJumpToQuestion()` 快速跳转

对有 `apiIndex/apiTotal` 的条目，使用比例滚动直接跳到估算位置：

```js
const ratio = item.apiIndex / item.apiTotal;
const targetTop = Math.floor(ratio * maxTop);
setScrollTop(scroller, targetTop);
```

然后轮询等待虚拟滚动渲染（每 300ms 检查一次，最多 3 秒）。如果仍未找到，尝试微调滚动（±200px、±500px）触发重新渲染。

### manifest.json（修改）

```json
{
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      "js": ["api.js", "content.js"],
      "css": ["styles.css"],
      "run_at": "document_idle"
    }
  ]
}
```

权限不变：`["storage"]` + `host_permissions`。

---

## 本次会话修复的 Bug

### Bug 1: conversationId 提取失败 (v0.2.41)

**问题**：GPT URL 格式 `/g/g-p-xxx/c/{id}` 无法匹配 `^\/c\/` 正则
**修复**：改为 `/\/c\/([^/?#]+)/` 匹配

### Bug 2: 重复条目 (v0.2.42)

**问题**：API 使用 `api:{msg.id}` 缓存键，DOM 使用 `turn:{testid}` 缓存键，同一消息出现两条
**修复**：`loadConversationFromApi` 清空 map 后用文本匹配保留 DOM 引用；`scanQuestions` 通过文本匹配找到 API 条目并原地更新

### Bug 3: 跳转靠滚动 (v0.2.42 ~ v0.2.44)

**问题**：API 加载的条目 `element: null`，`jumpToQuestion` 调用 `locateAndJumpToQuestion` 进行逐步扫描（每步 260ms）
**根因**：
1. `scanQuestions` 用 DOM cacheKey 替换了 API cacheKey，导致 `getItemByCacheKey` 查找失败
2. 比例滚动后 600ms 等待不够，虚拟滚动未渲染目标消息
**修复**：
1. `scanQuestions` 原地更新 API 条目，保留原始 cacheKey
2. 比例滚动后轮询等待（300ms × 10 次 = 3 秒）
3. 添加微调滚动（±200px、±500px）触发虚拟滚动重新渲染

---

## 已知问题与待办

### 当前状态 (v0.2.44)

- API 加载正常：51 个用户消息，0 个被过滤
- 比例滚动触发正常（日志确认 `apiIndex=44/51 ratio=0.86`）
- **仍未解决**：比例滚动后 item 始终 `isLoaded=false`，虚拟滚动未渲染目标消息

### 待诊断

- `poll #0` 日志会显示 `inMap` 和 `isLoaded` 状态
- 如果 `inMap=false`：scanQuestions 仍在改变 cacheKey（需要进一步调试）
- 如果 `inMap=true isLoaded=false`：虚拟滚动确实未渲染，需要更强的触发机制

### 后续计划

1. **Phase 2**: 创建 `interceptor.js`（MAIN world fetch 拦截），实时捕获新发送的消息
2. **Phase 3**: 移除深度扫描代码、清理诊断日志、Chrome Web Store 打包

---

## 关键数据流

```
页面加载
  → waitForAppReady()
    → refreshAll() (DOM 扫描，~10-20 条)
    → 2500ms 后 loadConversationFromApi()
      → API 获取完整对话 (51 条)
      → 清空 seenQuestionMap，从 API 重建
      → renderList()
    → MutationObserver 触发 scanQuestions()
      → 文本匹配已有 API 条目
      → 原地更新 DOM 引用，保留 cacheKey

点击未加载条目
  → jumpToQuestion(item)
    → item.element === null
    → locateAndJumpToQuestion(item)
      → 比例滚动到 apiIndex/apiTotal 位置
      → 轮询 300ms×10 等待渲染
      → 微调滚动 ±200/±500px
      → 兜底：逐步扫描 tryLocateQuestionInDirection
```

---

## 缓存键格式

| 来源 | 格式 | 示例 |
|------|------|------|
| DOM (有 testid) | `{convKey}::turn:{testid}` | `/c/abc::turn:user-123` |
| DOM (无 testid) | `{convKey}::text:{normalized}::images:{count}` | `/c/abc::text:hello world::images:0` |
| API | `{convKey}::api:{msg.id}` | `/c/abc::api:msg-id-456` |

---

## 版本历史

| 版本 | 变更 |
|------|------|
| 0.2.44 | 比例滚动后轮询等待虚拟滚动渲染，添加微调滚动 |
| 0.2.43 | 修复 scanQuestions 合并时丢失 API cacheKey |
| 0.2.42 | 修复重复条目（文本去重），添加比例滚动跳转 |
| 0.2.41 | 修复 GPT URL 格式的 conversationId 提取 |
| 0.2.40 | 记录实际 pathname 以调试 conversationId |
| 0.2.39 | 添加 API 详细诊断日志 |
| 0.2.38 | 添加 Backend API 数据层 |
| 0.2.37 | 自动深度扫描、优化扫描参数 |
| 0.2.36 | 修复 README、优化跳转搜索策略 |
| 0.2.35 | 深度扫描、回复标题懒解析、对话缓存隔离 |

---

## 用户约束

- **每次代码变更必须更新版本号**：manifest.json、README.md、README_CN.md 三处同步更新，并记录 changelog
- **必须确保能上架 Chrome Web Store**：仅用 `storage` + `host_permissions`，无敏感权限
- Git 用户名: shimu-huang666，邮箱: shimuhuang3@gmail.com
