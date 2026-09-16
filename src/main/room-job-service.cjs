"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const JOB_STATES = new Set(["queued", "running", "paused", "completed", "failed", "cancelled"]);
const ACTIVE_JOB_STATES = new Set(["queued", "running", "paused"]);

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function boundedJson(value, maximum, label) {
  const cloned = clone(value ?? null);
  if (JSON.stringify(cloned).length > maximum) throw new Error(`${label}过大`);
  return cloned;
}

class RoomJobService {
  constructor(roomStore) {
    this.roomStore = roomStore;
    this.locks = new Map();
  }

  filePath(roomId) { return path.join(this.roomStore.getDataRoot(roomId), "jobs.json"); }

  async load(roomId) {
    try {
      const stored = JSON.parse(await fsp.readFile(this.filePath(roomId), "utf8"));
      return stored?.formatVersion === 1 && Array.isArray(stored.jobs) ? stored.jobs : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async save(roomId, jobs) {
    const target = this.filePath(roomId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify({ formatVersion: 1, jobs }, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, target);
  }

  async mutate(roomId, operation) {
    const previous = this.locks.get(roomId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(roomId, tail);
    await previous;
    try {
      const jobs = await this.load(roomId);
      const result = await operation(jobs);
      await this.save(roomId, jobs);
      return result;
    } finally {
      release();
      if (this.locks.get(roomId) === tail) this.locks.delete(roomId);
    }
  }

  publicJob(job) { return clone(job); }

  async create(roomId, input = {}) {
    const type = String(input.type || "task").trim().slice(0, 80);
    if (!/^[a-z][a-z0-9._-]*$/i.test(type)) throw new Error("任务类型无效");
    const payload = boundedJson(input.payload, 1_000_000, "任务输入");
    return this.mutate(roomId, async (jobs) => {
      const now = Date.now();
      const job = { id: crypto.randomUUID(), type, state: "queued", payload, progress: { completed: 0, total: Number(input.total) > 0 ? Number(input.total) : 0, message: "" }, checkpoint: null, result: null, error: null, attempts: 0, createdAt: now, updatedAt: now };
      jobs.push(job);
      return this.publicJob(job);
    });
  }

  async list(roomId, options = {}) {
    const state = options.state ? String(options.state) : null;
    if (state && !JOB_STATES.has(state)) throw new Error("任务状态过滤无效");
    const limit = Math.min(500, Math.max(1, Number(options.limit || 100)));
    return (await this.load(roomId)).filter((job) => !state || job.state === state).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((job) => this.publicJob(job));
  }

  async get(roomId, id) {
    const job = (await this.load(roomId)).find((item) => item.id === id);
    if (!job) throw new Error("任务不存在");
    return this.publicJob(job);
  }

  async transition(roomId, id, input = {}) {
    const nextState = String(input.state || "");
    if (!JOB_STATES.has(nextState)) throw new Error("任务状态无效");
    return this.mutate(roomId, async (jobs) => {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error("任务不存在");
      const allowed = {
        queued: new Set(["running", "paused", "cancelled"]),
        running: new Set(["paused", "completed", "failed", "cancelled", "queued"]),
        paused: new Set(["queued", "running", "cancelled"]),
        failed: new Set(["queued", "cancelled"]),
        completed: new Set([]),
        cancelled: new Set(["queued"])
      };
      if (nextState !== job.state && !allowed[job.state]?.has(nextState)) throw new Error(`不能把任务从 ${job.state} 改为 ${nextState}`);
      job.state = nextState;
      if (nextState === "running") job.attempts += 1;
      if (input.progress !== undefined) {
        const progress = boundedJson(input.progress, 16_000, "任务进度");
        job.progress = { ...job.progress, ...progress };
      }
      if (input.checkpoint !== undefined) job.checkpoint = boundedJson(input.checkpoint, 256_000, "任务检查点");
      if (input.result !== undefined) job.result = boundedJson(input.result, 1_000_000, "任务结果");
      if (input.error !== undefined) job.error = String(input.error || "").slice(0, 4000) || null;
      if (["queued", "running"].includes(nextState)) job.error = null;
      job.updatedAt = Date.now();
      return this.publicJob(job);
    });
  }

  async recover(roomId) {
    return this.mutate(roomId, async (jobs) => {
      let count = 0;
      for (const job of jobs) {
        if (job.state === "running") { job.state = "queued"; job.error = "应用上次关闭时任务仍在运行，已恢复到队列"; job.updatedAt = Date.now(); count += 1; }
      }
      return { recovered: count, active: jobs.filter((job) => ACTIVE_JOB_STATES.has(job.state)).length };
    });
  }
}

module.exports = { RoomJobService, JOB_STATES };
