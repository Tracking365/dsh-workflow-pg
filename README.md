# DSH DevKit / dsh-workflow-pg

基于 DeepSeek Harness 的研发辅助插件，按既有 `dsh-devkit-handoff/` 计划迭代。

**当前是首个可运行的控制面与 Bug 修复 fixture 增量，不是 M0–M3 全部完成，更不是生产自动修复系统。**
真实 DSH 的 bundle/profile 装载已联调；官方 Codex 子代理桥接已在真实 DSH 注册表和 provider 注册夹具中验证。新增的原生无模型闭环只支持一个内容锁定的分页 fixture，策略和插件配置均须显式授权。另有测试专用离线 `LlmAdapter` 驱动真实 DSH AgentLoop，已验证会话内的工具选择、渲染结果回传和取消后的文本保留；它不含端点、凭据或网络代码。候选工作副本专用的短生命周期 DSH 父会话也已在真实 AgentLoop/Session 夹具中组成，并证明官方 provider 的拒绝式 subprocess seam 收到该候选目录。官方 provider 的本地 JSON-RPC 取消夹具还验证了已发布 turn 的 interrupt、受管进程终止确认和候选父会话释放。macOS Seatbelt 现在既包裹受信任验证命令，也能在 DevKit 专属 subprocess scope 中包裹官方 provider 的唯一 App Server 启动形状；宿主级无模型夹具实际运行一个伪 `@openai/codex` 包装脚本，证明候选写入允许、控制写入/受保护根读取/TCP 与 Unix socket 连接均被拒绝，宿主 home 目录内容无法枚举，且私有状态只在退出确认后移除。App Server 会显式 tombstone DSH 原本会继承的每个父环境变量，并先阻断宿主 home、临时区、卷和已知配置根的读取，只恢复候选目录、私有状态、当前 Node 运行时与精确的 `node_modules` 包树；这不是完整的 macOS 文件读取白名单。它没有启动真正的 Codex，也不是凭据 broker。2026-09-22 在一次明确授权、非 CI 的临时 Git fixture 中，官方 App Server 以当前登录态实际运行 1 次：`permissionMode: "never"`、显式 `env: {}`、无 full-access；观察到其 cwd 与候选目录一致并生成精确 proof。它不证明 App Server 的 OS 级文件/网络/凭据隔离或真实取消边界，原生入口默认仍阻塞代码执行，不会偷偷使用测试替身或 full-access。

官方 provider 的协议夹具还证明，只有 `approve-for-me` 会显式下发 `sandbox: "workspace-write"`。这只是 provider 协议前置条件：锁定版本没有认证的 App Server 审批转发，且尚无凭据 broker，因此 native `doctor` 明确报告 writer 仍不可启动；它不是 OS 沙箱，也不会启用 live。

2026-09-23 新增了一个独立的 App Server stdio JSONL 客户端原型，不再依赖或篡改该
provider 的自动拒绝流。它强制 ephemeral 候选线程、受限读写、命令网络关闭，并对审批
条目和终态通知都校验 task/thread/turn/item 绑定；伪造服务端已覆盖逐请求人工审批、取消和
退出证明，并可复用既有 Seatbelt 启动封装。配套的本地审批队列与 loopback HTML 页面使用
一次性 ID、过期/取消/容量拒绝、宿主密钥登录、`HttpOnly` 会话和 CSRF 校验。现在只有在
宿主策略显式声明 `codexApprovalControlPlane` 且提供专用 `DSH_DEVKIT_*` 密钥时，native 才会
启动该页面并在卸载时关闭它；它仍未接入 direct client 的执行路径。它们没有读取当前登录、
没有模型网络或凭据 broker，因此不能把它们当作生产可用开关。

同日还把 App Server 的通用 JSONL 传输拆成共享层，并加入 `CodexManagedAuthSession` 的
账户协议最小面：它只能经一个与候选写入器不兼容、没有 workspace/cwd 参数的宿主 launch
seam 使用 `account/read`、受管 ChatGPT 的浏览器/设备码 `account/login/start` 和
`account/login/cancel`。它拒绝 API key、外部 ChatGPT token、登出、线程/turn/工具和服务端
token-refresh 请求；账户状态不暴露 email/token，登录 URL/设备码也只作为内存中的宿主展示
材料存在。`PrivateCodexStateRoot` 现在会建立权限为 0700、且与候选/控制根不重叠的持久
`CODEX_HOME`；配套的 `MacosSeatbeltManagedAuthLaunch` 不接收候选 cwd，并在真实 Seatbelt
夹具中证明伪包装器只能读写该状态根、不能读候选或受保护目录。它现在只允许连接每次启动时新建的
本机代理端口；代理要求随机会话凭据，只接受 `auth.openai.com:443` 的 CONNECT，并在解析后固定公网
IPv4 地址。Seatbelt 仍拒绝直连外网及其他回环端口。该专用账号会话没有 thread/turn/tool/candidate
能力，因此代理不会暴露给候选命令；不可把它复用于模型 worker。退出证明后代理关闭，临时 HOME 才会删除，
私有 `CODEX_HOME` 保留。合成测试没有启动 OAuth、浏览器或真正 Codex，也没有连 OpenAI；实际 App Server
是否采用注入的代理环境仍待显式授权的隔离登录夹具验证。当前它未接入 native 策略或 live writer。

