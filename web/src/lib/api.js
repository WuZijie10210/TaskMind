// API client. All paths are RELATIVE ("api/..."), resolved against <base href>
// so they work under the gateway prefix from any client route.

async function j(url, opts) {
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body && body.error) msg = body.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  listTasks: () => j("api/tasks"),
  createTask: (firstMessage) =>
    j("api/tasks", { method: "POST", body: JSON.stringify({ firstMessage }) }),
  getTask: (id) => j(`api/tasks/${id}`),
  renameTask: (id, title) =>
    j(`api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteTask: (id) =>
    j(`api/tasks/${id}`, { method: "DELETE", body: JSON.stringify({}) }),
  listMessages: (conversationId) => j(`api/conversations/${conversationId}/messages`),
  createBranch: (taskId) => j(`api/tasks/${taskId}/branches`, { method: "POST" }),
  getBranchOrigin: (conversationId) => j(`api/conversations/${conversationId}/origin`),
  renameBranch: (taskId, branchId, title) =>
    j(`api/tasks/${taskId}/branches/${branchId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteBranch: (taskId, branchId) =>
    j(`api/tasks/${taskId}/branches/${branchId}`, { method: "DELETE", body: JSON.stringify({}) }),
  // deposition (沉淀)
  createDeposition: (conversationId) =>
    j("api/depositions", { method: "POST", body: JSON.stringify({ conversationId }) }),
  getTaskDepositions: (taskId) => j(`api/tasks/${taskId}/depositions`),
  getTaskArtifacts: (taskId) => j(`api/tasks/${taskId}/artifacts`),
  getArtifactSource: (taskId, artifactId) => j(`api/tasks/${taskId}/artifacts/${artifactId}/source`),
  renameArtifact: (taskId, artifactId, title) =>
    j(`api/tasks/${taskId}/artifacts/${artifactId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteArtifact: (taskId, artifactId) =>
    j(`api/tasks/${taskId}/artifacts/${artifactId}`, { method: "DELETE", body: JSON.stringify({}) }),
  getDeposition: (jobId) => j(`api/depositions/${jobId}`),
  confirmDeposition: (jobId, artifacts) =>
    j(`api/depositions/${jobId}/confirm`, { method: "POST", body: JSON.stringify({ artifacts }) }),
  discardDeposition: (jobId) =>
    j(`api/depositions/${jobId}/discard`, { method: "POST", body: JSON.stringify({}) }),
  reanalyzeDeposition: (jobId) =>
    j(`api/depositions/${jobId}/reanalyze`, { method: "POST", body: JSON.stringify({}) }),
  retryDeposition: (jobId) =>
    j(`api/depositions/${jobId}/retry`, { method: "POST", body: JSON.stringify({}) }),
  // @references
  referenceOptions: (taskId) => j(`api/tasks/${taskId}/reference-options`),
};

// POST a chat turn and consume the server's SSE response.
// onEvent receives the parsed frames:
//   {type:'user'|'start'|'delta'|'done'|'error', ...}
// references: optional [{type:'artifact'|'task', id}] explicit @mentions.
// signal: optional AbortSignal (task switched / component unmounted).
export async function streamChat(conversationId, content, onEvent, signal, references) {
  const body = {};
  if (content) body.content = content;
  if (references && references.length) body.references = references;
  const r = await fetch(`api/conversations/${conversationId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body && body.error) msg = body.error;
    } catch (_) {}
    throw new Error(msg);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handleFrame = (frame) => {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch (_) {}
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      handleFrame(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);
}
