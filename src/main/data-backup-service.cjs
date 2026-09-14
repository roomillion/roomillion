"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const yazl = require("yazl");
const { assertRoomId } = require("./room-store.cjs");
const { MAX_PACKAGE_BYTES, MAX_UNPACKED_BYTES, MAX_ENTRIES, extractZip, sha256 } = require("./room-package.cjs");

const scryptAsync = promisify(crypto.scrypt);
const BACKUP_KIND = "zhibian-room-data";
const BACKUP_FORMAT_VERSION = "0.1";
const MAX_DATABASE_BYTES = require("node:buffer").constants.MAX_LENGTH;
const MAX_BACKUP_FILE_BYTES = require("node:buffer").constants.MAX_LENGTH;
const MIN_FREE_SPACE_RESERVE_BYTES = 16 * 1024 * 1024;
const RESTORE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RESTORE_TTL_MS = 15 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const ROOM_TRANSFER_KIND = "zhibian-room-transfer";
const ROOM_TRANSFER_ENCRYPTED_KIND = "zhibian-room-transfer-encrypted";
const ROOM_TRANSFER_FORMAT_VERSION = "0.2";
const ROOM_TRANSFER_EXTENSION = ".room";
const LEGACY_ROOM_TRANSFER_EXTENSION = ".zroom";
const ROOM_TRANSFER_EXTENSIONS = new Set([ROOM_TRANSFER_EXTENSION, LEGACY_ROOM_TRANSFER_EXTENSION]);
const ROOM_TRANSFER_APP_FILE = "room.zroom";
const ROOM_TRANSFER_DATA_FILE = "data.roomdb";
const MAX_ROOM_TRANSFER_ARCHIVE_BYTES = require("node:buffer").constants.MAX_LENGTH;
const MAX_ROOM_TRANSFER_UNPACKED_BYTES = MAX_UNPACKED_BYTES;
const MAX_ROOM_TRANSFER_FILE_BYTES = require("node:buffer").constants.MAX_LENGTH;
const ROOM_TRANSFER_MTIME = new Date("1980-01-01T00:00:00.000Z");

async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function validateBundleFileRecord(record, expectedPath, maximumBytes) {
  if (!record || record.path !== expectedPath) throw new Error(`完整房间包缺少 ${expectedPath}`);
  if (!Number.isInteger(record.bytes) || record.bytes <= 0 || record.bytes > maximumBytes) {
    throw new Error(`完整房间包 ${expectedPath} 大小无效`);
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`完整房间包 ${expectedPath} 哈希无效`);
  }
  return { path: expectedPath, bytes: record.bytes, sha256: record.sha256 };
}

