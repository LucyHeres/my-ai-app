import path from 'path';
import fs from 'fs';
import express from 'express';
import multer from 'multer';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ChatOpenAI } from '@langchain/openai';
import { initDb, saveMessage, loadHistory, saveDocument, loadDocuments, getDocument, deleteDocument } from './db/db.js';
import { createOutputSanitizer } from './utils/output_sanitize.js';
import { ragIngest } from './rag/rag.js';
import { loadDocument } from './rag/rag_document_loader.js';
import { ensureEmbeddingsForDocument, vectorSearch } from './rag/rag_vector.js';
import { buildChatMessagesWithLangChain } from './rag/rag_langchain.js';

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
  }
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
      const content = await loadDocument(req.file.path);
      if (content && content.trim()) {
        const ragResult = await ragIngest(userId, result.document_id, docTitle, content);
        ensureEmbeddingsForDocument(userId, ragResult.document_id).catch((e) => {
          console.error('[RAG] 文档生成向量失败:', e?.message || String(e));
        });
        console.log(`[RAG] 文档 ${docTitle} 已摄入，chunk 数量: ${ragResult.chunks}`);
      } else {
        console.warn(`[RAG] 文档 ${docTitle} 内容为空，跳过摄入`);
      }
    } catch (e) {
      console.error('[RAG] 文档内容提取失败:', e?.message || String(e));
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

    // 尝试读取文件内容（仅支持文本文件预览）
    let content = null;
    let canPreview = false;
    const ext = path.extname(doc.filename || '').toLowerCase();
    const textExts = ['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml'];

    if (textExts.includes(ext) && doc.file_path && fs.existsSync(doc.file_path)) {
      try {
        content = fs.readFileSync(doc.file_path, 'utf8');
        canPreview = true;
      } catch (e) {
        console.error('[Preview] 读取文件失败:', e?.message || String(e));
      }
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
        content: content
      }
    });
  } catch (e) {
    console.error('[Preview] 获取文档失败:', e?.message || String(e));
    return res.status(500).json({ ok: false, error: '获取文档失败' });
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
  let sourceDocuments = [];
  if (rag) {
    try {
      ragHits = await vectorSearch(userId, message);

      // 收集来源文档 - 只保留相似度最高的文档
      if (ragHits.length > 0 && ragHits[0].document_id) {
        const bestHit = ragHits[0];
        sourceDocuments = [{
          document_id: bestHit.document_id,
          title: bestHit.title,
          filename: bestHit.filename
        }];
        // 发送来源文档信息给前端
        sseSend(res, { sources: sourceDocuments });
      }
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
