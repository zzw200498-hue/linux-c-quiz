import type { Question } from './types';

/** 填空/答案归一化：去首尾空白、去全部空白、转小写、去句末标点 */
export function normalize(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[。．.]+$/, '');
}

/**
 * 判题。返回：
 * - true / false：客观题的判定结果
 * - null：主观题（short / rewrite / coding），不自动判
 */
export function judge(q: Question, value: string | string[] | null): boolean | null {
  if (value === null) return null;

  if (q.type === 'single' && typeof value === 'string') {
    return normalize(value) === normalize(String(q.answer ?? ''));
  }

  if (q.type === 'multi' && Array.isArray(value)) {
    if (value.length === 0) return null;
    const expect = [...(q.answer ?? [])].map(String).sort().join(',');
    const got = [...value].sort().join(',');
    return expect === got;
  }

  if (q.type === 'fill') {
    const arr = Array.isArray(value) ? value : [value];
    const blanks = q.blanks ?? [];
    if (arr.every((v) => !normalize(v))) return null; // 全空 = 未作答
    return blanks.every((b, i) => {
      const v = normalize(arr[i] ?? '');
      if (!v) return false; // 有空没填
      return [b.answer, ...(b.alt ?? [])].some((cand) => normalize(cand) === v);
    });
  }

  return null;
}

export function isObjective(q: Question): boolean {
  return q.type === 'single' || q.type === 'multi' || q.type === 'fill';
}

/** 作答是否为空（未选 / 未填）：空作答不该被判定，也不该计入错题本连对 */
export function isEmptyAnswer(value: string | string[] | null | undefined): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.every((v) => !normalize(String(v ?? '')));
  return normalize(value) === '';
}

const LETTERS = 'ABCDEFGH';

/**
 * 生成「参考答案」的可读文本（错题本里点「查看参考答案」时用）。
 * 只看答案、不参与自动判定：机器判定拿不准的（输出结果、命令顺序、等价写法）由学习者自己对照。
 */
export function referenceAnswerLines(q: Question): string[] {
  if (q.type === 'single' || q.type === 'multi') {
    const letters = typeof q.answer === 'string' ? [q.answer] : (q.answer ?? []);
    const choices = q.choices ?? [];
    return letters
      .map(String)
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const i = LETTERS.indexOf(l.trim().toUpperCase());
        const text = i >= 0 ? choices[i] : undefined;
        return text ? `${l}. ${text}` : l;
      });
  }

  if (q.type === 'fill') {
    const blanks = q.blanks ?? [];
    return blanks.map((b, i) => {
      const all = [b.answer, ...(b.alt ?? [])].filter((x) => String(x ?? '').trim() !== '');
      return `空${i + 1}：${all.join('  /  ')}`;
    });
  }

  if (q.referenceAnswer) return [q.referenceAnswer];
  if (typeof q.answer === 'string') return q.answer ? [q.answer] : [];
  if (Array.isArray(q.answer)) return q.answer.length > 0 ? [q.answer.join('  /  ')] : [];
  return [];
}
