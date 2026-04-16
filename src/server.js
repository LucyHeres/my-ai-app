import path from 'path';
import express from 'express';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ChatOpenAI } from '@langchain/openai';
import { initDb, saveMessage, loadHistory } from './db/db.js';
import { ragIngest, RAG_TOP_K } from './rag/rag.js';
import { ensureEmbeddingsForDocument, vectorSearch } from './rag/rag_vector.js';
import { createOutputSanitizer } from './utils/output_sanitize.js';
import { buildChatMessagesWithLangChain } from './rag/rag_langchain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL;
const DEFAULT_MODEL = 'deepseek-chat';
const MAX_HISTORY = Number.parseInt(process.env.MAX_HISTORY || '20', 10);

// 产品侧身份（企业常见做法：对外只暴露产品助手身份，而不是“我是某个模型”）
const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT;
const sanitizeOutput = createOutputSanitizer({ agentName: AGENT_NAME });

initDb();

const llm = new ChatOpenAI({
  apiKey: DEEPSEEK_API_KEY,
  model: DEFAULT_MODEL,
  temperature: 0.2,
  configuration: { baseURL: DEEPSEEK_BASE_URL },
});

function sseInit(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 立刻把 header 刷出去（有些代理/浏览器会缓存输出）
  res.flushHeaders?.();
}

function sseSend(res, obj) {
  // 这里输出的格式要符合 SSE 协议：每条消息一行 data: ...，末尾用两个换行分隔
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function toLcRole(role) {
  if (role === 'assistant') return 'ai';
  if (role === 'user') return 'human';
  return 'system';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

app.get('/', (req, res) => {
  // index.html 直接用静态文件输出（不需要模板引擎）
  res.sendFile(path.join(__dirname, '..', 'templates', 'index.html'));
});

app.use('/static', express.static(path.join(__dirname, '..', 'static')));

app.post('/rag/ingest', (req, res) => {
  const userId = String(req.body?.user_id || '').trim();
  const title = req.body?.title ? String(req.body.title).trim() : null;
  const text = String(req.body?.text || '').trim();

  if (!userId) return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
  if (!text) return res.status(400).json({ ok: false, error: 'text 不能为空' });

  const result = ragIngest(userId, title, text);
  ensureEmbeddingsForDocument(userId, result.document_id).catch((e) => {
    console.error('[RAG] 文档生成向量失败:', e?.message || String(e));
  });
  return res.json({ ok: true, ...result, embeddings: { status: 'scheduled' } });
});

app.post('/chat', async (req, res) => {
  const message = String(req.query?.message || '').trim();
  const userId = String(req.query?.user_id || 'default').trim();
  const sessionId = String(req.query?.session_id || 'default').trim();
  const rag = String(req.query?.rag || '0') === '1';

  sseInit(res);

  if (!message) {
    sseSend(res, { error: 'message 不能为空' });
    return res.end();
  }
  
  // 1) 先写入用户消息（持久化记忆）
  saveMessage(userId, sessionId, 'user', message);

  // 2) 拉取历史作为上下文（从旧到新）
  const history = loadHistory(userId, sessionId, Math.max(0, MAX_HISTORY) * 2);

  // 3) 可选：RAG 检索，把命中的资料片段注入 system prompt
  let ragHits = [];
  if (rag) {
    try {
      ragHits = await vectorSearch(userId, message, RAG_TOP_K);
    } catch (e) {
      console.error('[RAG] 检索失败:', e?.message || String(e));
    }
  }

  const openaiMessages = await buildChatMessagesWithLangChain({
    agentSystemPrompt: AGENT_SYSTEM_PROMPT,
    history,
    ragHits,
  });

  // LangChain 支持多种 message 输入格式，这里用 tuple 简化转换
  const lcMessages = openaiMessages.map((m) => [toLcRole(m.role), String(m.content || '')]);

  try {
    let assistantText = '';
    sseSend(res, { model: DEFAULT_MODEL });

    const stream = await llm.stream(lcMessages);
    for await (const chunk of stream) {
      const piece = contentToText(chunk?.content);
      if (!piece) continue;
      const cleaned = sanitizeOutput(piece);
      assistantText += cleaned;
      sseSend(res, { text: cleaned });
    }

    if (assistantText) saveMessage(userId, sessionId, 'assistant', assistantText);
    return res.end();
  } catch (e) {
    console.error('[LLM] 调用失败:', e?.message || String(e));
    sseSend(res, { error: '模型不可用' });
    return res.end();
  }
});

const PORT = Number.parseInt(process.env.PORT || '8000', 10);
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
