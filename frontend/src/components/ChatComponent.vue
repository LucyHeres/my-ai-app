<template>
  <div class="chat-container">
    <div class="chat-layout">
      <aside class="session-sidebar">
        <div class="session-header">
          <div class="session-title">会话列表</div>
          <el-button size="small" @click="handleNewChat">+ 新建</el-button>
        </div>
        <div class="session-list">
          <div
            v-for="item in conversations"
            :key="item.session_id"
            class="session-item"
            :class="{ active: item.session_id === currentSessionId }"
            @click="handleSessionClick(item.session_id)"
          >
            <span class="session-item-text">{{ getConversationLabel(item) }}</span>
            <el-button
              class="session-item-delete"
              type="danger"
              text
              size="small"
              @click.stop="handleDeleteSession(item.session_id)"
            >
              删除
            </el-button>
          </div>
          <div v-if="conversations.length === 0" class="session-empty">暂无历史会话</div>
        </div>
      </aside>

      <section class="chat-main">
        <div class="messages-container" ref="messagesContainer">
          <div v-if="messages.length === 0" class="empty-state">
            <div class="empty-icon">🤖</div>
            <div class="empty-title">你好！我是Satori</div>
            <div class="empty-desc">有什么可以帮助你的吗？</div>
          </div>

          <div v-for="(msg, idx) in messages" :key="idx" class="message-box" :class="msg.role">
            <!-- AI 消息：无气泡，宽度占满 -->
            <template v-if="msg.role === 'ai'">
              <div class="ai-message">
                <details v-if="msg.toolCalls && msg.toolCalls.length > 0" class="thinking-panel">
                  <summary class="thinking-summary">
                    <span>已完成思考</span>
                    <span class="thinking-chevron">›</span>
                  </summary>
                  <div class="thinking-content">
                    <div v-for="(step, stepIdx) in msg.toolCalls" :key="stepIdx" class="thinking-step">
                      <div class="thinking-line">
                        <span class="thinking-label">工具：</span>
                        <code>{{ step.name }}</code>
                      </div>
                      <div class="thinking-line">
                        <span class="thinking-label">参数：</span>
                        <code>{{ formatToolArgs(step.args) }}</code>
                      </div>
                    </div>
                  </div>
                </details>
                <div class="message-text markdown-body" v-html="renderMarkdown(msg.content)"></div>
                <div v-if="msg.sources && msg.sources.length > 0 && msg.streamingComplete" class="sources-footer">
                  <div class="sources-left">
                    <span class="sources-label">数据来源：</span>
                    <span v-for="(doc, docIdx) in uniqueSources(msg.sources)" :key="docIdx" class="source-doc">
                      {{ doc.title || doc.filename }}
                    </span>
                  </div>
                  <div class="sources-right">
                    <el-button type="primary" link @click="showRecallDetails(msg.sources)">
                      <el-icon><Document /></el-icon> 召回详情
                    </el-button>
                  </div>
                </div>
              </div>
            </template>
            <!-- 用户消息：保留气泡 -->
            <template v-else>
              <div class="message-bubble user">
                <div class="message-text">{{ msg.content }}</div>
              </div>
            </template>
          </div>
        </div>

        <div class="input-area">
          <div class="input-wrapper">
            <div class="input-header">
              <div class="input-meta">
                <div class="model-name">{{ modelName }}</div>
                <span v-if="!isCurrentPersisted(currentSessionId)" class="draft-tag">草稿会话（未入库）</span>
              </div>
              <div class="input-tip">Enter 发送，Shift+Enter 换行</div>
            </div>
            <el-input
              v-model="inputMessage"
              type="textarea"
              :rows="3"
              placeholder="输入问题，按 Enter 发送，Shift+Enter 换行"
              @keydown="handleKeyDown"
              :disabled="isSending"
            />
          </div>
        </div>
      </section>
    </div>

    <el-drawer
      v-model="drawerVisible"
      title="召回详情"
      direction="rtl"
      size="400px"
    >
      <el-tabs v-model="activeTab">
        <el-tab-pane :label="`召回切片 (${currentSources.length})`" name="slices">
          <div v-for="(slice, index) in currentSources" :key="index" class="slice-item">
            <div class="slice-content">{{ slice.content }}</div>
            <div class="slice-meta">
              <el-icon><Document /></el-icon> {{ slice.title || slice.filename }}
            </div>
            <div class="slice-score">
              <span>召回分数 {{ slice.score?.toFixed(4) }}</span>
              <span class="slice-rank">NO.{{ index + 1 }}</span>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="Prompt 组装" name="prompt">
          <div class="prompt-info">暂无详情</div>
        </el-tab-pane>
      </el-tabs>
    </el-drawer>

  </div>
