/** 用例自检 CLI：node dist/verify-bank.cjs <bankDir> <sshHost> [paperFile关键字] */
import * as fs from 'fs';
import * as path from 'path';
import { load as yaml } from 'js-yaml';
import { paperSchema } from '../src/shared/types';
import type { PaperFile } from '../src/shared/types';
import { SshRunner } from '../src/runner/ssh';
import { verifyPaperSolutions } from '../src/core/verify';

async function main() {
  const bankDir = path.resolve(process.argv[2] ?? 'bank/bank');
  const host = process.argv[3] ?? 'daniya@192.168.88.128';
  const keyword = process.argv[4] ?? '';

  const files = fs.readdirSync(bankDir).filter((f) => /\.ya?ml$/i.test(f) && f.includes(keyword));
  const runner = new SshRunner(host, '~/.quiz-runner', 'gcc', undefined);

  for (const f of files) {
    const full = path.join(bankDir, f);
    const doc = paperSchema.parse(yaml(fs.readFileSync(full, 'utf8')));
    const paper: PaperFile = {
      file: path.basename(full),
      paper: doc.paper,
      questions: doc.questions,
    };
    console.log(`\n===== 自检《${paper.paper.title}》（${paper.file}）=====`);
    const report = await verifyPaperSolutions(runner, paper, process.cwd(), {
      cCompiler: 'gcc',
      cppCompiler: 'g++',
      timeoutMs: 5000,
    });
    for (const r of report.results) {
      if (r.skipped) console.log(`  ${r.qid} ⏭ ${r.error}`);
      else if (r.summary) console.log(`  ${r.qid} ${r.ok ? '✅' : '❌'} ${r.summary.passed}/${r.summary.total}`);
      else console.log(`  ${r.qid} ❌ ${r.error}`);
    }
    if (report.badTests.length === 0) console.log('  → 全部用例合格 ✅');
    else {
      console.log('  → 发现坏用例：');
      for (const b of report.badTests) console.log(`     ${b.qid}「${b.test}」: ${b.reason}`);
    }
    // 清理自检目录
    fs.rmSync(path.join(process.cwd(), '.quiz', 'verify'), { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
