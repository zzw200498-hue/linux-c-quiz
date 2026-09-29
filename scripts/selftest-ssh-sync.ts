/**
 * 验证 ssh 同步脚本：本机起一个 bash（Git Bash）真实执行脚本，
 * 检查远端目录（这里用临时目录模拟）里的文件内容、换行归一化是否都正确。
 * 不需要 VM。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { capture } from '../src/runner/exec';
import { buildSyncScript } from '../src/runner/ssh';

function main(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sync-'));
  const src = path.join(tmp, 'src');
  const dst = path.join(tmp, 'dst');
  fs.mkdirSync(src);

  // 故意用 CRLF 的 Makefile（Windows 编辑后的样子）+ 正常 C 文件 + 应被跳过的产物
  fs.writeFileSync(path.join(src, 'main.c'), '#include <stdio.h>\r\nint main(void){printf("hi\\n");return 0;}\r\n');
  fs.writeFileSync(path.join(src, 'Makefile'), 'all:\r\n\tgcc main.c -o main\r\n');
  fs.writeFileSync(path.join(src, 'source.txt'), 'hello\r\nworld\r\n');
  fs.writeFileSync(path.join(src, 'main'), 'BINARY-ISH\x00junk');
  fs.writeFileSync(path.join(src, '.meta.json'), '{"x":1}');
  fs.writeFileSync(path.join(src, 'main.o'), 'obj');

  const { script, count } = buildSyncScript(src, dst.replace(/\\/g, '/'));
  console.log(`待上传文件数: ${count}（期望 3：main.c / Makefile / source.txt）`);

  const bash = process.platform === 'win32' ? 'bash' : '/bin/bash';
  void (async () => {
    const r = await capture([bash, '-s'], { stdin: script, timeoutMs: 15000 });
    console.log(`bash exit=${r.exitCode} stdout=${r.stdout.trim()} stderr=${r.stderr.trim()}`);

    const got = fs.readdirSync(dst).sort();
    console.log(`落盘文件: ${got.join(', ')}（期望 main.c,Makefile,source.txt）`);

    const mk = fs.readFileSync(path.join(dst, 'Makefile'), 'utf8');
    const c = fs.readFileSync(path.join(dst, 'main.c'), 'utf8');
    console.log(`Makefile 含 CRLF: ${mk.includes('\r\n')}（期望 false）`);
    console.log(`main.c 含 CRLF:   ${c.includes('\r\n')}（期望 false）`);
    console.log(`main.c 内容一致:  ${c === '#include <stdio.h>\nint main(void){printf("hi\\n");return 0;}\n'}`);

    const ok =
      count === 3 &&
      r.exitCode === 0 &&
      got.join(',') === 'Makefile,main.c,source.txt' &&
      !mk.includes('\r\n') &&
      !c.includes('\r\n');
    console.log(ok ? '\n同步脚本自检：通过 ✅' : '\n同步脚本自检：失败 ❌');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  })();
}

main();
