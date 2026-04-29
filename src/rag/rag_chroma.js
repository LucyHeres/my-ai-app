import { ChromaClient } from 'chromadb';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8001';
const RAG_TOP_K = 5;
const RAG_FETCH_K = 30; // 先多取一些候选给 rerank
const RAG_SIMILARITY_THRESHOLD = 1.15;//固定阈值：distance < 1.15

let chromaClient = null;
let collections = {};

// 调用 Rerank API
async function callRerankAPI(query, chunks) {
  if (!process.env.RERANK_API_KEY || !process.env.RERANK_API_URL) {
    console.log('[Rerank] 未配置 RERANK_API_KEY 或 RERANK_API_URL，跳过');
    return null;
  }

  try {
    const documents = chunks.map(c => c.content);
    console.log('[Rerank] 调用 rerank API，文档数:', documents.length);

    const response = await fetch(process.env.RERANK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RERANK_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.RERANK_MODEL,
        query,
        documents,
        top_n: chunks.length,
      }),
    });

    if (!response.ok) {
      console.error('[Rerank] API 错误:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    console.log('[Rerank] API 返回:', data);

    return data.results ? data : null;
  } catch (e) {
    console.error('[Rerank] 调用失败:', e);
    return null;
  }
}

// 重排序函数（优先用 API，fallback 到规则）
async function rerankChunks(query, chunks, topK) {
  if (!chunks || chunks.length === 0) return [];

  // 尝试用 Rerank API
  const rerankResult = await callRerankAPI(query, chunks);

  const reranked = [];
  if (rerankResult && rerankResult.results) {
    console.log('[Rerank] 使用 API 重排序结果');
    // 根据 API 返回的索引重新排序
    for (const r of rerankResult.results) {
      if (r.index != null && chunks[r.index]) {
        reranked.push({
          ...chunks[r.index],
          combinedScore: r.relevance_score || 0
        });
      }
    }
  }
  return reranked.slice(0, topK);
}

// 自定义 EmbeddingFunction，兼容 ModelScope API
function createEmbedder() {
  return {
    generate: async (texts) => {
      const response = await fetch(`${process.env.EMBEDDINGS_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EMBEDDINGS_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.EMBEDDINGS_MODEL,
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
  const fetchK = opts?.fetchK || RAG_FETCH_K;

  console.log('[Chroma] 开始检索, userId:', userId, 'query:', query);

  let collection = await getOrCreateCollection(userId);
  console.log('[Chroma] 获取 collection 成功, 开始 query... ');

  let results = await collection.query({
    queryTexts: [query],
    nResults: fetchK, // 先多取一些用于重排序
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

  const candidates = [];
  for (let i = 0; i < results.ids[0].length; i++) {
    const distance = results.distances?.[0]?.[i];
    const metadata = results.metadatas?.[0]?.[i];
    const content = results.documents?.[0]?.[i];

    if (distance == null || !metadata || !content) continue;
    if (distance >= threshold) continue; // 先按距离阈值过滤

    candidates.push({
      distance,
      chunk_id: metadata.chunk_id,
      content,
      document_id: metadata.document_id,
      title: metadata.title,
      filename: metadata.filename,
    });
  }

  console.log('[Chroma] 初筛候选数:', candidates.length);

  // 重排序
  const reranked = await rerankChunks(query, candidates, topK);

  // 转换成最终格式（score 用回之前的格式）
  const finalHits = reranked.map(c => ({
    score: 2 - c.distance,
    chunk_id: c.chunk_id,
    content: c.content,
    document_id: c.document_id,
    title: c.title,
    filename: c.filename,
  }));

  console.log('[Chroma] 重排序后的最终结果:', finalHits);
  return finalHits;
}

export { addToChroma, deleteFromChroma, vectorSearch };
