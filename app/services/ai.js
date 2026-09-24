// Provider boundary: OpenAI-compatible Chat Completions (AI_BASE_URL ends in /v1).
const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
const model = process.env.AI_MODEL;
function isAiEnabled() { return Boolean(key && model); }
function config() {
  if (!isAiEnabled()) throw new Error("AI_API_KEY (or OPENAI_API_KEY) and AI_MODEL are required");
  const url = new URL(base);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("AI_BASE_URL must use HTTPS in production");
  }
  return `${base}/chat/completions`;
}
function aiError(data, status) { return new Error(data?.error?.message || `AI service HTTP ${status}`); }
function timeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  timer.unref?.();
  return { controller, timer };
}
async function request(messages, { system, maxTokens, stream }) {
  const url = config();
  const { controller, timer } = timeout();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        stream, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw aiError(data, response.status);
    }
    return { response, controller, timer };
  } catch (e) { clearTimeout(timer); throw e; }
}
async function chat(messages, { system = null, maxTokens = 8000 } = {}) {
  const { response, timer } = await request(messages, { system, maxTokens, stream: false });
  try {
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("AI returned no text");
    return content;
  } finally { clearTimeout(timer); }
}
async function* chatStream(messages, { system = null, maxTokens = 2048 } = {}) {
  const { response, controller, timer } = await request(messages, { system, maxTokens, stream: true });
  if (!response.body) { clearTimeout(timer); throw new Error("AI returned no stream"); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (!payload) continue;
        const data = JSON.parse(payload);
        if (data.error) throw aiError(data, 200);
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === "string") yield delta;
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    controller.abort();
  }
}
module.exports = { isAiEnabled, chat, chatStream };
