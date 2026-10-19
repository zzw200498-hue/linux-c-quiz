import * as fs from 'fs';
import * as path from 'path';

/**
 * 桌面端配置：复用 VSCode 版本的那套约定，只是来源从 vscode 设置改成 .vscode/settings.json。
 * 工作区根 = 题库所在目录（默认 <项目根>/bank，与 VSCode 里打开的一致）。
 */
export type QuizConfig = {
  wsRoot: string;
  bankDir: string;
  stateFile: string;
  scratchDir: string;
  sysrootDir: string;
  runner: 'local' | 'ssh' | 'off';
  sshHost: string;
  remoteRoot: string;
  cCompiler: string;
  cppCompiler: string;
  timeoutMs: number;
  sshBin: string;
  /** 出题提示词文件（prompts/generate.md），界面上一键复制用 */
  promptFile: string;
};

/** 去掉 // 注释后解析 JSON（VSCode 的 settings.json 允许写注释） */
function readJsonc(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 这个目录里有没有 yaml 试卷 */
function hasYaml(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => /\.ya?ml$/i.test(n));
  } catch {
    return false;
  }
}

/**
 * 找真正存放试卷的目录。
 *
 * 约定是 wsRoot/bankPath，但历史上出现过「工作区根不小心多套了一层」的情况
 * （wsRoot 已经是 bank 了，再拼一个 bank 变成 bank/bank/bank）。
 * 这里做兜底：按 wsRoot/bankPath、wsRoot/bank、wsRoot/bankPath/bankPath……
 * 的顺序试，取第一个真的含 yaml 的目录；都没有就照原样返回，让上层报空。
 */
function resolveBankDir(wsRoot: string, bankPath: string): string {
  const candidates: string[] = [];
  const primary = path.join(wsRoot, bankPath);
  candidates.push(primary, wsRoot);
  if (bankPath && bankPath !== '.') {
    candidates.push(path.join(primary, bankPath)); // 多套一层的情况
  }
  for (const c of candidates) {
    if (hasYaml(c)) return c;
  }
  return primary;
}

export function resolveConfig(): QuizConfig {
  const wsRoot = process.env.QUIZ_WS
    ? path.resolve(process.env.QUIZ_WS)
    : path.resolve(__dirname, '..', '..', 'bank');

  const settings = readJsonc(path.join(wsRoot, '.vscode', 'settings.json'));
  const get = <T>(key: string, def: T): T => (settings[`quiz.${key}`] as T) ?? def;

  return {
    wsRoot,
    bankDir: resolveBankDir(wsRoot, get<string>('bankPath', 'bank')),
    stateFile: path.join(wsRoot, '.quiz', 'state.json'),
    scratchDir: path.join(wsRoot, '.quiz', 'scratch'),
    sysrootDir: path.join(wsRoot, '.quiz', 'sysroot'),
    runner: get<'local' | 'ssh' | 'off'>('runner', 'ssh'),
    sshHost: process.env.QUIZ_SSH_HOST ?? get<string>('sshHost', ''),
    remoteRoot: get<string>('remoteRoot', '~/.quiz-runner'),
    cCompiler: get<string>('cCompiler', 'gcc'),
    cppCompiler: get<string>('cppCompiler', 'g++'),
    timeoutMs: get<number>('runTimeoutSec', 5) * 1000,
    sshBin: get<string>('sshBin', ''),
    promptFile: resolvePromptFile(wsRoot),
  };
}

/**
 * 找出题提示词。打包后 __dirname 在程序目录里，跟源码的 prompts/ 不是一路，
 * 所以统一按工作区往上找（用户的 prompts 在项目根，工作区是它下面的 bank）。
 */
function resolvePromptFile(wsRoot: string): string {
  if (process.env.QUIZ_PROMPT) return path.resolve(process.env.QUIZ_PROMPT);
  const cands = [
    path.join(wsRoot, 'prompts', 'generate.md'),
    path.resolve(wsRoot, '..', 'prompts', 'generate.md'),
    path.resolve(wsRoot, '..', '..', 'prompts', 'generate.md'),
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return cands[1];
}
