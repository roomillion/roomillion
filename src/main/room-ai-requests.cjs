"use strict";

function validateRequestId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(id)) {
    throw new Error("AI 请求标识无效");
  }
  return id;
}

class RoomAiRequests {
  constructor() { this.owners = new WeakMap(); }

  start(sender, roomId, id) {
    validateRequestId(id);
    if (sender.isDestroyed()) throw new Error("房间已关闭");
    let owner = this.owners.get(sender);
    if (!owner) {
      owner = { requests: new Map() };
      const abortAll = () => {
        for (const request of owner.requests.values()) request.controller.abort(new Error("房间已关闭或重载"));
        owner.requests.clear();
        this.release(sender, owner);
      };
      owner.destroyed = abortAll;
      owner.navigation = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) abortAll();
      };
      sender.on("destroyed", owner.destroyed);
      sender.on("did-start-navigation", owner.navigation);
      this.owners.set(sender, owner);
    }
    if (owner.requests.has(id)) throw new Error("AI 请求标识正在使用，请为每次请求创建新标识");
    const request = { roomId, controller: new AbortController() };
    owner.requests.set(id, request);
    return {
      signal: request.controller.signal,
      finish: () => {
        if (owner.requests.get(id) === request) owner.requests.delete(id);
        if (!owner.requests.size) this.release(sender, owner);
      }
    };
  }

  cancel(sender, roomId, id) {
    validateRequestId(id);
    const request = this.owners.get(sender)?.requests.get(id);
    if (!request || request.roomId !== roomId) return { cancelled: false };
    request.controller.abort(new Error("AI 请求已取消"));
    return { cancelled: true };
  }

  release(sender, owner) {
    sender.removeListener("destroyed", owner.destroyed);
    sender.removeListener("did-start-navigation", owner.navigation);
    if (this.owners.get(sender) === owner) this.owners.delete(sender);
  }
}

module.exports = { RoomAiRequests, validateRequestId };
