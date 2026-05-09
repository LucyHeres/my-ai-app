<template>
  <div class="app-container">
    <el-header class="gradient-bg">
      <div class="header-left">
        <div class="logo">
          <img src="./assets/satori.png" style="width: 40px;" alt="Satori" />
        </div>
        <span class="title">Satori</span>
      </div>

      <div class="header-right">
        <el-button circle @click="handleSwitchUser">
          <el-icon><User /></el-icon>
        </el-button>
      </div>
    </el-header>

    <el-main class="main-content">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>

      <el-button class="kb-fab" type="primary" @click="goKnowledgeBase">
        {{ isDocumentsPage ? '返回聊天' : '知识库' }}
      </el-button>
    </el-main>
  </div>
</template>

<script setup>
import { computed, reactive, provide } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'

const router = useRouter()
const route = useRoute()

const USERS_KEY = 'chat_users'
const CURRENT_USER_KEY = 'chat_current_user'
const SESSION_MAP_KEY = 'chat_session_by_user'

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') ?? fallback; } catch { return fallback; }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function getCurrentUser() {
  const u = loadJson(CURRENT_USER_KEY, null)
  if (u && u.id && u.name) return u
  const users = loadJson(USERS_KEY, {})
  const name = '游客'
  const id = users[name] || newId()
  users[name] = id
  saveJson(USERS_KEY, users)
  const user = { id, name }
  saveJson(CURRENT_USER_KEY, user)
  return user
}

function setCurrentUser(name) {
  const users = loadJson(USERS_KEY, {})
  const id = users[name] || newId()
  users[name] = id
  saveJson(USERS_KEY, users)
  const user = { id, name }
  saveJson(CURRENT_USER_KEY, user)
  return user
}

function getSessionIdByUser(userId) {
  const map = loadJson(SESSION_MAP_KEY, {})
  let sid = map[userId]
  if (!sid) {
    sid = newId()
    map[userId] = sid
    saveJson(SESSION_MAP_KEY, map)
  }
  return sid
}

function newSessionForUser(userId) {
  const map = loadJson(SESSION_MAP_KEY, {})
  const sid = newId()
  map[userId] = sid
  saveJson(SESSION_MAP_KEY, map)
  return sid
}

const globalState = reactive({
  user: getCurrentUser(),
  modelName: '模型：未加载'
})
const isDocumentsPage = computed(() => route.path === '/documents')

// 使用 provide 向子组件提供全局状态
provide('globalState', globalState)
provide('getSessionIdByUser', getSessionIdByUser)
provide('newSessionForUser', newSessionForUser)

function goKnowledgeBase() {
  if (isDocumentsPage.value) {
    router.push('/chat')
    return
  }
  router.push('/documents')
}

async function handleSwitchUser() {
  const name = prompt('输入用户名（用于本地模拟登录/切换）', globalState.user.name)
  if (!name) return
  globalState.user = setCurrentUser(name.trim())
  newSessionForUser(globalState.user.id)
  ElMessage.success('已切换用户')
}
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }

.gradient-bg {
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  min-height: 56px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 18px;
}

.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

.app-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.main-content {
  flex: 1;
  overflow: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.header-left {
  display: flex;
  align-items: center;
}

.logo {
  width: 40px;
  height: 40px;
  /* background: rgba(255,255,255,0.2); */
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.title {
  font-size: 18px;
  font-weight: 500;
  color: #111827;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right .el-button {
  background: #fff;
  border: 1px solid #e5e7eb;
  color: #111827;
}

.kb-fab {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 20;
}
</style>
