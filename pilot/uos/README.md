# 千万间 Roomillion UOS/Linux x64 离线验收包

本验收包用于认证一个**精确版本**的统信 UOS/Linux x64 环境。它不安装系统包、不需要 root，也不会把当前设备自动写入“已认证”列表。

## 使用方法

1. 将整个验收包复制到目标 UOS 设备并解压，不要只复制 AppImage。
2. 断开公网；若需验证内网 AI，可保留到内网服务的连接。
3. 打开终端进入验收包目录，执行：

   ```sh
   sh run-uos-acceptance.sh
   ```

4. 自动部分成功后，会生成一个 `results-日期时间` 目录，其中包含：

   - 匿名系统画像；
   - 目录版和 AppImage 的机器可读离线冒烟报告；
   - Windows→Linux 的迁移报告与回传 `.room/.zdata`；
   - 待填写的人工验收清单。

5. 完成人工清单，把整个结果目录复制回原 Windows 项目，在项目根目录运行：

   ```powershell
   npm run migration:verify-return -- --input "结果目录\migration-return" --report "结果目录\windows-return-report.json" --label win32-x64
   ```

只有自动报告、Windows 回迁报告和人工清单全部通过，且设备画像锁定了 UOS 版本、补丁、桌面和 x86_64 架构后，才能把该精确环境列为“已认证”。

## 说明

- `vectors/windows-source` 是公开测试数据，测试密码固定为 `zhibian-migration-0.1`，不得放入真实业务数据。
- AppImage 若缺少 FUSE 2，会自动临时解包运行；不会添加 `--no-sandbox`。
- 自动验收不会收集主机名、用户名、IP 地址或业务内容。
- 若任一步失败，请保留结果目录和终端日志，不要为了通过测试安装不明依赖或降低沙箱权限。
