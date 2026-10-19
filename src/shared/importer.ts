import { paperSchema, TYPE_LABEL, type Paper } from './types';

/**
 * 导入新卷的纯逻辑（VSCode 插件和桌面端共用）。
 * 这里刻意不碰 vscode API、不碰文件系统 —— 只负责「文本 → 校验过的试卷」。
 */

/** 从一段文本里取出 yaml：优先 ```yaml 围栏块，否则整篇当 yaml 用 */
export function extractYaml(text: string): string {
  const fence = /```ya?ml\s*\r?\n([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1];
  // 无语言标记的围栏：只有当它本身就是整卷（含顶层 paper: / questions:）时才采用。
  // 否则会误伤 —— 题库 yaml 内部常有 ```c 代码块，那样会把第一个代码块当成整卷内容。
  const plain = /```\s*\r?\n([\s\S]*?)```/.exec(text);
  if (plain && /(^|\n)\s*(paper|questions)\s*:/i.test(plain[1])) return plain[1];
  return text;
}

export type ParseResult =
  | { ok: true; data: Paper }
  | { ok: false; stage: 'yaml' | 'schema'; message: string; issues?: string[] };

/**
 * 文本 → 试卷。yaml 语法错误和结构校验不通过都给中文说明，
 * 因为用户是直接从 AI 对话框里复制过来的，出错很常见。
 */
export function parsePaperText(
  text: string,
  loadYaml: (raw: string) => unknown,
): ParseResult {
  let data: unknown;
  try {
    data = loadYaml(extractYaml(text).trim());
  } catch (e) {
    return { ok: false, stage: 'yaml', message: yamlHint(e) };
  }

  const parsed = paperSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => {
      const at = i.path.join('.') || '(顶层)';
      return `${at}：${i.message}`;
    });
    return {
      ok: false,
      stage: 'schema',
      message: `字段校验没通过（共 ${parsed.error.issues.length} 处）`,
      issues,
    };
  }
  return { ok: true, data: parsed.data };
}

/** js-yaml 的报错多半是缩进问题，给一句人话提示 */
function yamlHint(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  let hint = msg.split('\n')[0];
  if (/bad indentation|could not find expected|mapping values are not allowed/i.test(msg)) {
    hint += '（多半是缩进问题：代码块粘贴时丢了缩进，或用了 Tab 混空格）';
  }
  if (/end of the stream|unexpected end/i.test(msg)) {
    hint += '（看着像没复制完整，代码块后半段可能丢了）';
  }
  return hint;
}

/** 标题 → 安全文件名（去掉 Windows 非法字符，限长） */
export function safePaperName(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '') // 全是空白/符号的标题会只剩 '-'，这里抹掉
    .slice(0, 60);
  return s || 'untitled';
}

/** 在这个目录里找一个不重名的文件名（重了就加 -2、-3） */
export function uniquePaperFileName(dir: string, title: string, exists: (p: string) => boolean): string {
  const safe = safePaperName(title);
  let name = `${safe}.yaml`;
  let i = 2;
  while (exists(`${dir}/${name}`)) name = `${safe}-${i++}.yaml`;
  return name;
}

export type LintResult = { errors: string[]; warnings: string[] };

const LETTERS = 'ABCDEFGH';

/**
 * 入库质量检查 —— schema 只管字段类型，管不了「选择题有没有选项」这类
 * 「能解析但根本没法做」的问题。AI 出题偶尔会漏，这里替用户先挡一道。
 *
 * errors   = 没法做（会导致作答/判分错乱）→ 拦下不导入
 * warnings = 能做但体验差（缺解析、缺评分要点）→ 放行，但提示
 */
export function lintPaper(p: Paper): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  if (!p.paper.title?.trim()) errors.push('试卷缺少 paper.title');

  for (const [i, q] of p.questions.entries()) {
    const label = TYPE_LABEL[q.type] ?? q.type;
    const at = `第 ${i + 1} 题（id=${q.id}）`;

    if (seen.has(q.id)) errors.push(`${at}：题号 id 与其它题重复，作答记录会串，请改成唯一值`);
    seen.add(q.id);
    if (!q.stem?.trim()) errors.push(`${at}：题干为空`);

    if (q.type === 'single' || q.type === 'multi') {
      const choices = q.choices ?? [];
      const ans = Array.isArray(q.answer) ? q.answer : q.answer ? [q.answer] : [];
      if (choices.length < 2) {
        errors.push(`${at}：${label}题必须给至少 2 个选项（choices）`);
      }
      const legal = LETTERS.slice(0, choices.length).split('');
      if (ans.length === 0) {
        errors.push(`${at}：${label}题没给 answer，无法判分`);
      } else {
        const bad = ans.filter((a) => !legal.includes(String(a).trim().toUpperCase()));
        if (bad.length) {
          errors.push(
            `${at}：answer 里的 ${bad.join('/')} 超出选项范围（本题可选 A-${legal[legal.length - 1] ?? '?'}）`,
          );
        }
        if (q.type === 'single' && ans.length > 1) {
          errors.push(`${at}：单选题给了 ${ans.length} 个正确答案，只能有一个`);
        }
      }
    }

    if (q.type === 'fill') {
      const blanks = q.blanks ?? [];
      const maxSlot = Math.max(
        0,
        ...[...q.stem.matchAll(/____(\d+)____/g)].map((m) => Number(m[1])),
      );
      if (blanks.length === 0) {
        errors.push(`${at}：填空题没给 blanks 答案`);
      } else if (maxSlot !== blanks.length) {
        errors.push(
          `${at}：题干里有 ${maxSlot} 个空位（ ____1____ 这样数），但 blanks 给了 ${blanks.length} 个答案`,
        );
      }
    }

    if (q.type === 'coding') {
      // 没有 tests 的编程题仍能做（自己写、自己跑），只是不能自动判 —— 算提醒不算拦
      if (!q.tests?.length) {
        warnings.push(`${at}：编程题没有 tests 用例，只能自己写代码看结果，没法自动跑测试`);
      }
      if (!q.templateCode?.trim()) warnings.push(`${at}：编程题没有 templateCode，编辑器会是空的`);
      else if (!q.solutionCode?.trim()) {
        warnings.push(`${at}：编程题缺 solutionCode（无法校验用例本身是否可靠）`);
      }
    }

    if (q.type === 'short' || q.type === 'rewrite') {
      if (q.type === 'rewrite' && !q.originCode?.trim()) {
        errors.push(`${at}：改写题缺少 originCode（要改写的原代码）`);
      }
      if (!q.rubrics?.length) warnings.push(`${at}：${label}题没有评分要点 rubrics，批改会更主观`);
      if (q.type === 'short' && !q.referenceAnswer?.trim()) {
        warnings.push(`${at}：简答题没有参考答案 referenceAnswer`);
      }
    }

    if (!q.explain?.trim() && (q.type === 'single' || q.type === 'multi')) {
      warnings.push(`${at}：没有解析 explain（错题本里看不到为什么）`);
    }
  }

  return { errors, warnings };
}

/** 「单选×8，多选×4」这种题型的摘要 */
export function paperTypeSummary(questions: { type: string }[]): string {
  const counts = new Map<string, number>();
  for (const q of questions) counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t as keyof typeof TYPE_LABEL] ?? t}×${n}`)
    .join('，');
}
