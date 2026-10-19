import * as fs from 'fs';
import * as path from 'path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import {
  answerSchema,
  paperSchema,
  stateSchema,
  type Answer,
  type Grade,
  type PaperFile,
  type PaperSummary,
  type Question,
  type QuizState,
  type WrongbookEntry,
} from '../../src/shared/types';
import { computeSummary } from '../../src/shared/summary';
import { judge, isObjective, isEmptyAnswer } from '../../src/shared/judge';
import { lintPaper, parsePaperText, paperTypeSummary, uniquePaperFileName } from '../../src/shared/importer';
import {
  buildWrongbookQuestions,
  isPassScore,
  listWrongbook,
  recordPractice,
  shuffle,
  syncWrongbook as syncWrongbookPure,
  verdictFromScore,
  wrongKey,
  type WrongbookKind,
} from '../../src/shared/wrongbook';
import type { QuizConfig } from './config';

/**
 * 桌面端 Store：与 VSCode 插件的 store.ts 一一对应，但去掉 vscode API 依赖。
 * 所有判定/错题本/成绩单逻辑都复用 src/shared 里的纯函数 —— 两边行为完全一致。
 */
export class NodeStore {
  constructor(private cfg: QuizConfig) {}

  /* ---------- 题库 ---------- */

  listPapers(): PaperFile[] {
    const dir = this.cfg.bankDir;
    if (!fs.existsSync(dir)) return [];
    const out: PaperFile[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/i.test(name)) continue;
      try {
        const raw = yamlLoad(fs.readFileSync(path.join(dir, name), 'utf8'));
        const parsed = paperSchema.parse(raw);
        out.push({ file: name, paper: parsed.paper, questions: parsed.questions });
      } catch (e) {
        console.warn(`[desktop] 试卷解析失败: ${name}`, e);
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file, 'zh'));
  }

  loadPaper(file: string): PaperFile | undefined {
    const full = path.join(this.cfg.bankDir, file);
    if (!fs.existsSync(full)) return undefined;
    const parsed = paperSchema.parse(yamlLoad(fs.readFileSync(full, 'utf8')));
    return { file, paper: parsed.paper, questions: parsed.questions };
  }

  /* ---------- 导入新卷 ---------- */

  /**
   * 把一段文本（可以是 AI 回复里带 ```yaml 围栏的整段内容）落成一张新卷。
   * 落盘前必须过 schema 校验，否则坏卷子会把整个题库拖崩（列表页会解析失败）。
   */
  importPaper(
    text: string,
  ):
    | { ok: true; file: string; title: string; count: number; summary: string; warnings: string[] }
    | { ok: false; stage: 'empty' | 'yaml' | 'schema' | 'lint'; message: string; issues?: string[] } {
    if (!text || !text.trim()) return { ok: false, stage: 'empty', message: '内容为空' };

    const r = parsePaperText(text, (raw) => yamlLoad(raw));
    if (!r.ok) return r;

    // schema 过了不代表能做：还要检查「选择题有没有选项」这类 deadly combination
    const lint = lintPaper(r.data);
    if (lint.errors.length) {
      return {
        ok: false,
        stage: 'lint',
        message: `这张卷有 ${lint.errors.length} 处做不了的地方（已拦下，没有写进题库）`,
        issues: [...lint.errors, ...lint.warnings],
      };
    }

    const p = r.data;
    fs.mkdirSync(this.cfg.bankDir, { recursive: true });
    const name = uniquePaperFileName(this.cfg.bankDir, p.paper.title, (n) => fs.existsSync(n));
    // 存的是校验通过的对象（yamlDump 重新格式化，缩进乱七八糟也能救回来）
    fs.writeFileSync(
      path.join(this.cfg.bankDir, name),
      yamlDump(r.data, { lineWidth: -1 }),
      'utf8',
    );
    return {
      ok: true,
      file: name,
      title: p.paper.title,
      count: p.questions.length,
      summary: paperTypeSummary(p.questions),
      warnings: lint.warnings,
    };
  }

  /* ---------- 状态 ---------- */

  loadState(): QuizState {
    if (!fs.existsSync(this.cfg.stateFile)) return stateSchema.parse({});
    try {
      return stateSchema.parse(JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8')));
    } catch {
      return stateSchema.parse({});
    }
  }

  saveState(state: QuizState): void {
    fs.mkdirSync(path.dirname(this.cfg.stateFile), { recursive: true });
    fs.writeFileSync(this.cfg.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  async saveAnswer(
    paperFile: string,
    qid: string,
    patch: {
      value: string | string[] | null;
      correct: boolean | null;
      grade?: unknown;
      lastRun?: { passed: number; total: number; ts: number };
    },
  ): Promise<void> {
    const st = this.loadState();
    st.papers[paperFile] ??= {};
    const prev = st.papers[paperFile][qid];
    st.papers[paperFile][qid] = answerSchema.parse({
      ...prev,
      value: patch.value,
      correct: patch.correct,
      ts: Date.now(),
      ...(patch.grade !== undefined ? { grade: patch.grade } : {}),
      ...(patch.lastRun !== undefined ? { lastRun: patch.lastRun } : {}),
    });
    this.saveState(st);
  }

  /** 交卷：判定所有客观题 → 重算成绩单 → 同步错题本 */
  async submitPaper(paperFile: string): Promise<{ right: number; total: number; summary: PaperSummary | null }> {
    const paper = this.loadPaper(paperFile);
    if (!paper) return { right: 0, total: 0, summary: null };
    const st = this.loadState();
    st.papers[paperFile] ??= {};
    let right = 0;
    let total = 0;
    for (const q of paper.questions) {
      if (!isObjective(q)) continue;
      const a = st.papers[paperFile][q.id];
      const v = a?.value ?? null;
      if (isEmptyAnswer(v)) continue;
      total++;
      const c = judge(q, v) === true;
      if (c) right++;
      st.papers[paperFile][q.id] = answerSchema.parse({ ...a, value: v, correct: c, ts: a?.ts ?? Date.now() });
    }
    st.wrongbook = syncWrongbookPure(st.wrongbook, st.papers).next;
    const summary = computeSummary(
      paper.questions,
      st.papers[paperFile],
      st.summaries[paperFile]?.overall ?? '',
      paper.paper.scoreWeights,
    );
    st.summaries[paperFile] = summary;
    this.saveState(st);
    return { right, total, summary };
  }

  /** 清除判定（保留作答，可重刷） */
  async clearJudgement(paperFile: string): Promise<void> {
    const paper = this.loadPaper(paperFile);
    if (!paper) return;
    const st = this.loadState();
    for (const q of paper.questions) {
      if (!isObjective(q)) continue;
      const a = st.papers[paperFile]?.[q.id];
      if (a?.correct != null) {
        st.papers[paperFile][q.id] = { ...a, correct: null };
      }
    }
    this.saveState(st);
    await this.refreshSummary(paperFile);
  }

  async refreshSummary(paperFile: string, overall?: string): Promise<PaperSummary | null> {
    const paper = this.loadPaper(paperFile);
    if (!paper) return null;
    const st = this.loadState();
    const summary = computeSummary(
      paper.questions,
      st.papers[paperFile] ?? {},
      overall !== undefined ? overall : (st.summaries[paperFile]?.overall ?? ''),
      paper.paper.scoreWeights,
    );
    st.summaries[paperFile] = summary;
    this.saveState(st);
    return summary;
  }

  async syncWrongbook(): Promise<{ added: number; recycled: number }> {
    const st = this.loadState();
    const { next, added, recycled } = syncWrongbookPure(st.wrongbook, st.papers);
    if (added > 0 || recycled > 0) {
      st.wrongbook = next;
      this.saveState(st);
    }
    return { added, recycled };
  }

  async recordWrongbookPractice(
    paperFile: string,
    qid: string,
    ok: boolean | null,
  ): Promise<WrongbookEntry | null> {
    const st = this.loadState();
    const k = wrongKey(paperFile, qid);
    if (!st.wrongbook[k]) {
      st.wrongbook = syncWrongbookPure(st.wrongbook, st.papers).next;
      if (!st.wrongbook[k]) {
        st.wrongbook[k] = {
          paper: paperFile,
          qid,
          streak: 0,
          passed: false,
          tries: 0,
          awaitingGrade: false,
          graduatedAt: 0,
          ts: Date.now(),
          source: 'auto',
        };
      }
    }
    st.wrongbook = recordPractice(st.wrongbook, paperFile, qid, ok);
    this.saveState(st);
    return st.wrongbook[k];
  }

  /** 主观题自行打分（0-100）：≥60 记一次连对，<60 打回；不重算原卷成绩单 */
  async saveSelfGrade(
    paperFile: string,
    qid: string,
    score: number,
  ): Promise<{ grade: Grade; entry: WrongbookEntry | null }> {
    const s = Math.max(0, Math.min(100, Math.round(score)));
    const verdict = verdictFromScore(s);
    const grade: Grade = {
      verdict,
      score: s,
      comment: '自行打分',
      correct_answer: '',
      missed_points: [],
      source: 'self',
    };
    const st = this.loadState();
    const prev = st.papers[paperFile]?.[qid];
    await this.saveAnswer(paperFile, qid, {
      value: prev?.value ?? null,
      correct: verdict === 'correct' ? true : verdict === 'wrong' ? false : null,
      grade,
    });
    const entry = await this.recordWrongbookPractice(paperFile, qid, isPassScore(s));
    return { grade, entry };
  }

  wrongbookEntries(kind: WrongbookKind): WrongbookEntry[] {
    return listWrongbook(this.loadState().wrongbook, kind);
  }

  /* ---------- 随机刷题（v0.5 抽题池：只抽做过的题） ---------- */

  /**
   * 从「全库已作答过」的题里随机抽一组。
   * 配额：编程题 ≤2、简答/改写 ≤3，其余补客观题（与 VSCode 版规划一致）。
   */
  randomSet(count = 15): {
    title: string;
    questions: (Question & { panelId: string })[];
    source: Record<string, { paper: string; qid: string }>;
  } {
    const st = this.loadState();
    const papers = this.listPapers();
    const byFile = new Map(papers.map((p) => [p.file, p]));

    const pool: { paperFile: string; q: Question }[] = [];
    for (const [file, answers] of Object.entries(st.papers)) {
      const paper = byFile.get(file);
      if (!paper) continue;
      for (const q of paper.questions) {
        const a = answers[q.id];
        if (!a || isEmptyAnswer(a.value)) continue;
        pool.push({ paperFile: file, q });
      }
    }
    shuffle(pool);

    // 先按配额从整个池子里挑（不能边遍历边凑数：那样前 15 个都是客观题时，编程题永远轮不上）
    const quota = { coding: 2, subjective: 3 };
    const isObj = (t: string) => t === 'single' || t === 'multi' || t === 'fill';
    const codingPick = pool.filter((i) => i.q.type === 'coding').slice(0, quota.coding);
    const subjPick = pool.filter((i) => i.q.type === 'short' || i.q.type === 'rewrite').slice(0, quota.subjective);
    const fixed = [...codingPick, ...subjPick];
    const inFixed = (i: { paperFile: string; q: Question }) =>
      fixed.some((f) => f.paperFile === i.paperFile && f.q.id === i.q.id);
    const objRest = pool.filter((i) => isObj(i.q.type) && !inFixed(i));
    const picked = [...fixed, ...objRest].slice(0, count);
    shuffle(picked); // 打乱顺序，别让编程题总在第一题

    const { questions, source } = buildWrongbookQuestions(picked);
    return {
      title: `随机练习（${questions.length} 题 · 只抽做过的）`,
      questions: questions as (Question & { panelId: string })[],
      source: source as Record<string, { paper: string; qid: string }>,
    };
  }

  /* ---------- 统计 ---------- */

  stats() {
    const st = this.loadState();
    const papers = this.listPapers();
    let answered = 0;
    let correct = 0;
    let judged = 0;
    const tagTotal = new Map<string, number>();
    const tagWrong = new Map<string, number>();

    for (const paper of papers) {
      const answers = st.papers[paper.file] ?? {};
      for (const q of paper.questions) {
        const a = answers[q.id] as Answer | undefined;
        if (!a || isEmptyAnswer(a.value)) continue;
        answered++;
        const tags = q.tags ?? [];
        for (const t of tags) tagTotal.set(t, (tagTotal.get(t) ?? 0) + 1);
        const v = a.correct != null ? a.correct : a.grade ? a.grade.verdict === 'correct' : null;
        if (v == null) continue;
        judged++;
        const ok = v === true || (a.grade ? a.grade.score >= 60 : false);
        if (ok) correct++;
        else for (const t of tags) tagWrong.set(t, (tagWrong.get(t) ?? 0) + 1);
      }
    }

    const weakTags = [...tagTotal.entries()]
      .filter(([, n]) => n >= 3)
      .map(([tag, n]) => ({ tag, total: n, wrong: tagWrong.get(tag) ?? 0, rate: (tagWrong.get(tag) ?? 0) / n }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total)
      .slice(0, 8);

    // 近 7 天作答量（按作答 ts 统计）
    const days: { label: string; n: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, n: 0 });
    }
    for (const answers of Object.values(st.papers)) {
      for (const a of Object.values(answers)) {
        if (!a?.ts) continue;
        const diff = Math.floor((today.getTime() - new Date(a.ts).setHours(0, 0, 0, 0)) / 86400000);
        if (diff >= 0 && diff < 7) days[6 - diff].n++;
      }
    }

    const active = listWrongbook(st.wrongbook, 'active').length;
    const passed = listWrongbook(st.wrongbook, 'passed').length;

    return {
      answered,
      correct,
      judged,
      accuracy: judged > 0 ? Math.round((correct / judged) * 100) : 0,
      paperCount: papers.length,
      wrongActive: active,
      wrongPassed: passed,
      weakTags,
      days,
    };
  }
}
