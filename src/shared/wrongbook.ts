import type { Answer } from './types';

/** 连续答对几次才算过关（过关后移入「已过关」组） */
export const WRONG_STREAK_TARGET = 3;

/**
 * 及格线：自行打分 / 批改得分 ≥ 60 才算「答对一次」（计入连对）；
 * < 60 一律打回待攻克（连对清零）。用户拍板：partial(30-59) 不算通过。
 */
export const PASS_SCORE = 60;

/** 由百分制得分推导判定：≥90 正确 / ≥60 部分正确 / <60 错误 */
export function verdictFromScore(score: number): 'correct' | 'partial' | 'wrong' {
  if (score >= 90) return 'correct';
  if (score >= PASS_SCORE) return 'partial';
  return 'wrong';
}

/** 得分是否算「答对一次」（错题本连对 +1；SM-2 里对应 q≥3） */
export function isPassScore(score: number): boolean {
  return score >= PASS_SCORE;
}

export type WrongbookKind = 'active' | 'passed';

export interface WrongbookEntry {
  /** 来源试卷文件名 */
  paper: string;
  /** 题目 id */
  qid: string;
  /** 连续答对次数（答错清零） */
  streak: number;
  /** 是否已过关（连对 WRONG_STREAK_TARGET 次） */
  passed: boolean;
  /** 在错题本里练过的次数 */
  tries: number;
  /** 主观题已在错题本里练过，等批改导入后结算连对次数 */
  awaitingGrade: boolean;
  /** 过关时间；用于判断「过关之后又判错」要回炉 */
  graduatedAt: number;
  ts: number;
  source: 'auto' | 'manual';
}

export type Wrongbook = Record<string, WrongbookEntry>;

export function wrongKey(paper: string, qid: string): string {
  return `${paper}#${qid}`;
}

export function parseWrongKey(key: string): { paper: string; qid: string } {
  const i = key.indexOf('#');
  return { paper: key.slice(0, i), qid: key.slice(i + 1) };
}

/** 是否算「错题」：客观题判错，或主观题被批改判为 wrong / partial（部分正确也收） */
export function isWrongAnswer(a: Answer | undefined): boolean {
  if (!a) return false;
  if (a.grade) return a.grade.verdict === 'wrong' || a.grade.verdict === 'partial';
  return a.correct === false;
}

function blankEntry(paper: string, qid: string, ts: number): WrongbookEntry {
  return {
    paper,
    qid,
    streak: 0,
    passed: false,
    tries: 0,
    awaitingGrade: false,
    graduatedAt: 0,
    ts,
    source: 'auto',
  };
}

/**
 * 按作答判定同步错题本：
 * - 新判错的题 → 收录（streak 0、未过关）
 * - 已过关的题若**在过关之后**又被判定为错 → 回炉（清零、退回待攻克）
 * - 只做收集与回炉，不动 streak（streak 只在错题本内练习时变化）
 * @returns { next, added, recycled }
 */
export function syncWrongbook(
  prev: Wrongbook,
  papers: Record<string, Record<string, Answer>>,
): { next: Wrongbook; added: number; recycled: number } {
  const next: Wrongbook = { ...prev };
  let added = 0;
  let recycled = 0;

  for (const [paper, answers] of Object.entries(papers)) {
    for (const [qid, a] of Object.entries(answers)) {
      if (!isWrongAnswer(a)) continue;
      const k = wrongKey(paper, qid);
      const existed = next[k];
      if (!existed) {
        next[k] = blankEntry(paper, qid, a.ts ?? Date.now());
        added++;
        continue;
      }
      if (existed.passed && (a.ts ?? 0) > existed.graduatedAt) {
        next[k] = { ...existed, passed: false, streak: 0, graduatedAt: 0, ts: Date.now() };
        recycled++;
      }
    }
  }
  return { next, added, recycled };
}

/** 错题本内练习一次：ok=true 连对+1（达标过关）、ok=false 清零回炉、ok=null 主观题待批改 */
export function recordPractice(
  prev: Wrongbook,
  paper: string,
  qid: string,
  ok: boolean | null,
): Wrongbook {
  const k = wrongKey(paper, qid);
  const e = prev[k];
  if (!e) return prev;
  const now = Date.now();
  if (ok === null) {
    return { ...prev, [k]: { ...e, awaitingGrade: true, tries: e.tries + 1, ts: now } };
  }
  const streak = ok ? e.streak + 1 : 0;
  const passed = streak >= WRONG_STREAK_TARGET;
  return {
    ...prev,
    [k]: {
      ...e,
      streak,
      passed,
      tries: e.tries + 1,
      awaitingGrade: false,
      graduatedAt: passed ? now : e.graduatedAt,
      ts: now,
    },
  };
}

/** 批改导入后结算主观题：verdict=correct 计一次连对，否则清零（已过关的会被打回） */
export function settleGrades(
  prev: Wrongbook,
  paper: string,
  grades: Record<string, { verdict: 'correct' | 'partial' | 'wrong' }>,
): Wrongbook {
  let next = prev;
  for (const [qid, g] of Object.entries(grades)) {
    const k = wrongKey(paper, qid);
    const e = next[k];
    if (!e || !e.awaitingGrade) continue;
    next = recordPractice(next, paper, qid, g.verdict === 'correct');
  }
  return next;
}

/** 列出某组条目（待攻克 / 已过关），按最近练习时间升序（前端会再随机洗牌） */
export function listWrongbook(wb: Wrongbook, kind: WrongbookKind): WrongbookEntry[] {
  return Object.values(wb)
    .filter((e) => (kind === 'passed' ? e.passed : !e.passed))
    .sort((a, b) => a.ts - b.ts);
}

/** 洗牌（Fisher-Yates，原地） */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
