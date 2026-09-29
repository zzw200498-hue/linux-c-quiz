/**
 * 真机验证 sysroot 同步：拉取 VM 头文件 → 解压到工作区 → 检查关键头文件与扩展配置。
 * 用法：node dist/e2e-sysroot.cjs [wsRoot] [user@host]
 */
import * as fs from 'fs';
import * as path from 'path';
import { syncSysroot, hasSysroot, sysrootIncludePaths } from '../src/core/sysroot';

async function main() {
  const wsRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'bank'));
  const host = process.argv[3] ?? 'daniya@192.168.88.128';
  console.log(`工作区: ${wsRoot}`);
  console.log(`VM: ${host}\n`);

  const res = await syncSysroot(wsRoot, { host });
  console.log(res.message);

  if (!res.ok) process.exit(1);

  const base = path.join(wsRoot, '.quiz', 'sysroot');
  const must = [
    'usr/include/stdio.h',
    'usr/include/unistd.h',
    'usr/include/pthread.h',
    'usr/include/fcntl.h',
    'usr/include/x86_64-linux-gnu/sys/socket.h', // glibc 多架构布局：sys/* 在 x86_64-linux-gnu 下
    'usr/include/x86_64-linux-gnu/sys/types.h',
  ];
  let ok = true;
  for (const f of must) {
    const exists = fs.existsSync(path.join(base, f));
    console.log(`${exists ? '✅' : '❌'} ${f}`);
    ok = ok && exists;
  }

  console.log('\nincludePath 配置:');
  for (const p of sysrootIncludePaths(wsRoot)) console.log(`  ${p}`);

  const propsFile = path.join(wsRoot, '.vscode', 'c_cpp_properties.json');
  const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'));
  const incOk = Array.isArray(props.configurations?.[0]?.includePath);
  console.log(`\nc_cpp_properties.json includePath: ${incOk ? '✅' : '❌'}`);
  const clangdOk = fs.existsSync(path.join(wsRoot, '.clangd'));
  console.log(`.clangd: ${clangdOk ? '✅' : '❌'}`);
  console.log(`hasSysroot(): ${hasSysroot(wsRoot) ? '✅' : '❌'}`);

  process.exit(ok && incOk && clangdOk && hasSysroot(wsRoot) ? 0 : 1);
}

void main().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
