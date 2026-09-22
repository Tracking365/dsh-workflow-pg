# DSH DevKit / dsh-workflow-pg

基于 DeepSeek Harness 的研发辅助插件，按既有 `dsh-devkit-handoff/` 计划迭代。

**当前是首个可运行的控制面与 Bug 修复 fixture 增量，不是 M0–M3 全部完成，更不是生产自动修复系统。**
真实 DSH 的 bundle/profile 装载已联调；官方 Codex 子代理桥接已在真实 DSH 注册表和 provider 注册夹具中验证。新增的原生无模型闭环只支持一个内容锁定的分页 fixture，策略和插件配置均须显式授权。另有测试专用离线 `LlmAdapter` 驱动真实 DSH AgentLoop，已验证会话内的工具选择、渲染结果回传和取消后的文本保留；它不含端点、凭据或网络代码。真实 Codex 进程、候选工作副本绑定和 OS 沙箱仍未完成联调。原生入口默认仍阻塞代码执行，不会偷偷使用测试替身或 full-access。

## 已实现

TypeScript strict 领域层、严格任务/宿主策略校验、SQLite 事务任务与事件、持久仓库运行锁、任务创建时冻结基准提交、独立 Git 副本、包含未跟踪文件/二进制/模式的快照、冻结测试与范围检查、真实 Node TAP 验证、独立审核协议、待办去重、共享两次返修预算、补丁产物和宿主人工验收。

提供 DSH bundle patch、七个工具定义、生命周期关闭入口、官方 `@deepseek-ai/dsh-subagent-codex` 的薄桥接，以及独立的 DeepSeek HTTP 只读审核适配器。Codex 桥接只经 DSH 的 `subagents` 服务委托，不会自行调用 CLI/API；它会校验父 session 工作目录与候选副本完全一致，并在不能证明子代理已退出时保留写锁。另有 `pagination-v1` 确定性 fixture：它只接受带标记的临时分页仓库、固定 `src/` 写入范围、冻结的 `test/` 与固定 Node TAP 命令，执行器和审核器均为宿主代码，不调用模型。两种真实适配器都未使用真实账号调用，当前不会被自动接入 live 工作流。

## 本地验证

使用 Node >=22.13（内置 `node:sqlite`；最新干净锁文件验证见 [TEST_REPORT](docs/TEST_REPORT.md)）。

```sh
npm ci
npm run check
npm test
npm run demo
npm run test:pack
npm run test:launcher
npm run test:codex-provider-profile
```

`demo` 只对新建临时仓库工作，作者与审核均为显式 fixture；真实运行 Git、Node 回归测试并输出 patch/report 路径。`npm test` 还会经过真实 Cordis/DSH ToolRuntime 跑完 `pagination-v1` 的 create → run → status → report → cancel/resume 边界。它们不会修改此插件仓库或你的业务仓库，不调用付费模型、不推送、不合并。`test:launcher` 是较慢的隔离 DSH profile gate：它不传任务文本，因而不调用模型。`test:codex-provider-profile` 只安装官方 Codex provider 并启动隔离 profile；它不调用 `subagents.start`，因而不会启动 Codex App Server。

打包导入测试不等于 DSH 原生分派测试。实际证据与环境差异见 [TEST_REPORT](docs/TEST_REPORT.md)。

## 在 DSH 中安装

```sh
npm ci
npm run build
npm pack
# 在已安装 DSH 的机器上，使用独立测试 profile：
dsh plugin --profile devkit-eval add ./dsh-devkit-0.1.0.tgz
dsh --profile devkit-eval --dump-config
dsh --profile devkit-eval --help
```

上面的流程已在本次环境的临时 headless profile 执行。工具包括 `devkit_doctor`、`dev_task_create/run/status/cancel/resume/report`。默认仅任务管理可用，`run` 安全阻塞，`resume` 明确要求操作者核对现场。唯一例外是双重明确开启的 `pagination-v1` 测试 fixture，它不能指定任意仓库、命令或模型；请勿把 `--help` 替换为真实任务文本，除非你已完成独立的模型、执行器与沙箱配置。

请先阅读 [QUICKSTART](docs/QUICKSTART.md)、[SECURITY](docs/SECURITY.md)、[DSH_COMPATIBILITY](docs/DSH_COMPATIBILITY.md) 和 [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md)。

如需只验证官方 Codex provider 是否能被 profile 注册，可另行安装精确版本：

```sh
dsh plugin --profile devkit-eval add @deepseek-ai/dsh-subagent-codex@0.1.6-alpha.2
```

这只增加 host-plane provider，不会开启 DevKit 的 `run`，也不是已验证的沙箱。不要把 provider 改成 `dangerously-bypass-approvals-and-sandbox`，更不要因为 `doctor` 显示 provider 已注册就输入真实任务或凭据。

`skills/bugfix/SKILL.md` 是随包分发的规则；不会因为进入 npm 包就自动被 DSH 发现，应按项目 Skills 规则显式安装到测试项目，不覆盖既有文件。

## 后续重点

为独立候选副本建立可证明的 Codex session 工作目录与 OS 沙箱、网络/凭据边界；接入独立真实审核；完成安全恢复与审批凭据。离线 AgentLoop fixture 已覆盖会话内的工具选择、呈现和取消，但不能替代真实 Provider 进程验证。UI 修复和需求开发仍是 M4/M5，不在本增量中假装完成。
