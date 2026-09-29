import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { extractYaml } from './importer';
import { gradeSchema, TYPE_LABEL, type PaperFile, type Question } from '../shared/types';
import type { Store } from './store';

/* ---------- 提示词读取：工作区 prompts/ 优先，扩展内置兜底 ---------- */

export async function readPrompt(ctx: vscode.ExtensionContext, store: Store, name: string): Promise<string> {
  if (store.wsRoot) {
    const wsPath = vscode.Uri.joinPath(store.wsRoot, 'prompts', name).fsPath;
    if (fs.existsSync(wsPath)) return fs.readFileSync(wsPath, 'utf8');
  }
  const extPath = vscode.Uri.joinPath(ctx.extensionUri, 'prompts', name).fsPath;
  return fs.readFileSync(extPath, 'utf8');
}

/* ---------- 导出作答（生成批改请求） ---------- */

const gradeListSchema = z.object({
  grades: z.record(z.string(), gradeSchema),
});

function fmtValue(v: string | string[] | null): string {
  if (v === null) return '（未作答）';
  if (Array.isArray(v)) return v.join('，');
  return v;
}

function questionSection(q: Question, value: string | string[] | null, auto?: boolean | null): string {
  const lines: string[] = [];
  lines.push(`## ${q.id} [${TYPE_LABEL[q.type]}] 难度${q.difficulty}${q.tags.length ? ' 标签:' + q.tags.join('/') : ''}`);
  lines.push('题干：');
  lines.push('```');
  lines.push(q.stem);
  lines.push('```');
  if (q.choices?.length) {
    lines.push('选项：');
    q.choices.forEach((c, i) => lines.push(`- ${String.fromCharCode(65 + i)}. ${c}`));
  }
  if (q.answer !== undefined) lines.push(`【参考答案】${Array.isArray(q.answer) ? q.answer.join('，') : q.answer}`);
  if (q.referenceAnswer) lines.push(`【参考答案】\n${q.referenceAnswer}`);
  if (q.referenceCode) lines.push(`【参考代码】\n\`\`\`\n${q.referenceCode}\n\`\`\``);
  if (q.rubrics?.length) lines.push(`【评分要点】\n${q.rubrics.map((r) => `- ${r}`).join('\n')}`);
  if (q.explain) lines.push(`【解析】${q.explain}`);
  lines.push('【我的作答】');
  lines.push(typeof value === 'string' && /[{}\n;]/.test(value) ? `\`\`\`\n${value}\n\`\`\`` : fmtValue(value));
  if (auto === true) lines.push('（客观题自动判定：正确）');
  if (auto === false) lines.push('（客观题自动判定：错误）');
  return lines.join('\n');
}

export async function buildReviewMarkdown(
  ctx: vscode.ExtensionContext,
  store: Store,
  paperFile: PaperFile | string,
): Promise<string> {
  const file = typeof paperFile === 'string' ? paperFile : paperFile.file;
  const paper = await store.loadPaper(file);
  if (!paper) throw new Error(`找不到试卷 ${file}`);
  const st = await store.loadState();
  const answers = st.papers[file] ?? {};

  const head = await readPrompt(ctx, store, 'review.md');
  const body = paper.questions
    .map((q) => questionSection(q, answers[q.id]?.value ?? null, answers[q.id]?.correct))
    .join('\n\n---\n\n');
  return `${head.replace('{{PAPER_TITLE}}', paper.paper.title)}\n\n=== 题目与作答（${paper.paper.title}）===\n\n${body}\n`;
}

export async function exportAnswers(
  ctx: vscode.ExtensionContext,
  store: Store,
  file: string,
): Promise<void> {
  const md = await buildReviewMarkdown(ctx, store, file);
  const root = store.wsRoot!;
  const outDir = vscode.Uri.joinPath(root, '.quiz', 'export').fsPath;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.parse(file).name}-${Date.now()}.md`);
  fs.writeFileSync(outPath, md, 'utf8');
  await vscode.env.clipboard.writeText(md);
  const doc = await vscode.workspace.openTextDocument(outPath);
  await vscode.window.showTextDocument(doc, { preview: true });
  void vscode.window.showInformationMessage(
    '批改请求已生成并复制到剪贴板：粘贴给 DeepSeek，收到回复后运行「导入批改结果（从剪贴板）」。',
  );
}

/* ---------- 导入批改结果 ---------- */

export async function importGradesFromClipboard(
  ctx: vscode.ExtensionContext,
  store: Store,
  provider: { refresh(): Promise<void> | void },
  file: string,
): Promise<void> {
  const text = await vscode.env.clipboard.readText();
  if (!text.trim()) {
    void vscode.window.showErrorMessage('剪贴板为空：先把 DeepSeek 的批改回复复制下来。');
    return;
  }
  let data: unknown;
  try {
    data = yamlLoad(extractYaml(text));
  } catch (e) {
    void vscode.window.showErrorMessage(`解析失败：不是合法 YAML —— ${String(e)}`);
    return;
  }
  const parsed = gradeListSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    void vscode.window.showErrorMessage(
      `批改结果格式不对（需要 { grades: { qid: {verdict,score,...} } }）：\n${issues}`,
      { modal: true },
    );
    return;
  }
  const hit = await store.mergeGrades(file, parsed.data.grades);
  await provider.refresh();
  void vscode.window.showInformationMessage(
    hit > 0 ? `已导入 ${hit} 条批改结果，错题已可在侧栏查看。` : '批改结果里没有匹配到本卷的题目 id，请确认是同一份卷。',
  );
}
