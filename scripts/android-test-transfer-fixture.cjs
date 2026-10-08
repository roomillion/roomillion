"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const { pipeline } = require("node:stream/promises");
const yazl = require("yazl");
const { RoomDatabaseService } = require("../src/main/database.cjs");
const { DataBackupService } = require("../src/main/data-backup-service.cjs");
const { RoomBlobService } = require("../src/main/room-blob-service.cjs");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const docx = require("docx");
const XLSX = require("xlsx");
const PptxGenJS = require("pptxgenjs");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "roomillion-android-transfer-"));
  const output = path.join(__dirname, "..", "android", "app", "build", "generated", "androidTestAssets");
  const id = "cn.zhibian.example.inventory";
  const room = { id, name: "物资台账", version: "1.0.0" };
  const store = {
    dataRoot: root,
    tempRoot: root,
    getRoom(requested) { return requested === id ? room : null; },
    getDataRoot(requested) {
      if (requested !== id) throw new Error("Unexpected room ID");
      return path.join(root, "room-data");
    },
    async exportRoom(requested, destination) {
      if (requested !== id) throw new Error("Unexpected room ID");
      await fs.copyFile(path.join(__dirname, "..", "resources", "examples", "inventory.room"), destination);
      return destination;
    }
  };
  const database = await new RoomDatabaseService(store).init();
  try {
    const dataRoot = store.getDataRoot(id);
    await fs.mkdir(path.join(dataRoot, "files"), { recursive: true });
    await fs.writeFile(path.join(dataRoot, "files", "private-note.txt"), "DESKTOP_ASSET", "utf8");
    await new RoomBlobService(store).put(id, { name: "desktop-page.png", mimeType: "image/png" },
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await database.run(id, "CREATE TABLE transfer_fixture(value TEXT NOT NULL)");
    await database.run(id, "INSERT INTO transfer_fixture(value) VALUES('DESKTOP_DATABASE')");
    await fs.mkdir(output, { recursive: true });
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([320, 200]);
    page.drawText("Android PDF sample", { x: 24, y: 100, size: 16,
      font: await pdf.embedFont(StandardFonts.Helvetica) });
    await fs.writeFile(path.join(output, "document-probe.pdf"), await pdf.save());
    const word = new docx.Document({ sections: [{ children: [
      new docx.Paragraph({ text: "安卓 Word 标题", heading: docx.HeadingLevel.HEADING_1 }),
      new docx.Paragraph("安卓 Word 中文正文")
    ] }] });
    await fs.writeFile(path.join(output, "document-probe.docx"), await docx.Packer.toBuffer(word));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "数量"], ["安卓表格", 2]]), "第一页");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["第二页"], ["表格切换成功"]]), "第二页");
    await fs.writeFile(path.join(output, "document-probe.xlsx"), XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    const presentation = new PptxGenJS();
    presentation.addSlide().addText("安卓幻灯片第一页", { x: 1, y: 1, w: 6, h: 1 });
    presentation.addSlide().addText("安卓幻灯片第二页", { x: 1, y: 1, w: 6, h: 1 });
    await fs.writeFile(path.join(output, "document-probe.pptx"), Buffer.from(await presentation.write({ outputType: "arraybuffer" })));
    const transfers = await new DataBackupService(store, database).init();
    await transfers.createRoomTransfer(id, { includeData: true }, path.join(output, "desktop-app-and-data.room"));
    await transfers.createRoomTransfer(id, { includeData: true, password: "android-test-password" }, path.join(output, "desktop-encrypted.room"));
    await transfers.createRoomTransfer(id, { includeData: false, password: "android-test-password" }, path.join(output, "desktop-encrypted-app-only.room"));
    const app = await fs.readFile(path.join(__dirname, "..", "resources", "examples", "inventory.room"));
    const snapshot = await database.exportSnapshot(id);
    const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
    const legacy = {
      kind: "zhibian-room-transfer", formatVersion: "0.2", contents: "app-and-data",
      room, createdAt: new Date().toISOString(),
      app: { path: "room.zroom", bytes: app.length, sha256: sha256(app) },
      data: { path: "data.roomdb", bytes: snapshot.length, sha256: sha256(snapshot) }
    };
    const zip = new yazl.ZipFile();
    const written = pipeline(zip.outputStream, fsSync.createWriteStream(path.join(output, "desktop-legacy.room")));
    zip.addBuffer(Buffer.from(JSON.stringify(legacy)), "bundle.json");
    zip.addBuffer(app, "room.zroom");
    zip.addBuffer(snapshot, "data.roomdb");
    zip.end();
    await written;
  } finally {
    await database.closeAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
