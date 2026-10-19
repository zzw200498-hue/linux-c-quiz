# Linux C 题库 · 桌面端

把 VSCode 插件里的做题功能搬到独立桌面程序里。**数据完全共用**——读的是同一个题库目录、同一份作答状态，
所以桌面端做的题，回到 VSCode 打开还是同一份进度。

## 启动

两种用法，任选：

### 1) 真正的桌面 App（推荐）：双击 exe

```bash
npm run desktop:package     # 打包
```

产物在 `桌面\Linux C 题库\LinuxCQuiz-win32-x64\LinuxCQuiz.exe`，双击即可。
没有命令行窗口、不依赖浏览器、不需要装 Node —— 程序自带 Electron 运行时和内置服务。

自定义输出目录：

```bash
node desktop/package.cjs --out=D:\apps\quiz
```

### 2) 开发模式：起服务 + 借 Edge 开窗口

双击 `启动桌面端.bat`（首次会自动构建），或者：

```bash
npm run desktop
```

先起本地服务（127.0.0.1:5733），再用 Edge「应用模式」开一个没有地址栏的独立窗口。
改界面代码时不用重新打包，刷新页面即可，适合调样式。

### Electron 壳是怎么工作的

```
双击 exe
  └─ Electron 主进程（electron/main.cjs）
       ├─ 确定题库目录（见下）
       ├─ 在主进程里 require 内置服务（app/server.cjs），监听 127.0.0.1 的随机空闲端口
       └─ 开一个无边框窗口，红黄绿灯画在页面里 → 加载这个本地地址
```

题库目录的解析顺序：

1. 命令行 `LinuxCQuiz.exe --ws="D:\my-bank"`
2. 环境变量 `QUIZ_WS`
3. 上次选过的（记在 `%APPDATA%\Linux C 题库\quiz-ws.json`）
4. 默认工作区 `…\WorkBuddy\2026-09-23-22-59-07\bank`
5. 都没有 → 弹文件夹选择框，选完记住

> ⚠️ **工作区根就选 `bank` 这一层**（里面有 `.vscode` 和 `.quiz`）。
> 试卷 yaml 在它的下一层 `bank/bank/`，这个位置由 `.vscode/settings.json` 里的
> `quiz.bankPath` 指定。**不要把选择框指到 yaml 那一层**，否则会多套一层目录读不到卷子
> （v0.1 的早期构建有这个坑：选到 `bank/bank` 后一张卷都不显示）。

窗口上的三个灯是真的能用的（关闭 / 最小化 / 最大化），标题栏可以拖动，
页脚会显示当前题库目录。

### 双击没反应 / 看不到试卷怎么办

按顺序查：

1. 看启动日志：`%APPDATA%\Linux C 题库\startup.log`（记录了工作区路径和实际端口）
2. **一张卷都没有** → 几乎都是工作区选深了一层。删掉 `%APPDATA%\Linux C 题库\quiz-ws.json`
   重开，或者启动时明确指定：
   `LinuxCQuiz.exe --ws="D:\你的题库工作区"`（换成你自己的路径，指向工作区根目录，里面有 `bank/` 和 `.quiz/`）
3. 端口被占用 → App 用的是随机空闲端口，一般不会有这问题；日志里有实际端口
4. 想确认是不是界面本身的问题 → 用开发模式 `npm run desktop`（借 Edge 打开同一个页面）对比

## 导入新卷（界面里就能做）

试卷页右上角两个按钮：

- **📋 复制出题提示词** —— 把 `prompts/generate.md` 的整份提示词复制到剪贴板，直接粘给 AI（粘贴后把「主题范围」那行改成你要练的内容）。
- **＋ 导入新卷** —— 打开导入面板：

