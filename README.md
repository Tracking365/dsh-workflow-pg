# DSH DevKit

DSH DevKit 是面向 DeepSeek Harness 的研发辅助插件，首版目标是可复现 Bug 的受限修复闭环。当前仓库处于 M0 早期：领域合同和安全门禁已开始实现，真实 DSH 装配尚未接入。

## 开发

```sh
npm install
npm run check
npm test
```

不要把本项目仓库当作业务 Bug 的目标仓库；后续 fixture 应在临时目录生成。默认不 push、merge、deploy。
