<template>
  <div class="documents-container">
    <div class="content-wrapper">
      <div class="page-header">
        <h2>知识库</h2>
        <div class="header-actions">
          <el-input v-model="searchKeyword" placeholder="搜索文档..." prefix-icon="Search" style="width: 300px;" />
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
        <div class="file-list">
          <div v-for="(file, idx) in uploadFiles" :key="idx" class="file-item">
            <span class="file-icon">{{ getFileIcon(file.name).icon }}</span>
            <span class="file-name">{{ file.name }}</span>
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
          </div>
        </div>
      </div>

      <el-card class="documents-card">
        <el-table :data="documents" v-loading="loadingDocs" style="width: 100%;">
          <el-table-column prop="title" label="文档名称" min-width="300">
            <template #default="{ row }">
              <div class="document-info">
                <div class="file-icon" :class="getFileIcon(row.filename).class">
                  {{ getFileIcon(row.filename).icon }}
                </div>
                <span class="doc-title">{{ row.title || row.filename || '未命名文档' }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="file_size" label="大小" width="120">
            <template #default="{ row }">{{ formatFileSize(row.file_size) }}</template>
          </el-table-column>
          <el-table-column prop="created_at" label="上传时间" width="140">
            <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="previewDocument(row)">
                <el-icon><View /></el-icon>
              </el-button>
              <el-button link type="primary" @click="downloadDocument(row)">
                <el-icon><Download /></el-icon>
              </el-button>
              <el-button link type="danger" @click="deleteDocument(row)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <template #empty>
          <div class="empty-state">暂无文档，请上传</div>
        </template>
      </el-card>
    </div>

    <el-dialog v-model="previewVisible" title="文档预览" width="800px" :close-on-click-modal="false">
      <div v-if="previewDoc" class="preview-info">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="文件名">{{ previewDoc.filename }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{ formatFileSize(previewDoc.file_size) }}</el-descriptions-item>
          <el-descriptions-item label="上传时间">{{ formatDate(previewDoc.created_at) }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <div v-if="previewDoc?.can_preview && previewContent" class="preview-content">{{ previewContent }}</div>
      <div v-else-if="previewDoc" class="no-preview">
        <div class="no-preview-icon">📄</div>
        <div>该文件类型暂不支持在线预览，请下载后查看</div>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadDocument(previewDoc)">
          <el-icon><Download /></el-icon> 下载
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, inject, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const globalState = inject('globalState')

const documents = ref([])
const loadingDocs = ref(false)
const uploadFiles = ref([])
const isUploading = ref(false)
const searchKeyword = ref('')
const previewVisible = ref(false)
const previewDoc = ref(null)
const previewContent = ref('')
const fileInput = ref(null)

async function loadDocuments() {
  loadingDocs.value = true
  try {
    const res = await fetch(`/documents?user_id=${encodeURIComponent(globalState.user.id)}`)
    const data = await res.json()
    console.log('收到的文档列表:', data.documents)
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
    previewVisible.value = true
  } catch (e) {
    console.error('预览失败:', e)
    ElMessage.error('预览失败: ' + (e.message || '未知错误'))
  }
}

function downloadDocument(doc) {
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
  overflow-y: auto;
  padding: 24px;
  background: #f5f7fa;
  height: 100%;
}

.content-wrapper {
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
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

.upload-section {
  background: white;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

.upload-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.upload-title {
  font-weight: 600;
}

.upload-actions {
  display: flex;
  gap: 12px;
}

.upload-actions .el-button--primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}

.file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f9fafb;
  padding: 10px 14px;
  border-radius: 10px;
}

.file-item .file-icon {
  font-size: 24px;
}

.file-item .file-name {
  font-size: 14px;
}

.file-item .file-size {
  font-size: 12px;
  color: #9ca3af;
}

.documents-card {
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

.document-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.document-info .file-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}

.document-info .file-icon.pdf { background: #fee2e2; color: #dc2626; }
.document-info .file-icon.docx { background: #dbeafe; color: #2563eb; }
.document-info .file-icon.pptx { background: #fed7aa; color: #ea580c; }
.document-info .file-icon.txt { background: #e5e7eb; color: #4b5563; }

.doc-title {
  font-weight: 500;
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: #9ca3af;
}

.preview-info {
  margin-bottom: 20px;
}

.preview-content {
  max-height: 60vh;
  overflow-y: auto;
  background: #f9fafb;
  padding: 20px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.7;
}

.no-preview {
  text-align: center;
  padding: 40px;
  color: #9ca3af;
}

.no-preview-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

:deep(.el-dialog__footer .el-button--primary) {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
}
</style>
