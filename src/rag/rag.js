import { db } from '../db/db.js';

const RAG_CHUNK_SIZE = Number.parseInt(process.env.RAG_CHUNK_SIZE || '800', 10);
const RAG_CHUNK_OVERLAP = Number.parseInt(process.env.RAG_CHUNK_OVERLAP || '120', 10);
const RAG_TOP_K = Number.parseInt(process.env.RAG_TOP_K || '4', 10);

// 例子 text = "ABCDEFGHIJ" ， chunkSize = 4 ， overlap = 2
// - 切出来大概是： ABCD 、 CDEF 、 EFGH 、 GHIJ
function chunkText(text, chunkSize, overlap) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (chunkSize <= 0) return [t];

  const safeOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));
  const out = [];
  let i = 0;
  while (i < t.length) {
    const j = Math.min(t.length, i + chunkSize);
    out.push(t.slice(i, j).trim());
    if (j >= t.length) break;
    i = Math.max(0, j - safeOverlap);
  }
  return out.filter(Boolean);
}

const stmtInsertDoc = db.prepare(`INSERT INTO rag_documents (user_id, title) VALUES (?, ?)`);
const stmtInsertChunk = db.prepare(
  `INSERT INTO rag_chunks (user_id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)`
);

function ragIngest(userId, title, text) {
  const chunks = chunkText(text, RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP);

  const tx = db.transaction(() => {
    const doc = stmtInsertDoc.run(userId, title || null);
    const docId = doc.lastInsertRowid;
    for (let idx = 0; idx < chunks.length; idx += 1) {
      stmtInsertChunk.run(userId, docId, idx, chunks[idx]);
    }
    return { document_id: Number(docId), chunks: chunks.length };
  });

  return tx();
}

export {
  RAG_TOP_K,
  ragIngest,
};
