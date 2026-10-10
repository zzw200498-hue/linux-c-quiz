/** 题干里的一段：markdown 文本 或 代码块 */
export type StemChunk = { type: 'text' | 'code'; lang: string; text: string };

/**
 * 把 stem 切成「markdown 文本」与「代码块」两种块。
 *
 * 为什么需要：填空题的题干要按 ____N____ 拆成行内片段插入输入框，
 * 但如果整段走行内渲染，```c 围栏里的换行会被压平，代码挤成一整行。
 * 所以先把围栏代码块单独摘出来按块渲染（保留换行 + 高亮），其余文本才走行内渲染。
 *
 * 未闭合的围栏不匹配，会留在文本里（退化成旧行为，不会丢内容）。
 */
const FENCE_RE = /```([A-Za-z0-9_+#-]*)[ \t]*\r?\n([\s\S]*?)```/g;

export function splitStem(stem: string): StemChunk[] {
  const out: StemChunk[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(stem)) !== null) {
    if (m.index > last) out.push({ type: 'text', lang: '', text: stem.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1] || '', text: m[2].replace(/\s+$/, '') });
    last = FENCE_RE.lastIndex;
  }
  if (last < stem.length) out.push({ type: 'text', lang: '', text: stem.slice(last) });
  if (out.length === 0) out.push({ type: 'text', lang: '', text: stem });
  return out;
}

/** 文本块按空行切成段落（题干里的换行要保住，不能挤成一段） */
export function splitParagraphs(text: string): string[] {
  return text.split(/\r?\n[ \t]*\r?\n/).filter((s) => s.trim() !== '');
}

/** 段落切成行，并去掉首尾的空行（否则会在段前/段后多出空 <br>） */
export function splitLines(para: string): string[] {
  const lines = para.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}
