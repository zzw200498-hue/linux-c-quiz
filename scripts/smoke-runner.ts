/* 冒烟测试：验证 capture（超时/输出捕获）与 runQuestionTests 的比对逻辑（不依赖真实 gcc） */
import { capture } from '../src/runner/exec';
import { runQuestionTests } from '../src/core/tester';
import type { Runner } from '../src/runner';
import type { Question, RunResult } from '../src/shared/types';

let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` —— ${detail}`}`);
  if (!ok) fail++;
}

async function main(): Promise<void> {
  // 1. capture：基本输出
  const r1 = await capture([process.execPath, '-e', 'console.log("拷贝完成")'], { timeoutMs: 5000 });
  check('capture 捕获 stdout/exit', r1.exitCode === 0 && r1.stdout.trim() === '拷贝完成', JSON.stringify(r1));

  // 2. capture：stdin 传递
  const r2 = await capture([process.execPath, '-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("got:"+d.trim()))'], {
    stdin: 'hello-quiz\n',
    timeoutMs: 5000,
  });
  check('capture 传递 stdin', r2.stdout.trim() === 'got:hello-quiz', JSON.stringify(r2));

  // 3. capture：超时强杀
  const r3 = await capture([process.execPath, '-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 600 });
  check('capture 超时终止', r3.timedOut && r3.exitCode !== 0, JSON.stringify({ timedOut: r3.timedOut, code: r3.exitCode }));

  // 4. runQuestionTests 比对逻辑（FakeRunner，makefile 分支不编译）
  const scripted: RunResult[] = [
    { cmd: 'make', exitCode: 0, signal: null, stdout: 'gcc -Wall -g -c main.c -o main.o\r\n', stderr: '', timedOut: false, durationMs: 10 },
    { cmd: 'make clean', exitCode: 0, signal: null, stdout: 'rm -f main.o app\n', stderr: '', timedOut: false, durationMs: 10 },
    { cmd: 'make', exitCode: 2, signal: null, stdout: '', stderr: 'make: *** No rule to make target', timedOut: false, durationMs: 10 },
  ];
  let i = 0;
  const fake: Runner = {
    kind: 'local',
    describe: () => 'fake',
    prepare: async (d) => d,
    exec: async (_cwd, argv) => ({ ...scripted[i++]!, cmd: argv.join(' ') }),
  };
  const mkQ = (match: 'exact' | 'contains'): Question => ({
    id: 't',
    type: 'coding',
    stem: '',
    language: 'makefile',
    tags: [],
    difficulty: 1,
    tests: [
      { name: '编译', args: ['make'], stdin: '', expectedStdout: 'gcc -Wall -g -c main.c -o main.o\n', match },
      { name: '清理', args: ['make', 'clean'], stdin: '', expectedStdout: 'rm -f main.o app', match },
      { name: '坏编译', args: ['make'], stdin: '', expectedStdout: '不存在的东西', match: 'contains' },
    ],
  });

  const s1 = await runQuestionTests(fake, mkQ('exact'), '.', { cCompiler: 'gcc', cppCompiler: 'g++', timeoutMs: 5000 });
  check(
    'exact：CRLF 归一化后通过',
    s1.passed === 2 && s1.total === 3 && s1.tests[0]!.passed && s1.tests[1]!.passed && !s1.tests[2]!.passed,
    JSON.stringify(s1.tests.map((t) => t.passed)),
  );

  i = 0;
  const s2 = await runQuestionTests(fake, mkQ('contains'), '.', { cCompiler: 'gcc', cppCompiler: 'g++', timeoutMs: 5000 });
  check('contains 同样通过', s2.passed === 2, JSON.stringify(s2.tests.map((t) => t.passed)));

  // 5. off runner
  i = 0;
  const offRunner: Runner = {
    kind: 'off',
    describe: () => 'off（不运行）',
    prepare: async (d) => d,
    exec: async () => ({ cmd: '', exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 }),
  };
  const s3 = await runQuestionTests(offRunner, mkQ('exact'), '.', { cCompiler: 'gcc', cppCompiler: 'g++', timeoutMs: 5000 });
  check('off 模式给出提示不执行', s3.passed === 0 && Boolean(s3.error), JSON.stringify(s3));

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
