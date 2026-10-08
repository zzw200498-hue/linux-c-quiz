import type { Answer, PaperSummary, Question } from './types';

/** 每题的有效得分：grade.score 优先；客观题判分计 100/0；未判定为 null */
export function questionScore(a: Answer | undefined): number | null {
  if (a?.grade) return a.grade.score;
  if (a?.correct === true) return 100;
  if (a?.correct === false) return 0;
  return null;
}

/** 每题的判定结论：grade.verdict 优先；客观题判分映射为 correct/wrong；未判定为 null */
export function questionVerdict(a: Answer | undefined): 'correct' | 'partial' | 'wrong' | null {
  if (a?.grade) return a.grade.verdict;
  if (a?.correct === true) return 'correct';
  if (a?.correct === false) return 'wrong';
  return null;
}

/**
 * 计算整卷成绩单（统计维度）。
 * @param overall 批改者给的整卷总评；只存批改者的原文——自动评语由 UI 层按统计现场生成，
 *                因此重算时不要把自动文本写回存储。
 * @param weights 题型分值表（每题满分），如 { single: 2, short: 4 }。
 *                提供时总分 = Σ(得分% × 分值) / Σ(已判定题分值)，即卷面百分制；
 *                未提供或某题型缺省时该题按 1 分等权处理。
 *                单题上的 question.score 优先级最高，用于同题型分值不同的情况。
 */
export function computeSummary(
  questions: Question[],
  answers: Record<string, Answer>,
  overall?: string,
  weights?: Record<string, number>,
): PaperSummary {
  const counts = { correct: 0, partial: 0, wrong: 0 };
  const weakTagFreq = new Map<string, number>();
  let weightedSum = 0;
  let weightSum = 0;
  let judged = 0;

  for (const q of questions) {
    const a = answers[q.id];
    const score = questionScore(a);
    if (score === null) continue;
    judged++;
    const w = q.score ?? weights?.[q.type] ?? 1;
    weightedSum += score * w;
    weightSum += w;
    const v = questionVerdict(a);
    if (v) counts[v]++;
    if ((v === 'wrong' || v === 'partial') && q.tags.length) {
      for (const t of q.tags) weakTagFreq.set(t, (weakTagFreq.get(t) ?? 0) + 1);
    }
  }

  const questionCount = questions.length;
  const weakTags = [...weakTagFreq.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([t]) => t);

  return {
    totalScore: weightSum > 0 ? Math.round(weightedSum / weightSum) : 0,
    judgedCount: judged,
    questionCount,
    pendingCount: questionCount - judged,
    verdictCounts: counts,
    overall: overall?.trim() ?? '',
    weakTags,
    ts: Date.now(),
  };
}

/** 无批改者总评时，按统计生成一段展示用评语（不入库） */
export function autoOverallText(s: PaperSummary): string {
  if (s.judgedCount === 0) return '尚未交卷或批改。';
  const c = s.verdictCounts;
  let text = `已判定 ${s.judgedCount}/${s.questionCount} 题：全对 ${c.correct}、部分正确 ${c.partial}、错 ${c.wrong}。`;
  if (c.partial === 0 && c.wrong === 0 && s.pendingCount === 0) {
    text += '全卷通过，掌握扎实，可以推进下一专题。';
  } else if (s.weakTags.length > 0) {
    text += `薄弱方向：${s.weakTags.join('、')}，建议优先重做对应错题。`;
  } else if (c.wrong > 0 || c.partial > 0) {
    text += '建议对照解析重做错题。';
  }
  if (s.pendingCount > 0) text += `（还有 ${s.pendingCount} 题待判定/批改）`;
  return text;
}
