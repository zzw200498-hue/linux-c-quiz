/* 一次性迁移：给卷二的编程题注入配套文件 files{}，使编程题在 scratch 里可真实编译运行 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法: node inject-fixtures.cjs <bank yaml 路径>');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(file, 'utf8'));
const byId = new Map(doc.questions.map((q) => [q.id, q]));

byId.get('q23').files = {
  'source.txt': 'Hello, Linux!\n嵌入式 C 刷题工作台。\n第三行：文件IO练习\n',
};

byId.get('q24').files = {
  'main.c': [
    '#include <stdio.h>',
    '#include "file_io.h"',
    '',
    'int main(void) {',
    '    printf("main ok\\n");',
    '    file_io_hello();',
    '    return 0;',
    '}',
    '',
  ].join('\n'),
  'file_io.h': [
    '#ifndef FILE_IO_H',
    '#define FILE_IO_H',
    '',
    'void file_io_hello(void);',
    '',
    '#endif',
    '',
  ].join('\n'),
  'file_io.c': [
    '#include <stdio.h>',
    '#include "file_io.h"',
    '',
    'void file_io_hello(void) {',
    '    printf("file_io ok\\n");',
    '}',
    '',
  ].join('\n'),
};

fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
console.log(`已注入 files：${path.basename(file)}（q23 source.txt；q24 main.c/file_io.c/file_io.h）`);
