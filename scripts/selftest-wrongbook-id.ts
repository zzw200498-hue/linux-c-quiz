/**
 * 错题本题 id 唯一化冒烟：
 * 回归「打开一道还没做的题，却已经有判定结果 / 别的卷的答案」——
 * 根因是不同卷的题号都是 q1、q2，跨卷抽题时按 qid 记的状态会串台。
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { buildWrongbookQuestions } from '../src/shared/wrongbook';

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}`);
  if (!cond) fail++;
}

const Q = (id: string) => ({ id, type: 'fill', stem: 's', tags: [], difficulty: 1 }) as never;

/* ---- 1. 基本行为 ---- */
const items = [
  { paperFile: '综合四.yaml', q: Q('q1') },
  { paperFile: '第五章.yaml', q: Q('q1') },
  { paperFile: '第五章.yaml', q: Q('q2') },
];
const { questions, source } = buildWrongbookQuestions(items);

ok('跨卷同号题 → 面板 id 唯一', new Set(questions.map((q) => q.id)).size === 3);
ok('id 形如 试卷#题id', questions[0].id === '综合四.yaml#q1' && questions[1].id === '第五章.yaml#q1');
ok('source 能还原原卷 + 原题', source['第五章.yaml#q1'].paper === '第五章.yaml' && source['第五章.yaml#q1'].qid === 'q1');
ok('不就地改题库里的题目对象', items[0].q.id === 'q1' && items[1].q.id === 'q1');
ok('原题其余字段带过来', questions[0].type === 'fill' && questions[0].stem === 's');
ok('顺序与输入一致', questions[2].id === '第五章.yaml#q2');

/* ---- 2. 真实题库：确认确实存在跨卷同号 ---- */
const bankDir = path.resolve(__dirname, '..', 'bank', 'bank');
let collisions = 0;
let totalQuestions = 0;
if (fs.existsSync(bankDir)) {
  const files = fs.readdirSync(bankDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const seen = new Map<string, string>();
  const real: { paperFile: string; q: never }[] = [];
  for (const f of files) {
    const doc = yaml.load(fs.readFileSync(path.join(bankDir, f), 'utf8')) as {
      questions?: { id: string }[];
    };
    for (const q of doc?.questions ?? []) {
      totalQuestions++;
      if (seen.has(q.id)) collisions++;
      else seen.set(q.id, f);
      real.push({ paperFile: f, q: q as never });
    }
  }
  const built = buildWrongbookQuestions(real);
  ok(
    `真实题库 ${files.length} 卷 / ${totalQuestions} 题：跨卷同号 ${collisions} 处，合成后 id 全部唯一`,
    built.questions.length === totalQuestions &&
      new Set(built.questions.map((q) => q.id)).size === totalQuestions,
  );
  ok('每条都有 source 可还原', Object.keys(built.source).length === totalQuestions);
} else {
  console.log('  skip  未找到真实题库目录');
}

console.log(fail === 0 ? '\n[wrongbook-id] 全部通过' : `\n[wrongbook-id] 失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
