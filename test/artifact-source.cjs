const assert = require('node:assert/strict');
const express = require('express');
const db = require('../app/services/db');

const taskId = '00000000-0000-4000-8000-000000000011';
const jobId = '00000000-0000-4000-8000-000000000012';
const artifactId = '00000000-0000-4000-8000-000000000013';
const conversationId = '00000000-0000-4000-8000-000000000014';
const messageId = '00000000-0000-4000-8000-000000000015';
const sourceText = '我先形成判断，再请 AI 提出反例。';
let saved;
let guest = 'owner';

const pool = {
  async query(sql, params = []) {
    if (sql.startsWith('SELECT 1 FROM tasks') || sql.startsWith('SELECT 1 FROM deposition_jobs')) {
      return { rows: guest === 'owner' ? [{ exists: 1 }] : [] };
    }
    if (sql.startsWith('SELECT * FROM deposition_jobs')) {
      return { rows: [{ id: jobId, task_id: taskId, conversation_id: conversationId,
        status: 'ready', source_message_ids: [messageId],
        source_snapshot: { messages: [{ messageId, role: 'user', content: sourceText }] } }] };
    }
    if (sql.startsWith('SELECT title FROM conversations')) {
      return { rows: [{ title: '支线｜反馈时机' }] };
    }
    if (sql.startsWith('SELECT a.source_snapshot')) {
      return { rows: saved ? [{ source_snapshot: saved.source_snapshot,
        source_message_ids: saved.source_message_ids,
        saved_title: saved.source_conversation_title, live_title: null }] : [] };
    }
    throw new Error('Unexpected query: ' + sql);
  },
  async connect() {
    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('UPDATE deposition_jobs SET status')) return { rowCount: 1, rows: [{ id: jobId }] };
        if (sql.startsWith('INSERT INTO artifacts')) {
          saved = { id: artifactId, task_id: taskId, source_conversation_id: conversationId,
            title: params[2], type: params[3], summary: params[4], content: params[5],
            source_message_ids: params[6], source_snapshot: JSON.parse(params[7]),
            source_conversation_title: params[8] };
          return { rows: [saved] };
        }
        throw new Error('Unexpected transaction query: ' + sql);
      },
      release() {},
    };
  },
};

const oldGetPool = db.getPool;
db.getPool = () => pool;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { guest = req.headers['x-guest'] || 'owner'; req.guestId = guest; next(); });
app.use('/api/depositions', require('../app/routes/depositions'));
app.use('/api/tasks', require('../app/routes/tasks'));

(async () => {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const confirm = await fetch(`${base}/api/depositions/${jobId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifacts: [{ title: '三步框架', type: '方法',
        summary: '用户确认后的新摘要', content: '用户修改后的正文', sourceMessageIds: [messageId] }] }),
    });
    assert.equal(confirm.status, 201);
    assert.equal(saved.summary, '用户确认后的新摘要');
    assert.equal(saved.source_snapshot[0].content, sourceText);
    assert.equal(saved.source_conversation_title, '支线｜反馈时机');

    // The original branch is gone; its saved provenance still opens.
    const url = `${base}/api/tasks/${taskId}/artifacts/${artifactId}/source`;
    const source = await fetch(url);
    assert.equal(source.status, 200);
    const body = await source.json();
    assert.equal(body.sourceConversationDeleted, true);
    assert.equal(body.sourceConversationTitle, '支线｜反馈时机');
    assert.deepEqual(body.messages.map((m) => m.content), [sourceText]);
    const stranger = await fetch(url, { headers: { 'x-guest': 'other' } });
    assert.equal(stranger.status, 404);
    console.log('Confirmed summary and frozen source PASS');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.getPool = oldGetPool;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; db.getPool = oldGetPool; });
