/**
 * 给卷二 q23/q24 注入 solutionCode（参考答案）并修正用例：
 * - q23: 加 checkPresent(dest.txt)，参考答案 = 完整拷贝程序
 * - q24: make clean 用例改成文件语义检查（checkAbsent），不再比对 rm 参数顺序；
 *        make 编译用例加 checkPresent；参考答案 = 正确 Makefile
 * 用 node 跑，避免手编长 YAML。
 */
const fs = require('fs');
const yaml = require('js-yaml');

const file = process.argv[2];
const doc = yaml.load(fs.readFileSync(file, 'utf8'));

const q23 = doc.questions.find((q) => q.id === 'q23');
const q24 = doc.questions.find((q) => q.id === 'q24');

q23.solutionCode = [
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <fcntl.h>',
  '#include <unistd.h>',
  '',
  'int main(void) {',
  '    int fd1 = open("source.txt", O_RDONLY);',
  '    if (fd1 < 0) { perror("open source.txt"); exit(1); }',
  '    int fd2 = open("dest.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);',
  '    if (fd2 < 0) { perror("open dest.txt"); exit(1); }',
  '',
  '    char buf[4096];',
  '    ssize_t n;',
  '    while ((n = read(fd1, buf, sizeof(buf))) > 0) {',
  '        ssize_t off = 0;',
  '        while (off < n) {',
  '            ssize_t w = write(fd2, buf + off, (size_t)(n - off));',
  '            if (w < 0) { perror("write"); exit(1); }',
  '            off += w;',
  '        }',
  '    }',
  '    if (n < 0) { perror("read"); exit(1); }',
  '    close(fd1);',
  '    close(fd2);',
  '    printf("拷贝完成\\n");',
  '    return 0;',
  '}',
].join('\n');
q23.tests[0].checkPresent = ['dest.txt'];

q24.solutionCode = [
  'CC := gcc',
  'CFLAGS := -Wall -g',
  'OBJECT := main.o file_io.o',
  '.PHONY: clean',
  '',
  'app: $(OBJECT)',
  '\t$(CC) $(CFLAGS) -o $@ $^',
  '',
  '%.o: %.c file_io.h',
  '\t$(CC) $(CFLAGS) -c $< -o $@',
  '',
  'clean:',
  '\trm -f $(OBJECT) app',
].join('\n');

// make 编译：输出比对（验证用了自己的规则与 $< $^）+ 产物存在
q24.tests[0].checkPresent = ['app', 'main.o', 'file_io.o'];
// make clean：不再比对 rm 参数顺序（rm -f app main.o file_io.o 与 rm -f main.o file_io.o app 等价），
// 改成语义检查——跑完后产物必须真的消失
q24.tests[1].expectedStdout = '';
q24.tests[1].match = 'contains';
q24.tests[1].checkAbsent = ['app', 'main.o', 'file_io.o'];

fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1, noRefs: true }), 'utf8');
console.log('injected solutionCode + semantic checks into', file);
for (const q of [q23, q24]) {
  console.log(q.id, 'tests =', JSON.stringify(q.tests));
}
