import * as fs from 'fs';
import * as path from 'path';
import type { PaperFile, Question, RunSummary } from '../shared/types';
import { runQuestionTests } from './tester';
import type { TesterConfig } from './tester';
import type { Runner } from '../runner';

export type QuestionVerify = {
  qid: string;
  stem: string;
  ok: boolean;
  /** 没配 solutionCode，跳过 */
  skipped?: boolean;
  error?: string;
  summary?: RunSummary;
};

export type PaperVerify = {
  paperFile: string;
  title: string;
  results: QuestionVerify[];
  /** 需要人工关注的用例问题（参考答案跑不过的） */
  badTests: { qid: string; test: string; reason: string }[];
};

/** 编程题的入口文件名 */
function entryName(q: Question): string {
  const lang = (q.language ?? 'c').toLowerCase();
  if (lang === 'makefile') return 'Makefile';
  if (lang === 'python' || lang === 'py') return 'main.py';
  if (lang === 'shell' || lang === 'sh') return 'main.sh';
  return lang === 'cpp' || lang === 'c++' ? 'main.cpp' : 'main.c';
}

function rmRf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 用例自检：把每道编程题的 solutionCode 落盘，真跑一遍 tests。
 * 参考答案都跑不过的用例一定是坏用例（期望输出写死顺序、漏配文件、依赖缺失等），
 * 应该在录入时逮住，而不是让学生做题时撞上。
 */
export async function verifyPaperSolutions(
  runner: Runner,
  paper: PaperFile,
  baseDir: string,
  cfg: TesterConfig,
): Promise<PaperVerify> {
  const coding = paper.questions.filter((q) => q.type === 'coding');
  const results: QuestionVerify[] = [];
  const badTests: PaperVerify['badTests'] = [];

  for (const q of coding) {
    const stem = q.stem.slice(0, 60);
    if (!q.solutionCode) {
      results.push({ qid: q.id, stem, ok: false, skipped: true, error: '未配置 solutionCode（参考答案），无法自检。' });
      continue;
    }
    if (!q.tests || q.tests.length === 0) {
      results.push({ qid: q.id, stem, ok: false, skipped: true, error: '没有配置 tests 用例。' });
      continue;
    }

    const dir = path.join(baseDir, '.quiz', 'verify', q.id);
    rmRf(dir);
    fs.mkdirSync(dir, { recursive: true });
    // 入口文件 = 参考答案；files 里同名条目让位
    fs.writeFileSync(path.join(dir, entryName(q)), q.solutionCode, 'utf8');
    for (const [name, content] of Object.entries(q.files ?? {})) {
      const abs = path.join(dir, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (path.basename(abs) === entryName(q)) continue;
      fs.writeFileSync(abs, content, 'utf8');
    }

    try {
      const summary = await runQuestionTests(runner, q, dir, cfg);
      results.push({ qid: q.id, stem, ok: summary.passed === summary.total, summary });
      for (const t of summary.tests) {
        if (!t.passed) {
          const reason = t.timedOut
            ? '超时'
            : t.error
              ? `执行出错：${t.error}`
              : `exit=${t.exitCode}，实际输出=${JSON.stringify(t.stdout.slice(0, 200))}，期望=${JSON.stringify(t.expected.slice(0, 200))}`;
          badTests.push({ qid: q.id, test: t.name || '用例', reason });
        }
      }
      if (summary.error) badTests.push({ qid: q.id, test: '（整体）', reason: summary.error });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      results.push({ qid: q.id, stem, ok: false, error: msg });
      badTests.push({ qid: q.id, test: '（整体）', reason: msg });
    }
  }

  return { paperFile: paper.file, title: paper.paper.title, results, badTests };
}
