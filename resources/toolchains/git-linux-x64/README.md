# Linux x64 Git 工具链占位说明

这个目录是阶段三构建合同的一部分，目前**没有伪装成可用的 Linux Git**。`metadata.json` 的状态为 `awaiting-verified-toolchain`，因此 Linux 构建前置检查会主动失败。

补齐工具链时必须满足：

```text
git-linux-x64/
├─ bin/git
├─ libexec/git-core/
├─ lib/ 或 lib64/（需要随包携带的动态库）
├─ LICENSE.txt
└─ metadata.json
```

`metadata.json` 需要改为 `status: ready`，填写精确版本、来源、`bin/git` 的 SHA-256、许可证相对路径、实际所需文件、链接方式、验证日期和认证系统。

不得从 `/usr/bin/git` 复制一个无法独立运行的文件，也不得让工作台在缺失时退回系统 PATH。动态依赖需要在目标 UOS 基线上审计；只有 libc、图形栈等明确列入系统基线的库可以作为系统依赖。

验证命令：

```bash
npm run verify:linux-toolchain
```

验证通过后才能执行 Linux 目录包、`tar.xz` 或 AppImage 构建。
