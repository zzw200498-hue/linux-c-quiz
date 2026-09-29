import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RunResult } from '../shared/types';
import { capture } from './exec';
import { sh } from './types';
import type { ExecOptions, Runner } from './types';

/** heredoc 结束标记（内容经 base64 编码，不可能撞上） */
const EOF = 'QUIZ_EOF_7c1d';
/** ssh 通用参数：BatchMode 防卡在密码输入，accept-new 自动接受首次主机指纹 */
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

/**
 * 选择 ssh 可执行文件。
 * Windows 上必须优先用系统自带的 OpenSSH：PATH 里靠前的 Git-Bash ssh（MSYS）
 * 在中文用户名目录下会把路径编码搞坏，导致读不到 ~/.ssh 的私钥和 known_hosts。
 */
export function resolveSshBin(configured?: string): string {
  const p = configured?.trim();
  if (p) return p;
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const sys = path.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'ssh';
}

/** 远端路径只保留 ASCII 安全字符，避免 Windows→Linux 的中文路径编码问题 */
function safeSegment(name: string): string {
  const ascii = name
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (/^[A-Za-z0-9]/.test(ascii)) return ascii;
  return `p_${crypto.createHash('md5').update(name).digest('hex').slice(0, 10)}`;
}

type SyncFile = { rel: string; abs: string };

/** 收集需要上传的文件：跳过隐藏文件（.meta.json）和编译产物 */
function collectFiles(dir: string, base: string, out: SyncFile[] = []): SyncFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      collectFiles(abs, base, out);
      continue;
    }
    if (e.name.startsWith('.')) continue; // .meta.json 之类
    if (/\.(o|a|out|exe)$/i.test(e.name)) continue; // 编译产物
    if (/^main$/i.test(e.name)) continue; // 可执行文件
    out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs });
  }
  return out;
}

/**
 * 读取文件内容并归一化换行：
 * 本地 Windows 编辑的 Makefile / shell 若带 CRLF，在远端 make 会直接报错。
 * 二进制文件（含 \0）原样 base64 上传。
 */
function readForUpload(abs: string): Buffer {
  const buf = fs.readFileSync(abs);
  const sample = buf.subarray(0, 4096);
  const isBinary = sample.includes(0);
  if (isBinary) return buf;
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  return Buffer.from(text, 'utf8');
}

/**
 * 生成同步脚本（纯函数，便于单测）：创建远端目录 + 用 base64 heredoc 写入每个文件。
 * 远程执行方式 `ssh host bash -s` + stdin，避开 Windows 命令行长度限制。
 */
export function buildSyncScript(localDir: string, remoteDir: string): { script: string; count: number } {
  const files = collectFiles(localDir, localDir);
  // 先清空再同步：上一次运行的产物（app、main、dest.txt 等）必须清掉，
  // 否则 make 会报 "up to date"、C 程序会读到旧的输出文件，判分就不可信了
  const chunks: string[] = [`rm -rf ${sh(remoteDir)}`, `mkdir -p ${sh(remoteDir)}`];
  for (const f of files) {
    const target = `${remoteDir}/${f.rel}`;
    chunks.push(`base64 -d > ${sh(target)} <<'${EOF}'`);
    chunks.push(readForUpload(f.abs).toString('base64'));
    chunks.push(EOF);
  }
  chunks.push(`echo SYNC_OK ${files.length}`);
  return { script: `${chunks.join('\n')}\n`, count: files.length };
}

/**
 * VSCode 跑在 Windows 本地、编译要在 VM 里进行时：
 * 每次运行前把本地 scratch 目录同步到远端（一次 ssh + base64，不走 scp）。
 *
 * 不用 scp 的原因：Windows 路径含盘符 "C:\..."，冒号会被 scp 解析成主机分隔符。
 * 不用命令行传脚本的原因：Windows 命令行长度上限约 8191 字符，代码文件会超。
 * 所以走 stdin：`ssh host bash -s` + base64 heredoc。
 */
export class SshRunner implements Runner {
  readonly kind = 'ssh' as const;

  constructor(
    private host: string,
    private remoteRoot: string,
    private compiler: string,
    private sshBin: string = resolveSshBin(),
  ) {}

  describe(): string {
    return `ssh ${this.host} (${this.compiler})`;
  }

