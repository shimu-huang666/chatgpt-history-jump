(() => {
  "use strict";

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

    const res = await fetch("/api/auth/session", {
      credentials: "include",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      console.warn("[CGHJ-API] /api/auth/session failed:", res.status);
      return null;
    }

    const data = await res.json();
    cachedToken = data.accessToken || null;
    tokenExpiresAt = data.expires
      ? new Date(data.expires).getTime() - 60000
      : Date.now() + 25 * 60 * 1000;

    return cachedToken;
  }

  async function fetchConversation(conversationId) {
    const token = await getAccessToken();
    if (!token) return null;

    const url = `/backend-api/conversation/${conversationId}`;
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      console.warn("[CGHJ-API] fetchConversation failed:", res.status);
      return null;
    }

    return await res.json();
  }

  function getConversationId() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function getActiveNodePath(mapping, currentNodeId) {
    const path = [];
    let nodeId = currentNodeId;

    while (nodeId && mapping[nodeId]) {
      path.unshift(nodeId);
      nodeId = mapping[nodeId].parent || null;
    }

    return path;
  }

  function parseConversationMessages(apiResponse) {
    if (!apiResponse?.mapping) return [];

    const mapping = apiResponse.mapping;
    const currentNodeId = apiResponse.current_node;
    const activePath = currentNodeId
      ? new Set(getActiveNodePath(mapping, currentNodeId))
      : null;

    const messages = [];
    let totalNodes = 0;
    let skippedNodes = 0;

    for (const nodeId of Object.keys(mapping)) {
      totalNodes++;
      const node = mapping[nodeId];

      if (activePath && !activePath.has(nodeId)) {
        skippedNodes++;
        continue;
      }

      const msg = node?.message;
      if (!msg?.author?.role || !msg?.content) continue;

      const role = msg.author.role;
      if (role !== "user" && role !== "assistant") continue;

      const parts = msg.content.parts || [];
      const text = parts
        .filter((p) => typeof p === "string")
        .join("\n")
        .trim();

      if (!text && role === "user") continue;

      messages.push({
        id: msg.id || nodeId,
        role,
        text,
        createTime: msg.create_time || 0,
        author: msg.author,
        contentType: msg.content.content_type || "text",
      });
    }

    messages.sort((a, b) => a.createTime - b.createTime);
    console.log(
      `[CGHJ-API] parsed: ${totalNodes} nodes, ${skippedNodes} off-path skipped, ${messages.length} messages (${messages.filter((m) => m.role === "user").length} user)`
    );
    return messages;
  }

  async function loadFullConversation() {
    const conversationId = getConversationId();
    if (!conversationId) return null;

    const apiResponse = await fetchConversation(conversationId);
    if (!apiResponse) return null;

    const messages = parseConversationMessages(apiResponse);
    return { conversationId, messages, raw: apiResponse };
  }

  window.__cghjApi = {
    getAccessToken,
    fetchConversation,
    getConversationId,
    parseConversationMessages,
    loadFullConversation,
  };
})();