| 方式 | 说明 |
| --- | --- |
| 粘贴 | 把 AI 回复的**整段**内容丢进去。带 ` ```yaml ` 围栏也行，会自动提取；前后有寒暄也不会干扰 |
| 读取文件 | 选一个 `.yaml` / `.yml` / `.md` 文件 |
| 拖拽 | 直接把 `.yaml` 文件拖到输入框上 |
| 剪贴板 | 点「从剪贴板粘贴」一键填入 |

快捷键 `Ctrl/Cmd + Enter` 直接导入，`Esc` 关闭。导入成功会提示「已导入《xxx》：N 题（单选×8，多选×4…）」并立刻刷新试卷列表；同名卷自动加 `-2`、`-3` 后缀，不会覆盖旧卷。

### 导入前的两道校验

1. **格式校验**（schema）：字段名、类型对不对。YAML 缩进错了会给出人话提示（"多半是缩进问题：粘贴时丢了缩进"）。
2. **质量检查**（lint）—— schema 管不了"能解析但根本没法做"的问题，所以额外挡一道：

| 拦下（error，不写入题库） | 放行但提醒（warning） |
| --- | --- |
| 选择题没有 choices / 没有 answer | 编程题没有 tests 用例（只能自己跑） |
| answer 字母超出选项范围（如 4 个选项却给 E） | 编程题缺 templateCode / solutionCode |
| 单选题给了多个正确答案 | 简答/改写题缺 rubrics 或参考答案 |
| 题号 id 重复（作答记录会串） | 客观题缺 explain 解析 |
| 填空题空位数与 blanks 数量对不上 | |
| 改写题缺 originCode | |

两边的校验逻辑都在 `src/shared/importer.ts`，VSCode 插件导入走的是同一份（不会出现"App 能导入、插件报错"）。

## 功能对照

| 功能 | 桌面端 | 说明 |
| --- | --- | --- |
| 试卷列表 | ✅ | 彩点完成度（绿 ≥80% / 黄 60~79% / 红 <60%）、进度条、成绩单分数 |
| **导入新卷** | ✅ | 粘贴 / 读文件 / 拖拽，带格式 + 质量双校验，失败给中文原因 |
| 做题（单选/多选/填空/简答/改写/编程） | ✅ | 判定规则与插件完全一致（同一份 `src/shared/judge.ts`） |
| 交卷判分 + 成绩单 | ✅ | 加权百分制、薄弱标签、总评 |
| 错题本 | ✅ | 待攻克 / 已过关、连对 3 次毕业、过关后再错回炉 |
| 主观题自行打分 | ✅ | 0-100 自评，≥60 记连对，<60 打回 |
| 客观题自主判分 | ✅ | 查看参考答案 / 我算对 / 我算错（对付答案写法多样的题） |
| **随机刷题** | ✅ | 只抽做过的题，每次 15 道，编程 ≤2、简答 ≤3 |
| 统计面板 | ✅ | 累计作答、正确率、薄弱知识点 Top 8、近 7 天作答量 |
| 编程题写代码 | ✅ | Monaco 编辑器（VSCode 同款内核）+ C 补全 + 运行测试 |
| ssh 运行器 | ✅ | 与插件同一套 ssh 逻辑，VM 里编译运行 |

## 代码是怎么写的（重点）

编程题用的是 **Monaco Editor —— 也就是 VSCode 的编辑器内核**，所以你在 App 里写代码的体验
和在 VSCode 里几乎一样：语法高亮、行号、缩进、括号匹配、自动补全（内置 C 关键字 + 常用 POSIX 函数 + 头文件）。

文件落在 `.quiz/scratch/<试卷>/<题号>/`，和插件用的是**同一个目录**：

```
.quiz/scratch/综合四/q23/main.c
```

编辑时有 800ms 防抖自动保存（写回 scratch 文件 + 作答记录），点「▶ 运行测试」会：

1. 把 scratch 目录整体同步到 VM（base64 heredoc 走 stdin，避开 Windows 路径和命令行长度限制）
2. 在 VM 里 `gcc -Wall -o main *.c` 编译
3. 逐个跑 `tests` 用例（含超时、文件存在性检查），输出回显在下方终端区

这些都直接复用插件的 `src/runner/ssh.ts` 和 `src/core/tester.ts` —— **没有重写一份**，
所以两边的判分行为不会漂移。

## 架构

```
desktop/
  server/
    config.ts    读 bank/.vscode/settings.json（runner / sshHost / 编译器等）
    store.ts     题库、作答状态、成绩单、错题本、随机抽题（复用 src/shared 纯函数）
    scratch.ts   编程题工作目录（结构同插件）
    main.ts      HTTP 接口 + 静态资源
  web/
    index.html   界面骨架
    app.css      mac 风格样式
    app.ts       交互逻辑（复用 src/shared/stem.ts 的题干切块、judge.ts 的判定）
  electron/
    package.json Electron 应用的 package.json（应用名 / 入口）
    main.cjs     主进程：起内置服务 + 开无边框窗口 + 选择题库目录
    preload.cjs  只把窗口控制（最小化/最大化/关闭）暴露给页面
    app/         构建产物：server.cjs（内置服务）
    web/         构建产物：index.html / app.js / app.css / monaco（网页界面）  build.mjs      打包：server → CJS、web → IIFE、Monaco → 静态资源、产出 electron/{app,web}
  launch.mjs     开发模式：起服务 + 用 Edge 开窗口
  package.cjs    用 electron-packager 打成 Windows exe
```

复用的纯模块（桌面端与 VSCode 插件共用同一份源码）：

- `src/shared/judge.ts` 判定
- `src/shared/importer.ts` 导入（提取 yaml / 校验 / 质量检查 / 文件名）
- `src/shared/wrongbook.ts` 错题本（连对、毕业、回炉）
- `src/shared/summary.ts` 成绩单
- `src/shared/stem.ts` 题干切块（代码块不被压平的关键）
- `src/runner/ssh.ts`、`src/core/tester.ts` 编译运行

## 配置

跟插件一样，读 `bank/.vscode/settings.json`：

```jsonc
{
  "quiz.runner": "ssh",
  "quiz.sshHost": "ubuntu@192.168.1.100",   // 示例地址，换成你自己的用户名@VM的IP
  "quiz.remoteRoot": "~/.quiz-runner",
  "quiz.cCompiler": "gcc",
  "quiz.runTimeoutSec": 5
}
```

也可以临时用环境变量覆盖：`QUIZ_SSH_HOST`（ssh 目标）、`QUIZ_WS`（工作区根）、`QUIZ_PORT`（端口）。

右上角的状态徽章会实时显示 ssh 是否连通（打开时探测一次）。

## 下一步（还没做）

1. **应用图标**：现在是 Electron 默认图标，可以换成自己的 .ico（打包时传 icon）。
2. **VSCode 双向联动**：在 App 里改了代码，VSCode 侧自动刷新（目前靠文件本身一致）。
3. **AI 批改面板**：把「导出作答 → AI 批改 → 导入」也搬到 App 里。
4. **深色主题**：目前是浅色 mac 风，可加一个开关。
