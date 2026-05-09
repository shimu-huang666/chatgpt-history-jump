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
    console.log("[CGHJ-API] session response:", JSON.stringify(data).slice(0, 500));

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

    const data = await res.json();
    console.log("[CGHJ-API] conversation keys:", Object.keys(data));
    console.log("[CGHJ-API] mapping sample:", JSON.stringify(data.mapping).slice(0, 1000));
    return data;
  }

  function getConversationId() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function parseConversationMessages(apiResponse) {
    if (!apiResponse?.mapping) return [];

    const messages = [];
    const mapping = apiResponse.mapping;

    for (const nodeId of Object.keys(mapping)) {
      const node = mapping[nodeId];
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
    console.log("[CGHJ-API] parsed messages:", messages.length);
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
