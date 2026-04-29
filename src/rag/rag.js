import { db } from '../db/db.js';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const RAG_CHUNK_SIZE = Number.parseInt(process.env.RAG_CHUNK_SIZE || '500', 10);
const RAG_CHUNK_OVERLAP = Number.parseInt(process.env.RAG_CHUNK_OVERLAP || '100', 10);

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 100,
  separators: ['\n\n', '\n', '。', '，', ' ', ''],
});

async function chunkText(text) {
  const splitTexts = await splitter.splitText(String(text || '').trim());
  console.log("✅ 文档读取成功，共", splitTexts.length, "段");
  return splitTexts;
}

const stmtInsertChunk = db.prepare(
  `INSERT INTO rag_chunks (user_id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)`
);

async function genTextChunks(userId, docId, title, text) {
  const chunks = await chunkText(text);

  const tx = db.transaction(() => {
    for (let idx = 0; idx < chunks.length; idx += 1) {
      stmtInsertChunk.run(userId, docId, idx, chunks[idx]);
    }
    return { document_id: Number(docId), chunks: chunks.length };
  });

  // 返回 chunks 数据，方便直接传给向量数据库
  const chunksWithMeta = chunks.map((content, idx) => ({
    chunk_id: null, // SQLite 刚插入还没 id，传 null 没关系，Chroma 会自己生成
    content,
    document_id: Number(docId),
    chunk_index: idx,
    title,
    filename: title,
  }));

  return { ...tx(), chunkData: chunksWithMeta };
}

export {
  genTextChunks,
};
