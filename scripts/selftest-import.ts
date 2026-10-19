/**
 * 导入功能的离线冒烟测试（不联网、不碰真实题库）。
 *
 *   node dist/selftest-import.cjs            # 用内置用例 + 现有题库的 lint 体检
 *   node dist/selftest-import.cjs bank/bank  # 额外指定一个题库目录做 lint 扫描
 *
 * 覆盖：
 *   A. 从「AI 回复整段（带 ```yaml 围栏）」里提取 yaml
 *   B. yaml 语法错误 / 字段不合规 / 题号重复 / 选择题缺选项 的拦截
 *   C. 文件名生成（非法字符、重名加后缀）
 *   D. 现有题库跑一遍 lint，确认规则不会误伤正常卷
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { load as yamlLoad } from 'js-yaml';
import {
  extractYaml,
  lintPaper,
  parsePaperText,
  paperTypeSummary,
  safePaperName,
  uniquePaperFileName,
} from '../src/shared/importer';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

const parse = (text: string) => parsePaperText(text, (raw) => yamlLoad(raw));

/* ---------- A. 文本提取 ---------- */
console.log('\nA. 从 AI 回复里提取 yaml');
{
  const wrapped = '好的，这是练习卷：\n\n```yaml\npaper:\n  title: "卷A"\nquestions: []\n```\n\n祝顺利！';
  check('带 ```yaml 围栏时只取围栏内容', !extractYaml(wrapped).includes('祝顺利'));
  check('围栏内容能找回 title', extractYaml(wrapped).includes('卷A'));

  const plainFence = '```\npaper:\n  title: "卷B"\n```';
  check('没标语言的 ``` 也能提取', extractYaml(plainFence).includes('卷B'));

  const raw = 'paper:\n  title: "卷C"\nquestions: []';
  check('纯 yaml 原样返回', extractYaml(raw).includes('卷C'));
}

/* ---------- B. 校验拦截 ---------- */
console.log('\nB. 校验与拦截');
{
  const ok = [
    'paper:',
    '  title: "正常卷"',
    '  topics: [进程]',
    'questions:',
    '  - id: q01',
    '    type: single',
    '    stem: "pipe() 参数个数"',
    '    choices: ["1", "2", "3", "4"]',
    '    answer: B',
    '    explain: "pipe(fd[2])"',
    '    tags: [IPC]',
    '    difficulty: 1',
  ].join('\n');
  const r1 = parse(ok);
  check('样例卷解析通过', r1.ok);
  if (r1.ok) {
    check('标题解析正确', r1.data.paper.title === '正常卷');
    check('题型摘要正确', paperTypeSummary(r1.data.questions) === '单选×1', paperTypeSummary(r1.data.questions));
    check('正常卷 lint 无 error', lintPaper(r1.data).errors.length === 0);
  }

  const broken = parse('paper:\n  title: "x"\n  bad: [unclosed\n');
  check('yaml 语法错误被识别为 yaml 阶段', !broken.ok && broken.stage === 'yaml');
  check(
    '语法错误信息带中文提示',
    !broken.ok && /缩进|没复制完整/.test(broken.message),
    !broken.ok ? broken.message : '',
  );

  const noTitle = parse('paper:\n  topics: [t]\nquestions:\n  - id: q01\n    type: single\n    stem: "x"\n    choices: ["a","b"]\n    answer: A\n');
  check('缺 paper.title 被 schema 拦下', !noTitle.ok && noTitle.stage === 'schema');

  const noChoices = parse('paper:\n  title: "坏"\n  topics: [t]\nquestions:\n  - id: q01\n    type: single\n    stem: "没有选项"\n    tags: [t]\n');
  check('选择题缺选项：schema 放过', noChoices.ok);
  if (noChoices.ok) {
    const l = lintPaper(noChoices.data);
    check('选择题缺选项：lint 拦下', l.errors.length >= 2, l.errors.join(' / '));
  }

  const dupId = parse(
    [
      'paper:',
      '  title: "重号"',
      'questions:',
      '  - id: q01',
      '    type: single',
      '    stem: "a"',
      '    choices: ["1","2","3","4"]',
      '    answer: A',
      '    explain: "x"',
      '  - id: q01',
      '    type: single',
      '    stem: "b"',
      '    choices: ["1","2","3","4"]',
      '    answer: B',
      '    explain: "x"',
    ].join('\n'),
  );
  check('题号重复：schema 放过', dupId.ok);
  if (dupId.ok) {
    const l = lintPaper(dupId.data);
    check('题号重复：lint 拦下', l.errors.some((e) => /重复/.test(e)), l.errors.join(' / '));
  }

  const badLetter = parse(
    ['paper:', '  title: "越界"', 'questions:', '  - id: q01', '    type: multi', '    stem: "x"', '    choices: ["1","2"]', '    answer: [A, C]', '    explain: "x"'].join('\n'),
  );
  if (badLetter.ok) {
    const l = lintPaper(badLetter.data);
    check('answer 超出选项范围被拦下', l.errors.some((e) => /超出选项范围/.test(e)), l.errors.join(' / '));
  }

  const multiOne = parse(
    ['paper:', '  title: "单答案多选"', 'questions:', '  - id: q01', '    type: single', '    stem: "x"', '    choices: ["1","2","3"]', '    answer: [A, B]', '    explain: "x"'].join('\n'),
  );
  if (multiOne.ok) {
    const l = lintPaper(multiOne.data);
    check('单选题给多个答案被拦下', l.errors.some((e) => /只能有一个/.test(e)), l.errors.join(' / '));
  }

  const fillMismatch = parse(
    ['paper:', '  title: "空位对不上"', 'questions:', '  - id: q01', '    type: fill', '    stem: "这里 ____1____ 和 ____2____ 两个空"', '    blanks:', '      - answer: a', '    explain: "x"'].join('\n'),
  );
  if (fillMismatch.ok) {
    const l = lintPaper(fillMismatch.data);
    check('填空空位数与 blanks 不一致被拦下', l.errors.some((e) => /空位/.test(e)), l.errors.join(' / '));
  }

  const codingNoTests = parse(
    ['paper:', '  title: "编程题没用例"', 'questions:', '  - id: q01', '    type: coding', '    stem: "写个程序"', '    templateCode: "int main(){}"'].join('\n'),
  );
  if (codingNoTests.ok) {
    const l = lintPaper(codingNoTests.data);
    check('编程题缺 tests 只算提醒（仍可导入）', l.errors.length === 0 && l.warnings.some((w) => /tests/.test(w)), JSON.stringify(l));
  }

  // yaml 内部含 ```c 代码块时，不能把代码块误当成整卷内容（题库里真实存在这种卷）
  const withCodeFence = [
    'paper:',
    '  title: "含代码块的卷"',
    'questions:',
    '  - id: q01',
    '    type: fill',
    '    stem: |',
    '      下面代码输出什么：',
    '      ```c',
    '      int main(void) {',
    '          printf("hi");',
    '      }',
    '      ```',
    '      输出 `____1____`',
    '    blanks:',
    '      - answer: hi',
    '    explain: "x"',
  ].join('\n');
  const codeFence = parse(withCodeFence);
  check('yaml 内含 ```c 代码块也能正确解析（不被当成围栏整卷）', codeFence.ok, !codeFence.ok ? codeFence.message : '');

  const onlyWarn = parse(
    ['paper:', '  title: "只有提醒"', 'questions:', '  - id: q01', '    type: short', '    stem: "说说 fork"'].join('\n'),
  );
  if (onlyWarn.ok) {
    const l = lintPaper(onlyWarn.data);
    check('简答题缺 rubrics 只算提醒（能导入）', l.errors.length === 0 && l.warnings.length > 0, JSON.stringify(l));
  }
}

