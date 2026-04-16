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

function initDb() {
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
}

const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (user_id, session_id, role, content) VALUES (?, ?, ?, ?)`
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

function saveMessage(userId, sessionId, role, content) {
  stmtInsertMessage.run(userId, sessionId, role, content);
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

export {
  db,
  initDb,
  saveMessage,
  loadHistory,
  saveDocument,
  loadDocuments,
};
