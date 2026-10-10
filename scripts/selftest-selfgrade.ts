/**
 * 自行打分（v0.4.1）离线冒烟：只测纯逻辑，不需要 VSCode / VM。
 * 跑法：npm run build && npx esbuild scripts/selftest-selfgrade.ts --bundle --platform=node --format=cjs --outfile=dist/selftest-selfgrade.cjs && node dist/selftest-selfgrade.cjs
 */
import { gradeSchema } from '../src/shared/types';
import {
  PASS_SCORE,
  WRONG_STREAK_TARGET,
  isPassScore,
  recordPractice,
  verdictFromScore,
  wrongKey,
  type Wrongbook,
} from '../src/shared/wrongbook';

let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

console.log('[selfgrade] 1) 分数 → 判定');
ok('100 → correct', verdictFromScore(100) === 'correct');
ok('90 → correct', verdictFromScore(90) === 'correct');
ok('89 → partial', verdictFromScore(89) === 'partial');
ok('60 → partial', verdictFromScore(60) === 'partial');
ok('59 → wrong', verdictFromScore(59) === 'wrong');
ok('0 → wrong', verdictFromScore(0) === 'wrong');

console.log('[selfgrade] 2) 及格线');
ok(`≥${PASS_SCORE} 算过`, isPassScore(60) && isPassScore(85));
ok(`<${PASS_SCORE} 不算过`, !isPassScore(59) && !isPassScore(0));

console.log('[selfgrade] 3) 错题本连对结算');
const P = 'demo.yaml';
const Q = 'q1';
let wb: Wrongbook = {
  [wrongKey(P, Q)]: {
    paper: P,
    qid: Q,
    streak: 0,
    passed: false,
    tries: 0,
    awaitingGrade: false,
    graduatedAt: 0,
    ts: 0,
    source: 'auto',
  },
};
const grade = (score: number) => recordPractice(wb, P, Q, isPassScore(score));

wb = grade(85);
ok('自评 85 → 连对 1', wb[wrongKey(P, Q)].streak === 1);
wb = grade(70);
ok('自评 70 → 连对 2', wb[wrongKey(P, Q)].streak === 2);
wb = grade(100);
const done = wb[wrongKey(P, Q)];
ok(`连对 ${WRONG_STREAK_TARGET} 次过关`, done.streak === 3 && done.passed === true);
ok('过关时间已记录', done.graduatedAt > 0);

wb = grade(40);
const back = wb[wrongKey(P, Q)];
ok('过关后自评 40 → 打回待攻克', back.passed === false && back.streak === 0);
// 注：graduatedAt 打回后保留历史值（回炉判据要用「新判定 ts > graduatedAt」，清零会导致误伤）
ok('打回后保留历史过关时间', back.graduatedAt > 0);

wb = grade(59);
ok('59 分（partial 区间以下）不算过', wb[wrongKey(P, Q)].streak === 0);
wb = grade(60);
ok('刚好 60 分算过', wb[wrongKey(P, Q)].streak === 1);

console.log('[selfgrade] 4) grade schema（自评来源）');
const g = gradeSchema.parse({
  verdict: verdictFromScore(85),
  score: 85,
  comment: '自行打分',
  correct_answer: '',
  missed_points: [],
  source: 'self',
});
ok('source=self 保留', g.source === 'self');
const g2 = gradeSchema.parse({ verdict: 'correct', score: 100 });
ok('缺省 source=ai', g2.source === 'ai');
ok('缺省字段补齐', g2.comment === '' && g2.missed_points.length === 0);

console.log(fail === 0 ? '\n[selfgrade] 全部通过' : `\n[selfgrade] 失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
