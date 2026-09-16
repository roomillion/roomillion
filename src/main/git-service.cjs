"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assertRoomId } = require("./room-store.cjs");
const { keysForPermissions } = require("./permission-service.cjs");
const { packDirectory } = require("./room-package.cjs");
const { createLegacyWindowsGitDescriptor } = require("./platform-runtime.cjs");

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CHECKPOINT_KINDS = new Set(["initial", "install", "generated", "ai-before", "ai-update", "before-restore", "restore", "manual"]);

function safeLabel(value) {
  if (typeof value !== "string") throw new Error("检查点说明无效");
  const label = value.replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, 120);
  if (!label) throw new Error("检查点说明不能为空");
  return label;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class GitService {
  constructor(roomStore, gitToolchain) {
    this.roomStore = roomStore;
    this.gitToolchain = typeof gitToolchain === "string"
      ? createLegacyWindowsGitDescriptor(gitToolchain)
      : gitToolchain;
    if (!this.gitToolchain || typeof this.gitToolchain.executable !== "string") {
      throw new Error("内置 Git 工具链描述无效");
    }
    this.gitExecutable = path.resolve(this.gitToolchain.executable);
    this.toolchainRoot = path.resolve(this.gitToolchain.toolchainRoot);
    this.projectsRoot = path.join(roomStore.dataRoot, "projects");
    this.queues = new Map();
  }

  async init() {
    let stats;
    try {
      stats = await fsp.stat(this.gitExecutable);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`内置 ${this.gitToolchain.displayName} 不完整：缺少 ${this.gitExecutable}`);
      }
      throw error;
    }
    if (!stats.isFile()) throw new Error(`内置 ${this.gitToolchain.displayName} 不完整：缺少 Git 可执行文件`);
    await fsp.mkdir(this.projectsRoot, { recursive: true });
    const version = await this.runExecutable(["--version"], this.projectsRoot);
    if (!/^git version 2\./.test(version.stdout.trim())) throw new Error("内置 Git 版本输出无效");
    this.version = version.stdout.trim();
    return this;
  }

  getProjectRoot(roomId) {
    assertRoomId(roomId);
    return path.join(this.projectsRoot, roomId);
  }

  getWorktreeRoot(roomId) {
    return path.join(this.getProjectRoot(roomId), "worktree");
  }

  getHistoryPath(roomId) {
    return path.join(this.getProjectRoot(roomId), "history.json");
  }

  async enqueue(roomId, operation) {
    assertRoomId(roomId);
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.queues.set(roomId, current.catch(() => {}));
    return current;
  }

  async createEnvironment(projectRoot) {
    const home = path.join(projectRoot, "git-home");
    const temporary = path.join(projectRoot, "tmp");
    await fsp.mkdir(home, { recursive: true });
    await fsp.mkdir(temporary, { recursive: true });
    const environment = {
      PATH: this.gitToolchain.pathEntries.join(this.gitToolchain.pathDelimiter),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.gitToolchain.nullDevice,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_EXEC_PATH: this.gitToolchain.gitExecPath,
      GIT_TEMPLATE_DIR: this.gitToolchain.gitTemplatePath,
      LC_ALL: "C",
      LANG: "C"
    };
    if (this.gitToolchain.platform === "win32") {
      environment.SystemRoot = process.env.SystemRoot;
      environment.WINDIR = process.env.WINDIR;
      environment.COMSPEC = process.env.COMSPEC;
      environment.USERPROFILE = home;
    } else if (this.gitToolchain.libraryPaths?.length) {
      environment.LD_LIBRARY_PATH = this.gitToolchain.libraryPaths.join(this.gitToolchain.pathDelimiter);
    }
    return environment;
  }

  async runExecutable(args, cwd) {
    const projectRoot = cwd.startsWith(this.projectsRoot) ? cwd.split(`${path.sep}worktree`)[0] : this.projectsRoot;
    const env = await this.createEnvironment(projectRoot);
    try {
      return await execFileAsync(this.gitExecutable, args, {
        cwd,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024
      });
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message).trim().slice(0, 1200);
      throw new Error(`内置 Git 操作失败：${detail}`);
    }
  }

  async runGit(roomId, args) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Git 参数无效");
    const common = [
      "-c", `core.hooksPath=${this.gitToolchain.nullDevice}`,
      "-c", "core.symlinks=false",
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "credential.helper=",
      "-c", "diff.external=",
      "-c", "protocol.allow=never",
      "-c", "user.name=千万间 Roomillion",
      "-c", "user.email=workbench@local.invalid"
    ];
    return this.runExecutable([...common, ...args], this.getWorktreeRoot(roomId));
  }

  async ensureRepository(roomId) {
    const worktree = this.getWorktreeRoot(roomId);
    await fsp.mkdir(worktree, { recursive: true });
    try {
      await fsp.access(path.join(worktree, ".git"));
    } catch {
      await this.runGit(roomId, ["init", "--initial-branch=main", "."]);
    }
    return worktree;
  }

  async syncProgramToWorktree(roomId) {
    const worktree = await this.ensureRepository(roomId);
    const programRoot = this.roomStore.getProgramRoot(roomId);
    const entries = await fsp.readdir(worktree, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      await fsp.rm(path.join(worktree, entry.name), { recursive: true, force: true });
    }
    const programEntries = await fsp.readdir(programRoot, { withFileTypes: true });
    for (const entry of programEntries) {
      await fsp.cp(path.join(programRoot, entry.name), path.join(worktree, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
        errorOnExist: false
      });
    }
    return worktree;
  }

  async loadHistory(roomId) {
    assertRoomId(roomId);
    try {
      const parsed = JSON.parse(await fsp.readFile(this.getHistoryPath(roomId), "utf8"));
      if (parsed?.formatVersion !== 1 || !Array.isArray(parsed.checkpoints)) throw new Error("版本历史格式无效");
      return parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { formatVersion: 1, checkpoints: [] };
    }
  }

  async saveHistory(roomId, history) {
    const historyPath = this.getHistoryPath(roomId);
    const temporaryPath = `${historyPath}.tmp`;
    await fsp.mkdir(path.dirname(historyPath), { recursive: true });
    await fsp.writeFile(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await fsp.rename(temporaryPath, historyPath);
  }

  async commitChanges(roomId, label) {
    await this.runGit(roomId, ["add", "--all", "--", "."]);
    await this.runGit(roomId, ["commit", "--allow-empty", "--no-gpg-sign", "-m", safeLabel(label)]);
    const result = await this.runGit(roomId, ["rev-parse", "HEAD"]);
    const commit = result.stdout.trim().toLowerCase();
    if (!COMMIT_PATTERN.test(commit)) throw new Error("Git 返回了无效检查点 ID");
    return commit;
  }

  async readChanges(roomId, commit) {
    const result = await this.runGit(roomId, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", commit]);
    return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200).map((line) => {
      const [status, ...paths] = line.split("\t");
      return { status, paths };
    });
  }

  async captureRoom(roomId, label, { kind = "manual" } = {}) {
    if (!CHECKPOINT_KINDS.has(kind)) throw new Error("检查点类型无效");
    return this.enqueue(roomId, async () => {
      const room = this.roomStore.getRoom(roomId);
      if (!room) throw new Error("房间不存在");
      await this.syncProgramToWorktree(roomId);
      const commit = await this.commitChanges(roomId, label);
      const changes = await this.readChanges(roomId, commit);
      const history = await this.loadHistory(roomId);
      const checkpoint = {
        id: commit,
        shortId: commit.slice(0, 8),
        label: safeLabel(label),
        kind,
        createdAt: new Date().toISOString(),
        room: {
          id: room.id,
          name: room.name,
          version: room.version,
          source: room.source,
          trust: room.trust,
          publisher: clone(room.publisher)
        },
        grantedPermissionKeys: keysForPermissions(room.grantedPermissions),
        changes
      };
      history.checkpoints.unshift(checkpoint);
      await this.saveHistory(roomId, history);
      return clone(checkpoint);
    });
  }

  async listHistory(roomId, limit = 50) {
    if (!this.roomStore.getRoom(roomId)) throw new Error("房间不存在");
    const history = await this.loadHistory(roomId);
    return {
      gitVersion: this.version,
      checkpoints: clone(history.checkpoints.slice(0, Math.max(1, Math.min(100, limit))))
    };
  }

  async initializeExistingRooms() {
    for (const room of this.roomStore.listRooms()) {
      try {
        if (!(await fsp.stat(this.roomStore.getProgramRoot(room.id))).isDirectory()) continue;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const history = await this.loadHistory(room.id);
      if (!history.checkpoints.length) await this.captureRoom(room.id, "建立初始检查点", { kind: "initial" });
    }
  }

  async removeRoom(roomId) {
    assertRoomId(roomId);
    this.queues.delete(roomId);
    await fsp.rm(this.getProjectRoot(roomId), { recursive: true, force: true });
    return true;
  }

  async copyWorktreeToTemporarySource(roomId, destination) {
    const worktree = this.getWorktreeRoot(roomId);
    await fsp.mkdir(destination, { recursive: true });
    const entries = await fsp.readdir(worktree, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      await fsp.cp(path.join(worktree, entry.name), path.join(destination, entry.name), {
        recursive: entry.isDirectory(),
        force: true,
        errorOnExist: false
      });
    }
  }

  async restoreCheckpoint(roomId, checkpointId) {
    assertRoomId(roomId);
    if (typeof checkpointId !== "string" || !COMMIT_PATTERN.test(checkpointId)) throw new Error("检查点 ID 无效");
    return this.enqueue(roomId, async () => {
      const currentRoom = this.roomStore.getRoom(roomId);
      if (!currentRoom) throw new Error("房间不存在");
      const history = await this.loadHistory(roomId);
      const target = history.checkpoints.find((entry) => entry.id === checkpointId);
      if (!target) throw new Error("检查点不属于这个房间");

      await this.syncProgramToWorktree(roomId);
      const beforeCommit = await this.commitChanges(roomId, `恢复前：${target.label}`);
      const beforeChanges = await this.readChanges(roomId, beforeCommit);
      history.checkpoints.unshift({
        id: beforeCommit,
        shortId: beforeCommit.slice(0, 8),
        label: `恢复前：${target.label}`.slice(0, 120),
        kind: "before-restore",
        createdAt: new Date().toISOString(),
        room: {
          id: currentRoom.id,
          name: currentRoom.name,
          version: currentRoom.version,
          source: currentRoom.source,
          trust: currentRoom.trust,
          publisher: clone(currentRoom.publisher)
        },
        grantedPermissionKeys: keysForPermissions(currentRoom.grantedPermissions),
        changes: beforeChanges
      });
      await this.saveHistory(roomId, history);

      const sourceRoot = await fsp.mkdtemp(path.join(this.roomStore.tempRoot, "history-restore-"));
      const packagePath = path.join(this.roomStore.tempRoot, `history-${crypto.randomBytes(8).toString("hex")}.room`);
      try {
        await this.runGit(roomId, ["restore", `--source=${checkpointId}`, "--staged", "--worktree", "--", "."]);
        await this.copyWorktreeToTemporarySource(roomId, sourceRoot);
        const manifest = await packDirectory(sourceRoot, packagePath);
        const currentKeys = keysForPermissions(currentRoom.grantedPermissions);
        const targetKeys = new Set(keysForPermissions(manifest.permissions));
        const selectedKeys = currentKeys.filter((key) => targetKeys.has(key));
        const room = await this.roomStore.installPackage(packagePath, {
          source: currentRoom.source,
          selectedKeys
        });
        await this.syncProgramToWorktree(roomId);
        const restoredCommit = await this.commitChanges(roomId, `恢复到：${target.label}`);
        const changes = await this.readChanges(roomId, restoredCommit);
        const updatedHistory = await this.loadHistory(roomId);
        const restored = {
          id: restoredCommit,
          shortId: restoredCommit.slice(0, 8),
          label: `恢复到：${target.label}`.slice(0, 120),
          kind: "restore",
          createdAt: new Date().toISOString(),
          room: {
            id: room.id,
            name: room.name,
            version: room.version,
            source: room.source,
            trust: room.trust,
            publisher: clone(room.publisher)
          },
          grantedPermissionKeys: keysForPermissions(room.grantedPermissions),
          changes
        };
        updatedHistory.checkpoints.unshift(restored);
        await this.saveHistory(roomId, updatedHistory);
        return { room, checkpoint: clone(restored), restoredFrom: clone(target) };
      } catch (error) {
        await this.syncProgramToWorktree(roomId);
        throw error;
      } finally {
        await fsp.rm(sourceRoot, { recursive: true, force: true });
        await fsp.rm(packagePath, { force: true });
      }
    });
  }
}

module.exports = { COMMIT_PATTERN, GitService, safeLabel };
