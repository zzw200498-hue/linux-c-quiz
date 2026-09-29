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
