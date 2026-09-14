# alpha.34 提供商搜索焦点修复

日期：2026-09-12。

## 原因与修改

提供商搜索的 input 处理器每次筛选后调用 setProviderPickerOpen(true)，该函数默认聚焦结果列表的选中项。因此输入第一个字符后焦点离开搜索框，后续文字无法继续输入。

现在区分“更新结果”和“主动进入结果”：搜索更新仅展开列表，不移动焦点和光标；点击提供商选择按钮或在搜索框按下方向键仍可进入结果。中文组词期间的方向键不触发切换。没有修改用户凭据、模型配置或已安装房间。

## 验证

- npm test：174/174 通过。
- 源码 Electron 冒烟通过。
- alpha.34 单文件便携成品 --smoke：退出码 0，报告 PASS。
- 在 Electron 实际渲染进程中派发输入事件，连续输入 kimi，中间插入/删除、无匹配项、清空、粘贴及模拟中文组词共 15 个检查点，焦点与光标位置全部符合预期。
- 筛选 Kimi、无匹配结果、下方向键进入结果、Escape 收起并返回选择按钮均通过。
- 中文组词采用合成事件测试，不替代不同系统输入法的人工实测。测试使用临时业务数据和模拟凭据，未调用真实 AI API。

## 本地交付

- release/Roomillion-0.3.0-alpha.34-Portable.exe
- release/Roomillion-0.3.0-alpha.34-Portable-Folder.zip
- release/Roomillion-0.3.0-alpha.34-Packaged-Smoke.json
- release/Roomillion-0.3.0-alpha.34-SHA256SUMS.txt

关闭旧版本后再打开 alpha.34；已运行的旧进程不会自动加载此修复。本版本未增加签名或完成新的跨平台实机认证。
