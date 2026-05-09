import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import express from 'express';
import multer from 'multer';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  initDb,
  saveMessage,
  loadHistory,
  createConversation,
  loadConversations,
  deleteConversation,
  saveDocument,
  loadDocuments,
  getDocument,
  deleteDocument
} from './db/db.js';
import { createOutputSanitizer } from './utils/output_sanitize.js';
import { genTextChunks } from './rag/rag.js';
import { loadDocument } from './rag/rag_document_loader.js';
import { addToChroma, deleteFromChroma, vectorSearch } from './rag/rag_chroma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// 确保上传目录存在
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 修复文件名编码
function fixFilenameEncoding(filename) {
  if (!filename) return filename;
  try {
    // 尝试从latin1转utf8
    return Buffer.from(filename, 'latin1').toString('utf8');
  } catch {
    return filename;
  }
}

// 配置 multer 文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // 修复文件名编码
    file.originalname = fixFilenameEncoding(file.originalname);
    // 生成唯一文件名，保留原扩展名
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB 限制
  }
});

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL;
const DEFAULT_MODEL = 'deepseek-chat';
const MAX_HISTORY = Number.parseInt(process.env.MAX_HISTORY || '20', 10);

// 产品侧身份（企业常见做法：对外只暴露产品助手身份，而不是"我是某个模型"）
const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT;
const sanitizeOutput = createOutputSanitizer({ agentName: AGENT_NAME });

const llm = new ChatOpenAI({
  apiKey: DEEPSEEK_API_KEY,
  model: DEFAULT_MODEL,
  temperature: 0.2,
  configuration: { baseURL: DEEPSEEK_BASE_URL },
});

// 1. 定义工具 (Tools Schema) 
const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "当用户询问当前时间或进行计算时调用",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "可选，时区，例如 'Asia/Shanghai'",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "当用户询问内部文档、项目资料、人员简历或特定领域知识时，调用此工具进行检索",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "用于检索知识库的查询关键词或句子",
          },
        },
        required: ["query"]
      },
    },
  }
];

const llmWithTools = llm.bindTools(tools);

// 2. 实现本地工具函数
function getCurrentTime(args) {
  try {
    const tz = args.timezone || 'Asia/Shanghai';
    const time = new Date().toLocaleString('zh-CN', { timeZone: tz });
    return `当前时间是：${time}`;
  } catch (e) {
    return `获取时间失败：${e.message}`;
  }
}

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

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

function genSessionId() {
  return randomUUID();
}

async function executeToolCall({ toolCall, userId, fallbackQuery, res }) {
  if (toolCall.name === 'get_current_time') {
    const args = toolCall.args || {};
    console.log(`[Agent] 执行工具: ${toolCall.name}`, args);
    sseSend(res, { tool_call: { name: toolCall.name, args } });

    const result = getCurrentTime(args);
    console.log(`[Agent] 工具返回结果: ${result}`);
    return result;
  }

  if (toolCall.name === 'search_knowledge_base') {
    const args = toolCall.args || {};
    const query = args.query || fallbackQuery;
    console.log('[Agent] 执行工具: search_knowledge_base', args);
    sseSend(res, { tool_call: { name: toolCall.name, args } });

    let resultText = '未检索到相关资料。';
    const ragHits = await vectorSearch(userId, query);
    const validHits = ragHits.slice(0, 3);
    // console.log('[RAG] 查询到的向量validHits:', validHits);
    if (validHits.length > 0) {
      const sourceDocuments = validHits
        .map((hit) => ({
          document_id: hit.document_id,
          title: hit.title,
          filename: hit.filename,
          content: hit.content,
          score: hit.score,
        }))
        .filter((item) => item.score > 0.5).slice(0, 1);

      if (sourceDocuments.length > 0) {
        sseSend(res, { sources: sourceDocuments });
        resultText = sourceDocuments
          .map((doc) => `[来源: ${doc.title || doc.filename}]\n${doc.content}`)
          .join('\n\n');
      }
    }
    return resultText;
  }

  throw new Error(`未知工具: ${toolCall.name}`);
}

