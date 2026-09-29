/* 开发期工具：校验 bank/*.yaml 是否符合题目 Schema（模拟扩展导入路径） */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { paperSchema } from '../src/shared/types';

const dir = path.resolve(process.argv[2] ?? 'bank/bank');
let fail = 0;
for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/i.test(x))) {
  let data: unknown;
  try {
    data = load(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (e) {
    console.log(`YAML-SYNTAX-FAIL ${f}: ${String(e)}`);
    fail++;
    continue;
  }
  const r = paperSchema.safeParse(data);
  if (r.success) {
    const types = new Map<string, number>();
    for (const q of r.data.questions) types.set(q.type, (types.get(q.type) ?? 0) + 1);
    const s = [...types.entries()].map(([t, n]) => `${t}×${n}`).join(' ');
    console.log(`OK  ${f} (${r.data.questions.length} 题: ${s})`);
  } else {
    fail++;
    console.log(
      `FAIL ${f}:\n` +
        r.error.issues
          .slice(0, 8)
          .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
          .join('\n'),
    );
  }
}
process.exit(fail > 0 ? 1 : 0);
