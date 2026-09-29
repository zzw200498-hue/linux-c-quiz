import type { RunResult } from '../shared/types';
import { capture } from './exec';
import type { ExecOptions, Runner } from './types';

/** 直接在本机 spawn：Remote-SSH 会话里扩展跑在 Ubuntu 上，gcc/make/qemu 都可直接调 */
export class LocalRunner implements Runner {
  readonly kind = 'local' as const;

  constructor(private compiler: string) {}

  describe(): string {
    return `local (${this.compiler})`;
  }

  async prepare(localDir: string): Promise<string> {
    return localDir;
  }

  exec(cwd: string, argv: string[], opts: ExecOptions): Promise<RunResult> {
    return capture(argv, { cwd, stdin: opts.stdin, timeoutMs: opts.timeoutMs });
  }
}
