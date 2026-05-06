<template>
  <div class="documents-container">
    <div class="page-header">
      <h2>知识库</h2>
      <div class="header-actions">
        <el-input v-model="searchKeyword" placeholder="搜索文档..." prefix-icon="Search" style="width: 240px;" />
        <el-button type="primary" @click="fileInput && fileInput.click()">
          <el-icon><Upload /></el-icon> 上传文档
        </el-button>
        <input ref="fileInput" type="file" multiple style="display: none;" @change="handleFileChange" />
      </div>
    </div>

    <div v-if="uploadFiles.length > 0" class="upload-section">
      <div class="upload-header">
        <span class="upload-title">待上传文件 ({{ uploadFiles.length }})</span>
        <div class="upload-actions">
          <el-button @click="uploadFiles = []" :disabled="isUploading">清空</el-button>
          <el-button type="primary" @click="startUpload" :loading="isUploading" :disabled="isUploading">
            {{ isUploading ? '上传中...' : '开始上传' }}
          </el-button>
        </div>
      </div>
      <div class="upload-file-list">
        <div v-for="(file, idx) in uploadFiles" :key="idx" class="upload-file-item">
          <span class="file-icon-small">{{ getFileIcon(file.name).icon }}</span>
          <span class="upload-file-name">{{ file.name }}</span>
          <span class="upload-file-size">{{ formatFileSize(file.size) }}</span>
        </div>
      </div>
    </div>

    <div class="main-layout">
      <div class="sidebar">
        <div v-if="loadingDocs" class="sidebar-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
        </div>
        <div v-else-if="filteredDocuments.length === 0" class="sidebar-empty">暂无文档</div>
        <div
          v-for="doc in filteredDocuments"
          :key="doc.id"
          class="doc-item"
          :class="{ active: previewDoc?.id === doc.id }"
          @click="previewDocument(doc)"
        >
          <div class="doc-item-icon" :class="getFileIcon(doc.filename).class">
            {{ getFileIcon(doc.filename).icon }}
          </div>
          <div class="doc-item-info">
            <div class="doc-item-title" :title="doc.title || doc.filename">{{ doc.title || doc.filename || '未命名文档' }}</div>
            <div class="doc-item-meta">{{ formatFileSize(doc.file_size) }}</div>
          </div>
          <div class="doc-item-actions">
            <el-button link type="primary" @click.stop="downloadDocument(doc)" title="下载">
              <el-icon><Download /></el-icon>
            </el-button>
            <el-button link type="danger" @click.stop="deleteDocument(doc)" title="删除">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
      </div>

      <div class="preview-area">
        <div v-if="!previewDoc" class="preview-empty">
          <div class="preview-empty-icon">📄</div>
          <div>选择文档以预览</div>
        </div>
        <template v-else>
          <div class="preview-header">
            <div class="preview-file-info">
              <span class="preview-filename">{{ previewDoc.filename }}</span>
              <span class="preview-meta">{{ formatFileSize(previewDoc.file_size) }} &middot; {{ formatDate(previewDoc.created_at) }}</span>
            </div>
            <el-button type="primary" size="small" @click="downloadDocument(previewDoc)">
              <el-icon><Download /></el-icon> 下载
            </el-button>
          </div>
          <div class="preview-body">
            <div v-if="previewDoc?.can_preview && previewDoc?.preview_url" class="preview-pdf">
              <iframe :src="previewDoc.preview_url" class="pdf-iframe" />
            </div>
            <div v-else-if="previewDoc?.can_preview && previewContent" class="preview-content">{{ previewContent }}</div>
            <div v-else class="no-preview">
              <div class="no-preview-icon">📄</div>
              <div>该文件类型暂不支持在线预览，请下载后查看</div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, inject, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'

const globalState = inject('globalState')

const documents = ref([])
const loadingDocs = ref(false)
const uploadFiles = ref([])
const isUploading = ref(false)
const searchKeyword = ref('')
const previewDoc = ref(null)
const previewContent = ref('')
const fileInput = ref(null)

const filteredDocuments = computed(() => {
  const kw = searchKeyword.value.trim().toLowerCase()
  if (!kw) return documents.value
  return documents.value.filter(d =>
    (d.title || d.filename || '').toLowerCase().includes(kw)
  )
})

async function loadDocuments() {
  loadingDocs.value = true
  try {
    const res = await fetch(`/documents?user_id=${encodeURIComponent(globalState.user.id)}`)
    const data = await res.json()
    if (data.ok && data.documents) {
      documents.value = data.documents
    }
  } catch (e) {
    console.error('加载文档失败:', e)
    ElMessage.error('加载文档失败')
  } finally {
    loadingDocs.value = false
  }
}

function handleFileChange(event) {
  const fileList = event.target.files
  if (!fileList || fileList.length === 0) return
  uploadFiles.value = Array.from(fileList)
}

