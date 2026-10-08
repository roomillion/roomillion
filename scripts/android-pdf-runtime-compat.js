"use strict";

// PDF.js 6 targets newer WebViews than the Android 12 baseline. This prefix is
// added to its main module and worker while packaging Android's pinned copy.
if (!Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value() { return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join(""); },
    configurable: true, writable: true
  });
}
if (!Uint8Array.fromBase64) {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); },
    configurable: true, writable: true
  });
}
if (!Uint8Array.prototype.toBase64) {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value() {
      let binary = "";
      for (let offset = 0; offset < this.length; offset += 32768) {
        binary += String.fromCharCode(...this.subarray(offset, offset + 32768));
      }
      return btoa(binary);
    },
    configurable: true, writable: true
  });
}
if (!Promise.withResolvers) {
  Object.defineProperty(Promise, "withResolvers", {
    value() {
      let resolve;
      let reject;
      const promise = new this((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      return { promise, resolve, reject };
    },
    configurable: true, writable: true
  });
}
if (!Promise.try) {
  Object.defineProperty(Promise, "try", {
    value(callback, ...args) { return new this((resolve) => resolve(callback(...args))); },
    configurable: true, writable: true
  });
}
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true, writable: true,
    value(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  });
}
if (!globalThis.structuredClone) {
  globalThis.structuredClone = (value) => {
    const seen = new WeakMap();
    const copy = (item) => {
      if (item === null || typeof item !== "object") return item;
      if (seen.has(item)) return seen.get(item);
      if (item instanceof ArrayBuffer) return item.slice(0);
      if (ArrayBuffer.isView(item)) {
        if (item instanceof DataView) return new DataView(copy(item.buffer), item.byteOffset, item.byteLength);
        return new item.constructor(item);
      }
      if (item instanceof Date) return new Date(item.getTime());
      if (item instanceof RegExp) return new RegExp(item.source, item.flags);
      if (typeof Blob !== "undefined" && item instanceof Blob) return item.slice(0, item.size, item.type);
      const output = item instanceof Map ? new Map() : item instanceof Set ? new Set() :
        Array.isArray(item) ? [] : {};
      seen.set(item, output);
      if (item instanceof Map) for (const [key, entry] of item) output.set(copy(key), copy(entry));
      else if (item instanceof Set) for (const entry of item) output.add(copy(entry));
      else for (const key of Object.keys(item)) output[key] = copy(item[key]);
      return output;
    };
    return copy(value);
  };
}
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    value() {
      const reader = this.getReader();
      return {
        next() { return reader.read(); },
        async return() { try { await reader.cancel(); } finally { reader.releaseLock(); } return { done: true }; },
        [Symbol.asyncIterator]() { return this; }
      };
    }
  });
}
