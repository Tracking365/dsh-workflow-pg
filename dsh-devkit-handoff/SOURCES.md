# 官方资料与核验边界

核对日期：**2026-09-20**。以下页面在编写交接包时已读取。它们是接口定位依据，不是针对用户机器的兼容性认证。

**实现前仍须以锁定版本实际安装的类型与源码为准。不要把文档中的示意片段、旧接口或本交接包自定义协议当成当前 SDK 的可复制代码。**

| ID | 来源及地址 | 与本项目相关的已核对事实 |
|---|---|---|
| S1 | DSH 架构：`https://deepseek-harness.github.io/deepseek-harness/reference/` | Cordis 插件、服务与组合体系；应用经 DSH launcher 与 profile 启动。 |
| S2 | 第一个插件：`https://deepseek-harness.github.io/deepseek-harness/develop/basic/` | 插件入口通过 apply/Context 注册；本地 overlay 的路径需正确解析。 |
| S3 | 打包与安装：`https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish` | bundle 是分发配置层；profile 是可启动组合，两者不可混作一物。 |
| S4 | 工具编写：`https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool` | 工具注册、参数/结果合同、取消、执行身份与资源处理。 |
| S5 | 子代理：`https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent` | 有 Codex、Claude Code 等提供方；能力不同，不能通用套用 agentOptions 等选项。 |
| S6 | 工作流：`https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workflow` | phases 是进度信息，不是业务验收或强制状态机。 |
| S7 | Skills：`https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills` | 支持项目技能发现及按需加载。 |
| S8 | 沙箱：`https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox` | 文件效果模式与网络权限不是同一保证；后端强制执行可能为 partial。 |
| S9 | 模型配置：`https://deepseek-harness.github.io/deepseek-harness/guide/providers` | 模型路由、凭据引用与模态声明；声明图片能力不等于端点真的支持。 |
| S10 | Codex 子代理：`https://developers.openai.com/codex/subagents` | 可请求委派和不同推理设置，实际能力取决于当前环境；文档可能重定向到官方 ChatGPT Learn。 |
| S11 | Codex 项目规范：`https://developers.openai.com/codex/guides/agents-md` | AGENTS.md 用于项目指令；应尊重现有作用域，不盲目覆盖。 |
| S12 | Git worktree：`https://git-scm.com/docs/git-worktree` | 多个工作目录仍关联同一个仓库，不能据此推导安全沙箱保证。 |
| S13 | Playwright 视觉比较：`https://playwright.dev/docs/test-snapshots` | 截图断言可用于视觉回归；需要稳定浏览器、字体和系统环境。 |
| S14 | 扩展模式：`https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook` | 原生工具/钩子/服务扩展；单调拒绝与一般可重排事件策略需要区分。 |
| S15 | Codex App Server：`https://developers.openai.com/codex/app-server` | 原生执行接口及权限等字段应按实际版本核对；本项目优先复用 DSH 已有提供方。 |

## 事实、设计和未知分别是什么

**事实**：上表关于 DSH/Codex/Git/Playwright 的窄范围能力说明。

**本项目设计**：DSH DevKit 名称、模块拆分、任务字段、工具名、两轮返修、状态机、审批与验收规则、目录和样例配置。这些不是 DSH 原生约定，也不代表已有成品。

**尚未验证**：用户实际仓库、安装版本、DSH profile、Codex 登录、API 凭据、审核模型、宿主沙箱强制程度、平台兼容性、真实任务成功率。

## M0 必须补齐的证据

记录实际 DSH/Cordis/执行器版本、选定模型路由、符号定义路径和关键配置来源；报告只包含脱敏信息。不要遍历和打印用户密钥文件。

特别检查：

- 本地装配和发布装配是否都能真实加载插件；打包后所需配置、编译产物和 Skills 是否被包含。
- 外部子代理的 cwd、权限、工具、模型与取消是否真实生效，而不只是传了无效参数。
- DSH 原生事件日志与本项目任务持久化的所有权边界；不可强行改写内部 Session 格式。
- SDK/提供方缺少能力时是否明确拒绝，而不是静默退化成更高权限运行。
