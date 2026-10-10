# Linux C Quiz 刷题工作台（VSCode 扩展）

把 DeepSeek 等 LLM 出的题目录入进来，在 VSCode 里作答的 Linux/嵌入式 C 刷题工作台。
支持：单选 / 多选（含判断题）/ 填空 / 简答 / 代码改写 / 编程题，作答自动持久化，并带「导出作答 → LLM 批改 → 导入结果 → 错题追踪」闭环。

## 安装

```bash
code --install-extension linux-c-quiz-0.2.0.vsix
```

> **Remote-SSH 用户注意**：本扩展声明了 `extensionKind: workspace`，需安装到**远端**（Ubuntu VM）。
> 在 Remote-SSH 会话中，扩展面板里选择 `Install in SSH: <你的VM>`，或 ssh 进 VM 后直接执行上面命令。

## 使用流程

1. **出题**：命令面板（`Ctrl+Shift+P`）→ `Quiz: 复制出题提示词` → 粘贴给 DeepSeek（记得填主题）→ 把它输出的 yaml 代码块存成 `.yaml` 或 `.md` 文件。
2. **导入**：侧栏「刷题」图标 → 顶部 ➕ → 选择刚才的文件 → 试卷出现在题库树中。
   *删除*：题库树里**右键试卷**（或悬停点垃圾桶图标）→「删除试卷」，题库文件会备份到 `.quiz/trash/`，可手动恢复；该卷作答记录一并清除。
3. **做题**：点试卷或任意题号 → 主区打开答题面板。客观题点选/填空后只保存答案，整卷做完点「交卷 · 判定客观题」统一判分（可「清除判定」重刷）；简答/代码题保存后待批改。
4. **批改闭环**：
   - `Quiz: 导出本卷作答` → 生成完整批改请求并**自动复制到剪贴板**（同时存到 `.quiz/export/`）；
   - 粘贴给 DeepSeek，把回复全文复制；
   - `Quiz: 导入批改结果（从剪贴板）` → 分数/点评写回，侧栏显示每题状态（✓ / ✗ / 分数）。
5. 作答数据存放在工作区 `.quiz/state.json`，题库在 `bank/*.yaml`，都可以 git 管理。

## 编程题：编译运行（v0.2）

编程题答题面板上有三个关键动作：

1. **在编辑器中打开**：在 `.quiz/scratch/<试卷>/<题号>/` 生成入口文件（C 题 `main.c`、Makefile 题 `Makefile`）和题目自带的配套文件（`files` 字段，如输入样例 `source.txt`），并用**真正的 VSCode 编辑器**打开——C/C++/clangd 扩展的补全、跳转、调试全部原生可用。**编辑器里保存即自动回写作答**（导出给 DS 批改用的是保存后的代码）。
2. **▶ 编译运行**：执行 `gcc -Wall -o main *.c`（Makefile 题直接跑 `make`），逐条跑 `tests` 用例，面板里显示每个用例 ✓/✗、执行的命令、实际输出、期望输出、耗时/超时/退出码；侧栏题目状态变为「用例 x/y」。
3. **Webview 快速编辑**：小改动直接在面板文本框改，点「编译运行」会先落盘再跑，编辑器和 Webview 双向同步（谁最新以谁为准）。

**Runner 三档**（设置里 `quiz.runner`）：

| 取值 | 场景 | 说明 |
|---|---|---|
| `local`（默认） | **Remote-SSH 到 Ubuntu VM 时用** | 扩展跑在远端，直接 spawn `gcc`/`make` |
| `ssh` | **VSCode 在 Windows 本地** | 每次运行把 scratch 目录同步到 VM 再 ssh 执行；需设置 `quiz.sshHost`（如 `daniya@192.168.88.128`，建议先配免密） |
| `off` | 只做题不运行 | 面板不出现运行结果 |

其它相关配置：`quiz.cCompiler`（默认 `gcc`，以后交叉编译题改成 `arm-linux-gnueabihf-gcc`）、`quiz.runTimeoutSec`（单用例超时，默认 5s，超时强制 kill）、`quiz.remoteRoot`（ssh 模式远端根目录）、`quiz.sshPath`（ssh 可执行文件路径，留空自动选）。

### Windows 本地 + VM 编译（ssh 模式）

工作区 `.vscode/settings.json` 里配好即可：

```jsonc
{
  "quiz.runner": "ssh",
  "quiz.sshHost": "daniya@192.168.88.128",   // 用户名@VM的IP
  "quiz.remoteRoot": "~/.quiz-runner",
  "quiz.cCompiler": "gcc",
  "quiz.runTimeoutSec": 5
}
```

前置条件：VM 开 sshd，且 Windows 本机免密登录已配好：