async function uploadFile(file) {
  try {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('user_id', globalState.user.id)

    const res = await fetch('/documents/upload', {
      method: 'POST',
      body: formData
    })

    const data = await res.json()
    if (!data.ok) {
      throw new Error(data.error || '上传失败')
    }

    ElMessage.success(`上传成功: ${file.name}`)
    return true
  } catch (e) {
    console.error('上传失败:', e)
    ElMessage.error(`上传失败: ${file.name} - ${e.message}`)
    return false
  }
}

async function startUpload() {
  if (uploadFiles.value.length === 0) {
    ElMessage.warning('请先选择文件')
    return
  }

  isUploading.value = true
  let successCount = 0

  for (const file of uploadFiles.value) {
    const ok = await uploadFile(file)
    if (ok) successCount++
  }

  if (successCount > 0) {
    loadDocuments()
  }

  uploadFiles.value = []
  isUploading.value = false
}

async function previewDocument(doc) {
  try {
    const res = await fetch(`/documents/${doc.id}?user_id=${encodeURIComponent(globalState.user.id)}`)
    const data = await res.json()
    if (!data.ok || !data.document) {
      throw new Error(data.error || '获取文档失败')
    }

    previewDoc.value = data.document
    previewContent.value = data.document.content || ''
  } catch (e) {
    console.error('预览失败:', e)
    ElMessage.error('预览失败: ' + (e.message || '未知错误'))
  }
}

function downloadDocument(doc) {
  if (!doc) return
  const url = `/documents/${doc.id}/download?user_id=${encodeURIComponent(globalState.user.id)}`
  window.open(url, '_blank')
}

async function deleteDocument(doc) {
  try {
    await ElMessageBox.confirm('确定要删除这个文档吗？删除后不可恢复。', '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })

    const res = await fetch(`/documents/${doc.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: globalState.user.id })
    })

    const data = await res.json()
    if (!data.ok) {
      throw new Error(data.error || '删除失败')
    }

    if (previewDoc.value?.id === doc.id) {
      previewDoc.value = null
      previewContent.value = ''
    }

    ElMessage.success('删除成功')
    loadDocuments()
  } catch (e) {
    if (e !== 'cancel') {
      console.error('删除失败:', e)
      ElMessage.error('删除失败: ' + (e.message || '未知错误'))
    }
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '-'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || ''
  if (ext === 'pdf') return { icon: '📕', class: 'pdf' }
  if (['doc', 'docx'].includes(ext)) return { icon: '📘', class: 'docx' }
  if (['ppt', 'pptx'].includes(ext)) return { icon: '📙', class: 'pptx' }
  return { icon: '📄', class: 'txt' }
}

onMounted(() => {
  loadDocuments()
})
</script>

<style scoped>
.documents-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
  background: #f5f7fa;
  height: 100%;
  overflow: hidden;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-shrink: 0;
}

.page-header h2 {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.header-actions .el-button--primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}

/* 上传区域 */
.upload-section {
  background: white;
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  flex-shrink: 0;
}

.upload-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.upload-title {
  font-weight: 600;
  font-size: 14px;
}

.upload-actions {
  display: flex;
  gap: 12px;
}

.upload-actions .el-button--primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}

.upload-file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.upload-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f9fafb;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
}

.file-icon-small {
  font-size: 18px;
}

.upload-file-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-file-size {
  font-size: 12px;
  color: #9ca3af;
}

/* 主布局：左列表 + 右预览 */
.main-layout {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

/* 左侧文档列表 */
.sidebar {
  width: 280px;
  min-width: 280px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  overflow-y: auto;
  flex-shrink: 0;
}

.sidebar-loading,
.sidebar-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  color: #9ca3af;
  font-size: 14px;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.15s;
  position: relative;
}

.doc-item:last-child {
  border-bottom: none;
}

.doc-item:hover {
  background: #f5f7fa;
}

.doc-item.active {
  background: #eef2ff;
}

.doc-item-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.doc-item-icon.pdf { background: #fee2e2; color: #dc2626; }
.doc-item-icon.docx { background: #dbeafe; color: #2563eb; }
.doc-item-icon.pptx { background: #fed7aa; color: #ea580c; }
.doc-item-icon.txt { background: #e5e7eb; color: #4b5563; }

.doc-item-info {
  flex: 1;
  min-width: 0;
}

.doc-item-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.doc-item-meta {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 2px;
}

.doc-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.doc-item:hover .doc-item-actions {
  opacity: 1;
}

.doc-item-actions .el-button {
  padding: 4px;
}

/* 右侧预览区域 */
.preview-area {
  flex: 1;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  font-size: 14px;
}

.preview-empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.preview-file-info {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.preview-filename {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-meta {
  font-size: 12px;
  color: #9ca3af;
  white-space: nowrap;
}

.preview-header .el-button--primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}

.preview-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.preview-pdf {
  width: 100%;
  height: 100%;
}

.pdf-iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.preview-content {
  height: 100%;
  overflow-y: auto;
  padding: 20px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.7;
  font-size: 14px;
  color: #333;
}

.no-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #9ca3af;
}

.no-preview-icon {
  font-size: 48px;
  margin-bottom: 16px;
}
</style>