</template>

<script setup>
import { ref, watch, nextTick, inject, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Document } from '@element-plus/icons-vue'
import { marked } from 'marked'

const globalState = inject('globalState')
const RAG_ENABLED_KEY = 'rag_enabled'

const messages = ref([])
const inputMessage = ref('')
const isSending = ref(false)
const ragEnabled = ref(localStorage.getItem(RAG_ENABLED_KEY) === '1')
const modelName = ref('模型：未加载')
const messagesContainer = ref(null)

const drawerVisible = ref(false)
const currentSources = ref([])
const activeTab = ref('slices')
const conversations = ref([])
const currentSessionId = ref('')

// 配置 marked
marked.setOptions({
  breaks: true,
  gfm: true
})

function renderMarkdown(content) {
  if (!content) return ''
  return marked.parse(content)
}

function showRecallDetails(sources) {
  currentSources.value = sources || []
  activeTab.value = 'slices'
  drawerVisible.value = true
}

function uniqueSources(sources) {
  if (!sources) return [];
  const seen = new Set();
  return sources.filter(doc => {
    const key = doc.document_id || doc.filename;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatToolArgs(args) {
  try {
    return JSON.stringify(args || {})
  } catch {
    return '{}'
  }
}

watch(ragEnabled, (val) => {
  localStorage.setItem(RAG_ENABLED_KEY, val ? '1' : '0')
})

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function mapHistoryToUI(history) {
  return (history || []).map((item) => ({
    role: item.role === 'assistant' ? 'ai' : 'user',
    content: item.content || '',
    sources: [],
    toolCalls: [],
    streamingComplete: true,
  }))
}

function getConversationLabel(item) {
  const text = String(item?.title || '').trim();
  if (!text) return `会话 ${String(item?.session_id || '').slice(0, 8)}`;
  return text.length > 20 ? `${text.slice(0, 20)}...` : text;
}

function genSessionId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isCurrentPersisted(sessionId) {
  return conversations.value.some((c) => c.session_id === sessionId);
}

async function fetchConversations() {
  const userId = globalState.user.id;
  const res = await fetch(`/conversations?user_id=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error('获取会话列表失败');
  const data = await res.json();
  conversations.value = data.conversations || [];
}

async function loadSessionMessages(sessionId) {
  if (!sessionId) {
    messages.value = [];
    return;
  }
  const userId = globalState.user.id;
  const res = await fetch(`/conversations/${encodeURIComponent(sessionId)}/messages?user_id=${encodeURIComponent(userId)}&limit=200`);
  if (!res.ok) throw new Error('获取会话消息失败');
  const data = await res.json();
  messages.value = mapHistoryToUI(data.messages);
  scrollToBottom();
}

async function ensureConversationReady() {
  await fetchConversations();
  if (conversations.value.length === 0) {
    currentSessionId.value = genSessionId();
    messages.value = [];
    return;
  }

  const exists = conversations.value.some((c) => c.session_id === currentSessionId.value);
  if (!exists) {
    currentSessionId.value = conversations.value[0].session_id;
  }
  await loadSessionMessages(currentSessionId.value);
}

async function handleSessionClick(sessionId) {
  try {
    currentSessionId.value = sessionId;
    await loadSessionMessages(sessionId);
  } catch (e) {
    ElMessage.error(e?.message || '切换会话失败');
  }
}

function handleKeyDown(event) {
  // Enter 发送，Shift+Enter 换行
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}

async function sendMessage() {
  const text = inputMessage.value.trim()
  if (!text || isSending.value) return

  if (!currentSessionId.value) {
    currentSessionId.value = genSessionId();
  }

  messages.value.push({ role: 'user', content: text })
  inputMessage.value = ''
  isSending.value = true

  messages.value.push({ role: 'ai', content: '', sources: [], toolCalls: [], streamingComplete: false })
  const aiMsgIndex = messages.value.length - 1

  let fullContent = ''

    try {
      const userId = globalState.user.id
      const sessionId = currentSessionId.value
      const rag = ragEnabled.value ? '&rag=1&rag_mode=lc' : ''
      const url = `/chat?message=${encodeURIComponent(text)}&user_id=${encodeURIComponent(userId)}&session_id=${encodeURIComponent(sessionId)}${rag}`

    const res = await fetch(url, { method: 'POST' })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ detail: res.statusText || 'Error' }))
      throw new Error(data.detail || ('HTTP ' + res.status))
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // 流式传输完成，标记为完成以显示参考文档
        messages.value[aiMsgIndex] = {
          ...messages.value[aiMsgIndex],
          streamingComplete: true
        }
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()

      for (const part of parts) {
        if (part.startsWith('data: ')) {
          const jsonStr = part.slice(6)
          try {
            const data = JSON.parse(jsonStr)
            if (data.text) {
              for (const char of data.text) {
                fullContent += char
                messages.value[aiMsgIndex] = {
                  ...messages.value[aiMsgIndex],
                  content: fullContent
                }
                scrollToBottom()
                await new Promise(resolve => setTimeout(resolve, 5))
              }
            }
            if (data.model) {
              globalState.modelName = `模型：${data.model}`
              modelName.value = `模型：${data.model}`
            }
            if (data.tool_call) {
              const toolCalls = [...(messages.value[aiMsgIndex].toolCalls || [])]
              toolCalls.push({
                name: data.tool_call.name,
                args: data.tool_call.args || {}
              })
              messages.value[aiMsgIndex] = {
                ...messages.value[aiMsgIndex],
                toolCalls
              }
              scrollToBottom()
            }
            if (data.sources) {
              messages.value[aiMsgIndex] = {
                ...messages.value[aiMsgIndex],
                sources: data.sources
              }
            }
          } catch (e) {
            console.error('解析SSE数据失败:', e)
          }
        }
      }
    }
  } catch (e) {
    console.error('[LLM] 调用失败:', e?.message || String(e))
    const errorMsg = `错误：${e.message}`
    fullContent = errorMsg
    messages.value[aiMsgIndex] = {
      ...messages.value[aiMsgIndex],
      content: errorMsg
    }
    ElMessage.error('消息发送失败')
  } finally {
    isSending.value = false
    fetchConversations().catch(() => {})
  }
}

async function handleNewChat() {
  currentSessionId.value = genSessionId();
  messages.value = [];
  ElMessage.success('已新建草稿会话');
}

async function handleDeleteSession(targetSessionId) {
  const sid = targetSessionId || currentSessionId.value;
  if (!sid) return;
  if (!window.confirm('确认删除当前会话？删除后不可恢复。')) return;

  try {
    if (!isCurrentPersisted(sid)) {
      currentSessionId.value = genSessionId();
      messages.value = [];
      ElMessage.success('草稿会话已清空');
      return;
    }

    const userId = globalState.user.id;
    const res = await fetch(`/conversations/${encodeURIComponent(sid)}?user_id=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('删除会话失败');

    await fetchConversations();
    if (conversations.value.length === 0) {
      currentSessionId.value = genSessionId();
      messages.value = [];
    } else {
      currentSessionId.value = conversations.value[0].session_id;
      await loadSessionMessages(currentSessionId.value);
    }
    ElMessage.success('会话已删除');
  } catch (e) {
    ElMessage.error(e?.message || '删除会话失败');
  }
}

onMounted(() => {
  ensureConversationReady().catch((e) => {
    ElMessage.error(e?.message || '初始化会话失败');
  });
});

watch(() => globalState.user.id, () => {
  currentSessionId.value = '';
  ensureConversationReady().catch((e) => {
    ElMessage.error(e?.message || '加载会话失败');
  });
});
</script>

<style scoped>
.chat-container {
  flex: 1;
  display: flex;
  background: #f8fafc;
  height: 100%;
}

.chat-layout {
  flex: 1;
  display: flex;
  min-height: 0;
}

.session-sidebar {
  width: 260px;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
}

.session-header {
  padding: 12px;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.session-title {
  font-size: 14px;
  color: #334155;
  font-weight: 600;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-item {
  width: 100%;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
  color: #334155;
  font-size: 13px;
  line-height: 1.4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.session-item:hover {
  background: #f8fafc;
}

.session-item.active {
  background: #eff6ff;
  color: #1d4ed8;
}

.session-item-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-delete {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.session-item:hover .session-item-delete,
.session-item:focus-within .session-item-delete {
  opacity: 1;
  pointer-events: auto;
}

.session-empty {
  color: #94a3b8;
  font-size: 12px;
  padding: 8px 10px;
}

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: #9ca3af;
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}

.empty-desc {
  font-size: 14px;
}

.message-box {
  margin-bottom: 24px;
}

.message-box.user {
  display: flex;
  justify-content: flex-end;
}

/* AI 消息：无气泡，占满宽度 */
.ai-message {
  width: 100%;
}

.thinking-panel {
  /* border-left: 3px solid #dbeafe; */
  background: #f8fafc;
  border-radius: 8px;
  padding: 8px 10px 8px 0;
  margin-bottom: 10px;
}

.thinking-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 500;
  list-style: none;
}

.thinking-summary::-webkit-details-marker {
  display: none;
}

.thinking-chevron {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
  transform: rotate(0deg);
  transition: transform 0.2s ease;
}

.thinking-panel[open] .thinking-chevron {
  transform: rotate(90deg);
}

.thinking-content {
  margin-top: 8px;
  font-size: 13px;
  color: #64748b;
}

.thinking-step {
  margin-bottom: 8px;
}

.thinking-step:last-child {
  margin-bottom: 0;
}

.thinking-line {
  line-height: 1.6;
}

.thinking-label {
  color: #94a3b8;
  margin-right: 4px;
}

/* 用户消息：保留气泡 */
.message-bubble.user {
  background: rgba(0,0,0,.04);
  color: #000;
  padding: 12px 16px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 700px;
}

/* Markdown 样式 */
.markdown-body {
  line-height: 1.7;
}

.markdown-body :deep(p) {
  margin: 0 0 8px 0;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(strong) {
  font-weight: 600;
  color: #1e293b;
}

.markdown-body :deep(em) {
  font-style: italic;
}

.markdown-body :deep(code) {
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
  color: #e11d48;
}

.markdown-body :deep(pre) {
  background: #1e293b;
  padding: 12px 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
}

.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  color: #e2e8f0;
  font-size: 0.9em;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 12px 0 8px 0;
  font-weight: 600;
  color: #1e293b;
}

.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.25em; }
.markdown-body :deep(h3) { font-size: 1.1em; }

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 8px 0;
  padding-left: 24px;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid #e2e8f0;
  padding-left: 12px;
  margin: 8px 0;
  color: #64748b;
  font-size: 14px;
}

.markdown-body :deep(a) {
  color: #3b82f6;
  text-decoration: underline;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: #f8fafc;
  font-weight: 600;
}

.sources-footer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.sources-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}

.sources-right {
  margin-left: auto;
}

.sources-label {
  color: #64748b;
  margin-right: 4px;
}

.source-doc {
  background: #f1f5f9;
  padding: 2px 8px;
  border-radius: 12px;
  color: #475569;
  font-weight: 500;
}

.slice-item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  background: #fff;
}

.slice-content {
  font-size: 14px;
  color: #334155;
  line-height: 1.6;
  margin-bottom: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.slice-meta {
  font-size: 12px;
  color: #3b82f6;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.slice-score {
  font-size: 12px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 8px;
}

.slice-rank {
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.prompt-info {
  color: #9ca3af;
  text-align: center;
  padding: 40px 0;
}

.input-area {
  background: white;
  border-top: 1px solid #e5e7eb;
  padding: 20px 24px;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
}


.input-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.input-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-tip {
  color: #9ca3af;
  font-size: 12px;
}

.draft-tag {
  font-size: 12px;
  color: #0f766e;
  background: #ecfeff;
  border: 1px solid #ccfbf1;
  border-radius: 999px;
  padding: 2px 8px;
}

.input-footer {
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.model-name {
  color: #9ca3af;
  font-size: 14px;
}

</style>
