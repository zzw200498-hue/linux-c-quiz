/**
 * 开发期自检：把题库里的题渲染成侧栏悬停提示 + 整卷知识点速览，肉眼确认 Markdown 是否正确。
 * 用法：npx esbuild scripts/preview-knowledge.ts --bundle --platform=node --outfile=dist/preview-knowledge.cjs --log-level=warning
 *        node dist/preview-knowledge.cjs "bank/bank/xxx.yaml"
 */
import * as fs from 'fs';
import * as path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { answerSchema, paperSchema, stateSchema, type Answer } from '../src/shared/types';
import { renderPaperKnowledge, renderTooltip } from '../src/shared/knowledge';

const arg = process.argv[2] ?? 'bank/bank';
let yamlPath = arg;
if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
  const f = fs.readdirSync(arg).find((x) => /\.ya?ml$/i.test(x));
  yamlPath = f ? path.join(arg, f) : arg;
  if (!f) {
    console.error(`目录下没有 yaml: ${arg}`);
    process.exit(1);
  }
}

const paper = paperSchema.parse(yamlLoad(fs.readFileSync(yamlPath, 'utf8')));
const file = path.basename(yamlPath);

/** 约定：state.json 位于题库目录的上一级 .quiz/ 下 */
const statePath = path.join(path.dirname(path.dirname(yamlPath)), '.quiz', 'state.json');
let answers: Record<string, Answer> = {};
if (fs.existsSync(statePath)) {
  const st = stateSchema.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  answers = st.papers[file] ?? {};
  console.log(`已读取作答状态：${statePath}（${Object.keys(answers).length} 条）`);
} else {
  console.log(`未找到作答状态：${statePath}`);
  // 给几个样例用于观察渲染效果
  answers = {
    q01: { value: 'C', correct: false, ts: Date.now() },
    q21: {
      value: '标准 IO 有缓冲，系统调用没有。',
      correct: null,
      ts: Date.now(),
      grade: answerSchema.shape.grade.parse({
        verdict: 'partial',
        score: 60,
        comment: '漏了操作对象的区别，嵌入式实时性也没提。',
        correct_answer: 'FILE * vs 文件描述符',
        missed_points: ['未提 FILE * 与文件描述符', '未说明硬件操作实时性'],
      }),
    },
  } as Record<string, Answer>;
}

const picks = process.argv[3]
  ? process.argv[3]
      .split(',')
      .map((id) => paper.questions.find((q) => q.id === id.trim()))
      .filter((q): q is NonNullable<typeof q> => Boolean(q))
  : paper.questions.filter((q) => answers[q.id]).slice(0, 3);
const shown = picks.length ? picks : paper.questions.slice(0, 2);
for (const q of shown) {
  console.log(`\n===== 悬停提示预览 ${q.id}（${answers[q.id] ? '用真实作答' : '无作答'}）=====`);
  console.log(renderTooltip(q, answers[q.id], paper.questions.indexOf(q)));
}

console.log('\n\n===== 整卷知识点速览（前 80 行）=====');
const doc = renderPaperKnowledge({ file, paper: paper.paper, questions: paper.questions }, answers);
console.log(doc.split('\n').slice(0, 80).join('\n'));

// --out=<path>：把完整速览写到文件（用于生成样例 / 手工复习文档）
const outArg = process.argv.find((a) => a.startsWith('--out='));
if (outArg) {
  const outPath = outArg.slice('--out='.length);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, doc, 'utf8');
  console.log(`\n已写入：${outPath}`);
}