  async prepare(localDir: string): Promise<string> {
    const parts = localDir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    const qid = safeSegment(parts[parts.length - 1] ?? 'q');
    const paperSafe = safeSegment(parts[parts.length - 2] ?? 'paper');
    // remoteRoot 里的 ~ 必须先解析成绝对路径：sh() 的单引号会阻止 shell 展开 ~，
    // 否则远端会创建出一个字面量叫 "~" 的目录
    const root = this.remoteRoot.startsWith('~') ? `${await this.remoteHome()}${this.remoteRoot.slice(1)}` : this.remoteRoot;
    const remoteDir = `${root}/${paperSafe}/${qid}`;

    const { script, count } = buildSyncScript(localDir, remoteDir);
    if (count === 0) {
      throw new Error('scratch 目录为空，先点「在编辑器中打开」写代码。');
    }

    const r = await capture([...this.argv(), 'bash', '-s'], {
      stdin: script,
      timeoutMs: 30000,
    });

    if (r.error) throw new Error(`ssh 连接失败（${this.host}）：${r.error}`);
    if (r.exitCode !== 0 || r.timedOut) {
      throw new Error(`同步到 VM 失败：${this.hint(r)}`);
    }
    return remoteDir;
  }

  exec(cwd: string, argv: string[], opts: ExecOptions): Promise<RunResult> {
    const inner = `cd ${sh(cwd)} && ${argv.map(sh).join(' ')}`;
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    // 远端套一层 timeout，避免死循环程序在 ssh 断开后仍在 VM 里跑。
    // 退出码必须显式回传：进程被信号杀死时（如 SIGSEGV）ssh 客户端会跟着"自杀"，
    // Windows 上 exitCode 会变成 0xFFFFFFFF，真实退出码（139）就丢了。
    const remoteCmd =
      `timeout -k 1 ${secs} bash -c ${sh(inner)}; __ec=$?; ` +
      `printf '[quiz]exit=%d\\n' "$__ec" >&2; exit $__ec`;
    const display = `ssh ${this.host} '${inner}'`;
    return capture([...this.argv(), remoteCmd], {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs + 5000, // ssh 连接本身有开销
    }).then((r) => this.postProcess(r, display, opts.timeoutMs));
  }

  /** 从 stderr 里取回真实退出码，识别 timeout(124)，并把标记行从展示中剔除 */
  private postProcess(r: RunResult, display: string, timeoutMs: number): RunResult {
    let stderr = r.stderr ?? '';
    let exitCode = r.exitCode;
    let timedOut = r.timedOut;

    const m = /\[quiz\]exit=(-?\d+)/.exec(stderr);
    if (m) {
      stderr = stderr.replace(/\[quiz\]exit=-?\d+\n?/g, '');
      exitCode = Number(m[1]);
      if (exitCode === 124) {
        // GNU timeout 的超时退出码
        timedOut = true;
        stderr = `${stderr}${!stderr || stderr.endsWith('\n') ? '' : '\n'}[quiz] 运行超时（${Math.round(timeoutMs / 1000)}s），已在 VM 上终止`;
      }
    }

    return { ...r, cmd: display, exitCode, stderr, timedOut };
  }

  private homeCache: string | null = null;

  /** 取远端 HOME（每次会话只查一次） */
  private async remoteHome(): Promise<string> {
    if (this.homeCache) return this.homeCache;
    const r = await capture([...this.argv(), 'echo', '$HOME'], { timeoutMs: 15000 });
    const home = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!home.startsWith('/')) {
      throw new Error(`无法解析远端 HOME（得到 "${home}"），请把 quiz.remoteRoot 配成绝对路径（如 /home/daniya/quiz-run）。`);
    }
    this.homeCache = home;
    return home;
  }

  /** 直接在远端执行一条 shell 命令（诊断用） */
  async probe(cmd: string): Promise<RunResult> {
    return capture([...this.argv(), cmd], { timeoutMs: 20000 });
  }

  private argv(): string[] {
    return [this.sshBin, ...SSH_OPTS, this.host];
  }

  /** 把常见 ssh 失败场景翻译成人话 */
  private hint(r: RunResult): string {
    const s = `${r.stderr}\n${r.stdout}`;
    if (/Permission denied \(publickey/.test(s)) {
      return '免密登录没配好。在 VM 里执行：mkdir -p ~/.ssh && echo "<本机 ~/.ssh/id_ed25519.pub 内容>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys';
    }
    if (/Could not resolve hostname/.test(s)) {
      return `主机名/IP 无法解析，检查设置 quiz.sshHost（当前：${this.host}）。`;
    }
    if (/Connection timed out|Connection refused/.test(s)) {
      return `连不上 ${this.host}：确认 VM 已开机、sshd 在跑（sudo systemctl status ssh）、IP 没变。`;
    }
    if (r.timedOut) return 'ssh 连接超时（30s），通常是卡在密码输入——请配置免密登录。';
    return (r.stderr || r.stdout || `exit ${r.exitCode}`).trim();
  }
}
