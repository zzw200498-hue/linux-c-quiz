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
  /**
   * 本题满分（单题分值）。优先于 paper.scoreWeights[type]——
   * 用于同一题型分值不同的场景，如判断题 2 分而选择题 3 分。
   */
  score: z.number().optional(),
});

export const paperSchema = z.object({
  paper: z.object({
    title: z.string(),
    topics: z.array(z.string()).default([]),
    date: z.string().optional(),
    /**
     * 题型分值（每题满分），如 { single: 2, fill: 2, short: 4, coding: 4 }。
     * 提供后整卷总分 = Σ(每题得分% × 分值) / Σ(已判定题分值)，即卷面百分制；
     * 不提供时退回每题等权平均。
     */
    scoreWeights: z.record(z.string(), z.number()).optional(),
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
  /** 分数来源：ai=导入的批改结果（默认）；self=刷题时用户自行打分 */
  source: z.enum(['ai', 'self']).default('ai'),
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

/** 整卷成绩单：交卷/导入批改后自动计算，保留最近一次结果（为错题本/学习报告铺路） */
export const paperSummarySchema = z.object({
  /** 整卷百分制得分 = 已判定题目的平均分（客观题判分计 0/100，主观题取 grade.score） */
  totalScore: z.number().default(0),
  /** 已判定题数 / 总题数 / 待判定题数 */
  judgedCount: z.number().default(0),
  questionCount: z.number().default(0),
  pendingCount: z.number().default(0),
  verdictCounts: z
    .object({
      correct: z.number().default(0),
      partial: z.number().default(0),
      wrong: z.number().default(0),
    })
    .default({ correct: 0, partial: 0, wrong: 0 }),
  /** 整卷总评：批改者给的整体评价；无则由扩展按统计自动生成 */
  overall: z.string().default(''),
  /** 薄弱知识点标签（按错误/部分正确题目的 tags 频次取前 3） */
  weakTags: z.array(z.string()).default([]),
  ts: z.number().default(0),
});

/** 错题本条目：key = `试卷文件名#题目id` */
export const wrongbookEntrySchema = z.object({
  paper: z.string(),
  qid: z.string(),
  /** 连续答对次数（答错清零） */
  streak: z.number().default(0),
  /** 是否已过关（连对 3 次后移入「已过关」组） */
  passed: z.boolean().default(false),
  /** 在错题本里练过的次数 */
  tries: z.number().default(0),
  /** 主观题已练、等批改导入后结算 */
  awaitingGrade: z.boolean().default(false),
  /** 过关时间；用于判断过关后又被判错要回炉 */
  graduatedAt: z.number().default(0),
  ts: z.number().default(0),
  source: z.enum(['auto', 'manual']).default('auto'),
});

export const stateSchema = z.object({
  /** papers[试卷文件名][题目id] = 作答 */
  papers: z.record(z.string(), z.record(z.string(), answerSchema)).default({}),
  /** summaries[试卷文件名] = 整卷成绩单 */
  summaries: z.record(z.string(), paperSummarySchema).default({}),
  /** wrongbook[`试卷#题id`] = 错题本条目 */
  wrongbook: z.record(z.string(), wrongbookEntrySchema).default({}),
});

export type Grade = z.infer<typeof gradeSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type PaperSummary = z.infer<typeof paperSummarySchema>;
export type WrongbookEntry = z.infer<typeof wrongbookEntrySchema>;
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

/** 错题本刷题模式的附加信息（题目来自多张卷） */
export type WrongbookInit = {
  kind: 'active' | 'passed';
  /** qid → 来源试卷文件名（作答写回原卷） */
  source: Record<string, string>;
  /** qid → 连对进度 */
  progress: Record<string, { streak: number; passed: boolean; tries: number }>;
};

export type InitData = {
  paperTitle: string;
  paperFile: string;
  questions: Question[];
  startQid: string | null;
  answers: Record<string, Answer>;
  summary: PaperSummary | null;
  /** 非空表示当前是错题本刷题模式 */
  wrongbook?: WrongbookInit;
};

export type HostToWeb =
  | { type: 'init'; data: InitData }
  | { type: 'answersReplaced'; answers: Record<string, Answer> }
  | { type: 'runResults'; qid: string; data: RunSummary }
  | { type: 'scratchSaved'; qid: string; code: string }
  | { type: 'summaryUpdated'; data: PaperSummary }
  | { type: 'wrongbookProgress'; qid: string; streak: number; passed: boolean; graduated: boolean }
  /** 自行打分已保存：把分数回灌给 Webview（同时更新连对进度） */
  | { type: 'selfGraded'; qid: string; grade: Grade };

export type WebToHost =
  | { type: 'ready' }
  | { type: 'saveAnswer'; qid: string; value: string | string[] | null; correct: boolean | null }
  /** 错题本刷题：correct 为 null 表示主观题，等批改后结算连对次数 */
  | { type: 'saveWrongbookAnswer'; qid: string; value: string | string[] | null; correct: boolean | null }
  /** 错题本刷题：主观题自行打分（0-100），≥60 计一次连对，<60 打回待攻克 */
  | { type: 'selfGrade'; qid: string; score: number }
  | { type: 'copyText'; text: string }
  | { type: 'openScratch'; qid: string; code: string }
  | { type: 'runTests'; qid: string; code: string }
  | { type: 'syncSummary' };

/* ---------------- 试卷文件（侧栏用） ---------------- */

export type PaperFile = {
  /** 相对 bank 目录的文件名，作为 state key */
  file: string;
  paper: Paper['paper'];
  questions: Question[];
};
