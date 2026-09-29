/**
 * 真机端到端验证：Windows 本地 → VM（ssh）同步、编译、运行、比对、超时。
 * 用法：node dist/e2e-ssh.cjs [user@host]
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SshRunner, resolveSshBin } from '../src/runner/ssh';
import { normalizeOut } from '../src/core/tester';

const host = process.argv[2] ?? 'daniya@192.168.88.128';
const remoteRoot = '~/.quiz-e2e';

function mkScratch(name: string, files: Record<string, string>): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-e2e-')), '卷二', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
}

async function main() {
  const bin = resolveSshBin();
  console.log(`ssh 可执行文件: ${bin}`);
  console.log(`目标主机: ${host}\n`);
  const runner = new SshRunner(host, remoteRoot, 'gcc', bin);

  // 1. 连接
  const probe = await runner.probe('echo ok; whoami');
  check('ssh 连接', probe.exitCode === 0 && probe.stdout.includes('ok'), `whoami=${probe.stdout.trim().split('\n').pop()} exit=${probe.exitCode} ${probe.stderr.trim()}`);
  if (probe.exitCode !== 0) {
    console.log('\n连不上，后面的用例跳过。stderr:', probe.stderr || probe.error);
    return;
  }

  // 2. C 程序：同步 → 编译 → 运行 → 比对（含中文目录名）
  const dir1 = mkScratch('q23', {
    'main.c': '#include <stdio.h>\r\nint main(void){ printf("拷贝完成\\n"); return 0; }\r\n',
    'source.txt': 'hello\r\n',
  });
  const cwd1 = await runner.prepare(dir1);
  check('同步 scratch（含中文目录名）', !!cwd1, `远端目录 ${cwd1}`);
  const cc = await runner.exec(cwd1, ['gcc', '-Wall', '-o', 'main', 'main.c'], { timeoutMs: 30000 });
  check('gcc 编译', cc.exitCode === 0, `exit=${cc.exitCode} ${cc.stderr.trim() || '无警告'}`);
  const run1 = await runner.exec(cwd1, ['./main'], { timeoutMs: 5000 });
  check('运行并比对输出', normalizeOut(run1.stdout) === '拷贝完成', `stdout=${JSON.stringify(run1.stdout)} exit=${run1.exitCode}`);

  // 3. stdin
  const dir2 = mkScratch('q-stdin', {
    'main.c': '#include <stdio.h>\nint main(void){char b[64];if(fgets(b,64,stdin))printf("got:%s",b);return 0;}\n',
  });
  const cwd2 = await runner.prepare(dir2);
  await runner.exec(cwd2, ['gcc', '-Wall', '-o', 'main', 'main.c'], { timeoutMs: 30000 });
  const run2 = await runner.exec(cwd2, ['./main'], { stdin: 'abc\n', timeoutMs: 5000 });
  check('stdin 传入', run2.stdout.trim() === 'got:abc', `stdout=${JSON.stringify(run2.stdout)}`);

  // 4. Makefile（CRLF 已在上传时归一化）
  const dir3 = mkScratch('q24', {
    'Makefile': 'all:\r\n\t@echo built\r\nclean:\r\n\t@echo cleaned\r\n',
  });
  const cwd3 = await runner.prepare(dir3);
  const mk = await runner.exec(cwd3, ['make'], { timeoutMs: 15000 });
  check('make 执行（CRLF 已归一化）', mk.exitCode === 0 && mk.stdout.includes('built'), `exit=${mk.exitCode} stdout=${JSON.stringify(mk.stdout)} stderr=${JSON.stringify(mk.stderr)}`);
  const mk2 = await runner.exec(cwd3, ['make', 'clean'], { timeoutMs: 15000 });
  check('make clean', mk2.exitCode === 0 && mk2.stdout.includes('cleaned'), `stdout=${JSON.stringify(mk2.stdout)}`);

  // 5. 死循环 → 超时终止
  const dir4 = mkScratch('q-loop', {
    'main.c': '#include <stdio.h>\nint main(void){printf("start\\n");fflush(stdout);while(1){}return 0;}\n',
  });
  const cwd4 = await runner.prepare(dir4);
  await runner.exec(cwd4, ['gcc', '-Wall', '-o', 'main', 'main.c'], { timeoutMs: 30000 });
  const t0 = Date.now();
  const run4 = await runner.exec(cwd4, ['./main'], { timeoutMs: 3000 });
  check('死循环被超时终止', run4.timedOut === true || run4.exitCode === 124, `timedOut=${run4.timedOut} exit=${run4.exitCode} 耗时=${Date.now() - t0}ms stdout=${JSON.stringify(run4.stdout)}`);

  // 6. 段错误（嵌入式题常问 SIGNAL）
  const dir5 = mkScratch('q-segv', {
    'main.c': 'int main(void){int *p=0;*p=1;return 0;}\n',
  });
  const cwd5 = await runner.prepare(dir5);
  await runner.exec(cwd5, ['gcc', '-Wall', '-o', 'main', 'main.c'], { timeoutMs: 30000 });
  const run5 = await runner.exec(cwd5, ['./main'], { timeoutMs: 5000 });
  check('段错误能捕获退出码(139)', run5.exitCode === 139, `exit=${run5.exitCode} signal=${run5.signal} stderr=${JSON.stringify(run5.stderr.slice(0, 60))}`);

  // 清理远端
  await runner.probe(`rm -rf ${remoteRoot.replace(/^~/, '$HOME')} && echo cleaned`);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 通过 =====`);
  process.exit(bad.length ? 1 : 0);
}

void main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exit(1);
});