为避免把这个缺口误解为“给当前 App Server 开网络”即可解决，新增的 `SealedPatchProposalExecutor`
只向未来独立工作负载发送经 secret-like 检查、按值复制、相对路径的 UTF-8 源码快照，并只接受绑定快照、受限路径的 Git
文本补丁；它不传递候选绝对路径、私有状态、环境、凭据或冻结宿主上下文。当前只有合成夹具，尚无
worker、OAuth、端点或 live 接线；完整部署要求见 [sealed worker design](docs/SEALED_WORKER_DESIGN.md)。

同日核心任务增加了受限的冻结上下文：宿主可在仓库策略中用 `contextPaths` 声明精确文件或
目录白名单，任务仅可选择最多 8 个其中的相对文件。正文从任务创建时已固定的 Git 基准读取，
只接受 UTF-8 小文本且拒绝疑似密钥；候选副本在执行器前必须逐文件哈希匹配。任务、状态与事件
只保留清单哈希，原文只在私有数据根的 0600 工件中保存。这不是通用仓库检索，也没有解除 native
live 的阻断。

同日还增加了受限的冻结回归 overlay：宿主在 `regressionOverlays` 中预先把短引用映射到仓库和
`dataRoot` 之外的常规测试文件、一个尚不存在且位于 `protectedPaths` 下的目标、固定验证 profile 与
失败标记；任务只能提交最多 8 个引用，不能提交测试正文、路径、命令或标记。创建时内容被复制进私有
0700/0600 工件，基线必须在失败断言输出中命中每个宿主标记后才能派发写入器。overlay 在整个运行中
按冻结测试保护，且最终 patch 只从 `allowedPaths` 重建索引，不能借 Git index 把 overlay 或其他保护
文件夹带进交付物。它是受限的宿主断言，不是通用测试生成、独立证据或 live 开关；内容锁定的
`pagination-v1` fixture 明确拒绝该配置。

同日还新增了独立的中断任务恢复页。只有 disabled native 策略显式声明
`recoveryControlPlane` 并提供专用 `DSH_DEVKIT_*` 本机密钥时，它才绑定 `127.0.0.1`。经登录的
操作者只能请求恢复一个已中断任务，并且必须明确确认旧写入者已停止；授权绑定 task/run/快照事实，
再经二次检查后才会保留旧副本并排入一个从冻结基准新建的副本。它没有 `dev_task_recover` 工具、不
会释放原地工作区，也不会启动模型或解除 live 阻断。

同日新增的高风险审核裁决页也只在 disabled native 策略显式声明
`findingAdjudicationControlPlane` 并提供独立本机密钥时才启动。它展示经脱敏的 P0/P1 发现摘要，
将操作者选择绑定到 task/run/候选快照/发现指纹；“确认”还要求明确勾选，并且只进入既有的修复、
验证和再次审核循环，“保留给人工”则不会放行任务。它没有 `dev_task_adjudicate` 工具，不能驳回发现
后自动完成任务，也不会启动模型或解除 live 阻断。

## 已实现

TypeScript strict 领域层、严格任务/宿主策略校验、SQLite 事务任务与事件、持久仓库运行锁、任务创建时冻结基准提交、宿主白名单内的冻结上下文与冻结回归 overlay、独立 Git 副本、包含未跟踪文件/二进制/模式的快照、冻结测试与范围检查、真实 Node TAP 验证、独立审核协议、待办去重、共享两次返修预算、补丁产物和宿主人工验收。重启时遗留的运行会变为 `interrupted` 并保留 lease；可选的本机认证恢复页只允许宿主侧、绑定当前快照事实且由操作者明确确认旧写入者已停止的恢复授权，保留旧副本并从冻结基准创建全新候选副本。独立的本机认证裁决页只能确认高风险发现以触发有限返修，或保留给人工，不能作为自动验收或自动驳回通道。

