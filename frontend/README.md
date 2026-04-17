# 前端 Vue 版本

使用 .vue 单文件组件的前端版本，更易维护！

## 安装依赖

```bash
cd frontend
npm install
```

## 开发模式

```bash
npm run dev
```

前端会在 http://localhost:5173 运行，API 请求会代理到后端的 http://localhost:8000

## 生产构建

```bash
npm run build
```

## 项目结构

```
frontend/
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.js
    ├── App.vue
    └── components/
        ├── ChatComponent.vue
        └── DocumentsComponent.vue
```

## 优势

- ✅ 使用标准的 .vue 单文件组件
- ✅ 语法高亮和 IDE 支持更好
- ✅ 模板和逻辑完全分离
- ✅ 热重载开发体验
