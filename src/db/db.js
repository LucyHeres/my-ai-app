import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const DB_PATH = process.env.SQLITE_DB_PATH || 'data/chat.db';

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirForFile(DB_PATH);
const db = new Database(DB_PATH);
let dbInitialized = false;

function initDb() {
  if (dbInitialized) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at, id);`);
  const conversationCols = db.prepare(`PRAGMA table_info(conversations)`).all().map((r) => r.name);
  if (!conversationCols.includes('title')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN title TEXT;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((r) => r.name);
  if (!cols.includes('user_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN user_id TEXT;`);
  }
  if (!cols.includes('sources')) {
    db.exec(`ALTER TABLE messages ADD COLUMN sources TEXT;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_user_session_id ON messages(user_id, session_id, id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT,
      filename TEXT,
      file_size INTEGER,
      file_path TEXT,
      mime_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 添加新字段（兼容旧数据库）
  const docCols = db.prepare(`PRAGMA table_info(rag_documents)`).all().map((r) => r.name);
  if (!docCols.includes('filename')) {
    db.exec(`ALTER TABLE rag_documents ADD COLUMN filename TEXT;`);
  }
  if (!docCols.includes('file_size')) {
    db.exec(`ALTER TABLE rag_documents ADD COLUMN file_size INTEGER;`);
  }
  if (!docCols.includes('file_path')) {
    db.exec(`ALTER TABLE rag_documents ADD COLUMN file_path TEXT;`);
  }
  if (!docCols.includes('mime_type')) {
    db.exec(`ALTER TABLE rag_documents ADD COLUMN mime_type TEXT;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_user_doc ON rag_chunks(user_id, document_id, chunk_index);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_user_id ON rag_chunks(user_id, id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_chunk_embeddings_user_id ON rag_chunk_embeddings(user_id, chunk_id);`);
  dbInitialized = true;
}

// 先初始化表结构，再 prepare 语句，避免新表首次启动时报 "no such table"
initDb();

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (user_id, session_id, role, content) VALUES (?, ?, ?, ?)`
);
const stmtCreateConversation = db.prepare(
  `INSERT OR IGNORE INTO conversations (id, user_id) VALUES (?, ?)`
);
const stmtTouchConversation = db.prepare(
  `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`
);
const stmtSetConversationTitle = db.prepare(
  `UPDATE conversations
   SET title = ?
   WHERE id = ? AND user_id = ? AND (title IS NULL OR title = '')`
);
const stmtLoadConversations = db.prepare(
  `SELECT
     c.id AS session_id,
     c.title,
     c.created_at,
     c.updated_at,
     (
       SELECT m.content
       FROM messages m
       WHERE m.user_id = c.user_id AND m.session_id = c.id
       ORDER BY m.id DESC
       LIMIT 1
     ) AS last_message
   FROM conversations c
   WHERE c.user_id = ?
     AND EXISTS (
       SELECT 1
       FROM messages m2
       WHERE m2.user_id = c.user_id AND m2.session_id = c.id
     )
   ORDER BY c.updated_at DESC, c.created_at DESC`
);
const stmtDeleteMessagesBySession = db.prepare(
  `DELETE FROM messages WHERE user_id = ? AND session_id = ?`
);
const stmtDeleteConversation = db.prepare(
  `DELETE FROM conversations WHERE id = ? AND user_id = ?`
);
const stmtLoadHistory = db.prepare(
  `SELECT role, content FROM messages WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?`
);
const stmtInsertDocument = db.prepare(
  `INSERT INTO rag_documents (user_id, title, filename, file_size, file_path, mime_type) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtLoadDocuments = db.prepare(
  `SELECT id, title, filename, file_size, file_path, mime_type, created_at FROM rag_documents WHERE user_id = ? ORDER BY id DESC`
);
const stmtGetDocument = db.prepare(
  `SELECT id, user_id, title, filename, file_size, file_path, mime_type FROM rag_documents WHERE id = ? AND user_id = ?`
);
const stmtDeleteDocument = db.prepare(
  `DELETE FROM rag_documents WHERE id = ? AND user_id = ?`
);
const stmtDeleteChunksByDoc = db.prepare(
  `DELETE FROM rag_chunks WHERE document_id = ? AND user_id = ?`
);
const stmtDeleteEmbeddingsByDoc = db.prepare(
  `DELETE FROM rag_chunk_embeddings WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ? AND user_id = ?)`
);

const stmtLoadChunksByDoc = db.prepare(
  `SELECT c.id as chunk_id, c.content, c.document_id, c.chunk_index, d.title, d.filename
   FROM rag_chunks c
   JOIN rag_documents d ON c.document_id = d.id
   WHERE c.user_id = ? AND c.document_id = ?
   ORDER BY c.chunk_index ASC`
);

function saveMessage(userId, sessionId, role, content) {
  stmtCreateConversation.run(sessionId, userId);
  // 会话标题固定为首条用户消息，后续消息不再覆盖
  if (role === 'user') {
    const firstLine = String(content || '').trim().split('\n')[0] || '';
    const title = firstLine.slice(0, 60);
    if (title) stmtSetConversationTitle.run(title, sessionId, userId);
  }
  stmtInsertMessage.run(userId, sessionId, role, content);
  stmtTouchConversation.run(sessionId, userId);
}

function loadHistory(userId, sessionId, limit) {
  const rows = stmtLoadHistory.all(userId, sessionId, limit);
  rows.reverse();
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

function saveDocument(userId, title, filename, fileSize, filePath, mimeType) {
  const result = stmtInsertDocument.run(userId, title, filename, fileSize, filePath, mimeType);
  return { document_id: result.lastInsertRowid };
}

function loadDocuments(userId) {
  return stmtLoadDocuments.all(userId);
}

function getDocument(docId, userId) {
  return stmtGetDocument.get(docId, userId);
}

function deleteDocument(docId, userId) {
  const doc = getDocument(docId, userId);
  if (!doc) return { deleted: false, error: '文档不存在' };

  const tx = db.transaction(() => {
    // 删除向量
    stmtDeleteEmbeddingsByDoc.run(docId, userId);
    // 删除chunks
    stmtDeleteChunksByDoc.run(docId, userId);
    // 删除文档记录
    stmtDeleteDocument.run(docId, userId);
    return { deleted: true, filePath: doc.file_path };
  });

  return tx();
}

function loadChunksByDoc(userId, docId) {
  return stmtLoadChunksByDoc.all(userId, docId);
}

function createConversation(userId, sessionId) {
  stmtCreateConversation.run(sessionId, userId);
  stmtTouchConversation.run(sessionId, userId);
  return { session_id: sessionId };
}

function loadConversations(userId) {
  return stmtLoadConversations.all(userId);
}

function deleteConversation(userId, sessionId) {
  const tx = db.transaction(() => {
    stmtDeleteMessagesBySession.run(userId, sessionId);
    const result = stmtDeleteConversation.run(sessionId, userId);
    return { deleted: result.changes > 0 };
  });
  return tx();
}

export {
  db,
  initDb,
  saveMessage,
  loadHistory,
  createConversation,
  loadConversations,
  deleteConversation,
  saveDocument,
  loadDocuments,
  getDocument,
  deleteDocument,
  loadChunksByDoc,
};
