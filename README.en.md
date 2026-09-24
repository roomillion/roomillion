# Roomillion

[简体中文](README.md) | English

Roomillion is an offline-first desktop workbench. Its AI can create, revise, install, and share “Rooms”: small applications for office work, documents, data, and interactive tools. Rooms use controlled workbench APIs for files, storage, and AI. They cannot directly read system credentials or arbitrary files.

The current source version is 0.4.0. Windows x64 has an installer and two portable formats; generic Linux x64 is a technical preview. Each platform needs its own workbench build, but compatible .room packages can move between them. There is no publishable macOS build yet. This is still a technical preview, and the Linux build is not certification for any particular UOS release.

## Get started

When release assets are published, download them from the matching GitHub Release and verify the accompanying SHA-256 checksums. GitHub's automatically generated “Source code” archives are not runnable applications. Locally built release/ files are not stored in this repository.

| Platform | Artifact | Intended use |
| --- | --- | --- |
| Windows x64 | Roomillion-0.4.0-Setup.exe | Per-user installation with .room file association |
| Windows x64 | Roomillion-0.4.0-Portable-Folder.zip | Extract and run; data defaults to the extracted folder |
| Windows x64 | Roomillion-0.4.0-Portable.exe | Single-file portable build; data defaults to the user's application-data folder |
| Linux x64 | Roomillion-0.4.0-linux-x64.tar.xz and Roomillion-0.4.0-x86_64.AppImage | Generic technical preview; validate on the target distribution |

Windows binaries are currently unsigned. None of the three Windows formats requires Node.js, Git, SQLite, or npm packages on the target computer.

The extracted portable version stores workbench and Room data in Roomillion-data/ beside the application by default. On first launch, the single-file portable version lets you choose a data location; if you do not, it uses the current user's application-data folder. The installer also uses that folder. You can view or change the location under Settings → Room location. Copying the single executable alone does not carry your Rooms to another computer. For migration, export a Room with “Application + data” and import it on the other computer. API keys are encrypted by the operating system and must be configured again there.

When closing the workbench, you can quit or keep it running in the background. Background mode hides its windows while Rooms and AI tasks continue; the system tray restores the workbench.

To run from source (Node.js 22 or a newer compatible version):

    npm ci --cache .npm-cache
    npm run build:resources
    npm start

## Rooms and AI

The workbench includes eight public example Rooms: Inventory Ledger, Meeting Action Items, Offline 3D Crystal Challenge, AI Debate Arena, AI Model Capability Benchmark, Roomillion Browser, Document Browser & Converter, and Audio Analysis Studio. They demonstrate private data, file import and export, 3D interaction, multiple models, document conversion, audio analysis, and controlled web browsing. Unpublished examples are not included in this repository or its distribution packages.

A Room can be exported as a .room package containing only the application or both the application and its data, with optional password protection. Legacy .zroom packages can still be imported; new exports use .room. Before installation, the workbench shows integrity and permission checks.

AI can choose among 39 pinned official modules. The workbench supplies these modules offline as shared resources; Rooms cannot install npm packages at runtime. A Room that needs Web dependencies outside the catalog must package the actual assets with exact versions and licenses. Rooms call configured generative, Embedding, Rerank, and “Intuition” models through the workbench gateway; Room code never receives their API keys. Batch AI, persistent directory grants, artifacts, and recoverable jobs are available to Rooms.

Ordinary Rooms have no arbitrary network access. Roomillion Browser can visit websites only after the user enables workbench networking and grants its permissions. Web content remains isolated from the Room SDK, private data, and AI keys.

## Platforms and builds

Windows x64 is the primary development and delivery platform. The generic Linux x64 preview can be built and smoke-tested on Ubuntu under WSL, but real GPU behavior, Chinese input, drag and drop, file dialogs, and a specific UOS release still require testing on the target machine. macOS needs its own toolchain, packaging, signing, and notarization work.

Validate the current source:

    npm run build:resources
    npm test
    npm run smoke

On Windows, use npm run build:portable, npm run build:portable-folder, or npm run build:installer to rebuild the current version. npm run release:portable increments the version first, so do not use it merely to rebuild 0.4.0. For Linux x64, prepare a verified Git toolchain on a Linux build host, then run:

    sh scripts/linux/prepare-git-toolchain.sh --output .linux-build/git-linux-x64
    sh scripts/linux/build-generic-preview.sh --toolchain .linux-build/git-linux-x64 --appimage

Linux artifacts are written to release/linux/. A successful build is not UOS certification.

## License and contributing

Original code in this repository is licensed under [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) for attribution. Third-party dependencies, fonts, Electron, Git toolchains, and independently licensed modules retain their own licenses. Review the [third-party notices](THIRD-PARTY-NOTICES.md), [per-package license index](resources/compliance/THIRD-PARTY-LICENSES.md), and [outstanding review items](resources/compliance/LICENSE-REVIEW.md). Some license materials still need review; the project does not claim full compliance certification.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributions, [SECURITY.md](SECURITY.md) for security reports, and [CHANGELOG.md](CHANGELOG.md) for changes. Internal design and acceptance records remain in the local docs/ directory and are not distributed with the public repository.
