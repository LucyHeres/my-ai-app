/**
 * 最小 LangChain 学习版：
 * 仅用 LangChain 负责 RAG 提示词编排，不改现有 LLM 调用方式。
 */
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';

function buildRagBlock(ragHits) {
  const hits = Array.isArray(ragHits) ? ragHits : [];
  if (!hits.length) return '';
  return hits.map((h) => h.content).join('\n\n');
}

/**
 * 使用 LangChain 构建聊天 messages（OpenAI 兼容格式）。
 * @param {{
 *   agentSystemPrompt: string,
 *   history: Array<{role:string, content:string}>,
 *   ragHits: Array<{chunk_id:number, content:string}>
 * }} input
 * @returns {Promise<Array<{role:string, content:string}>>}
 */
async function buildChatMessagesWithLangChain(input) {
  const ragBlock = buildRagBlock(input.ragHits);

  const ragSystemPromptChain = RunnableSequence.from([
    PromptTemplate.fromTemplate(
      '以下是为本次问题检索到的知识库资料片段。请优先基于这些资料回答；如资料不足以支持结论，请明确说“不确定/不知道”，并可提出需要补充的资料。\n\n{rag_block}'
    ),
    (v) => String(v ?? ''),
  ]);

  const ragSystemPrompt = ragBlock
    ? await ragSystemPromptChain.invoke({ rag_block: ragBlock })
    : '';

  const messages = [{ role: 'system', content: String(input.agentSystemPrompt || '') }];
  if (ragSystemPrompt) messages.push({ role: 'system', content: ragSystemPrompt });
  messages.push(...(Array.isArray(input.history) ? input.history : []));

  return messages;
}

export {
  buildChatMessagesWithLangChain,
};
