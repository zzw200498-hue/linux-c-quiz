import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import {
  answerSchema,
  paperSchema,
  stateSchema,
  type PaperFile,
  type PaperSummary,
  type QuizState,
} from '../shared/types';
import { computeSummary } from '../shared/summary';

export class Store {
  constructor(private ctx: vscode.ExtensionContext) {}

  get wsRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  bankDir(): vscode.Uri | undefined {
    const root = this.wsRoot;
    if (!root) return undefined;
    const rel = vscode.workspace.getConfiguration('quiz').get<string>('bankPath', 'bank');
    return vscode.Uri.joinPath(root, rel);
  }

  private stateFile(): vscode.Uri | undefined {
    const root = this.wsRoot;
    if (!root) return undefined;
    return vscode.Uri.joinPath(root, '.quiz', 'state.json');
  }

  /* ---------- 题库 ---------- */

  async listPapers(): Promise<PaperFile[]> {
    const dir = this.bankDir();
    if (!dir || !fs.existsSync(dir.fsPath)) return [];
    const out: PaperFile[] = [];
    for (const name of fs.readdirSync(dir.fsPath)) {
      if (!/\.ya?ml$/i.test(name)) continue;
      try {
        const raw = yamlLoad(fs.readFileSync(path.join(dir.fsPath, name), 'utf8'));
        const parsed = paperSchema.parse(raw);
        out.push({ file: name, paper: parsed.paper, questions: parsed.questions });
      } catch (e) {
        console.warn(`[quiz] 试卷解析失败: ${name}`, e);
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  async loadPaper(file: string): Promise<PaperFile | undefined> {
    const dir = this.bankDir();
    if (!dir) return undefined;
    const full = path.join(dir.fsPath, file);
    if (!fs.existsSync(full)) return undefined;
    const raw = yamlLoad(fs.readFileSync(full, 'utf8'));
    const parsed = paperSchema.parse(raw);
    return { file, paper: parsed.paper, questions: parsed.questions };
  }

  /** 把通过校验的试卷对象落盘为 bank/<标题>.yaml */
  async savePaper(title: string, data: unknown): Promise<string> {
    const dir = this.bankDir();
    if (!dir) throw new Error('没有打开的工作区');
    fs.mkdirSync(dir.fsPath, { recursive: true });
    const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'untitled';
    let name = `${safe}.yaml`;
    let i = 2;
    while (fs.existsSync(path.join(dir.fsPath, name))) name = `${safe}-${i++}.yaml`;
    fs.writeFileSync(path.join(dir.fsPath, name), yamlDump(data, { lineWidth: -1 }), 'utf8');
    return name;
  }

  /* ---------- 作答状态 ---------- */

  async loadState(): Promise<QuizState> {
    const f = this.stateFile();
    if (!f || !fs.existsSync(f.fsPath)) return stateSchema.parse({});
    try {
      return stateSchema.parse(JSON.parse(fs.readFileSync(f.fsPath, 'utf8')));
    } catch {
      return stateSchema.parse({});
    }
  }

  async saveState(state: QuizState): Promise<void> {
    const f = this.stateFile();
    if (!f) return;
    fs.mkdirSync(path.dirname(f.fsPath), { recursive: true });
    fs.writeFileSync(f.fsPath, JSON.stringify(state, null, 2), 'utf8');
  }

  /** 删除试卷：文件移到 .quiz/trash/（可手动恢复），同时清掉该卷的作答记录 */
  async deletePaper(file: string): Promise<string | undefined> {
    const dir = this.bankDir();
    const root = this.wsRoot;
    if (!dir || !root) return undefined;
    const src = path.join(dir.fsPath, file);
    if (!fs.existsSync(src)) return undefined;
    const trashDir = path.join(root.fsPath, '.quiz', 'trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const dst = path.join(trashDir, `${Date.now()}-${file}`);
    fs.renameSync(src, dst);
    const st = await this.loadState();
    if (st.papers[file] || st.summaries[file]) {
      delete st.papers[file];
      delete st.summaries[file];
      await this.saveState(st);
    }
    return dst;
  }

  async getAnswer(paperFile: string, qid: string) {
    const st = await this.loadState();
    return st.papers[paperFile]?.[qid];
  }

  /** 把知识点速览写成 .quiz/review/<标题>-知识点.md，返回文件 Uri */
  async writeReviewDoc(title: string, content: string): Promise<vscode.Uri | undefined> {
    const root = this.wsRoot;
    if (!root) return undefined;
    const dir = vscode.Uri.joinPath(root, '.quiz', 'review');
    fs.mkdirSync(dir.fsPath, { recursive: true });
    const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'review';
    const uri = vscode.Uri.joinPath(dir, `${safe}-知识点.md`);
    fs.writeFileSync(uri.fsPath, content, 'utf8');
    return uri;
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
    const st = await this.loadState();
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
    await this.saveState(st);
  }

  /** 合并批改结果，返回命中的题目数；overall 为批改者给的整卷总评 */
  async mergeGrades(
    paperFile: string,
    grades: Record<string, { verdict: 'correct' | 'partial' | 'wrong' } & Record<string, unknown>>,
    overall?: string,
  ): Promise<number> {
    const paper = await this.loadPaper(paperFile);
    if (!paper) return 0;
    const ids = new Set(paper.questions.map((q) => q.id));
    let hit = 0;
    const st = await this.loadState();
    st.papers[paperFile] ??= {};
    for (const [qid, g] of Object.entries(grades)) {
      if (!ids.has(qid)) continue;
      hit++;
      const prev = st.papers[paperFile][qid];
      st.papers[paperFile][qid] = answerSchema.parse({
        ...prev,
        value: prev?.value ?? null,
        correct: g.verdict === 'correct' ? true : g.verdict === 'wrong' ? false : null,
        ts: prev?.ts ?? Date.now(),
        grade: g,
      });
    }
    if (hit > 0) await this.refreshSummaryInState(paper, st, paperFile, overall);
    await this.saveState(st);
    return hit;
  }

  /** 重新计算并保存某卷成绩单（供交卷/清除判定/导入批改后调用），返回新成绩单 */
  async refreshSummary(paperFile: string, overall?: string): Promise<PaperSummary | null> {
    const paper = await this.loadPaper(paperFile);
    if (!paper) return null;
    const st = await this.loadState();
    const summary = await this.refreshSummaryInState(paper, st, paperFile, overall);
    await this.saveState(st);
    return summary;
  }

  /** 在已有 state 对象上重算成绩单（不落盘）；overall 传 undefined 时保留已存储的批改总评 */
  private refreshSummaryInState(
    paper: PaperFile,
    st: QuizState,
    paperFile: string,
    overall?: string,
  ): PaperSummary {
    const finalOverall = overall !== undefined ? overall : (st.summaries[paperFile]?.overall ?? '');
    const summary = computeSummary(paper.questions, st.papers[paperFile] ?? {}, finalOverall);
    st.summaries[paperFile] = summary;
    return summary;
  }

  /** 读取某卷成绩单（没有则返回 null） */
  async getSummary(paperFile: string): Promise<PaperSummary | null> {
    const st = await this.loadState();
    return st.summaries[paperFile] ?? null;
  }
}
