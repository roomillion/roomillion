"use strict";

function validateRoomAiOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("AI 调用选项无效");
  if (Object.hasOwn(options, "input")) throw new Error("room.ai.generate 的图片参数是 images:[{data,mimeType}]，不是 input");
  if (Object.hasOwn(options, "model")) throw new Error("room.ai.generate 选择模型使用 profileId 或 slot，不是 model");
  if (Object.hasOwn(options, "signal")) throw new Error("room.ai.generate 不接收 AbortSignal；请传唯一 requestId，并用 room.ai.cancel(requestId) 取消宿主请求");
  if (options.images !== undefined && !Array.isArray(options.images)) throw new Error("AI 图片输入必须是数组");
  if (options.audio !== undefined && !Array.isArray(options.audio)) throw new Error("AI 音频输入必须是数组");
}

module.exports = { validateRoomAiOptions };
