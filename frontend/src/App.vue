<template>
  <div class="app-container">
    <el-header class="gradient-bg">
      <div class="header-left">
        <div class="logo">📚</div>
        <span class="title">知识库问答智能体</span>
      </div>

      <div class="header-center">
        <el-tabs v-model="currentPath" class="header-tabs" @tab-click="handleTabClick">
          <el-tab-pane label="智能问答" name="/chat" />
          <el-tab-pane label="知识库" name="/documents" />
        </el-tabs>
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
    </el-main>
  </div>
</template>

<script setup>
import { ref, watch, reactive, provide } from 'vue'
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

const currentPath = ref(route.path)
const globalState = reactive({
  user: getCurrentUser(),
  modelName: '模型：未加载'
})

// 使用 provide 向子组件提供全局状态
provide('globalState', globalState)
provide('getSessionIdByUser', getSessionIdByUser)
provide('newSessionForUser', newSessionForUser)

watch(() => route.path, (path) => {
  currentPath.value = path
})

function handleTabClick(pane) {
  router.push(pane.props.name)
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
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 24px;
  min-height: 64px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.header-tabs {
  --el-tabs-header-height: 44px;
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
  gap: 12px;
}

.logo {
  width: 40px;
  height: 40px;
  background: rgba(255,255,255,0.2);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.title {
  font-size: 20px;
  font-weight: 600;
  color: white;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right .el-button {
  background: rgba(255,255,255,0.15);
  border: none;
}

.header-tabs {
  --el-tabs-header-height: 44px;
  width: 100%;
}

.header-center {
  min-width: 300px;
  display: flex;
  justify-content: center;
  justify-self: center;
}
.header-tabs .el-tabs__header {
  margin: 0;
}
.header-tabs .el-tabs__nav-wrap {
  display: flex;
  justify-content: center;
}
.header-tabs .el-tabs__nav-wrap::after {
  display: none;
}
.header-tabs .el-tabs__nav {
  gap: 16px;
}
.gradient-bg .header-tabs .el-tabs__item {
  color: #fff !important;
  font-size: 15px;
  font-weight: 500;
  height: 44px;
  line-height: 44px;
  padding: 0 8px;
  transition: color 0.2s ease;
  opacity: 1;
}
.gradient-bg .header-tabs .el-tabs__item:hover {
  color: #fff !important;
}
.gradient-bg .header-tabs .el-tabs__item.is-active {
  color: #fff !important;
  font-weight: 600;
}
.gradient-bg .header-tabs .el-tabs__active-bar {
  background: #fff !important;
  height: 2px;
}
</style>
