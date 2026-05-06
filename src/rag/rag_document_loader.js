import pdfParse from 'pdf-parse';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import fs from 'fs';

export async function loadDocument(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();

  if (ext === 'pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text || '';
  } else if (ext === 'docx') {
    const loader = new DocxLoader(filePath);
    const docs = await loader.load();
    return docs.map(d => d.page_content).join('\n\n');
  } else if (ext === 'doc') {
    const loader = new DocxLoader(filePath, { type: 'doc' });
    const docs = await loader.load();
    return docs.map(d => d.page_content).join('\n\n');
  } else if (ext === 'txt' || ext === 'md') {
    return fs.readFileSync(filePath, 'utf-8');
  } else if (ext === 'csv') {
    const loader = new CSVLoader(filePath);
    const docs = await loader.load();
    return docs.map(d => d.page_content).join('\n\n');
  } else {
    throw new Error(`不支持的文件类型: ${ext}`);
  }
}
