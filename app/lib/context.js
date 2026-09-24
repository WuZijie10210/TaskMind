// app/lib/context.js — AI context assembly. The ONLY place that decides
// which messages the model receives for a conversation:
//
//   main   -> main's own messages
//   branch -> snapshot of the main line captured at branch-creation time
//             + the branch's own messages
//
// Plus, since 004: explicit references (@Artifact / @Task). For every user
// message that carries message_references, the FROZEN artifact snapshots are
// rendered into that message's content as [Explicitly Referenced Artifact]
// blocks ahead of a [User Message] marker — so historical references keep
// participating in later turns with exactly the content that was sent at the
// time, regardless of later artifact edits.
//
// Keep this module pure (no DB, no AI) so tests can verify the exact payload
// shape the gateway will receive.

function readSnapshot(conversation) {
  const snap = conversation && conversation.parent_context_snapshot;
  if (!snap) return [];
  const msgs = Array.isArray(snap.messages) ? snap.messages : [];
  return msgs
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

// Accepts DB rows (artifact_snapshots) and in-memory payloads
// (artifactSnapshots) alike.
function refSnapshots(ref) {
  const snaps = ref && (ref.artifact_snapshots || ref.artifactSnapshots);
  return Array.isArray(snaps) ? snaps : [];
}

// Render the frozen snapshots of one message's references as context blocks.
// Snapshots are deduped by artifact id across the message's references: the
// same artifact picked both by a direct @Artifact and by a @Task selector in
// one message enters the context once (the user's original reference records
// are unaffected — dedup happens only at render time).
function renderReferenceBlocks(refs) {
  const blocks = [];
  const seen = new Set();
  for (const ref of refs || []) {
    for (const s of refSnapshots(ref)) {
      if (!s || typeof s.content !== "string" || !s.content) continue;
      if (s.id && seen.has(s.id)) continue;
      if (s.id) seen.add(s.id);
      const lines = ["[Explicitly Referenced Artifact]", `Title: ${s.title || ""}`, `Type: ${s.type || ""}`];
      if (s.summary) lines.push(`Summary: ${s.summary}`);
      lines.push("Content:", s.content);
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

// conversation: row from the conversations table (must include type and
// parent_context_snapshot for branches). ownMessages: [{id?, role, content}]
// oldest first — ids are needed only to attach references.
// refsByMessageId (optional): { [messageId]: message_reference rows }.
function buildAiMessages(conversation, ownMessages, refsByMessageId) {
  const refMap = refsByMessageId || {};
  const own = (ownMessages || [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0
    )
    .map((m) => {
      if (m.role === "user" && m.id && refMap[m.id]) {
        const blocks = renderReferenceBlocks(refMap[m.id]);
        if (blocks) return { role: "user", content: blocks + "\n\n[User Message]\n" + m.content };
      }
      return { role: m.role, content: m.content };
    });
  const inherited =
    conversation && conversation.type === "branch" ? readSnapshot(conversation) : [];
  return [...inherited, ...own];
}

// How many inherited messages a conversation's AI context carries (0 for main).
function inheritedCount(conversation) {
  return conversation && conversation.type === "branch" ? readSnapshot(conversation).length : 0;
}

module.exports = { buildAiMessages, inheritedCount, readSnapshot, renderReferenceBlocks };
