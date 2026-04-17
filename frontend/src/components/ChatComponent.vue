<template>
  <div class="chat-container">
    <div class="messages-container" ref="messagesContainer">
      <div v-if="messages.length === 0" class="empty-state">
        <div class="empty-icon">🤖</div>
        <div class="empty-title">你好！我是智能助手</div>
        <div class="empty-desc">有什么可以帮助你的吗？</div>
      </div>

      <div v-for="(msg, idx) in messages" :key="idx" class="message-box" :class="msg.role">
        <div class="message-avatar" :class="msg.role">
          {{ msg.role === 'user' ? '我' : '🤖' }}
        </div>
        <div class="message-bubble" :class="msg.role">
          {{ msg.content }}
        </div>
      </div>
    </div>

    <div class="input-area">
      <div class="input-wrapper">
        <div class="input-header">
          <el-checkbox v-model="ragEnabled" size="large">聊天中启用知识库</el-checkbox>
          <el-button @click="handleNewChat">+ 新建对话</el-button>
        </div>
        <el-input
          v-model="inputMessage"
          type="textarea"
          :rows="3"
          placeholder="输入问题，按 Ctrl+Enter 发送"
          @keydown.ctrl.enter="sendMessage"
          :disabled="isSending"
        />
        <div class="input-footer">
          <div class="model-name">{{ modelName }}</div>
          <el-button type="primary" @click="sendMessage" :loading="isSending">
            发送 <el-icon><Right /></el-icon>
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, inject } from 'vue'
import { ElMessage } from 'element-plus'

const globalState = inject('globalState')
const getSessionIdByUser = inject('getSessionIdByUser')
const newSessionForUser = inject('newSessionForUser')
const RAG_ENABLED_KEY = 'rag_enabled'

const messages = ref([])
const inputMessage = ref('')
const isSending = ref(false)
const ragEnabled = ref(localStorage.getItem(RAG_ENABLED_KEY) === '1')
const modelName = ref('模型：未加载')
const messagesContainer = ref(null)

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

async function sendMessage() {
  const text = inputMessage.value.trim()
  if (!text || isSending.value) return

  messages.value.push({ role: 'user', content: text })
  inputMessage.value = ''
  isSending.value = true

  messages.value.push({ role: 'ai', content: '' })
  const aiMsgIndex = messages.value.length - 1

  let aiBubbleEl = null
  await nextTick()
  const bubbles = document.querySelectorAll('.message-bubble.ai')
  aiBubbleEl = bubbles[bubbles.length - 1]

  let fullContent = ''

    try {
      const userId = globalState.user.id
      const sessionId = getSessionIdByUser(userId)
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
      if (done) break

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
                if (aiBubbleEl) {
                  aiBubbleEl.textContent = fullContent
                }
                messages.value[aiMsgIndex] = {
                  ...messages.value[aiMsgIndex],
                  content: fullContent
                }
                scrollToBottom()
                await new Promise(resolve => setTimeout(resolve, 20))
              }
            }
            if (data.model) {
              globalState.modelName = `模型：${data.model}`
              modelName.value = `模型：${data.model}`
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
    if (aiBubbleEl) {
      aiBubbleEl.textContent = errorMsg
    }
    messages.value[aiMsgIndex] = {
      ...messages.value[aiMsgIndex],
      content: errorMsg
    }
    ElMessage.error('消息发送失败')
  } finally {
    isSending.value = false
  }
}

function handleNewChat() {
  newSessionForUser(globalState.user.id)
  messages.value = []
  ElMessage.success('已创建新会话')
}
</script>

<style scoped>
.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f8fafc;
  height: 100%;
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
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  max-width: 700px;
}

.message-box.user {
  margin-left: auto;
  flex-direction: row-reverse;
}

.message-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 18px;
}

.message-avatar.ai {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message-avatar.user {
  background: #e5e7eb;
}

.message-bubble {
  padding: 12px 16px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-bubble.ai {
  background: white;
  border: 1px solid #e5e7eb;
}

.message-bubble.user {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
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

.input-footer .el-button--primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}
</style>