// 文件上传端点
app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    const userId = String(req.body?.user_id || '').trim();
    const title = req.body?.title ? String(req.body.title).trim() : null;

    if (!userId) {
      // 如果没传user_id，删除已上传的文件并返回错误
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: '请选择要上传的文件' });
    }

    // 保存文档信息到数据库
    const docTitle = title || req.file.originalname;
    const result = saveDocument(
      userId,
      docTitle,
      req.file.originalname,
      req.file.size,
      req.file.path,
      req.file.mimetype
    );

    // 提取文档内容并触发 RAG ingestion
    try {
      console.log(`[RAG] 开始提取文档内容: ${req.file.path}`);
      const content = await loadDocument(req.file.path);
      console.log(`[RAG] 文档内容提取完成, 长度: ${content?.length || 0}`);
      if (content && content.trim()) {
        const ragResult = await genTextChunks(userId, result.document_id, docTitle, content);
        console.log(`[RAG] 分片完成: ${ragResult.chunks} 个 chunks, chunkData 长度: ${ragResult.chunkData?.length}`);
        const chromaResult = await addToChroma(userId, ragResult.chunkData);
        console.log(`[RAG] 文档 ${docTitle} 已导入: ${chromaResult.added}/${chromaResult.total} 个 chunks 成功添加到向量数据库`);
        if (chromaResult.failed && chromaResult.failed.length > 0) {
          console.log(`[RAG] 警告: ${chromaResult.failed.length} 个 chunks 添加失败`);
        }
      } else {
        console.log(`[RAG] 文档内容为空，跳过向量入库`);
      }
    } catch (e) {
      console.error('[RAG] 文档内容提取失败:', e);
    }

    return res.json({
      ok: true,
      document_id: result.document_id,
      filename: req.file.originalname,
      size: req.file.size,
      title: docTitle
    });
    
  } catch (e) {
    console.error('[Upload] 上传失败:', e?.message || String(e));
    // 清理已上传的文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ ok: false, error: '上传失败' });
  }
});

// 获取文档列表端点
app.get('/documents', (req, res) => {
  const userId = String(req.query?.user_id || '').trim();

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
  }

  const documents = loadDocuments(userId);
  return res.json({ ok: true, documents });
});

// 删除文档端点
app.delete('/documents/:id', (req, res) => {
  try {
    const docId = Number(req.params.id);
    const userId = String(req.body?.user_id || req.query?.user_id || '').trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    if (!docId || isNaN(docId)) {
      return res.status(400).json({ ok: false, error: '无效的文档ID' });
    }

    const result = deleteDocument(docId, userId);

    if (!result.deleted) {
      return res.status(404).json({ ok: false, error: result.error || '删除失败' });
    }

    // 从 Chroma 向量库删除
    deleteFromChroma(userId, docId).catch((e) => {
      console.error('[RAG] 从 Chroma 删除文档失败:', e?.message || String(e));
    });

    // 删除磁盘上的文件
    if (result.filePath && fs.existsSync(result.filePath)) {
      try {
        fs.unlinkSync(result.filePath);
      } catch (e) {
        console.error('[Delete] 删除文件失败:', e?.message || String(e));
      }
    }

    return res.json({ ok: true, document_id: docId, deleted: true });
  } catch (e) {
    console.error('[Delete] 删除文档失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '删除失败' });
  }
});

// 获取文档详情（用于预览）
app.get('/documents/:id', (req, res) => {
  try {
    const docId = Number(req.params.id);
    const userId = String(req.query?.user_id || '').trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    if (!docId || isNaN(docId)) {
      return res.status(400).json({ ok: false, error: '无效的文档ID' });
    }

    const doc = getDocument(docId, userId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: '文档不存在' });
    }

    // 尝试读取文件内容（支持文本文件和PDF预览）
    let content = null;
    let canPreview = false;
    let previewUrl = null;
    const ext = path.extname(doc.filename || '').toLowerCase();
    const textExts = ['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml'];

    if (textExts.includes(ext) && doc.file_path && fs.existsSync(doc.file_path)) {
      try {
        content = fs.readFileSync(doc.file_path, 'utf8');
        canPreview = true;
      } catch (e) {
        console.error('[Preview] 读取文件失败:', e?.message || String(e));
      }
    } else if (ext === '.pdf' && doc.file_path && fs.existsSync(doc.file_path)) {
      canPreview = true;
      previewUrl = `/documents/${docId}/preview?user_id=${encodeURIComponent(userId)}`;
    }

    return res.json({
      ok: true,
      document: {
        id: doc.id,
        title: doc.title,
        filename: doc.filename,
        file_size: doc.file_size,
        mime_type: doc.mime_type,
        created_at: doc.created_at,
        can_preview: canPreview,
        preview_url: previewUrl,
        content: content
      }
    });
  } catch (e) {
    console.error('[Preview] 获取文档失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '获取文档失败' });
  }
});

