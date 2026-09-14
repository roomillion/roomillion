# Windows 安装版文件关联与房间图标

日期：2026-09-12。

## 交付形态

- `Setup.exe`：安装到当前 Windows 用户，不要求管理员权限，创建开始菜单和桌面入口，并为当前用户注册 `.room`。
- `Portable.exe`：单文件便携版，不修改文件关联。
- `Portable-Folder.zip`：目录便携版，不修改文件关联。

安装版采用自定义 NSIS 当前用户注册项 `HKCU\\Software\\Classes`。这是因为 electron-builder 内置 `fileAssociations` 在 Windows NSIS 下要求 `perMachine:true`，会与本项目“不要求管理员权限”的目标冲突。卸载时只在 `.room` 仍由千万间 Roomillion拥有时移除扩展名关联，并移除本项目自己的 ProgID；房间业务数据默认保留。

## 双击 `.room`

1. Windows 把完整文件路径传给工作台。
2. 尚未运行时启动主窗口；已经运行时通过单实例机制唤醒现有窗口。
3. 工作台只接受绝对路径且扩展名为 `.room` 的普通文件。
4. 进入与“导入房间”相同的解密、完整性、版本、依赖、权限和风险预检。
5. 用户确认后才安装并打开，不因双击而绕过授权。

便携版仍可用“导入房间”或拖入文件。安装版是直接打开体验的推荐交付物。

## 房间图标

- Manifest 可选 `icon`，仅允许 `assets/` 下 SVG、PNG、JPEG、WebP；不设人为产品体积上限，仍受包格式的技术性解压边界约束。
- 静态 SVG 会拒绝脚本、事件、外部链接、嵌入页面等活动内容；位图校验扩展名与文件签名。
- 图标文件进入 `integrity.json`，导入、安装、更新、导出时保持在房间程序内。
- 工作台在主页卡片、侧栏、标签栏、标签总览、Agent 成果卡及导入预检中显示图标；加载失败时回退为房间名称首字。
- AI 创建默认按名称与主题生成离线 SVG 图标。用户明确要求最近上传的 PNG/JPEG/WebP 作为图标时，Agent 可将它打包；参考截图不会自动被误用为图标。

## 验证边界

自动测试覆盖命令行路径筛选、单实例入口代码、安装脚本的当前用户注册与带引号参数、图标格式/活动内容拒绝、上传图标打包、旧房间回退以及 Electron 中三处真实图标加载。最终仍应在干净 Windows 用户账户执行安装、双击、升级和卸载的人工验收；当前构建未做代码签名。

## alpha.35 本地交付与验收

- `npm test`：177/177 通过。
- alpha.35 单文件便携成品 `--smoke`：PASS；生成房间的 SVG 图标在主页、侧栏和标签页共 3 个位置加载成功。
- NSIS 安装版、单文件便携版和目录便携版均已构建；安装脚本已通过 NSIS 编译。
- 本地成品见 `release/Roomillion-0.3.0-alpha.35-Setup.exe`、`release/Roomillion-0.3.0-alpha.35-Portable.exe` 和 `release/Roomillion-0.3.0-alpha.35-Portable-Folder.zip`，校验值见同目录 `Roomillion-0.3.0-alpha.35-SHA256SUMS.txt`。
- 两个 EXE 的 Authenticode 状态均为 `NotSigned`。本轮没有静默安装到开发机，也没有以自动测试冒充干净用户账户的安装、双击、升级和卸载验收。
