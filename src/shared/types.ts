import { z } from 'zod';

/* ---------------- 题目 / 试卷 ---------------- */

export const QUESTION_TYPES = ['single', 'multi', 'fill', 'short', 'rewrite', 'coding'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const TYPE_LABEL: Record<QuestionType, string> = {
  single: '单选',
  multi: '多选',
  fill: '填空',
  short: '简答',
  rewrite: '代码改写',
  coding: '编程',
};

const blankSchema = z.object({
  answer: z.string(),
  alt: z.array(z.string()).default([]),
});

const testSchema = z.object({
  name: z.string().default(''),
  args: z.array(z.string()).default([]),
  stdin: z.string().default(''),
  expectedStdout: z.string().default(''),
  /** exact: 精确比对（默认）；contains: 忽略顺序/前后缀的包含比对 */
  match: z.enum(['exact', 'contains']).default('exact'),
  /** 命令跑完后必须存在的文件/目录（相对 scratch 目录），如 make 产物 */
  checkPresent: z.array(z.string()).default([]),
  /** 命令跑完后必须消失的文件/目录，如 make clean 后的产物 */
  checkAbsent: z.array(z.string()).default([]),
});

/** 编程题的固定配套文件（如 source.txt 输入样例、多文件工程的 file_io.c 等），写入 scratch 目录 */
const filesSchema = z.record(z.string(), z.string());

export const questionSchema = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  stem: z.string(),
  choices: z.array(z.string()).optional(),
  answer: z.union([z.string(), z.array(z.string())]).optional(),
  blanks: z.array(blankSchema).optional(),
  referenceAnswer: z.string().optional(),
  originCode: z.string().optional(),
  referenceCode: z.string().optional(),
  language: z.string().optional(),
  templateCode: z.string().optional(),
  /** 编程题参考答案：用于「用例自检」（参考答案跑不过的用例 = 坏用例） */
  solutionCode: z.string().optional(),
  tests: z.array(testSchema).optional(),
  files: filesSchema.optional(),
  rubrics: z.array(z.string()).optional(),
  explain: z.string().optional(),
  tags: z.array(z.string()).default([]),
  difficulty: z.number().default(1),
});

export const paperSchema = z.object({
  paper: z.object({
    title: z.string(),
    topics: z.array(z.string()).default([]),
    date: z.string().optional(),
  }),
  questions: z.array(questionSchema).min(1),
});

export type Blank = z.infer<typeof blankSchema>;
export type Test = z.infer<typeof testSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Paper = z.infer<typeof paperSchema>;

/* ---------------- 作答 / 批改 / 状态 ---------------- */

export const gradeSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'wrong']),
  score: z.number(),
  comment: z.string().default(''),
  correct_answer: z.string().default(''),
  missed_points: z.array(z.string()).default([]),
});

export const answerSchema = z.object({
  value: z.union([z.string(), z.array(z.string()), z.null()]).default(null),
  /** 客观题为 true/false；主观题保存后为 null，等待批改结果 */
  correct: z.boolean().nullable().default(null),
  ts: z.number().default(0),
  grade: gradeSchema.optional(),
  /** 编程题最近一次编译运行：passed/total 个用例通过 */
  lastRun: z
    .object({
      passed: z.number(),
      total: z.number(),
      ts: z.number(),
    })
    .optional(),
});

export const stateSchema = z.object({
  /** papers[试卷文件名][题目id] = 作答 */
  papers: z.record(z.string(), z.record(z.string(), answerSchema)).default({}),
});

export type Grade = z.infer<typeof gradeSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type QuizState = z.infer<typeof stateSchema>;

/* ---------------- Runner：编译运行 ---------------- */

export type RunResult = {
  /** 展示用命令行 */
  cmd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** 进程都没起来时的错误（如找不到 gcc / ssh 连不上） */
  error?: string;
};

export type CompileInfo = {
  ok: boolean;
  cmd: string;
  exitCode: number | null;
  output: string;
};

export type TestOutcome = {
  name: string;
  passed: boolean;
  cmd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  expected: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
  /** 文件存在性检查结果（checkPresent/checkAbsent） */
  fileChecks?: { file: string; present: boolean; ok: boolean }[];
};

export type RunSummary = {
  /** 执行环境描述，如 "local (gcc)" / "ssh user@host" */
  env: string;
  compile?: CompileInfo;
  tests: TestOutcome[];
  passed: number;
  total: number;
  error?: string;
};

/* ---------------- 宿主 <-> Webview 消息 ---------------- */

export type InitData = {
  paperTitle: string;
  paperFile: string;
  questions: Question[];
  startQid: string | null;
  answers: Record<string, Answer>;
};

export type HostToWeb =
  | { type: 'init'; data: InitData }
  | { type: 'answersReplaced'; answers: Record<string, Answer> }
  | { type: 'runResults'; qid: string; data: RunSummary }
  | { type: 'scratchSaved'; qid: string; code: string };

export type WebToHost =
  | { type: 'ready' }
  | { type: 'saveAnswer'; qid: string; value: string | string[] | null; correct: boolean | null }
  | { type: 'copyText'; text: string }
  | { type: 'openScratch'; qid: string; code: string }
  | { type: 'runTests'; qid: string; code: string };

/* ---------------- 试卷文件（侧栏用） ---------------- */

export type PaperFile = {
  /** 相对 bank 目录的文件名，作为 state key */
  file: string;
  paper: Paper['paper'];
  questions: Question[];
};