// PDF 内联预览
app.get('/documents/:id/preview', (req, res) => {
  try {
    const docId = Number(req.params.id);
    const userId = String(req.query?.user_id || '').trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    if (!docId || isNaN(docId)) {
      return res.status(400).json({ ok: false, error: '无效的文档ID' });
    }

    const doc = getDocument(docId, userId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: '文档不存在' });
    }

    if (!doc.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }

    if (doc.mime_type) {
      res.setHeader('Content-Type', doc.mime_type);
    }
    res.setHeader('Content-Disposition', 'inline');

    return res.sendFile(path.resolve(doc.file_path));
  } catch (e) {
    console.error('[Preview] 预览文档失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '预览失败' });
  }
});

// 下载文档
app.get('/documents/:id/download', (req, res) => {
  try {
    const docId = Number(req.params.id);
    const userId = String(req.query?.user_id || '').trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    if (!docId || isNaN(docId)) {
      return res.status(400).json({ ok: false, error: '无效的文档ID' });
    }

    const doc = getDocument(docId, userId);
    if (!doc) {
      return res.status(404).json({ ok: false, error: '文档不存在' });
    }

    if (!doc.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }

    // 设置下载头
    const filename = encodeURIComponent(doc.filename || 'download');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    if (doc.mime_type) {
      res.setHeader('Content-Type', doc.mime_type);
    }

    // 发送文件
    return res.sendFile(path.resolve(doc.file_path));
  } catch (e) {
    console.error('[Download] 下载文档失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '下载失败' });
  }
});

// 创建会话
app.post('/conversations', (req, res) => {
  try {
    const userId = String(req.body?.user_id || req.query?.user_id || '').trim();
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    const sessionId = String(req.body?.session_id || req.query?.session_id || genSessionId()).trim();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'session_id 无效' });
    }

    const result = createConversation(userId, sessionId);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[Conversation] 创建会话失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '创建会话失败' });
  }
});

// 会话列表
app.get('/conversations', (req, res) => {
  try {
    const userId = String(req.query?.user_id || '').trim();
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }

    const conversations = loadConversations(userId);
    return res.json({ ok: true, conversations });
  } catch (e) {
    console.error('[Conversation] 获取会话列表失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '获取会话列表失败' });
  }
});

// 删除会话
app.delete('/conversations/:id', (req, res) => {
  try {
    const userId = String(req.body?.user_id || req.query?.user_id || '').trim();
    const sessionId = String(req.params.id || '').trim();
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'session_id 不能为空' });
    }

    const result = deleteConversation(userId, sessionId);
    if (!result.deleted) {
      return res.status(404).json({ ok: false, error: '会话不存在' });
    }

    return res.json({ ok: true, session_id: sessionId, deleted: true });
  } catch (e) {
    console.error('[Conversation] 删除会话失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '删除会话失败' });
  }
});

