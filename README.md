# DSH DevKit / dsh-workflow-pg

基于 DeepSeek Harness 的研发辅助插件，按既有 `dsh-devkit-handoff/` 计划迭代。

**当前是首个可运行的控制面与 Bug 修复 fixture 增量，不是 M0–M3 全部完成，更不是生产自动修复系统。**
真实 DSH 运行时尚未联调；真实 Codex 执行器和 OS 沙箱尚未接入。原生入口默认阻塞代码执行，不会偷偷使用测试替身或 full-access。

## 已实现

TypeScript strict 领域层、严格任务/宿主策略校验、SQLite 事务任务与事件、持久仓库运行锁、任务创建时冻结基准提交、独立 Git 副本、包含未跟踪文件/二进制/模式的快照、冻结测试与范围检查、真实 Node TAP 验证、独立审核协议、待办去重、共享两次返修预算、补丁产物和宿主人工验收。

提供 DSH bundle patch、七个工具定义、生命周期关闭入口，以及独立的 DeepSeek HTTP 只读审核适配器。HTTP 适配器已做协议测试，未使用真实账号调用；当前不会被自动接入 live 工作流。

## 本地验证

使用 Node >=22.13（内置 `node:sqlite`；最新干净锁文件验证见 [TEST_REPORT](docs/TEST_REPORT.md)）。

```sh
npm ci
npm run check
npm test
npm run demo
npm run test:pack
```

`demo` 只对新建临时仓库工作，作者与审核均为显式 fixture；真实运行 Git、Node 回归测试并输出 patch/report 路径。它不会修改此插件仓库或你的业务仓库，不调用付费模型、不推送、不合并。

打包导入测试不等于 DSH 原生分派测试。实际证据与环境差异见 [TEST_REPORT](docs/TEST_REPORT.md)。

## 在 DSH 中安装

```sh
npm ci
npm run build
npm pack
# 在已安装 DSH 的机器上，使用独立测试 profile：
dsh plugin --profile devkit-eval add ./dsh-devkit-0.1.0.tgz
dsh --profile devkit-eval --dump-config
dsh --profile devkit-eval
```

上面的 DSH 命令依据官方文档，尚未在本次环境执行。工具包括 `devkit_doctor`、`dev_task_create/run/status/cancel/resume/report`。默认仅任务管理可用，`run` 安全阻塞，`resume` 明确要求操作者核对现场。

请先阅读 [QUICKSTART](docs/QUICKSTART.md)、[SECURITY](docs/SECURITY.md)、[DSH_COMPATIBILITY](docs/DSH_COMPATIBILITY.md) 和 [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md)。

`skills/bugfix/SKILL.md` 是随包分发的规则；不会因为进入 npm 包就自动被 DSH 发现，应按项目 Skills 规则显式安装到测试项目，不覆盖既有文件。

## 后续重点

锁定并安装真实 DSH runtime，验证装配/分派/卸载；实现原生 Codex 子代理与可证明的沙箱、取消适配；接入独立真实审核；完成安全恢复与审批凭据。UI 修复和需求开发仍是 M4/M5，不在本增量中假装完成。
