# Roomillion Project Documentation

[简体中文](README.md) | English

Roomillion is an offline-first, cross-platform Vibe Coding workbench designed for people who are not programmers. AI can create small applications inside a unified Room specification: common office workflows use stable declarative components, while games and custom interactions use controlled HTML, CSS, and JavaScript. A Harness inspects, tests, and installs generated Rooms.

Installed Rooms appear as cards on the home page. Regular Rooms and the AI Room workspace open as tabs and can be detached into independent windows. Rooms can also be exported and shared; after installing the workbench once, recipients can import the same Room package on a supported platform.

This repository contains the project documentation baseline, a working Windows x64 MVP, and a generic Linux x64 technical preview. They demonstrate the complete workbench → Room package → isolated data → controlled AI generation → offline sharing loop. They do not represent every planned capability or certification for every Linux distribution.

## License

Unless a file or component says otherwise, original project code and documentation are licensed under the [Apache License 2.0](LICENSE). Copyright attribution is “2026 Roomillion Project and Contributors”; see [NOTICE](NOTICE).

Third-party dependencies, fonts, Electron, Git toolchains, and independently licensed modules keep their original licenses. See the [third-party notice entry point](THIRD-PARTY-NOTICES.md), [per-package license index](resources/compliance/THIRD-PARTY-LICENSES.md), and [items requiring review](resources/compliance/LICENSE-REVIEW.md). These records do not claim that all compliance work has been certified as complete.

## Try the MVP

The current Windows development release is **0.3.0-alpha.43**. The generic Linux x64 technical preview remains **0.3.0-alpha.36**. Both are prereleases.

Windows users should normally choose the per-user installer. It does not require administrator privileges and registers the `.room` file association. A portable folder ZIP and a single-file portable executable are also available.

```text
release/Roomillion-0.3.0-alpha.43-Setup.exe
release/Roomillion-0.3.0-alpha.43-Portable-Folder.zip
release/Roomillion-0.3.0-alpha.43-Portable.exe
release/linux/Roomillion-0.3.0-alpha.36-linux-x64.tar.xz
release/linux/Roomillion-0.3.0-alpha.36-x86_64.AppImage
```

Download published binaries from the matching GitHub Release and verify the attached SHA-256 checksum. The source repository excludes the local `release/` directory. Windows artifacts are currently unsigned.

All three Windows distributions are self-contained and do not require Node.js, Git, SQLite, or npm packages on the target computer. The extracted portable ZIP stores rooms and workbench data in `Roomillion-data/` beside the executable by default. The single-file portable executable asks for a storage folder on first launch and creates `Roomillion-data/` there. The installer continues to use the current user's application data directory. You can view or change the location under Settings → Room location; changing it copies data on the next launch and retains the old directory. The room import picker starts in the last successfully used import folder. Copying the single executable alone does not carry rooms to another computer. API keys use system encryption and must be configured again on another computer.

The `.room` format supports application-only exports, application-and-data exports, and optional password protection. Legacy `.zroom` packages can still be imported, while new exports use `.room`.

Run from source:

```powershell
npm ci --cache .npm-cache
npm start
```

## Built-in example Rooms

Roomillion includes exactly six public examples:

| Room | Purpose | Main capabilities |
|---|---|---|
| Inventory Ledger | Inventory records, text import, CSV export, and AI inventory analysis | Private database, files, AI |
| Meeting Action Items | Owners, deadlines, priorities, completion tracking, and AI briefings | Private database, CSV export, AI |
| Offline 3D Crystal Challenge | A complete offline collection game built with Three.js and Rapier | 3D rendering, physics, keyboard and touch |
| AI Debate Arena | Multi-model debate with human participants, an independent judge, and history | Workbench models, database, Markdown export |
| AI Model Capability Benchmark | Text and vision evaluations, custom cases, token statistics, and rankings | Workbench text and vision models, private database |
| Roomillion Browser | Tabs, address search, bookmarks, history, downloads, and site permission prompts | Controlled browser navigation and downloads |

The first five examples have no ordinary internet access. AI-enabled examples can only use models already configured in the workbench through its AI gateway. Roomillion Browser is the explicit exception: it can browse only after the user grants its permissions and enables the global Room networking switch. Web content cannot access the Room SDK, Room databases, or AI keys.

The public repository and release builds contain only these six examples. Unpublished examples are excluded from source and packaging lists. Distribution configuration uses explicit package names and never collects arbitrary `.room` files from the resource directory.

See the [built-in example library](docs/17-内置示例房间库.md) and [controlled browser specification](docs/37-room-browser-v1规范与浏览器房间.md).

## Room modules and packaging

AI can select from 39 pinned, license-inventoried official modules. They cover dates, Office documents, search, charts, Markdown, 3D games, data grids, drag and drop, diagrams, rich text, maps, mathematics, image editing, canvas graphics, and graph visualization.

