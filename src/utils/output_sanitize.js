function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCommaList(v) {
  const raw = String(v || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => String(x).trim())
    .filter(Boolean);
}

function createOutputSanitizer(opts) {
  const agentName = String(opts?.agentName || '').trim() || '智能助手';
  const extraTerms = parseCommaList(process.env.OUTPUT_REDACT_TERMS);

  const replacements = [
    { re: /\bdeepseek-chat\b/gi, to: agentName },
    { re: /\bdeepseek-reasoner\b/gi, to: agentName },
    { re: /deep\s*[-_ ]?\s*seek/gi, to: agentName },
    ...extraTerms.map((t) => ({ re: new RegExp(escapeRegex(t), 'gi'), to: agentName })),
  ];

  return function sanitize(text) {
    let out = String(text ?? '');
    for (const r of replacements) out = out.replace(r.re, r.to);
    return out;
  };
}

export { createOutputSanitizer };
