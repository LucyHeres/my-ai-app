import { ChromaClient } from 'chromadb';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8001';
const RAG_TOP_K = 5;
const RAG_SIMILARITY_THRESHOLD = 1.15;//固定阈值：distance < 1.15

let chromaClient = null;
let collections = {};

// 自定义 EmbeddingFunction，兼容 ModelScope API
function createEmbedder() {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const model = process.env.EMBEDDINGS_MODEL;
  const baseUrl = process.env.EMBEDDINGS_BASE_URL;

  return {
    generate: async (texts) => {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          input: texts,
          encoding_format: 'float',  // ModelScope 需要这个参数
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('[Embedding] API 错误:', response.status, err);
        throw new Error(`Embedding API failed: ${response.status}`);
      }

      const data = await response.json();
      return data.data.map((item) => item.embedding);
    }
  };
}

async function getChromaClient() {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      path: CHROMA_URL,
    });
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
  let collection = await client.getOrCreateCollection({
    name: collectionName,
    metadata: { description: `User ${userId} RAG collection` },
    embeddingFunction: createEmbedder(),
  });

  collections[collectionName] = collection;
  console.log('[Chroma] 获取/创建集合:', collectionName);
  return collection;
}

async function addToChroma(userId, chunks) {
  const collection = await getOrCreateCollection(userId);
  let addedCount = 0;
  const failedChunks = [];

  for (const chunk of chunks) {
    const chunkId = chunk.chunk_id
      ? `chunk_${chunk.chunk_id}`
      : `chunk_${chunk.document_id}_${chunk.chunk_index}`;

    try {
      await collection.add({
        ids: [chunkId],
        metadatas: [{
          chunk_id: chunk.chunk_id || null,
          document_id: chunk.document_id,
          title: chunk.title || '',
          filename: chunk.filename || '',
          chunk_index: chunk.chunk_index || 0,
        }],
        documents: [chunk.content],
      });
      addedCount++;
    } catch (e) {
      console.error(`[Chroma] chunk ${chunkId} 添加失败:`, e?.message || String(e));
      failedChunks.push({
        index: chunk.chunk_index,
        error: e?.message || String(e)
      });
    }
  }

  console.log(`[Chroma] 完成: 成功 ${addedCount}/${chunks.length} 个 chunks`);
  if (failedChunks.length > 0) {
    console.log(`[Chroma] 失败的 chunks:`, failedChunks);
  }

  return {
    added: addedCount,
    total: chunks.length,
    failed: failedChunks
  };
}

async function deleteFromChroma(userId, documentId) {
  const collection = await getOrCreateCollection(userId);

  const results = await collection.get({
    where: { document_id: documentId },
  });

  if (results.ids.length > 0) {
    await collection.delete({ ids: results.ids });
    console.log('[Chroma] 删除了', results.ids.length, '个 chunk 从向量库');
  }

  return { deleted: results.ids.length };
}

async function vectorSearch(userId, query, opts = {}) {
  const topK = opts?.topK || RAG_TOP_K;
  const threshold = opts?.threshold ?? RAG_SIMILARITY_THRESHOLD;

  console.log('[Chroma] 开始检索, userId:', userId, 'query:', query);

  let collection = await getOrCreateCollection(userId);
  console.log('[Chroma] 获取 collection 成功, 开始 query... ');

  let results = await collection.query({
    queryTexts: [query],
    nResults: topK,
  });
  console.log('[Chroma] 原始检索结果:', results);

  // 检查是否返回错误
  if (results && results.error) {
    console.error('[Chroma] 检索返回错误:', results.error);
    const errMsg = String(results.error);

    // 如果是维度不匹配，删除旧 collection 重建
    if (errMsg.includes('InvalidDimension') || errMsg.includes('dimension')) {
      console.log('[Chroma] 维度不匹配，删除旧 collection 重建...');
      const client = await getChromaClient();
      const collectionName = `user_${userId}`;
      try {
        await client.deleteCollection({ name: collectionName });
        delete collections[collectionName]; // 清除缓存
        console.log('[Chroma] 旧 collection 已删除，重建完成，请重新上传文档');
      } catch (deleteErr) {
        console.error('[Chroma] 删除 collection 失败:', deleteErr);
      }
    }
    return [];
  }

  // 安全检查 results 结构
  if (!results || !results.ids || !results.ids[0]) {
    console.log('[Chroma] 检索结果为空或格式错误');
    return [];
  }

  const hits = [];
  for (let i = 0; i < results.ids[0].length; i++) {
    const distance = results.distances?.[0]?.[i];
    const metadata = results.metadatas?.[0]?.[i];
    const content = results.documents?.[0]?.[i];

    if (distance == null || !metadata || !content) continue;

    if (distance < threshold) {
      hits.push({
        score: 2 - distance,
        chunk_id: metadata.chunk_id,
        content,
        document_id: metadata.document_id,
        title: metadata.title,
        filename: metadata.filename,
      });
    }
  }

  console.log('[Chroma] 过滤后的检索结果 (阈值<' + threshold + '):', hits);
  return hits;
}

export { addToChroma, deleteFromChroma, vectorSearch };