提供 DSH bundle patch、七个工具定义、生命周期关闭入口、官方 `@deepseek-ai/dsh-subagent-codex` 的薄桥接，以及独立的 DeepSeek HTTP 只读审核适配器。Codex 桥接只经 DSH 的 `subagents` 服务委托，不会自行调用 CLI/API；候选会话组成层会从当前工具 Agent 建立谱系、以候选副本的 canonical `cwd` 创建短生命周期父会话，再由底层桥接再次校验目录相等。不能证明子代理或该父会话已退出时会保留写锁。另有 `pagination-v1` 确定性 fixture：它只接受带标记的临时分页仓库、固定 `src/` 写入范围、冻结的 `test/` 与固定 Node TAP 命令，执行器和审核器均为宿主代码，不调用模型。离线 fixture 与独立审核适配器不会使用真实账号或自动接入 live 工作流；唯一的当前登录态调用是上述一次受控临时 fixture。

审核器策略仅保存 HTTPS 端点、模型和以 `DSH_DEVKIT_` 开头的凭据环境变量名；值不写入 JSON，且在 doctor、创建任务或被阻塞的 run 中不会读取。

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
npm run test:seatbelt-host
```

`demo` 只对新建临时仓库工作，作者与审核均为显式 fixture；真实运行 Git、Node 回归测试并输出 patch/report 路径。`npm test` 还会经过真实 Cordis/DSH ToolRuntime 跑完 `pagination-v1` 的 create → run → status → report → cancel/resume 边界，并以真实 AgentLoop/官方 provider 的拒绝式 subprocess seam 覆盖候选会话 cwd 传递；该 seam 不会执行进程。`test:seatbelt-host` 是一项宿主能力门：它要求 Seatbelt 可用，并在临时目录中证明允许候选写入、拒绝控制目录写入和指定凭据目录读取、拒绝回环 TCP 与 Unix socket；同一门还经由伪包路径的 App Server 包装脚本验证真实 `sandbox-exec` 启动封装。在无法嵌套 Seatbelt 的受限环境中，普通 `npm test` 只验证其会 fail-closed。上述自动化命令不会修改此插件仓库或你的业务仓库，不调用付费模型、不推送、不合并。`test:launcher` 是较慢的隔离 DSH profile gate：它不传任务文本，因而不调用模型。`test:codex-provider-profile` 只安装官方 Codex provider 并启动隔离 profile；它不调用 `subagents.start`，因而不会启动 Codex App Server。

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

上面的流程已在本次环境的临时 headless profile 执行。工具包括 `devkit_doctor`、`dev_task_create/run/status/cancel/resume/report`。默认仅任务管理可用，`run` 安全阻塞；普通 `resume` 不能释放中断运行的 lease。可选的 host-secret 恢复页不暴露 `dev_task_recover`，高风险裁决页也不暴露 `dev_task_adjudicate`：前者只会在核验旧写入者停止后排入全新副本，后者只能触发重做或保留人工判断。唯一例外是双重明确开启的 `pagination-v1` 测试 fixture，它不能指定任意仓库、命令或模型；请勿把 `--help` 替换为真实任务文本，除非你已完成独立的模型、执行器与沙箱配置。

请先阅读 [QUICKSTART](docs/QUICKSTART.md)、[SECURITY](docs/SECURITY.md)、[DSH_COMPATIBILITY](docs/DSH_COMPATIBILITY.md) 和 [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md)。

如需只验证官方 Codex provider 是否能被 profile 注册，可另行安装精确版本：

```sh
dsh plugin --profile devkit-eval add @deepseek-ai/dsh-subagent-codex@0.1.6-alpha.2
```

这只增加 host-plane provider，不会开启 DevKit 的 `run`，也不是已验证的沙箱。native `doctor` 会拒绝 full-access、无法核验的 metadata/环境或非空显式 provider 环境；`permissionMode: "never"` 只能被观察。即使 `approve-for-me` 报告 provider-declared workspace-write，它仍会列出凭据 broker 与认证审批桥缺失，并保持 `writerLaunchEligible:false`；这不是 OS 沙箱的替代品。更不要因为 provider 已注册就输入真实任务或凭据。

`skills/bugfix/SKILL.md` 是随包分发的规则；不会因为进入 npm 包就自动被 DSH 发现，应按项目 Skills 规则显式安装到测试项目，不覆盖既有文件。

## 后续重点

候选副本父会话的组成、官方 provider 的 cwd seam、受控协议层取消、声明式 workspace-write 前置条件、一个可复用的 macOS 命令隔离器、受管 App Server 启动封装、native 策略驱动的本地审批/恢复/高风险裁决页面、冻结上下文、崩溃后保留 lease 的恢复内核与一次真实 App Server fixture 已有证据；独立审核器的安全配置路径也已接入但尚未实际调用。账户协议现在有严格的合成实现，但下一步仍是实现并验证全新私有 App Server home 的自管 ChatGPT OAuth（绝不读取或复制现有登录），设计不能被候选命令借用的出站传输边界、完整读白名单或独立执行容器，再将 direct client 接入 native 执行并覆盖真实 App Server 的取消边界与独立审核行为。一次受控运行不能替代可重复的安全验证。UI 修复和需求开发仍是 M4/M5，不在本增量中假装完成。
