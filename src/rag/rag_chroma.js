import { ChromaClient } from 'chromadb';
import OpenAI from 'openai';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const RAG_TOP_K = 10;
const RAG_SIMILARITY_THRESHOLD = 0.5;

let chromaClient = null;
let collections = {};

function createEmbeddingClient() {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const baseURL = process.env.EMBEDDINGS_BASE_URL;
  return new OpenAI({ apiKey, baseURL });
}

function getEmbeddingModel() {
  return process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
}

async function embedText(client, model, text) {
  console.log('[Chroma] 调用 embedding 接口, 输入文本:', text);
  try {
    const r = await client.embeddings.create({
      model,
      input: String(text || ''),
      encoding_format: 'float',
    });
    console.log('[Chroma] 转成向量成功');
    return r.data[0].embedding;
  } catch (error) {
    console.error('[Chroma] 调用 embedding 接口失败:', error);
    throw error;
  }
}

async function getChromaClient() {
  if (!chromaClient) {
    chromaClient = new ChromaClient({ path: CHROMA_URL });
    console.log('[Chroma] 连接到 Chroma DB:', CHROMA_URL);
  }
  return chromaClient;
}

async function getOrCreateCollection(userId) {
  const collectionName = `user_${userId}`;
  
  if (collections[collectionName]) {
    return collections[collectionName];
  }

  const client = await getChromaClient();
  const collection = await client.getOrCreateCollection({
    name: collectionName,
    metadata: { description: `User ${userId} RAG collection` }
  });
  
  collections[collectionName] = collection;
  console.log('[Chroma] 获取/创建集合:', collectionName);
  return collection;
}

async function addToChroma(userId, chunks, opts = {}) {
  const client = opts?.client || createEmbeddingClient();
  const model = opts?.model || getEmbeddingModel();
  const collection = await getOrCreateCollection(userId);

  const ids = [];
  const embeddings = [];
  const metadatas = [];
  const documents = [];

  for (const chunk of chunks) {
    const embedding = await embedText(client, model, chunk.content);
    ids.push(`chunk_${chunk.chunk_id}`);
    embeddings.push(embedding);
    metadatas.push({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      title: chunk.title || '',
      filename: chunk.filename || '',
      chunk_index: chunk.chunk_index || 0
    });
    documents.push(chunk.content);
  }

  await collection.add({
    ids,
    embeddings,
    metadatas,
    documents
  });

  console.log('[Chroma] 添加了', chunks.length, '个 chunk 到向量库');
  return { added: chunks.length };
}

async function deleteFromChroma(userId, documentId) {
  const collection = await getOrCreateCollection(userId);
  
  const results = await collection.get({
    where: { document_id: documentId }
  });

  if (results.ids.length > 0) {
    await collection.delete({ ids: results.ids });
    console.log('[Chroma] 删除了', results.ids.length, '个 chunk 从向量库');
  }

  return { deleted: results.ids.length };
}

async function vectorSearch(userId, query, opts = {}) {
  const client = opts?.client || createEmbeddingClient();
  const model = opts?.model || getEmbeddingModel();
  const topK = opts?.topK || RAG_TOP_K;
  const threshold = opts?.threshold ?? RAG_SIMILARITY_THRESHOLD;

  const collection = await getOrCreateCollection(userId);
  const queryEmbedding = await embedText(client, model, query);

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK
  });

  console.log('[Chroma] 原始检索结果:', results);

  const hits = [];
  for (let i = 0; i < results.ids[0].length; i++) {
    const distance = results.distances[0][i];
    const score = 1 - distance;
    const metadata = results.metadatas[0][i];
    const content = results.documents[0][i];

    if (score >= threshold) {
      hits.push({
        score,
        chunk_id: metadata.chunk_id,
        content,
        document_id: metadata.document_id,
        title: metadata.title,
        filename: metadata.filename
      });
    }
  }

  console.log('[Chroma] 过滤后的检索结果 (阈值=' + threshold + '):', hits);
  return hits;
}

export {
  addToChroma,
  deleteFromChroma,
  vectorSearch
};