// 获取会话消息历史
app.get('/conversations/:id/messages', (req, res) => {
  try {
    const userId = String(req.query?.user_id || '').trim();
    const sessionId = String(req.params.id || '').trim();
    const limit = Number.parseInt(String(req.query?.limit || '100'), 10);
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id 不能为空' });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'session_id 不能为空' });
    }

    const history = loadHistory(userId, sessionId, Math.max(1, Math.min(limit, 300)));
    return res.json({ ok: true, messages: history });
  } catch (e) {
    console.error('[Conversation] 获取会话消息失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '获取会话消息失败' });
  }
});

app.post('/chat', async (req, res) => {
  const message = String(req.query?.message || '').trim();
  const userId = String(req.query?.user_id || 'default').trim();
  const sessionId = String(req.query?.session_id || 'default').trim();

  sseInit(res);

  if (!message) {
    sseSend(res, { error: 'message 不能为空' });
    return res.end();
  }

  // 1) 先写入用户消息（持久化记忆）
  saveMessage(userId, sessionId, 'user', message);

  // 2) 拉取历史作为上下文（从旧到新）
  const history = loadHistory(userId, sessionId, Math.max(0, MAX_HISTORY) * 2);

  // 3) 构建 LangChain 消息上下文（当前 user 消息已在 history 中，不重复追加）
  const lcMessages = [
    new SystemMessage(AGENT_SYSTEM_PROMPT),
    new SystemMessage(
      [
        '工具调用策略：',
        '1) 涉及“当前时间/现在几点/日期时间/北京时间”等实时信息时，必须先调用 get_current_time，禁止凭空估计时间。',
        '2) 涉及内部文档、简历、资料类问题时，优先调用 search_knowledge_base。',
        '3) 若无需工具即可准确回答，再直接回答。',
      ].join('\n')
    ),
  ];
  if (Array.isArray(history)) {
    history.forEach((m) => {
      if (m.role === 'user') lcMessages.push(new HumanMessage(m.content));
      if (m.role === 'assistant') lcMessages.push(new AIMessage(m.content));
    });
  }

  try {
    let assistantText = '';
    sseSend(res, { model: DEFAULT_MODEL });

    // 4) Planner：先由模型做工具决策（有工具则返回 tool_calls）
    let plannerResponse = await llmWithTools.invoke(lcMessages);
    
    let toolCalls = Array.isArray(plannerResponse.tool_calls) ? plannerResponse.tool_calls : [];

    // 不需要工具时直接返回模型答案
    if (toolCalls.length === 0) {
      const candidateAnswer = contentToText(plannerResponse.content);
      if (candidateAnswer) {
        const cleaned = sanitizeOutput(candidateAnswer);
        assistantText = cleaned;
        sseSend(res, { text: cleaned });
      }
      if (assistantText) saveMessage(userId, sessionId, 'assistant', assistantText);
      return res.end();
    }

    // 5) Executor：执行工具并把结果写回上下文
    lcMessages.push(plannerResponse);
    for (const toolCall of toolCalls) {
      try {
        const toolResult = await executeToolCall({
          toolCall,
          userId,
          fallbackQuery: message,
          res,
        });
        lcMessages.push(new ToolMessage({ tool_call_id: toolCall.id, content: toolResult }));
      } catch (e) {
        const errText = `工具执行失败: ${e.message}`;
        console.error('[Agent] 工具执行失败:', e);
        lcMessages.push(new ToolMessage({ tool_call_id: toolCall.id, content: errText }));
      }
    }

    // 6) Responder：基于工具结果生成最终答案（不再继续调用工具）
    const finalResponse = await llm.invoke(lcMessages);
    const finalText = contentToText(finalResponse.content);
    if (finalText) {
      const cleaned = sanitizeOutput(finalText);
      assistantText = cleaned;
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
