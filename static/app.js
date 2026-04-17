const el = {
  messages: document.getElementById('messages'),
  form: document.getElementById('form'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  model: document.getElementById('model'),
  user: document.getElementById('user'),
  switchUser: document.getElementById('switchUser'),
  newChat: document.getElementById('newChat'),
  ragEnabled: document.getElementById('ragEnabled'),
  ragIngest: document.getElementById('ragIngest'),
  ragStatus: document.getElementById('ragStatus'),
  ragStatus2: document.getElementById('ragStatus2'),
  ragTitle: document.getElementById('ragTitle'),
  ragText: document.getElementById('ragText'),
  tabChat: document.getElementById('tabChat'),
  tabRag: document.getElementById('tabRag'),
  chatPanel: document.getElementById('chatPanel'),
  ragPanel: document.getElementById('ragPanel'),
  // 文档上传相关
  fileUpload: document.getElementById('fileUpload'),
  docList: document.getElementById('docList'),
  uploadStatus: document.getElementById('uploadStatus'),
  docSearch: document.getElementById('docSearch'),
  // 预览弹窗相关
  previewModal: document.getElementById('previewModal'),
  previewTitle: document.getElementById('previewTitle'),
  previewInfo: document.getElementById('previewInfo'),
  previewContent: document.getElementById('previewContent'),
  previewClose: document.getElementById('previewClose'),
  previewCloseBtn: document.getElementById('previewCloseBtn'),
  previewDownload: document.getElementById('previewDownload'),
}

// 下面这些 localStorage key 是"前端本地模拟"的用户/会话系统：
// - USERS_KEY：用户名 -> user_id 的映射
// - CURRENT_USER_KEY：当前选中的用户
// - SESSION_MAP_KEY：每个 user_id 当前会话的 session_id
// 对后端来说：user_id + session_id 共同决定"读哪一段历史"和"写到哪一段历史"
const USERS_KEY = 'chat_users';
const CURRENT_USER_KEY = 'chat_current_user';
const SESSION_MAP_KEY = 'chat_session_by_user';

// rag_enabled：是否启用知识库（RAG）
// 对后端来说：启用后会在 /chat 请求里追加 rag=1，后端会先检索知识库片段再让模型回答
const RAG_ENABLED_KEY = 'rag_enabled';

function newId(){
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
}

function loadJson(key, fallback){
  try{
    return JSON.parse(localStorage.getItem(key) || '') ?? fallback;
  }catch{
    return fallback;
  }
}

function saveJson(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

function getCurrentUser(){
  const u = loadJson(CURRENT_USER_KEY, null);
  if(u && u.id && u.name) return u;
  const users = loadJson(USERS_KEY, {});
  const name = '游客';
  const id = users[name] || newId();
  users[name] = id;
  saveJson(USERS_KEY, users);
  const user = { id, name };
  saveJson(CURRENT_USER_KEY, user);
  return user;
}

function setCurrentUser(name){
  const users = loadJson(USERS_KEY, {});
  const id = users[name] || newId();
  users[name] = id;
  saveJson(USERS_KEY, users);
  const user = { id, name };
  saveJson(CURRENT_USER_KEY, user);
  return user;
}

function getSessionIdByUser(userId){
  const map = loadJson(SESSION_MAP_KEY, {});
  let sid = map[userId];
  if(!sid){
    sid = newId();
    map[userId] = sid;
    saveJson(SESSION_MAP_KEY, map);
  }
  return sid;
}

function newSessionForUser(userId){
  const map = loadJson(SESSION_MAP_KEY, {});
  const sid = newId();
  map[userId] = sid;
  saveJson(SESSION_MAP_KEY, map);
  return sid;
}

function renderUser(){
  const user = getCurrentUser();
  if(el.user) el.user.textContent = `用户：${user.name}`;
}

function clearMessages(){
  el.messages.innerHTML = '';
}

function isRagEnabled(){
  return localStorage.getItem(RAG_ENABLED_KEY) === '1';
}

function setRagEnabled(v){
  localStorage.setItem(RAG_ENABLED_KEY, v ? '1' : '0');
}

function setRagStatus(text){
  if(el.ragStatus) el.ragStatus.textContent = text;
  if(el.ragStatus2) el.ragStatus2.textContent = text;
}

function switchTab(tab){
  const isChat = tab === 'chat';
  if(el.tabChat) el.tabChat.classList.toggle('active', isChat);
  if(el.tabRag) el.tabRag.classList.toggle('active', !isChat);
  if(el.chatPanel) el.chatPanel.classList.toggle('active', isChat);
  if(el.ragPanel) el.ragPanel.classList.toggle('active', !isChat);
}

function append(role, text){
  const row = document.createElement('div');
  row.className = `msg ${role}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? '张' : '🤖';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  row.append(roleEl, bubble);
  el.messages.appendChild(row);
  el.messages.scrollTop = el.messages.scrollHeight;
  return bubble;
}

// 这里的 send 函数使用了 Fetch API + ReadableStream 来处理 SSE 流式响应
// 类似前端处理视频流或长连接数据的方式
async function send(text){
  el.send.disabled = true;
  try{
    const user = getCurrentUser();
    const userId = user.id;
    const sessionId = getSessionIdByUser(userId);
    // 学习版：开启知识库时，默认走 LangChain 链路
    const rag = isRagEnabled() ? '&rag=1&rag_mode=lc' : '';
    const url = `/chat?message=${encodeURIComponent(text)}&user_id=${encodeURIComponent(userId)}&session_id=${encodeURIComponent(sessionId)}${rag}`;
    const res = await fetch(url, { method: 'POST' });

    if(!res.ok){
      const data = await res.json().catch(()=>({detail: res.statusText||'Error'}));
      throw new Error(data.detail||('HTTP '+res.status));
    }

    // 创建一个新的 AI 回复气泡
    const bubble = append('ai', '');

    // 获取响应体的读取器，用于流式读取数据
    // 就像接了一根水管，准备从里面接水
    const reader = res.body.getReader();
    // TextDecoder 用于将二进制数据流解码为文本
    const decoder = new TextDecoder();
    let buffer = '';

    // 循环读取流数据：只要流没结束，就一直循环
    while(true) {
      // await reader.read() 类似从水管接一杯水
      // 它会暂停代码执行，直到接收到新的一块二进制数据 (value)
      const { done, value } = await reader.read();

      // done 为 true 表示水流干了（后端结束响应）
      if (done) break;

      // 1. 解码：将二进制数据块 (Uint8Array) 转为字符串
      // 注意：这里只是拿到了一小段文本，可能是完整的 JSON，也可能只是一半（比如 "{"text": "你好"）
      buffer += decoder.decode(value, { stream: true });

      // 2. 切分：SSE 协议规定每条消息以双换行符分隔 (\n\n)
      // 就像我们在聊天软件里按回车发送一样，后端每发完一句话会加两个换行
      // 我们用正则表达式 /\r\n\r\n|\n\n/ 来找这个分隔符
      const parts = buffer.split(/\r\n\r\n|\n\n/);

      // 3. 缓存残留：数组最后一个元素通常是不完整的（因为可能数据还没传完）
      // 比如收到了 "data: {...}\n\ndata: {...", 最后那个 "data: {..." 要留给下一次拼接
      buffer = parts.pop();

      // 4. 处理每一条完整的消息
      for (const part of parts) {
        // 有些消息可能包含多行（比如 data: ... \n event: ...），这里再按行拆分
        const lines = part.split(/\r\n|\n/);

        for (const line of lines) {
          // SSE 格式规定数据行必须以 "data: " 开头
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6); // 去掉 "data: " 前缀，拿到后面的 JSON 字符串
            try {
              // 5. 解析 JSON：将字符串转为 JS 对象
              const data = JSON.parse(jsonStr);

              // 如果后端返回错误信息
              if (data.error) {
                throw new Error(data.error);
              }

              // 6. 核心渲染逻辑：将新收到的文本"追加"到气泡中
              // bubble.textContent 原来是 "你"，收到 "好" 后变成 "你好"
              // 这就是为什么你会看到字是一个个蹦出来的，而不是一次性显示
              if (data.text) {
                bubble.textContent += data.text;
                // 自动滚动到底部，保证用户总能看到最新内容
                el.messages.scrollTop = el.messages.scrollHeight;
              }

              // 更新模型名称展示
              if (data.model) {
                el.model.textContent = `模型：${data.model}`;
              }
            } catch (e) {
              console.error('解析 SSE 数据失败:', e);
            }
          }
        }
      }
    }
  }catch(e){
    // 如果气泡里已经有内容了，追加错误信息；否则新建气泡
    // 简单起见，这里直接追加或新建
    const lastMsg = el.messages.lastElementChild;
    if (lastMsg && lastMsg.classList.contains('ai') && lastMsg.querySelector('.bubble')?.textContent === '') {
       lastMsg.querySelector('.bubble').textContent = `错误：${e.message}`;
    } else {
       append('ai', `错误：${e.message}`);
    }
  }finally{
    el.send.disabled = false;
  }
}

el.form.addEventListener('submit', (ev)=>{
  ev.preventDefault();
  const text = el.input.value.trim();
  if(!text) return;
  append('user', text);
  el.input.value = '';
  send(text);
});

// 处理textarea的Enter发送
if(el.input){
  el.input.addEventListener('keydown', (ev)=>{
    if(ev.key === 'Enter' && !ev.shiftKey){
      ev.preventDefault();
      el.form.requestSubmit();
    }
  });
}

renderUser();
setRagStatus('知识库：未导入');
switchTab('chat');

if(el.tabChat){
  el.tabChat.addEventListener('click', ()=> switchTab('chat'));
}

if(el.tabRag){
  el.tabRag.addEventListener('click', ()=> switchTab('rag'));
}

if(el.ragEnabled){
  el.ragEnabled.checked = isRagEnabled();
  el.ragEnabled.addEventListener('change', ()=>{
    setRagEnabled(el.ragEnabled.checked);
  });
}

if(el.ragIngest){
  el.ragIngest.addEventListener('click', async ()=>{
    const user = getCurrentUser();
    const title = (el.ragTitle?.value || '').trim() || null;
    const text = (el.ragText?.value || '').trim();
    if(!text){
      setRagStatus('知识库：请输入文本');
      return;
    }
    setRagStatus('知识库：导入中...');
    try{
      // 把"粘贴的知识库文本"发给后端，让后端切片入库（RAG 的 ingest）
      const res = await fetch('/rag/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id, title, text }),
      });
      const data = await res.json().catch(()=>null);
      if(!res.ok || !data || data.ok !== true){
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      setRagStatus(`知识库：已导入 ${data.chunks} 段`);
      if(el.ragEnabled){
        el.ragEnabled.checked = true;
        setRagEnabled(true);
      }
    }catch(e){
      setRagStatus(`知识库：导入失败（${e.message}）`);
    }
  });
}

if(el.switchUser){
  el.switchUser.addEventListener('click', ()=>{
    const current = getCurrentUser();
    const name = prompt('输入用户名（用于本地模拟登录/切换）', current.name);
    if(!name) return;
    setCurrentUser(name.trim());
    newSessionForUser(getCurrentUser().id);
    clearMessages();
    renderUser();
  });
}

if(el.newChat){
  el.newChat.addEventListener('click', ()=>{
    const user = getCurrentUser();
    newSessionForUser(user.id);
    clearMessages();
  });
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 格式化日期
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

// 显示上传状态
function showUploadStatus(message, type = 'progress') {
  if (!el.uploadStatus) return;
  el.uploadStatus.style.display = 'block';
  el.uploadStatus.className = 'upload-status ' + type;
  el.uploadStatus.textContent = message;
}

// 隐藏上传状态
function hideUploadStatus() {
  if (!el.uploadStatus) return;
  el.uploadStatus.style.display = 'none';
}

// 加载文档列表
async function loadDocumentList() {
  if (!el.docList) return;

  try {
    const user = getCurrentUser();
    const res = await fetch(`/documents?user_id=${encodeURIComponent(user.id)}`);
    const data = await res.json();

    if (!data.ok || !data.documents) {
      el.docList.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 40px; color: #9ca3af;">
            加载失败
          </td>
        </tr>
      `;
      return;
    }

    if (data.documents.length === 0) {
      el.docList.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 40px; color: #9ca3af;">
            暂无文档，请上传
          </td>
        </tr>
      `;
      return;
    }

    el.docList.innerHTML = data.documents.map(doc => {
      const ext = (doc.filename || '').split('.').pop()?.toLowerCase() || '';
      let icon = '📄';
      let iconClass = '';

      if (ext === 'pdf') { icon = '📕'; iconClass = 'pdf'; }
      else if (['doc', 'docx'].includes(ext)) { icon = '📘'; iconClass = 'docx'; }
      else if (['ppt', 'pptx'].includes(ext)) { icon = '📙'; iconClass = 'pptx'; }
      else if (['txt', 'md'].includes(ext)) { icon = '📄'; iconClass = 'txt'; }

      return `
        <tr>
          <td>
            <div class="file-info">
              <div class="file-icon ${iconClass}">${icon}</div>
              <div>
                <div class="file-name">${doc.title || doc.filename || '未命名文档'}</div>
              </div>
            </div>
          </td>
          <td>${doc.file_size ? formatFileSize(doc.file_size) : '-'}</td>
          <td>${doc.created_at ? formatDate(doc.created_at) : '-'}</td>
          <td>
            <div class="file-actions">
              <button class="action-btn" title="预览" onclick="previewDocument(${doc.id})">👁️</button>
              <button class="action-btn" title="下载" onclick="downloadDocument(${doc.id})">⬇️</button>
              <button class="action-btn" title="删除" onclick="deleteDocument(${doc.id})">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (e) {
    console.error('加载文档列表失败:', e);
    el.docList.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 40px; color: #9ca3af;">
          加载失败
        </td>
      </tr>
    `;
  }
}

// 上传文件
async function uploadFile(file) {
  try {
    showUploadStatus(`正在上传: ${file.name}...`, 'progress');

    const user = getCurrentUser();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_id', user.id);

    const res = await fetch('/documents/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || '上传失败');
    }

    showUploadStatus(`上传成功: ${file.name}`, 'success');
    setTimeout(hideUploadStatus, 2000);

    // 刷新文档列表
    loadDocumentList();
    setRagStatus('知识库：已上传文档');

  } catch (e) {
    showUploadStatus(`上传失败: ${e.message}`, 'error');
  }
}

// 文件选择事件
if (el.fileUpload) {
  el.fileUpload.addEventListener('change', (ev) => {
    const files = ev.target.files;
    if (!files || files.length === 0) return;

    // 上传所有选择的文件
    for (const file of files) {
      uploadFile(file);
    }

    // 清空input，允许重复选择同一文件
    ev.target.value = '';
  });
}

// 切换到文档管理面板时刷新列表
let originalSwitchTab = switchTab;
switchTab = function(tab) {
  originalSwitchTab(tab);
  if (tab === 'rag') {
    loadDocumentList();
  }
};

// 初始加载时，如果在文档管理面板就加载列表
if (el.tabRag && el.tabRag.classList.contains('active')) {
  loadDocumentList();
}

// 当前预览的文档ID
let currentPreviewDocId = null;

// 显示预览弹窗
function showPreviewModal() {
  if (el.previewModal) {
    el.previewModal.classList.remove('hidden');
  }
}

// 隐藏预览弹窗
function hidePreviewModal() {
  if (el.previewModal) {
    el.previewModal.classList.add('hidden');
  }
  currentPreviewDocId = null;
}

// 预览文档
window.previewDocument = async function(id) {
  try {
    const user = getCurrentUser();
    const res = await fetch(`/documents/${id}?user_id=${encodeURIComponent(user.id)}`);
    const data = await res.json();

    if (!data.ok || !data.document) {
      throw new Error(data.error || '获取文档失败');
    }

    const doc = data.document;
    currentPreviewDocId = id;

    // 设置标题
    if (el.previewTitle) {
      el.previewTitle.textContent = doc.title || doc.filename || '文档预览';
    }

    // 设置文档信息
    if (el.previewInfo) {
      el.previewInfo.innerHTML = `
        <div class="modal-info-item">
          <div class="modal-info-label">文件名</div>
          <div class="modal-info-value">${doc.filename || '-'}</div>
        </div>
        <div class="modal-info-item">
          <div class="modal-info-label">大小</div>
          <div class="modal-info-value">${doc.file_size ? formatFileSize(doc.file_size) : '-'}</div>
        </div>
        <div class="modal-info-item">
          <div class="modal-info-label">上传时间</div>
          <div class="modal-info-value">${doc.created_at ? formatDate(doc.created_at) : '-'}</div>
        </div>
      `;
    }

    // 设置文档内容
    if (el.previewContent) {
      if (doc.can_preview && doc.content) {
        el.previewContent.innerHTML = `<pre>${escapeHtml(doc.content)}</pre>`;
      } else {
        el.previewContent.innerHTML = `
          <div class="modal-no-preview">
            <div class="modal-no-preview-icon">📄</div>
            <div>该文件类型暂不支持在线预览，请下载后查看</div>
          </div>
        `;
      }
    }

    showPreviewModal();
  } catch (e) {
    console.error('预览文档失败:', e);
    alert('预览失败: ' + (e.message || '未知错误'));
  }
};

// HTML转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 下载文档
window.downloadDocument = function(id) {
  try {
    const user = getCurrentUser();
    const url = `/documents/${id}/download?user_id=${encodeURIComponent(user.id)}`;
    window.open(url, '_blank');
  } catch (e) {
    console.error('下载文档失败:', e);
    alert('下载失败: ' + (e.message || '未知错误'));
  }
};

// 预览弹窗关闭按钮事件
if (el.previewClose) {
  el.previewClose.addEventListener('click', hidePreviewModal);
}

if (el.previewCloseBtn) {
  el.previewCloseBtn.addEventListener('click', hidePreviewModal);
}

// 点击遮罩层关闭弹窗
if (el.previewModal) {
  el.previewModal.addEventListener('click', (e) => {
    if (e.target === el.previewModal) {
      hidePreviewModal();
    }
  });
}

// 预览弹窗中的下载按钮
if (el.previewDownload) {
  el.previewDownload.addEventListener('click', () => {
    if (currentPreviewDocId) {
      window.downloadDocument(currentPreviewDocId);
    }
  });
}

// ESC键关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hidePreviewModal();
  }
});

// 删除文档
window.deleteDocument = async function(id) {
  if (!confirm('确定要删除这个文档吗？删除后不可恢复。')) {
    return;
  }

  try {
    const user = getCurrentUser();
    const res = await fetch(`/documents/${id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: user.id })
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || '删除失败');
    }

    // 刷新文档列表
    loadDocumentList();
    setRagStatus('知识库：已删除文档');

  } catch (e) {
    console.error('删除文档失败:', e);
    alert('删除失败: ' + (e.message || '未知错误'));
  }
};

