#!/usr/bin/env node
/**
 * 把 DeepSeek 生成的"已做过的卷子"（含 user_answer）导入题库。
 *
 * 源格式（DS YAML）: papers: [ { paper: {title}, questions: [ {id,type,stem,choices,answer,user_answer,explain} ] } ]
 * 题型映射:
 *   single   -> single（保留选项与答案字母）
 *   analysis -> fill  （题干代码放入 ```c 围栏，末尾加 输出结果：____1____）
 *   fill     -> fill  （把 ______ 替换为 ____1____/____2____，多空按"，"拆分答案）
 *   rewrite  -> short （参考答案 = answer）
 *   coding   -> short （参考答案 = answer）
 *   short    -> short
 *
 * 同时把 user_answer 预写入 bank/.quiz/state.json：
 *   客观题按 judge 规则（归一化）算好 correct；主观题 correct=null（待批改）。
 *
 * 用法: node scripts/import-ds-paper.cjs <源YAML> [题库目录] [状态文件]
 * 默认: 题库目录 bank/bank，状态文件 bank/.quiz/state.json
 */
const fs = require('fs');
const path = require('path');
const { load, dump } = require(path.join(__dirname, '..', 'node_modules', 'js-yaml'));

const [, , srcArg, bankArg, stateArg] = process.argv;
if (!srcArg) {
  console.error('用法: node scripts/import-ds-paper.cjs <源YAML> [题库目录] [状态文件]');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const bankDir = path.resolve(root, bankArg ?? 'bank/bank');
const stateFile = path.resolve(root, stateArg ?? 'bank/.quiz/state.json');

/** 与 src/shared/judge.ts 的 normalize 保持一致 */
function normalize(s) {
  return String(s).trim().replace(/\s+/g, '').toLowerCase().replace(/[。．.]+$/, '');
}

/** 每套卷子的 topics（按标题匹配，未命中则为空） */
const TOPICS = [
  { match: /C语言综合复习/, topics: ['C语言基础', '数组', '函数', '指针', '结构体', 'Makefile'] },
  { match: /Linux.*Makefile.*综合测试/, topics: ['Linux命令', 'Makefile', '指针', '贪吃蛇'] },
];

function pad(i) {
  return `q${String(i).padStart(2, '0')}`;
}

/** 把 DS 填空题的 ______ 换成带序号占位符，返回 { stem, count } */
function numberBlanks(stem) {
  let n = 0;
  const out = stem.replace(/_{3,}/g, () => `____${++n}____`);
  return { stem: out, count: n };
}

/** 多空答案拆分："目标文件，所有依赖文件" -> ["目标文件","所有依赖文件"] */
function splitAnswer(s, count) {
  const str = String(s);
  if (count <= 1) return [str];
  const parts = str.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  while (parts.length < count) parts.push('');
  return parts;
}

/** 含"或"的答案拆出可选写法："ps aux 或 ps -ef" -> alts */
function altsFor(ans) {
  const str = String(ans);
  if (!str.includes(' 或 ')) return [];
  return str.split(' 或 ').map((x) => x.trim()).filter(Boolean);
}

function convertQuestion(q, idx) {
  const id = pad(idx + 1);
  const explain = q.explain ? String(q.explain) : undefined;
  const base = { id, explain, tags: [], difficulty: 1 };

  if (q.type === 'single') {
    return {
      ...base,
      type: 'single',
      stem: String(q.stem),
      choices: (q.choices ?? []).map(String),
      answer: String(q.answer).trim(),
    };
  }

  if (q.type === 'analysis') {
    const raw = String(q.stem);
    const nl = raw.indexOf('\n');
    const head = nl === -1 ? raw : raw.slice(0, nl);
    const code = nl === -1 ? '' : raw.slice(nl + 1);
    return {
      ...base,
      type: 'fill',
      stem: `${head}\n\`\`\`c\n${code}\n\`\`\`\n输出结果：____1____`,
      blanks: [{ answer: String(q.answer), alt: [] }],
    };
  }

  if (q.type === 'fill') {
    const { stem, count } = numberBlanks(String(q.stem));
    const answers = splitAnswer(q.answer, count);
    const blanks = answers.map((a) => {
      const alts = altsFor(a).filter((x) => normalize(x) !== normalize(a));
      return { answer: a, alt: alts };
    });
    return { ...base, type: 'fill', stem, blanks };
  }

  // rewrite / coding / short -> short（主观题）
  return {
    ...base,
    type: 'short',
    stem: String(q.stem),
    referenceAnswer: String(q.answer),
  };
}

/** 计算客观题正确性（与 judge.ts 一致） */
function judgeConverted(q, value) {
  if (q.type === 'single') return normalize(value) === normalize(q.answer);
  if (q.type === 'fill') {
    const arr = Array.isArray(value) ? value : [value];
    return q.blanks.every((b, i) => {
      const v = normalize(arr[i] ?? '');
      if (!v) return false;
      return [b.answer, ...(b.alt ?? [])].some((c) => normalize(c) === v);
    });
  }
  return null;
}

function buildStateEntry(q, userAnswer) {
  if (q.type === 'single') {
    const v = String(userAnswer).trim();
    return { value: v, correct: judgeConverted(q, v), ts: Date.now() };
  }
  if (q.type === 'fill') {
    const count = q.blanks.length;
    const parts = count > 1 ? splitAnswer(userAnswer, count) : [String(userAnswer)];
    return { value: parts, correct: judgeConverted(q, parts), ts: Date.now() };
  }
  return { value: String(userAnswer), correct: null, ts: Date.now() };
}

/* ---------------- 主流程 ---------------- */

const src = load(fs.readFileSync(srcArg, 'utf8'));
const papers = src.papers ?? [];
if (!papers.length) {
  console.error('源文件里没有 papers');
  process.exit(1);
}

fs.mkdirSync(bankDir, { recursive: true });

// 读现有状态
let state = { papers: {} };
if (fs.existsSync(stateFile)) {
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = { papers: {} };
  }
}
state.papers ??= {};

for (const p of papers) {
  const title = String(p.paper?.title ?? 'untitled');
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'untitled';
  const fileName = `${safe}.yaml`;

  const topics = (TOPICS.find((t) => t.match.test(title)) ?? {}).topics ?? [];
  const converted = (p.questions ?? []).map((q, i) => convertQuestion(q, i));
  const doc = { paper: { title, topics }, questions: converted };
  fs.writeFileSync(path.join(bankDir, fileName), dump(doc, { lineWidth: -1 }), 'utf8');

  // 预写入答记录
  const rec = {};
  (p.questions ?? []).forEach((q, i) => {
    const cq = converted[i];
    if (q.user_answer === undefined || q.user_answer === null) return;
    rec[cq.id] = buildStateEntry(cq, q.user_answer);
  });
  state.papers[fileName] = { ...(state.papers[fileName] ?? {}), ...rec };

  const types = {};
  converted.forEach((q) => (types[q.type] = (types[q.type] ?? 0) + 1));
  console.log(`已导入《${title}》 -> ${fileName}`);
  console.log(`  题数 ${converted.length}（${Object.entries(types).map(([k, v]) => `${k}×${v}`).join(' ')}），含历史作答 ${Object.keys(rec).length} 题`);
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
console.log(`作答状态已更新: ${stateFile}`);
