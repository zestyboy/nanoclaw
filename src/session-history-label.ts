const XML_ENTITY_MAP: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(lt|gt|amp|quot|#39);/g,
    (entity) => XML_ENTITY_MAP[entity] || entity,
  );
}

export function sanitizeSessionHistoryPrompt(
  prompt: string | null,
): string | null {
  if (!prompt) return null;

  const matches = [
    ...prompt.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g),
  ];
  if (matches.length > 0) {
    const combined = matches
      .map((match) => decodeXmlEntities(match[1].trim()))
      .filter(Boolean)
      .join(' ')
      .trim();
    return combined || null;
  }

  const cleaned = decodeXmlEntities(prompt.trim());
  return cleaned || null;
}

export function formatSessionHistoryLabel(entry: {
  name: string | null;
  first_prompt: string | null;
  session_id: string;
}): string {
  return (
    entry.name ||
    sanitizeSessionHistoryPrompt(entry.first_prompt)?.slice(0, 80) ||
    entry.session_id.slice(0, 8)
  );
}
