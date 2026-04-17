import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import fs from 'fs';

export async function loadDocument(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  let docs = [];
  if (ext === 'pdf') {
    const loader = new PDFLoader(filePath);
    docs = await loader.load();
  } else if (ext === 'docx') {
    const loader = new DocxLoader(filePath);
    docs = await loader.load();
  } else if (ext === 'doc') {
    const loader = new DocxLoader(filePath, { type: 'doc' });
    docs = await loader.load();
  } else if (ext === 'txt' || ext === 'md') {
    const content = fs.readFileSync(filePath, 'utf-8');
    docs = [{ page_content: content }];
  } else if (ext === 'csv') {
    const loader = new CSVLoader(filePath);
    docs = await loader.load();
  } else {
    throw new Error(`不支持的文件类型: ${ext}`);
  }

  return docs.map(d => d.page_content).join('\n\n');
}