```bash
# 在 VM 里执行一次（把本机 ~/.ssh/id_ed25519.pub 的内容追加进去）
mkdir -p ~/.ssh && echo "<本机公钥内容>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

排查用：命令面板执行 **`Quiz: 检查编译环境（Runner 自检）`**，会连到 VM 打印 `whoami / gcc / make / gdb` 版本，连不上会直接给出原因（免密没配 / IP 不通 / 编译器缺失）。

### 本地补全：VM 系统头文件（sysroot）

Windows 本地没有 Linux 头文件，编辑 `main.c` 时 `unistd.h` / `pthread.h` 会报红线、补全失效。解法：命令面板执行 **`Quiz: 同步 VM 系统头文件（本地补全用）`**（ssh 模式下首次打开编程题也会自动同步一次），它会把 VM 的 `/usr/include` 和 gcc 内置头打包（约 16 MB）拉到本地 `.quiz/sysroot/`，并自动写好两个配置：

- `.vscode/c_cpp_properties.json` → includePath 指向 sysroot（C/C++ 扩展，intelliSenseMode 为 `linux-gcc-x64`）
- `.clangd` → `-isystem` 各头文件目录（clangd 用户）

之后本地编辑就是真实的 Linux C 体验：头文件不红线、补全、F12 跳转、悬停签名全部生效。VM 系统更新后（如换内核头/装新库）重跑一次该命令即可。

> 几个已处理的 Windows 坑：不用 scp（盘符冒号会被当主机分隔符）、同步走 stdin 而非命令行（避开 8191 字符上限）、上传前把 CRLF 统一成 LF（否则本地编辑的 Makefile 在远端 make 报错）、强制使用 `C:\Windows\System32\OpenSSH\ssh.exe`（PATH 里靠前的 Git-Bash ssh 在中文用户名目录下读不到私钥）、退出码显式回传（否则段错误 139 会变成 0xFFFFFFFF）。

**远程安装**：把 `.vsix` 装到 VM 里（二选一）：
- Remote-SSH 会话中：扩展面板 → 找到 Linux C Quiz → **Install in SSH: \<你的VM\>**；
- 或 Remote-SSH 连接后的终端里：`code --install-extension /path/to/linux-c-quiz-0.2.0.vsix`。

> 想要编辑器里的 C 补全/跳转，在远端装官方 **C/C++**（ms-vscode.cpptools）或 **clangd** 扩展即可。

## 复习（知识点速览）

- **悬停即看**：题库树里把鼠标停在题目上，提示内容由「题干」替换为**知识点**——正确答案 / 各空答案、解析、参考答案、评分要点、我的作答、批改结果。默认只对**已作答**的题生效（未作答仍只显示题干），可用配置 `quiz.knowledgeTooltip` 调整：
  | 取值 | 行为 |
  |---|---|
  | `answered`（默认） | 已作答的题显示知识点 |
  | `judged` | 仅已判定 / 已批改的题显示（交卷前零剧透） |
  | `always` | 所有题都显示 |
  | `off` | 只显示题干 |
- **整卷速览**：右键试卷（或悬停点 👁 图标）→「生成知识点速览」→ 生成 `.quiz/review/<标题>-知识点.md` 并打开 Markdown 预览，按题列出 正确答案 / 解析 / 参考答案 / 我的作答 / 批改点评，适合整卷回顾或打印。

## 目录约定

| 路径 | 说明 |
|---|---|
| `bank/*.yaml` | 题库（可用 `quiz.bankPath` 配置），一份文件 = 一张卷 |
| `prompts/generate.md` | 出题提示词（工作区优先，扩展内置兜底） |
| `prompts/review.md` | 批改提示词 |
| `.quiz/state.json` | 作答/批改状态 |
| `.quiz/scratch/<试卷>/<题号>/` | 编程题工作目录（真实编译运行发生地） |
| `.quiz/export/*.md` | 批改请求存档 |
| `.quiz/review/*.md` | 知识点速览（复习用） |
| `.quiz/trash/` | 删除试卷的备份 |

## 开发

```bash
npm install
npm run build        # esbuild 打包 extension + webview
npm run typecheck    # tsc 严格检查
npm run package      # 产出 .vsix
node dist/validate-bank.cjs   # 校验 bank/*.yaml 是否符合 Schema

# 预览悬停提示 / 知识点速览的渲染结果（题库 + 真实作答状态）
npx esbuild scripts/preview-knowledge.ts --bundle --platform=node \
  --outfile=dist/preview-knowledge.cjs --log-level=warning
node dist/preview-knowledge.cjs "bank" "q17,q21"
```

## Roadmap

- [x] v0.1 题库 Schema / 导入 / 答题 / 持久化 / 批改闭环
- [x] v0.1.4 侧栏悬停知识点 + 整卷知识点速览（复习）
- [x] v0.2 编程题 Runner：scratch 目录 + 真实 gcc/make 编译运行 + 用例比对（local / ssh / off 三档）
- [ ] v0.3 交叉编译 Runner：arm-linux-gnueabihf-gcc + qemu-user-static（改 `quiz.cCompiler` + 远端装 qemu 即可）
- [x] v0.4 错题本（待攻克 / 已过关，连对 3 次毕业）
- [x] v0.4.1 主观题自行打分（错题本 / 随机刷题里给 0-100 分，≥60 记一次连对，<60 打回）
- [x] v0.4.2 修复错题本误判：多选/填空要「提交并判定」才结算连对；刷题时不沿用原卷判定（不再锁定选项、不剧透）
- [x] v0.4.3 填空题题干代码块按块渲染（不再挤成一行）+ 客观题「自主判分」（查看参考答案，自己判对/错）
- [x] v0.4.4 修复错题本跨卷串台：题 id 加卷名前缀（不同卷都叫 q1，状态互相覆盖 → 一打开就有判定结果/别人的答案）
- [ ] v0.5 全库随机出题（只抽做过的题，每次 15 道）+ SM-2 间隔复习 + 统计面板
- [ ] v0.6 交叉编译 / 标签统计 / Anki 导出
