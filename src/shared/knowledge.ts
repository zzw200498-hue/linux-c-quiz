import type { Answer, PaperFile, Question } from './types';
import { TYPE_LABEL } from './types';

/**
 * 知识点速览渲染。
 * 纯字符串处理，不依赖 vscode，因此侧栏悬停提示、复习文档、后续导出都复用同一套逻辑。
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 转义可能被 markdown 误解析的字符，并把多行压成单行 */
export function inline(s: string, max = 160): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  const esc = flat.replace(/[\\`*_[\]<>#|]/g, (m) => `\\${m}`);
  return esc.length > max ? `${esc.slice(0, max)}…` : esc;
}

/** 行内代码（内容含反引号时退化为普通文本） */
function code(s: string): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '（未提供）';
  return t.includes('`') ? t : `\`${t}\``;
}

/** 代码块围栏（内容自带 ``` 时升级围栏长度） */
function fenced(body: string, lang = ''): string {
  const text = (body ?? '').replace(/\s+$/, '');
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** 引用块，便于区分「参考答案 / 我的作答」这类整段文字 */
function quote(text: string): string {
  return (text ?? '')
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

function answerKeys(q: Question): string[] {
  const a = q.answer;
  if (a == null) return [];
  const raw = Array.isArray(a) ? a : [a];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

/** 选项字母 → 「B. 选项正文」；若 answer 直接写的是文本则原样返回 */
function choiceLabel(q: Question, key: string): string {
  const upper = key.trim().toUpperCase();
  if (upper.length === 1) {
    const idx = LETTERS.indexOf(upper);
    const text = idx >= 0 ? q.choices?.[idx] : undefined;
    if (text) return `${upper}. ${inline(text, 160)}`;
  }
  return inline(key, 200);
}

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '错误',
};

function mineText(a?: Answer): string {
  const v = a?.value;
  if (v == null) return '';
  return Array.isArray(v) ? v.join('　／　') : String(v);
}

/** 判定状态：客观题交卷后有 correct，主观题导入批改后有 grade */
export function knowledgeState(a?: Answer): 'none' | 'answered' | 'judged' {
  if (!a || a.value == null) return 'none';
  if (a.grade || a.correct != null) return 'judged';
  return 'answered';
}

/** 题目是否自带可复习的知识点内容 */
export function hasKnowledge(q: Question): boolean {
  return Boolean(
    q.explain?.trim() ||
      q.referenceAnswer?.trim() ||
      q.referenceCode?.trim() ||
      q.rubrics?.length ||
      q.blanks?.length ||
      q.answer != null,
  );
}

/** 知识点正文（不含题干）——悬停提示与复习文档共用 */
export function renderKnowledgeBody(q: Question, a?: Answer): string {
  const out: string[] = [];

  if (q.type === 'single' || q.type === 'multi') {
    const keys = answerKeys(q);
    out.push(
      keys.length
        ? `**正确答案**：${keys.map((k) => choiceLabel(q, k)).join('　／　')}`
        : '**正确答案**：题库未提供',
    );
  }

  if (q.type === 'fill' && q.blanks?.length) {
    out.push('**答案**');
    out.push(
      q.blanks
        .map((b, i) => {
          const alts = (b.alt ?? [])
            .map((x) => String(x).trim())
            .filter((x) => x && x !== b.answer);
          const suffix = alts.length ? `　（也接受：${alts.map((x) => code(x)).join('、')}）` : '';
          return `${i + 1}. ${code(b.answer)}${suffix}`;
        })
        .join('\n'),
    );
  }

  if (q.referenceAnswer?.trim()) {
    out.push('**参考答案**');
    out.push(quote(q.referenceAnswer));
  }

  if (q.rubrics?.length) {
    out.push(q.type === 'short' ? '**评分要点**' : '**关键要点**');
    out.push(q.rubrics.map((r) => `- ${r}`).join('\n'));
  }

  if (q.referenceCode?.trim()) {
    out.push('**参考改写**');
    out.push(fenced(q.referenceCode, q.language || 'c'));
  }

  if (q.type === 'coding' && q.tests?.length) {
    out.push('**测试用例**');
    out.push(
      q.tests
        .map((t) => {
          const name = inline(t.name || '用例', 60);
          const args = t.args?.length ? `（${code(t.args.join(' '))}）` : '';
          return `- ${name}${args}`;
        })
        .join('\n'),
    );
  }

  if (q.explain?.trim()) {
    out.push('**解析**');
    out.push(q.explain.trim());
  }

  const mine = mineText(a).trim();
  if (mine) {
    out.push('**我的作答**');
    out.push(quote(mine.length > 400 ? `${mine.slice(0, 400)}…` : mine));
  }

  const g = a?.grade;
  if (g) {
    out.push(`**批改结果**：${g.score} 分 · ${VERDICT_LABEL[g.verdict] ?? g.verdict}`);
    if (g.comment?.trim()) out.push(quote(g.comment));
    if (g.missed_points?.length) {
      out.push('**漏掉的要点**');
      out.push(g.missed_points.map((p) => `- ${p}`).join('\n'));
    }
    if (g.correct_answer?.trim()) {
      out.push('**标准答案**');
      out.push(quote(g.correct_answer));
    }
  }

  const meta: string[] = [TYPE_LABEL[q.type]];
  if (q.tags?.length) meta.push(`标签：${q.tags.join(' / ')}`);
  if (q.difficulty) meta.push(`难度：${'★'.repeat(Math.max(1, Math.min(5, q.difficulty)))}`);
  out.push(`*${meta.join('　·　')}*`);

  return out.join('\n\n');
}

/** 侧栏悬停提示：题干摘要 + 知识点正文 */
export function renderTooltip(q: Question, a: Answer | undefined, index: number): string {
  const head = `**${String(index + 1).padStart(2, '0')} · ${TYPE_LABEL[q.type]}**`;
  const stem = inline(q.stem, 200);
  const state = knowledgeState(a);
  const mark = state === 'judged' ? (a?.grade ? `　${a.grade.score} 分` : a?.correct ? '　✓' : '　✗') : '';
  return [`${head}${mark}`, '', stem, '', renderKnowledgeBody(q, a)].join('\n');
}

/** 整卷知识点速览（Markdown 文档，用于复习 / 打印 / 存档） */
export function renderPaperKnowledge(
  paper: PaperFile,
  answers: Record<string, Answer>,
  now: Date = new Date(),
): string {
  const qs = paper.questions;
  let ok = 0;
  let bad = 0;
  let pending = 0;
  let blank = 0;
  for (const q of qs) {
    const a = answers[q.id];
    const state = knowledgeState(a);
    if (state === 'none') blank++;
    else if (a?.grade) {
      if (a.grade.verdict === 'correct') ok++;
      else bad++;
    } else if (a?.correct === true) ok++;
    else if (a?.correct === false) bad++;
    else pending++;
  }

  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;

  const head: string[] = [
    `# ${paper.paper.title} · 知识点速览`,
    '',
    `> 共 ${qs.length} 题　·　✅ ${ok}　❌ ${bad}　⏳ 待批改 ${pending}　⬜ 未作答 ${blank}`,
    `> 主题：${paper.paper.topics?.join(' / ') || '—'}${paper.paper.date ? `　·　试卷日期：${paper.paper.date}` : ''}`,
    `> 生成时间：${stamp}`,
    '',
  ];

  const body = qs.map((q, i) => {
    const a = answers[q.id];
    const state = knowledgeState(a);
    const mark =
      state === 'none'
        ? '⬜ 未作答'
        : a?.grade
          ? `📝 ${a.grade.score} 分 · ${VERDICT_LABEL[a.grade.verdict] ?? a.grade.verdict}`
          : a?.correct === true
            ? '✅ 正确'
            : a?.correct === false
              ? '❌ 错误'
              : '⏳ 待批改';
    return [
      '---',
      '',
      `## ${String(i + 1).padStart(2, '0')} · ${TYPE_LABEL[q.type]}　${mark}`,
      '',
      q.stem.trim(),
      '',
      renderKnowledgeBody(q, a),
      '',
    ].join('\n');
  });

  return [...head, ...body].join('\n');
}
