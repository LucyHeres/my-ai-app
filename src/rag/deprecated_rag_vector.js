import OpenAI from 'openai';
import { db } from '../db/db.js';

const RAG_TOP_K = 10;
const RAG_SIMILARITY_THRESHOLD = 0.4;

/**
 * 把向量统一转成 Float32Array，方便后续计算和存库。
 * @param {number[]|Float32Array} v
 * @returns {Float32Array}
 */
function toFloat32Array(v) {
  if (v instanceof Float32Array) return v;
  return Float32Array.from(v || []);
}

/**
 * 把 Float32Array 转成 Buffer，存到 SQLite 的 BLOB 字段。
 * @param {number[]|Float32Array} vec
 * @returns {Buffer}
 */
function serializeEmbedding(vec) {
  const a = toFloat32Array(vec);
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * 从 SQLite BLOB 还原为 Float32Array。
 * @param {Buffer} buf
 * @returns {Float32Array}
 */
function deserializeEmbedding(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const arrBuf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(arrBuf);
}

/**
 * 余弦相似度：值越大，语义越相近。
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  const x = toFloat32Array(a);
  const y = toFloat32Array(b);
  const n = Math.min(x.length, y.length);
  if (!n) return 0;

  let dot = 0;
  let normX = 0;
  let normY = 0;
  for (let i = 0; i < n; i += 1) {
    dot += x[i] * y[i];
    normX += x[i] * x[i];
    normY += y[i] * y[i];
  }
  return dot / (Math.sqrt(normX) * Math.sqrt(normY));
}

// 取某个文档的所有 chunk（用于导入后补向量）
const stmtSelectChunksByDoc = db.prepare(
  `SELECT id, content FROM rag_chunks WHERE user_id = ? AND document_id = ? ORDER BY chunk_index ASC`
);

// 只取还没有向量的 chunk（避免重复计算）
const stmtSelectUnembeddedChunksByDoc = db.prepare(
  `SELECT c.id, c.content
   FROM rag_chunks c
   LEFT JOIN rag_chunk_embeddings e ON e.chunk_id = c.id
   WHERE c.user_id = ? AND c.document_id = ? AND e.chunk_id IS NULL
   ORDER BY c.chunk_index ASC`
);

// 向量入库（存在就覆盖）
const stmtUpsertEmbedding = db.prepare(
  `INSERT INTO rag_chunk_embeddings (chunk_id, user_id, dims, embedding)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(chunk_id) DO UPDATE SET
     user_id = excluded.user_id,
     dims = excluded.dims,
     embedding = excluded.embedding`
);

// 按 user 拿出所有向量，用于最简版全量扫描检索（包含文档信息）
const stmtSelectEmbeddingsForUser = db.prepare(
  `SELECT e.chunk_id, e.embedding, c.content, c.document_id, d.title, d.filename
   FROM rag_chunk_embeddings e
   JOIN rag_chunks c ON c.id = e.chunk_id
   LEFT JOIN rag_documents d ON d.id = c.document_id
   WHERE e.user_id = ?
   ORDER BY e.chunk_id DESC`
);

/**
 * 创建 embedding 客户端。
 * 优先读 EMBEDDINGS_*，没有就复用 DEEPSEEK_*。
 * @returns {OpenAI}
 */
function createEmbeddingClient() {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const baseURL = process.env.EMBEDDINGS_BASE_URL;
  return new OpenAI({ apiKey, baseURL });
}

/**
 * 获取当前 embedding 模型。
 * @returns {string}
 */
function getEmbeddingModel() {
  return process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
}

/**
 * 调 embedding 接口，把文本转成向量。
 * @param {OpenAI} client
 * @param {string} model
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
async function embedText(client, model, text) {
  console.log('调用 embedding 接口, 输入文本:',text);
  try {
    const r = await client.embeddings.create({
      model,
      input: String(text || ''),
      encoding_format: 'float',
    });
    console.log('转成向量:',r);
    const vec = r.data[0].embedding;
    return toFloat32Array(vec);
  } catch (error) {
    console.error('调用 embedding 接口失败:', error);
    throw error;
  }
}

/** 
 * 导入后给文档 chunk 生成向量并写入 SQLite。
 * @param {string} userId
 * @param {number} documentId
 * @param {{client?: OpenAI, model?: string}=} opts
 * @returns {Promise<{embedded:number, model:string, backend:string}>}
 */
async function ensureEmbeddingsForDocument(userId, documentId, opts) {
  const client = opts?.client || createEmbeddingClient();
  const model = opts?.model || getEmbeddingModel();
  const chunks = stmtSelectUnembeddedChunksByDoc.all(userId, documentId);

  let embedded = 0;
  for (const row of chunks) {
    const vec = await embedText(client, model, row.content);
    // 存入sqlite 向量库
    stmtUpsertEmbedding.run(row.id, userId, vec.length, serializeEmbedding(vec));
    embedded += 1;
  }
  return { embedded, model, backend: 'sqlite' };
}

/**
 * 最简版向量检索：
 * 1) query 转向量
 * 2) 全量扫描该用户所有 chunk 向量
 * 3) 按余弦相似度排序后取 TopK，并过滤低于阈值的结果
 * @param {string} userId
 * @param {string} query
 * @param {{topK?: number, threshold?: number, client?: OpenAI, model?: string}=} opts
 * @returns {Promise<Array<{score:number, chunk_id:number, content:string, document_id:number, title:string, filename:string}>>}
 */
async function vectorSearch(userId, query, opts) {
  const client = opts?.client || createEmbeddingClient();
  const model = opts?.model || getEmbeddingModel();
  const topK = opts?.topK || RAG_TOP_K;
  const threshold = opts?.threshold ?? RAG_SIMILARITY_THRESHOLD;

  const qvec = await embedText(client, model, query); 
  const rows = stmtSelectEmbeddingsForUser.all(userId);

  const scored = rows.map((row) => ({
    score: cosineSimilarity(qvec, deserializeEmbedding(row.embedding)),
    chunk_id: row.chunk_id,
    content: row.content,
    document_id: row.document_id,
    title: row.title,
    filename: row.filename,
  }));

  scored.sort((a, b) => b.score - a.score);
  console.log('[RAG] 从 SQLite 取出所有向量并按相似度排序:', scored?.map(item => item.score) || []);

  const filtered = scored.filter(item => item.score >= threshold);
  console.log('[RAG] 过滤后的检索结果 (阈值=' + threshold + '):', filtered);

  return filtered.slice(0, topK);
}

export {
  cosineSimilarity,
  createEmbeddingClient,
  embedText,
  ensureEmbeddingsForDocument,
  vectorSearch,
  stmtSelectChunksByDoc,
};
