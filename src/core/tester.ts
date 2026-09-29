import * as fs from 'fs';
import * as path from 'path';
import type { CompileInfo, Question, RunSummary, TestOutcome } from '../shared/types';
import type { Runner } from '../runner';

export type TesterConfig = {
  cCompiler: string;
  cppCompiler: string;
  timeoutMs: number;
};

/** 输出归一化：统一换行、去掉行尾空白和结尾空行，降低环境差异导致的误判 */
export function normalizeOut(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

function matches(expected: string, actual: string, mode: 'exact' | 'contains'): boolean {
  const e = normalizeOut(expected);
  const a = normalizeOut(actual);
  if (mode === 'contains') return a.includes(e);
  return a === e;
}

/**
 * 文件存在性检查：输出比对付不了「顺序无关」的断言（如 rm -f a b 和 rm -f b a 等价），
 * 直接问文件系统最可靠。通过一条 sh -c 批量探测，兼容 local(Linux)/ssh 两种 Runner。
 */
async function runFileChecks(
  runner: Runner,
  cwd: string,
  t: { checkPresent: string[]; checkAbsent: string[] },
  timeoutMs: number,
): Promise<{ file: string; present: boolean; ok: boolean }[] | undefined> {
  if (t.checkPresent.length === 0 && t.checkAbsent.length === 0) return undefined;
  // Windows 本地没有 sh（makefile 题本来也跑不了），跳过
  if (runner.kind === 'local' && process.platform === 'win32') return undefined;

  const all = [...t.checkPresent, ...t.checkAbsent];
  const script = 'for f in "$@"; do [ -e "$f" ] && echo "P|$f" || echo "A|$f"; done';
  const r = await runner.exec(cwd, ['sh', '-c', script, 'sh', ...all], { timeoutMs });
  if (r.error || r.exitCode !== 0) {
    return all.map((f) => ({ file: f, present: false, ok: false }));
  }
  const present = new Map<string, boolean>();
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('|');
    if (i > 0 && (line[0] === 'P' || line[0] === 'A')) {
      present.set(line.slice(i + 1).trim(), line[0] === 'P');
    }
  }
  return [
    ...t.checkPresent.map((f) => {
      const p = present.get(f) ?? false;
      return { file: f, present: p, ok: p };
    }),
    ...t.checkAbsent.map((f) => {
      const p = present.get(f) ?? false;
      return { file: f, present: p, ok: !p };
    }),
  ];
}

/** 本地 Windows 时 gcc -o main 产物是 main.exe */
function binArgv0(runner: Runner, localDir: string): string {
  if (runner.kind === 'local' && process.platform === 'win32') {
    if (fs.existsSync(path.join(localDir, 'main.exe'))) return 'main.exe';
    if (fs.existsSync(path.join(localDir, 'main'))) return '.\\main';
  }
  return './main';
}

/** 编译器找不到时给出可操作的引导，而不是丢一个 ENOENT */
function compileErrorText(error: string | undefined, cc: string): string {
  if (error && /ENOENT|spawn/i.test(error)) {
    const hint =
      process.platform === 'win32'
        ? 'Windows 本地没有 gcc。请打开设置把 quiz.runner 设为 ssh，并填 quiz.sshHost（用户名@VM的IP）用 VM 编译；或改用 Remote-SSH 窗口。'
        : `本机找不到编译器 ${cc}，请确认已安装（sudo apt install build-essential）。`;
    return `${hint}\n（原始错误：${error}）`;
  }
  return error ? `编译器启动失败：${error}` : '编译失败，请看编译输出。';
}

export async function runQuestionTests(
  runner: Runner,
  q: Question,
  localDir: string,
  cfg: TesterConfig,
): Promise<RunSummary> {
  const lang = (q.language ?? 'c').toLowerCase();
  const tests = q.tests ?? [];
  const env = runner.describe();

  if (runner.kind === 'off') {
    return { env, tests: [], passed: 0, total: tests.length, error: 'Runner 已关闭（quiz.runner = off），只作答不运行。' };
  }
  if (tests.length === 0) {
    return { env, tests: [], passed: 0, total: 0, error: '该题没有配置测试用例（tests）。' };
  }

  let cwd: string;
  try {
    cwd = await runner.prepare(localDir);
  } catch (e) {
    return { env, tests: [], passed: 0, total: tests.length, error: String((e as Error).message ?? e) };
  }

  // 编译（makefile/shell 类题目不编译，tests.args 即命令）
  let compile: CompileInfo | undefined;
  if (lang === 'c' || lang === 'cpp' || lang === 'c++') {
    const isCpp = lang !== 'c';
    const exts = isCpp ? ['.cpp', '.cc', '.cxx'] : ['.c'];
    let sources: string[] = [];
    try {
      sources = fs.readdirSync(localDir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e))).sort();
    } catch {
      /* 目录不存在的情况由 scratch 层保证 */
    }
    if (sources.length === 0) {
      return {
        env,
        tests: [],
        passed: 0,
        total: tests.length,
        error: `scratch 目录里没有 ${exts.join(' / ')} 源文件，先点「在编辑器中打开」写代码。`,
      };
    }
    const cc = isCpp ? cfg.cppCompiler : cfg.cCompiler;
    const r = await runner.exec(cwd, [cc, '-Wall', '-o', 'main', ...sources], { timeoutMs: 30000 });
    compile = {
      ok: r.exitCode === 0 && !r.error,
      cmd: r.cmd,
      exitCode: r.exitCode,
      output: `${r.stdout}${r.stderr}`.trim(),
    };
    if (!compile.ok) {
      return {
        env,
        compile,
        tests: [],
        passed: 0,
        total: tests.length,
        error: compileErrorText(r.error, cc),
      };
    }
  }

  const outcomes: TestOutcome[] = [];
  for (const t of tests) {
    let argv: string[];
    if (lang === 'c' || lang === 'cpp' || lang === 'c++') {
      argv = [binArgv0(runner, localDir), ...t.args];
    } else if (lang === 'python' || lang === 'py') {
      argv = ['python3', 'main.py', ...t.args];
    } else {
      // makefile / shell / 其它：args 即完整命令
      argv = t.args.length > 0 ? t.args : ['make'];
    }

    const r = await runner.exec(cwd, argv, { stdin: t.stdin, timeoutMs: cfg.timeoutMs });
    const checks = await runFileChecks(runner, cwd, t, cfg.timeoutMs);
    const checksOk = !checks || checks.every((c) => c.ok);
    const passed =
      !r.timedOut && !r.error && r.exitCode === 0 && matches(t.expectedStdout, r.stdout, t.match) && checksOk;
    outcomes.push({
      name: t.name || '用例',
      passed,
      cmd: r.cmd,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      expected: t.expectedStdout,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      error: r.error,
      fileChecks: checks,
    });
  }

  return {
    env,
    compile,
    tests: outcomes,
    passed: outcomes.filter((o) => o.passed).length,
    total: outcomes.length,
  };
}
