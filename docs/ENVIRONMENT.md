# Environment

核验日期：2026-09-22。

- 工作区：原始目录为空，仅包含 `dsh-devkit-handoff/`，不是现有 DSH 插件仓库。
- Node：`v24.14.1`；npm：`11.11.0`。
- Git：已初始化并同步至 `Tracking365/dsh-workflow-pg`；GitHub CLI 未安装。
- DSH：已安装并锁定 `@deepseek-ai/dsh@0.1.6-alpha.2` 与
  `@deepseek-ai/dsh-tools@0.1.6-alpha.2`。
- Cordis：已安装并锁定 `@deepseek-ai/cordis@4.0.3`。这是 DSH 0.1.6-alpha.2
  当前依赖树可满足的版本；先前强制 4.0.2 会让 npm 报告无效 peer。
- DSH 子代理：开发/验证依赖锁定 `@deepseek-ai/dsh-subagent@0.1.6-alpha.2` 与
  `@deepseek-ai/dsh-subagent-codex@0.1.6-alpha.2`；后二者作为可选 peer，实际 profile
  必须显式安装 provider 才会注册 `codex`。

真实 Cordis + DSH ToolRuntime 的装配、注册、分派与卸载/重载已在临时 fixture 中验证。
`npm run test:launcher` 还会在一次性 `DSH_HOME` 中安装当前 tarball、导出 profile 配置，并两次以
headless `--help` 启动；未传入任务、凭据或模型请求。真实官方 Codex provider 的注册也已在
Cordis fixture 中验证，且断言注册过程不启动子进程。`npm run test:codex-provider-profile`
还会将该 provider tarball 装入一次性 headless profile、核对 patch 并两次启动；不调用
`subagents.start`。真实 AgentLoop/Session 已在夹具中组成候选工作副本父会话，官方 provider
的拒绝式 subprocess seam 也确认收到该 canonical cwd；seam 不执行进程。实际 Codex
app-server、真实模型调用、网络/凭据边界与 OS 沙箱仍未验证；原生 `run` 默认保持阻塞。