function validateRoomRecord(input, label = "房间") {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label}信息无效`);
  assertRoomId(input.id);
  if (typeof input.name !== "string" || !input.name || input.name.length > 80) throw new Error(`${label}名称无效`);
  if (typeof input.version !== "string" || !input.version || input.version.length > 80) throw new Error(`${label}版本无效`);
  return { id: input.id, name: input.name, version: input.version };
}

function validateTransferManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("房间传输清单无效");
  if (input.kind !== ROOM_TRANSFER_KIND || input.formatVersion !== ROOM_TRANSFER_FORMAT_VERSION) {
    throw new Error("不支持的房间传输格式版本");
  }
  if (!["app-only", "app-and-data"].includes(input.contents)) throw new Error("房间传输内容类型无效");
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("房间传输创建时间无效");
  const result = {
    kind: ROOM_TRANSFER_KIND,
    formatVersion: ROOM_TRANSFER_FORMAT_VERSION,
    contents: input.contents,
    room: validateRoomRecord(input.room, "房间传输"),
    createdAt: new Date(input.createdAt).toISOString(),
    app: validateBundleFileRecord(input.app, ROOM_TRANSFER_APP_FILE, MAX_PACKAGE_BYTES),
    data: null
  };
  if (input.contents === "app-and-data") {
    result.data = validateBundleFileRecord(input.data, ROOM_TRANSFER_DATA_FILE, MAX_DATABASE_BYTES);
  } else if (input.data !== undefined && input.data !== null) {
    throw new Error("仅应用房间包不得包含数据记录");
  }
  return result;
}

async function getAvailableDiskBytes(directory) {
  const stats = await fsp.statfs(directory, { bigint: true });
  return stats.bavail * stats.bsize;
}

function normalizeAvailableBytes(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.floor(value));
  throw new Error("无法读取磁盘可用空间");
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new Error("备份密码必须是 8-128 个字符");
  }
  return password;
}

function normalizeOptionalPassword(password) {
  if (password === undefined || password === null || password === "") return null;
  return validatePassword(password);
}

function parseBase64(value, field, maxBytes = MAX_BACKUP_FILE_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    throw new Error(`${field} 格式无效`);
  }
  if (value.length % 4 !== 0) throw new Error(`${field} 格式无效`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  if (!end) throw new Error(`${field} 格式无效`);
  for (let offset = 0; offset < end; offset += 65536) {
    if (/[^A-Za-z0-9+/]/.test(value.slice(offset, Math.min(end, offset + 65536)))) throw new Error(`${field} 格式无效`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length > maxBytes) throw new Error(`${field} 超过大小限制`);
  return buffer;
}

// Avoid constructing a second giant JSON string for an already-base64 payload.
function envelopeParts(envelope) {
  const { payload, ...header } = envelope;
  const prefix = JSON.stringify(header).slice(0, -1) + ',"payload":"';
  const suffix = '"}\n';
  return { prefix, payload, suffix, bytes: Buffer.byteLength(prefix) + payload.length + Buffer.byteLength(suffix) };
}
async function writeEnvelope(filePath, parts) {
  const file = await fsp.open(filePath, "wx");
  try {
    await file.writeFile(parts.prefix, "utf8");
    for (let offset = 0; offset < parts.payload.length; offset += 65536) await file.writeFile(parts.payload.slice(offset, offset + 65536), "utf8");
    await file.writeFile(parts.suffix, "utf8");
  } finally { await file.close(); }
}

function validateEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("数据备份格式无效");
  if (input.kind !== BACKUP_KIND || input.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error("不支持的数据备份格式版本");
  }
  if (!input.room || typeof input.room !== "object") throw new Error("数据备份缺少房间信息");
  assertRoomId(input.room.id);
  if (typeof input.room.name !== "string" || !input.room.name || input.room.name.length > 80) throw new Error("数据备份房间名称无效");
  if (typeof input.room.version !== "string" || !input.room.version || input.room.version.length > 80) throw new Error("数据备份房间版本无效");
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("数据备份时间无效");
  const encryption = input.encryption;
  if (!encryption || encryption.kdf !== "scrypt" || encryption.cipher !== "aes-256-gcm") {
    throw new Error("数据备份加密参数无效");
  }
  if (encryption.N !== SCRYPT_OPTIONS.N || encryption.r !== SCRYPT_OPTIONS.r || encryption.p !== SCRYPT_OPTIONS.p) {
    throw new Error("数据备份密钥派生参数不受支持");
  }
  const salt = parseBase64(encryption.salt, "salt", 64);
  const iv = parseBase64(encryption.iv, "iv", 32);
  const tag = parseBase64(encryption.tag, "tag", 32);
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error("数据备份加密参数长度无效");
  const ciphertext = parseBase64(input.payload, "payload", MAX_BACKUP_FILE_BYTES);
  return {
    kind: input.kind,
    formatVersion: input.formatVersion,
    room: { id: input.room.id, name: input.room.name, version: input.room.version },
    createdAt: new Date(input.createdAt).toISOString(),
    encryption: {
      kdf: encryption.kdf,
      cipher: encryption.cipher,
      N: encryption.N,
      r: encryption.r,
      p: encryption.p,
      salt: encryption.salt,
      iv: encryption.iv,
      tag: encryption.tag
    },
    payload: input.payload,
    _buffers: { salt, iv, tag, ciphertext }
  };
}

function aadForEnvelope(envelope) {
  return Buffer.from(JSON.stringify({
    kind: envelope.kind,
    formatVersion: envelope.formatVersion,
    room: envelope.room,
    createdAt: envelope.createdAt,
    encryption: {
      kdf: envelope.encryption.kdf,
      cipher: envelope.encryption.cipher,
      N: envelope.encryption.N,
      r: envelope.encryption.r,
      p: envelope.encryption.p,
      salt: envelope.encryption.salt,
      iv: envelope.encryption.iv
    }
  }), "utf8");
}

async function deriveKey(password, salt) {
  return scryptAsync(password, salt, 32, SCRYPT_OPTIONS);
}

async function encryptPayload({ room, databaseBuffer, password, createdAt = new Date().toISOString() }) {
  validatePassword(password);
  if (!Buffer.isBuffer(databaseBuffer) || databaseBuffer.length === 0 || databaseBuffer.length > MAX_DATABASE_BYTES) {
    throw new Error("房间数据库为空或超过当前运行时可寻址范围");
  }
  const payloadHeader = JSON.stringify({
    formatVersion: BACKUP_FORMAT_VERSION,
    room: { id: room.id, version: room.version },
    database: {
      encoding: "base64",
      bytes: databaseBuffer.length,
      sha256: sha256(databaseBuffer)
    }
  }).slice(0, -2) + ',"data":"';
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const envelope = {
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    room: { id: room.id, name: room.name, version: room.version },
    createdAt: new Date(createdAt).toISOString(),
    encryption: {
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      salt: salt.toString("base64"),
      iv: iv.toString("base64")
    }
  };
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadForEnvelope(envelope));
  const encrypted = [cipher.update(payloadHeader, "utf8")];
  for (let offset = 0; offset < databaseBuffer.length; offset += 49152) encrypted.push(cipher.update(databaseBuffer.subarray(offset, offset + 49152).toString("base64"), "utf8"));
  encrypted.push(cipher.update('"}}', "utf8"), cipher.final());
  const ciphertext = Buffer.concat(encrypted);
  envelope.encryption.tag = cipher.getAuthTag().toString("base64");
  envelope.payload = ciphertext.toString("base64");
  return envelope;
}

async function decryptPayload(envelopeInput, password) {
  validatePassword(password);
  const envelope = validateEnvelope(envelopeInput);
  try {
    const key = await deriveKey(password, envelope._buffers.salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope._buffers.iv);
    decipher.setAAD(aadForEnvelope(envelope));
    decipher.setAuthTag(envelope._buffers.tag);
    const plaintext = Buffer.concat([decipher.update(envelope._buffers.ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (parsed?.formatVersion !== BACKUP_FORMAT_VERSION || parsed?.room?.id !== envelope.room.id) {
      throw new Error("备份内部房间信息不一致");
    }
    if (!parsed.database || parsed.database.encoding !== "base64") throw new Error("备份缺少数据库");
    const databaseBuffer = parseBase64(parsed.database.data, "database.data", MAX_DATABASE_BYTES);
    if (databaseBuffer.length !== parsed.database.bytes || sha256(databaseBuffer) !== parsed.database.sha256) {
      throw new Error("数据库完整性校验失败");
    }
    return { envelope, databaseBuffer };
  } catch {
    throw new Error("备份密码错误或文件已损坏");
  }
}

function aadForTransferEnvelope(envelope) {
  return Buffer.from(JSON.stringify({
    kind: envelope.kind,
    formatVersion: envelope.formatVersion,
    contents: envelope.contents,
    room: envelope.room,
    createdAt: envelope.createdAt,
    encryption: {
      kdf: envelope.encryption.kdf,
      cipher: envelope.encryption.cipher,
      N: envelope.encryption.N,
      r: envelope.encryption.r,
      p: envelope.encryption.p,
      salt: envelope.encryption.salt,
      iv: envelope.encryption.iv
    }
  }), "utf8");
}

function validateEncryptedTransferEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("加密房间包格式无效");
  if (input.kind !== ROOM_TRANSFER_ENCRYPTED_KIND || input.formatVersion !== ROOM_TRANSFER_FORMAT_VERSION) {
    throw new Error("不支持的加密房间包格式版本");
  }
  if (!["app-only", "app-and-data"].includes(input.contents)) throw new Error("加密房间包内容类型无效");
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("加密房间包创建时间无效");
  const encryption = input.encryption;
  if (!encryption || encryption.kdf !== "scrypt" || encryption.cipher !== "aes-256-gcm") {
    throw new Error("加密房间包参数无效");
  }
  if (encryption.N !== SCRYPT_OPTIONS.N || encryption.r !== SCRYPT_OPTIONS.r || encryption.p !== SCRYPT_OPTIONS.p) {
    throw new Error("加密房间包密钥派生参数不受支持");
  }
  const salt = parseBase64(encryption.salt, "salt", 64);
  const iv = parseBase64(encryption.iv, "iv", 32);
  const tag = parseBase64(encryption.tag, "tag", 32);
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error("加密房间包参数长度无效");
  const ciphertext = parseBase64(input.payload, "payload", MAX_ROOM_TRANSFER_ARCHIVE_BYTES);
  return {
    kind: ROOM_TRANSFER_ENCRYPTED_KIND,
    formatVersion: ROOM_TRANSFER_FORMAT_VERSION,
    contents: input.contents,
    room: validateRoomRecord(input.room, "加密房间包"),
    createdAt: new Date(input.createdAt).toISOString(),
    encryption: {
      kdf: encryption.kdf,
      cipher: encryption.cipher,
      N: encryption.N,
      r: encryption.r,
      p: encryption.p,
      salt: encryption.salt,
      iv: encryption.iv,
      tag: encryption.tag
    },
    payload: input.payload,
    _buffers: { salt, iv, tag, ciphertext }
  };
}

async function encryptTransferArchive({ room, contents, archiveBuffer, password, createdAt = new Date().toISOString() }) {
  validatePassword(password);
  if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length === 0 || archiveBuffer.length > MAX_ROOM_TRANSFER_ARCHIVE_BYTES) {
    throw new Error("房间传输载荷为空或超过大小限制");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const envelope = {
    kind: ROOM_TRANSFER_ENCRYPTED_KIND,
    formatVersion: ROOM_TRANSFER_FORMAT_VERSION,
    contents,
    room: validateRoomRecord(room),
    createdAt: new Date(createdAt).toISOString(),
    encryption: {
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      salt: salt.toString("base64"),
      iv: iv.toString("base64")
    }
  };
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadForTransferEnvelope(envelope));
  const ciphertext = Buffer.concat([cipher.update(archiveBuffer), cipher.final()]);
  envelope.encryption.tag = cipher.getAuthTag().toString("base64");
  envelope.payload = ciphertext.toString("base64");
  return envelope;
}

async function decryptTransferArchive(envelopeInput, password) {
  validatePassword(password);
  const envelope = validateEncryptedTransferEnvelope(envelopeInput);
  try {
    const key = await deriveKey(password, envelope._buffers.salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope._buffers.iv);
    decipher.setAAD(aadForTransferEnvelope(envelope));
    decipher.setAuthTag(envelope._buffers.tag);
    return Buffer.concat([decipher.update(envelope._buffers.ciphertext), decipher.final()]);
  } catch {
    throw new Error("房间包密码错误或文件已损坏");
  }
}

class DataBackupService {
  constructor(roomStore, database, options = {}) {
    this.roomStore = roomStore;
    this.database = database;
    this.backupsRoot = path.join(roomStore.dataRoot, "backups");
    this.pendingRestores = new Map();
    this.pendingRoomBundles = new Map();
    this.pendingEncryptedTransfers = new Map();
    this.getAvailableBytes = options.getAvailableBytes ?? getAvailableDiskBytes;
    this.freeSpaceReserveBytes = options.freeSpaceReserveBytes ?? MIN_FREE_SPACE_RESERVE_BYTES;
  }

  async init() {
    await fsp.mkdir(this.backupsRoot, { recursive: true });
    return this;
  }

  async assertSufficientDiskSpace(directory, writeBytes) {
    const required = BigInt(Math.max(0, Math.ceil(writeBytes))) + BigInt(this.freeSpaceReserveBytes);
    const available = normalizeAvailableBytes(await this.getAvailableBytes(directory));
    if (available < required) {
      const requiredMiB = Number(required / (1024n * 1024n));
      const availableMiB = Number(available / (1024n * 1024n));
      throw new Error(`磁盘可用空间不足：至少需要 ${requiredMiB} MiB，当前约 ${availableMiB} MiB`);
    }
    return { requiredBytes: required, availableBytes: available };
  }

  async createBackup(roomId, password, destinationPath) {
    assertRoomId(roomId);
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    validatePassword(password);
    const databaseBuffer = await this.database.exportSnapshot(roomId);
    const envelope = await encryptPayload({ room, databaseBuffer, password });
    const parts = envelopeParts(envelope);
    if (parts.bytes > MAX_BACKUP_FILE_BYTES) throw new Error("数据备份超过当前运行时可寻址范围");
    const temporaryPath = `${destinationPath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await this.assertSufficientDiskSpace(path.dirname(destinationPath), parts.bytes);
    try {
      await writeEnvelope(temporaryPath, parts);
      await fsp.rm(destinationPath, { force: true });
      await fsp.rename(temporaryPath, destinationPath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true });
      throw error;
    }
    return { roomId, bytes: parts.bytes, createdAt: envelope.createdAt };
  }

  async buildRoomTransferArchive(room, includeData, archivePath, stagingRoot, { allowAiModification } = {}) {
    const appPath = path.join(stagingRoot, ROOM_TRANSFER_APP_FILE);
    await this.roomStore.exportRoom(room.id, appPath, { allowAiModification });
    const appStats = await fsp.stat(appPath);
    const appSha256 = await sha256File(appPath);
    let databaseBuffer = null;
    if (includeData) {
      databaseBuffer = await this.database.exportSnapshot(room.id);
      if (!databaseBuffer.length || databaseBuffer.length > MAX_DATABASE_BYTES) {
        throw new Error("房间数据库为空或超过当前运行时可寻址范围");
      }
      await this.database.validateSnapshot(databaseBuffer);
    }
    const createdAt = new Date().toISOString();
    const manifest = {
      kind: ROOM_TRANSFER_KIND,
      formatVersion: ROOM_TRANSFER_FORMAT_VERSION,
      contents: includeData ? "app-and-data" : "app-only",
      room: { id: room.id, name: room.name, version: room.version },
      createdAt,
      app: { path: ROOM_TRANSFER_APP_FILE, bytes: appStats.size, sha256: appSha256 },
      data: includeData ? {
        path: ROOM_TRANSFER_DATA_FILE,
        bytes: databaseBuffer.length,
        sha256: sha256(databaseBuffer)
      } : null
    };
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const zipFile = new yazl.ZipFile();
    const completed = pipeline(zipFile.outputStream, fs.createWriteStream(archivePath, { flags: "wx" }));
    zipFile.addBuffer(manifestBuffer, "bundle.json", { mtime: ROOM_TRANSFER_MTIME, mode: 0o100644 });
    zipFile.addFile(appPath, ROOM_TRANSFER_APP_FILE, { mtime: ROOM_TRANSFER_MTIME, mode: 0o100644, compress: false });
    if (databaseBuffer) {
      zipFile.addBuffer(databaseBuffer, ROOM_TRANSFER_DATA_FILE, { mtime: ROOM_TRANSFER_MTIME, mode: 0o100644, compress: false });
    }
    zipFile.end();
    await completed;
    const stats = await fsp.stat(archivePath);
    if (stats.size > MAX_ROOM_TRANSFER_ARCHIVE_BYTES) throw new Error("房间传输包超过当前运行时可寻址范围");
    return { manifest, appBytes: appStats.size, dataBytes: databaseBuffer?.length ?? 0, archiveBytes: stats.size };
  }

  async createRoomTransfer(roomId, { includeData = false, password = "", allowAiModification } = {}, destinationPath) {
    assertRoomId(roomId);
    const room = this.roomStore.getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    if (typeof includeData !== "boolean") throw new Error("房间导出内容选项无效");
    if (allowAiModification !== undefined && typeof allowAiModification !== "boolean") throw new Error("房间导出分享选项无效");
    const normalizedPassword = normalizeOptionalPassword(password);
    if (typeof destinationPath !== "string" || path.extname(destinationPath).toLowerCase() !== ROOM_TRANSFER_EXTENSION) {
      throw new Error(`房间包必须使用 ${ROOM_TRANSFER_EXTENSION} 扩展名`);
    }
    if (!includeData && !normalizedPassword) {
      const exportedPath = await this.roomStore.exportRoom(roomId, destinationPath, { allowAiModification });
      const stats = await fsp.stat(exportedPath);
      return {
        roomId,
        mode: "app-only",
        protected: false,
        path: exportedPath,
        bytes: stats.size,
        appBytes: stats.size,
        dataBytes: 0,
        createdAt: new Date().toISOString()
      };
    }

    const stagingRoot = await fsp.mkdtemp(path.join(this.roomStore.tempRoot, "room-transfer-export-"));
    const archivePath = path.join(stagingRoot, "transfer.zip");
    const destinationDirectory = path.dirname(destinationPath);
    const temporaryPath = path.join(destinationDirectory, `.${path.basename(destinationPath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
    try {
      const built = await this.buildRoomTransferArchive(room, includeData, archivePath, stagingRoot, { allowAiModification });
      await fsp.mkdir(destinationDirectory, { recursive: true });
      let outputBytes;
      if (normalizedPassword) {
        const archiveBuffer = await fsp.readFile(archivePath);
        const envelope = await encryptTransferArchive({
          room,
          contents: built.manifest.contents,
          archiveBuffer,
          password: normalizedPassword,
          createdAt: built.manifest.createdAt
        });
        const parts = envelopeParts(envelope);
        if (parts.bytes > MAX_ROOM_TRANSFER_FILE_BYTES) throw new Error("加密房间包超过当前运行时可寻址范围");
        await this.assertSufficientDiskSpace(destinationDirectory, parts.bytes);
        await writeEnvelope(temporaryPath, parts);
        outputBytes = parts.bytes;
      } else {
        await this.assertSufficientDiskSpace(destinationDirectory, built.archiveBytes);
        await fsp.copyFile(archivePath, temporaryPath, fs.constants.COPYFILE_EXCL);
        outputBytes = built.archiveBytes;
      }
      await fsp.rm(destinationPath, { force: true });
      await fsp.rename(temporaryPath, destinationPath);
      return {
        roomId,
        mode: built.manifest.contents,
        protected: Boolean(normalizedPassword),
        path: destinationPath,
        bytes: outputBytes,
        appBytes: built.appBytes,
        dataBytes: built.dataBytes,
        createdAt: built.manifest.createdAt
      };
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async inspectZipRoomTransfer(filePath, { source = "external", protected: isProtected = false, outerBytes = null, expected = null } = {}) {
    const stagingPath = await fsp.mkdtemp(path.join(this.roomStore.tempRoot, "room-transfer-import-"));
    let roomInspection;
    try {
      const archive = await extractZip(filePath, stagingPath, {
        packageLabel: "房间包",
        maxPackageBytes: MAX_ROOM_TRANSFER_ARCHIVE_BYTES,
        maxUnpackedBytes: MAX_ROOM_TRANSFER_UNPACKED_BYTES,
        maxEntryBytes: MAX_DATABASE_BYTES,
        maxEntries: MAX_ENTRIES
      });
      const bundlePath = path.join(stagingPath, "bundle.json");
      const hasBundle = await fsp.stat(bundlePath).then((stats) => stats.isFile(), () => false);
      const hasClassicManifest = await fsp.stat(path.join(stagingPath, "manifest.json")).then((stats) => stats.isFile(), () => false);
      if (hasClassicManifest) {
        if (expected) throw new Error("加密房间包内部不是受支持的传输容器");
        await fsp.rm(stagingPath, { recursive: true, force: true });
        return this.roomStore.inspectPackage(filePath, { source });
      }
      if (!hasBundle) {
        if (expected) throw new Error("加密房间包内部缺少传输清单");
        await fsp.rm(stagingPath, { recursive: true, force: true });
        return this.roomStore.inspectPackage(filePath, { source });
      }
      const manifest = validateTransferManifest(JSON.parse(await fsp.readFile(bundlePath, "utf8")));
      if (expected && (
        manifest.contents !== expected.contents ||
        manifest.room.id !== expected.room.id ||
        manifest.room.name !== expected.room.name ||
        manifest.room.version !== expected.room.version
      )) throw new Error("加密房间包外层信息与内部清单不一致");
      const expectedFiles = ["bundle.json", ROOM_TRANSFER_APP_FILE, ...(manifest.data ? [ROOM_TRANSFER_DATA_FILE] : [])].sort();
      const entries = await fsp.readdir(stagingPath, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).sort();
      if (entries.some((entry) => !entry.isFile()) || names.join("|") !== expectedFiles.join("|")) {
        throw new Error("房间传输包包含清单之外的文件");
      }
      const appPath = path.join(stagingPath, ROOM_TRANSFER_APP_FILE);
      const appStats = await fsp.stat(appPath);
      if (appStats.size !== manifest.app.bytes || await sha256File(appPath) !== manifest.app.sha256) {
        throw new Error("房间传输包中的应用完整性校验失败");
      }
      let dataPath = null;
      if (manifest.data) {
        dataPath = path.join(stagingPath, ROOM_TRANSFER_DATA_FILE);
        const databaseBuffer = await fsp.readFile(dataPath);
        if (databaseBuffer.length !== manifest.data.bytes || sha256(databaseBuffer) !== manifest.data.sha256) {
          throw new Error("房间传输包中的数据完整性校验失败");
        }
        await this.database.validateSnapshot(databaseBuffer);
      }
      roomInspection = await this.roomStore.inspectPackage(appPath, { source });
      if (
        roomInspection.room.id !== manifest.room.id ||
        roomInspection.room.name !== manifest.room.name ||
        roomInspection.room.version !== manifest.room.version
      ) throw new Error("房间传输清单与应用不匹配");
      this.pendingRoomBundles.set(roomInspection.token, {
        kind: "transfer",
        stagingPath,
        dataPath,
        dataRecord: manifest.data,
        protected: isProtected,
        createdAtMs: Date.now()
      });
      return {
        ...roomInspection,
        transfer: {
          kind: manifest.contents,
          formatVersion: manifest.formatVersion,
          bytes: outerBytes ?? archive.packageBytes,
          createdAt: manifest.createdAt,
          protected: isProtected,
          encryption: isProtected ? "scrypt + aes-256-gcm" : "none",
          data: manifest.data ? {
            encrypted: isProtected,
            encryption: isProtected ? "scrypt + aes-256-gcm" : "none",
            bytes: manifest.data.bytes
          } : null
        }
      };
    } catch (error) {
      if (roomInspection?.token) await this.roomStore.cancelImport(roomInspection.token);
      await fsp.rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async inspectRoomTransfer(filePath, { source = "external" } = {}) {
    await this.discardExpiredRoomBundles();
    const extension = typeof filePath === "string" ? path.extname(filePath).toLowerCase() : "";
    if (!ROOM_TRANSFER_EXTENSIONS.has(extension)) throw new Error("房间包必须使用 .room 扩展名（兼容旧版 .zroom）");
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) throw new Error("房间包不是普通文件");
    if (stats.size > MAX_ROOM_TRANSFER_FILE_BYTES) throw new Error("房间包超过当前运行时可寻址范围");
    const handle = await fsp.open(filePath, "r");
    const signature = Buffer.alloc(4);
    try { await handle.read(signature, 0, signature.length, 0); } finally { await handle.close(); }
    if (signature[0] === 0x50 && signature[1] === 0x4b) {
      return this.inspectZipRoomTransfer(filePath, { source });
    }
    let envelope;
    try {
      envelope = validateEncryptedTransferEnvelope(JSON.parse(await fsp.readFile(filePath, "utf8")));
    } catch (error) {
      throw new Error(`无法识别房间包：${error.message}`);
    }
    const token = crypto.randomBytes(16).toString("hex");
    this.pendingEncryptedTransfers.set(token, { envelope, source, fileBytes: stats.size, createdAtMs: Date.now() });
    return {
      locked: true,
      token,
      source,
      room: envelope.room,
      transfer: {
        kind: envelope.contents,
        formatVersion: envelope.formatVersion,
        bytes: stats.size,
        createdAt: envelope.createdAt,
        protected: true,
        encryption: "scrypt + aes-256-gcm",
        data: envelope.contents === "app-and-data" ? { encrypted: true } : null
      }
    };
  }

  async unlockRoomTransfer(token, password) {
    if (typeof token !== "string" || !RESTORE_TOKEN_PATTERN.test(token)) throw new Error("房间包解锁令牌无效");
    const pending = this.pendingEncryptedTransfers.get(token);
    if (!pending) throw new Error("房间包解锁请求已过期，请重新选择文件");
    const archiveBuffer = await decryptTransferArchive(pending.envelope, password);
    const stagingRoot = await fsp.mkdtemp(path.join(this.roomStore.tempRoot, "room-transfer-unlock-"));
    const archivePath = path.join(stagingRoot, "unlocked.room");
    try {
      await fsp.writeFile(archivePath, archiveBuffer, { flag: "wx" });
      const inspection = await this.inspectZipRoomTransfer(archivePath, {
        source: pending.source,
        protected: true,
        outerBytes: pending.fileBytes,
        expected: pending.envelope
      });
      this.pendingEncryptedTransfers.delete(token);
      return inspection;
    } finally {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async discardExpiredRoomBundles() {
    const now = Date.now();
    for (const [token, pending] of this.pendingRoomBundles) {
      if (now - pending.createdAtMs <= RESTORE_TTL_MS) continue;
      this.pendingRoomBundles.delete(token);
      await fsp.rm(pending.stagingPath, { recursive: true, force: true });
    }
    for (const [token, pending] of this.pendingEncryptedTransfers) {
      if (now - pending.createdAtMs <= RESTORE_TTL_MS) continue;
      this.pendingEncryptedTransfers.delete(token);
    }
  }

  async cancelRoomBundle(importToken) {
    if (this.pendingEncryptedTransfers.delete(importToken)) return true;
    const pending = this.pendingRoomBundles.get(importToken);
    if (!pending) return false;
    this.pendingRoomBundles.delete(importToken);
    await fsp.rm(pending.stagingPath, { recursive: true, force: true });
    return true;
  }

  async restorePlainSnapshot(roomId, databaseBuffer) {
    assertRoomId(roomId);
    await this.database.validateSnapshot(databaseBuffer);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryDirectory = path.join(this.backupsRoot, roomId);
    await fsp.mkdir(recoveryDirectory, { recursive: true });
    const currentDatabasePath = path.join(this.roomStore.getDataRoot(roomId), "room.db");
    const currentDatabaseBytes = await fsp.stat(currentDatabasePath).then((stats) => stats.size, (error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    await this.assertSufficientDiskSpace(recoveryDirectory, databaseBuffer.length + currentDatabaseBytes);
    const backupPath = path.join(recoveryDirectory, `${timestamp}-pre-restore.room.db`);
    const result = await this.database.replaceSnapshot(roomId, databaseBuffer, backupPath);
    await this.pruneRecoveryPoints(roomId);
    return { roomId, backupCreated: result.backupCreated };
  }

  async completeRoomTransferImport(importToken, expectedRoomId) {
    const pending = this.pendingRoomBundles.get(importToken);
    if (!pending) return null;
    try {
      if (!pending.dataPath) return { kind: "app-only", protected: pending.protected };
      const databaseBuffer = await fsp.readFile(pending.dataPath);
      if (
        databaseBuffer.length !== pending.dataRecord.bytes ||
        sha256(databaseBuffer) !== pending.dataRecord.sha256
      ) throw new Error("随包数据在安装前发生变化");
      const restored = await this.restorePlainSnapshot(expectedRoomId, databaseBuffer);
      return { kind: "data-restored", protected: pending.protected, ...restored };
    } finally {
      this.pendingRoomBundles.delete(importToken);
      await fsp.rm(pending.stagingPath, { recursive: true, force: true });
    }
  }

  async discardExpiredRestores() {
    const now = Date.now();
    for (const [token, pending] of this.pendingRestores) {
      if (now - pending.createdAtMs > RESTORE_TTL_MS) this.pendingRestores.delete(token);
    }
  }

  async inspectBackup(filePath, expectedRoomId) {
    assertRoomId(expectedRoomId);
    await this.discardExpiredRestores();
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) throw new Error("数据备份不是普通文件");
    if (stats.size > MAX_BACKUP_FILE_BYTES) throw new Error("数据备份超过当前运行时可寻址范围");
    const envelope = validateEnvelope(JSON.parse(await fsp.readFile(filePath, "utf8")));
    if (envelope.room.id !== expectedRoomId) {
      throw new Error(`该备份属于房间 ${envelope.room.id}，不能恢复到当前房间`);
    }
    if (!this.roomStore.getRoom(envelope.room.id)) throw new Error("请先安装对应房间，再恢复数据");
    const token = crypto.randomBytes(16).toString("hex");
    this.pendingRestores.set(token, { envelope, createdAtMs: Date.now(), fileBytes: stats.size });
    return {
      token,
      room: envelope.room,
      createdAt: envelope.createdAt,
      bytes: stats.size,
      encrypted: true
    };
  }

  cancelRestore(token) {
    if (typeof token !== "string" || !RESTORE_TOKEN_PATTERN.test(token)) return false;
    return this.pendingRestores.delete(token);
  }

  async restoreBackup(token, password) {
    if (typeof token !== "string" || !RESTORE_TOKEN_PATTERN.test(token)) throw new Error("恢复确认令牌无效");
    const pending = this.pendingRestores.get(token);
    if (!pending) throw new Error("恢复预检已过期，请重新选择数据备份");
    const { envelope, databaseBuffer } = await decryptPayload(pending.envelope, password);
    await this.database.validateSnapshot(databaseBuffer);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryDirectory = path.join(this.backupsRoot, envelope.room.id);
    await fsp.mkdir(recoveryDirectory, { recursive: true });
    const currentDatabasePath = path.join(this.roomStore.getDataRoot(envelope.room.id), "room.db");
    const currentDatabaseBytes = await fsp.stat(currentDatabasePath).then((stats) => stats.size, (error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    await this.assertSufficientDiskSpace(recoveryDirectory, databaseBuffer.length + currentDatabaseBytes);
    const backupPath = path.join(recoveryDirectory, `${timestamp}-pre-restore.room.db`);
    const result = await this.database.replaceSnapshot(envelope.room.id, databaseBuffer, backupPath);
    this.pendingRestores.delete(token);
    await this.pruneRecoveryPoints(envelope.room.id);
    return {
      roomId: envelope.room.id,
      sourceCreatedAt: envelope.createdAt,
      backupCreated: result.backupCreated
    };
  }

  async listRecoveryPoints(roomId) {
    assertRoomId(roomId);
    const directory = path.join(this.backupsRoot, roomId);
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const names = entries.filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}T[\d-]+Z-pre-restore\.room\.db$/.test(entry.name)).map(entry => entry.name).sort().reverse();
    return Promise.all(names.map(async name => ({ name, bytes: (await fsp.stat(path.join(directory, name))).size })));
  }

  async readRecoveryPoint(roomId, name) {
    const points = await this.listRecoveryPoints(roomId);
    if (typeof name !== "string" || !points.some(point => point.name === name)) throw new Error("数据检查点不存在或已过期");
    const filePath = path.join(this.backupsRoot, roomId, name);
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATABASE_BYTES) throw new Error("数据检查点无效");
    const buffer = await fsp.readFile(filePath);
    await this.database.validateSnapshot(buffer);
    return buffer;
  }

  async pruneRecoveryPoints(roomId, keep = 5) {
    assertRoomId(roomId);
    const directory = path.join(this.backupsRoot, roomId);
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith("-pre-restore.room.db"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files.slice(keep)) await fsp.rm(path.join(directory, name), { force: true });
  }
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  DataBackupService,
  MAX_ROOM_TRANSFER_FILE_BYTES,
  MAX_BACKUP_FILE_BYTES,
  MAX_DATABASE_BYTES,
  MIN_FREE_SPACE_RESERVE_BYTES,
  ROOM_TRANSFER_ENCRYPTED_KIND,
  ROOM_TRANSFER_EXTENSION,
  LEGACY_ROOM_TRANSFER_EXTENSION,
  ROOM_TRANSFER_FORMAT_VERSION,
  ROOM_TRANSFER_KIND,
  decryptTransferArchive,
  decryptPayload,
  encryptTransferArchive,
  encryptPayload,
  getAvailableDiskBytes,
  validateEncryptedTransferEnvelope,
  validateEnvelope,
  validateTransferManifest,
  validatePassword
};