Official modules are provided offline by the workbench and shared as read-only resources. A Room cannot install npm packages at runtime or load undeclared modules. Dependencies outside the official catalog must include the actual pure-Web assets used by the Room, their exact versions, and licenses under the Room's `embedded/` directory.

See the [official module catalog and AI selection rules](docs/18-官方房间模块目录与AI自动选型.md), [Room dependency packaging policy](docs/19-v1房间依赖打包策略.md), and [extended module implementation record](docs/34-P0-P1-P2扩展模块实施记录.md).

## Platform capabilities for batch AI Rooms

The current development branch adds general-purpose runtime support for batch vision and long-document workflows: model roles and slots, bounded AI batches with retries, multi-file and persistent scoped-directory access, chunked Blobs, artifacts, recoverable jobs, Markdown-to-PDF conversion, sandboxed Web Workers, a per-tool authorized host/plugin bridge, and named credentials whose plaintext is never exposed to Room code. Batch-file and vision Rooms can ship `room-tests.json` scenarios that exercise real UI actions with local mocked AI responses. See the [platform capability record](docs/54-批量AI房间平台能力.md) for the API and security boundaries.

## Validation and builds

```powershell
npm test
npm run smoke
npm run smoke -- --offline-audit
npm run smoke:safe-storage
npm run smoke:mimo-agent

# Official Windows portable release: increment the version, rebuild, and test
npm run release:portable

# Rebuild other artifacts at the current version
npm run build:portable-folder
npm run pilot:kit
npm run verify:linux-toolchain
```

Release rules:

- Use `npm run release:portable` for an official Windows portable build. Do not add temporary labels such as dates, “fixed”, or feature names to artifact filenames.
- Prereleases increment deterministically, for example `0.3.0-alpha.1 → 0.3.0-alpha.2`. Stable releases increment the patch version.
- The portable artifact is always `release/Roomillion-<version>-Portable.exe`. The version is synchronized to `package.json`, `package-lock.json`, the application UI, and the regenerated SBOM.
- `npm run build:portable` rebuilds the current version without incrementing it.
- `npm run build:portable-folder` creates a self-contained folder ZIP at the current version.

For the generic Linux preview:

```sh
sh scripts/linux/prepare-git-toolchain.sh --output .linux-build/git-linux-x64
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --appimage
sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --offline --appimage
sh scripts/linux/verify-pilot.sh release/linux/linux-unpacked/roomillion
```

## Platform status

- **Windows x64:** `0.3.0-alpha.43` development release. Installer, portable folder ZIP, and single-file portable builds are supported.
- **Generic Linux x64:** `0.3.0-alpha.36` technical preview. Automated smoke tests passed on WSL2 Ubuntu 24.04 with an empty PATH and no outbound network attempts. This does not replace validation on a specific UnionTech UOS release with real GPU, Chinese input, drag-and-drop, and native file dialogs.
- **macOS:** no publishable artifact yet. Intel and Apple Silicon Git toolchains, packaging, icons, `.room` document association, signing, and notarization remain to be completed.

## Data migration

Create a Windows-to-Linux migration sample and UOS acceptance kit:

```powershell
npm run migration:create-source
wsl.exe -d Ubuntu -- sh /mnt/d/path/to/roomillion/scripts/linux/build-uos-acceptance-kit.sh
```

After running `sh run-uos-acceptance.sh` on the target UOS computer, copy the result back to Windows and verify it:

```powershell
npm run migration:verify-return -- --input "results\migration-return" --report "results\windows-return-report.json" --label win32-x64
```

See the [MVP operation and acceptance guide](docs/10-MVP运行与验收指南.md) for usage, demonstrations, data locations, and current limitations.

## Documentation and contribution

Start with these documents:

- [Project charter and decisions](docs/00-项目章程与决策摘要.md)
- [Product requirements](docs/01-产品需求文档-PRD.md)
- [Technical architecture](docs/02-总体技术架构.md)
- [Room package and runtime specification](docs/03-房间包与运行时规范.md)
- [Roadmap and milestones](docs/05-实施路线图与里程碑.md)
- [Risk and decision record](docs/07-风险与决策记录.md)
- [Windows MVP operation and acceptance](docs/10-MVP运行与验收指南.md)
- [Windows clean-machine pilot acceptance](docs/14-0.2干净机试点验收手册.md)
- [UOS/Linux x64 validation plan](docs/15-阶段三-UOS-Linux-x64技术验证计划.md)

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). Changes to the Room format, permissions, or SDK should update the specification and tests together. Test data must remain fictional, and real AI API calls require an explicit purpose and usage decision.

The current release still requires Windows clean-machine and internal pilot acceptance, validation against one exact UnionTech UOS x64 release, and completion of the license review items already listed in the repository.
