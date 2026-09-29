import { spawn } from 'child_process';
import type { RunResult } from '../shared/types';

/** 单流输出上限，防止死循环程序刷爆内存 */
const MAX_OUTPUT = 64 * 1024;
/** 超时后先 SIGTERM，再等这么久强杀 */
const GRACE_MS = 800;

export type CaptureOptions = {
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  /** 覆盖默认 64KB 输出上限（拉取 sysroot 等 large payload 时用） */
  maxOutput?: number;
};

/**
 * spawn 并捕获 stdout/stderr/exit code/信号。
 * 不经过 shell，参数数组原样传递；超时 kill；输出截断到 MAX_OUTPUT。
 */
export function capture(argv: string[], opts: CaptureOptions): Promise<RunResult> {
  const started = Date.now();
  const display = argv.join(' ');
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        cmd: display,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        error: String((e as Error)?.message ?? e),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let settled = false;

    const limit = opts.maxOutput ?? MAX_OUTPUT;
    const cap = (cur: string, chunk: Buffer): string => {
      if (cur.length >= limit) return cur;
      const next = cur + chunk.toString('utf8');
      return next.length > limit ? `${next.slice(0, limit)}\n…（输出已截断）` : next;
    };
    child.stdout?.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = cap(stderr, c)));

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          /* 进程已退出 */
        }
      }, GRACE_MS);
    }, Math.max(300, opts.timeoutMs));

    const finish = (exitCode: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        cmd: display,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        error,
      });
    };

    child.on('error', (e: Error) => finish(null, null, e.message));
    child.on('close', (code, signal) => {
      if (killed && timedOut) {
        stderr = `${stderr}${stderr.endsWith('\n') || !stderr ? '' : '\n'}[quiz] 超时（${opts.timeoutMs}ms）已强制终止`;
      }
      finish(code, signal);
    });

    if (opts.stdin) child.stdin?.write(opts.stdin);
    child.stdin?.end();
    child.stdin?.on('error', () => {
      /* 程序不读 stdin 时写管道会 EPIPE，忽略 */
    });
  });
}