/* ---------- C. 文件名 ---------- */
console.log('\nC. 文件名生成');
{
  check('非法字符被替换', safePaperName('综合四: 进程/内存*测试') === '综合四-进程-内存-测试', safePaperName('综合四: 进程/内存*测试'));
  check('空标题有兜底', safePaperName('   ') === 'untitled');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-name-'));
  const exists = (p: string) => fs.existsSync(p);
  const n1 = uniquePaperFileName(dir, '测试卷', exists);
  fs.writeFileSync(path.join(dir, n1), 'x');
  const n2 = uniquePaperFileName(dir, '测试卷', exists);
  fs.writeFileSync(path.join(dir, n2), 'x');
  const n3 = uniquePaperFileName(dir, '测试卷', exists);
  check('重名自动加后缀', n1 === '测试卷.yaml' && n2 === '测试卷-2.yaml' && n3 === '测试卷-3.yaml', `${n1} / ${n2} / ${n3}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- D. 现有题库体检 ---------- */
console.log('\nD. 现有题库 lint 体检（确认规则不误伤正常卷）');
{
  const dir = path.resolve(process.argv[2] ?? 'bank/bank');
  if (!fs.existsSync(dir)) {
    console.log(`  - 跳过：找不到 ${dir}`);
  } else {
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
    let errPapers = 0;
    let warnCount = 0;
    let qTotal = 0;
    for (const f of files) {
      const r = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!r.ok) {
        console.log(`  ✗ ${f} 解析失败：${r.message}`);
        errPapers++;
        continue;
      }
      const l = lintPaper(r.data);
      qTotal += r.data.questions.length;
      warnCount += l.warnings.length;
      if (l.errors.length) {
        errPapers++;
        console.log(`  ✗ ${f} 有 ${l.errors.length} 处 error：`);
        l.errors.slice(0, 3).forEach((e) => console.log(`      · ${e}`));
      }
    }
    console.log(`  扫描 ${files.length} 卷 / ${qTotal} 题：error 卷 ${errPapers}，warning ${warnCount} 条`);
    check('现有题库没有 error 级问题（规则没误伤）', errPapers === 0, `有 ${errPapers} 卷报 error`);
  }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
