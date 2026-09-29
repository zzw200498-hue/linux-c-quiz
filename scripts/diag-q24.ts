/** 复现 q24 判定：用真实 SshRunner 跑两个用例，输出原始字节 */
import * as path from 'path';
import { SshRunner } from '../src/runner/ssh';
import { normalizeOut } from '../src/core/tester';

const host = process.argv[2] ?? 'daniya@192.168.88.128';
const localDir = path.resolve(process.argv[3] ?? 'bank/.quiz/scratch/Linux嵌入式应用层-综合卷二（进程之前）/q24');

async function main() {
  const runner = new SshRunner(host, '~/.quiz-runner', 'gcc', undefined);
  const cwd = await runner.prepare(localDir);
  console.log('remote cwd =', cwd);

  for (const [name, argv] of [
    ['make 编译', ['make']],
    ['make clean', ['make', 'clean']],
  ] as const) {
    const r = await runner.exec(cwd, [...argv], { timeoutMs: 5000 });
    console.log(`\n===== ${name} =====`);
    console.log('cmd       =', r.cmd);
    console.log('exit      =', r.exitCode, 'timedOut =', r.timedOut, 'error =', r.error);
    console.log('stdout RAW =', JSON.stringify(r.stdout));
    console.log('stderr RAW =', JSON.stringify(r.stderr));
    console.log('normalized =', JSON.stringify(normalizeOut(r.stdout)));
  }

  const rm = await runner.exec(cwd, ['ls', '-la', cwd], { timeoutMs: 5000 });
  console.log('\nremote dir listing:\n' + rm.stdout);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
