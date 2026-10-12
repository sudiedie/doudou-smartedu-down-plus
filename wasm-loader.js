/**
 * 国家中小学智慧教育平台 - WASM 加载器与算法桥接
 *
 * 硬依赖约定：核心算法只存在于 WebAssembly 模块内，JS 侧不保留任何等价实现。
 * WASM 不可用时全部接口直接抛错，调用方必须失败，不得降级。
 */
(function (global) {
  "use strict";

  // WASM 模块必须导出的全部符号，缺一即视为模块被替换或损坏
  const REQUIRED_EXPORTS = [
    "memory",
    "moduleMagic",
    "getInBufPtr",
    "getOutBufPtr",
    "getBufSize",
    "calculateSignFromBuffer",
    "buildSequenceIv",
    "sanitizeFilenameWasm",
    "hexToBytesWasm",
  ];

  const MODULE_MAGIC = 0x5344574e; // "SDWN"

  let wasmInstance = null;
  let wasmLoadingPromise = null;

  function fail(message, cause) {
    const err = new Error(`[SmartEdu WASM] ${message}`);
    if (cause) err.cause = cause;
    return err;
  }

  async function loadWasm() {
    const wasmUrl =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL("build/smartedu.wasm")
        : "build/smartedu.wasm";

    let response;
    try {
      response = await fetch(wasmUrl);
    } catch (err) {
      throw fail("核心算法模块请求失败，无法继续", err);
    }
    if (!response.ok) {
      throw fail(`核心算法模块下载失败 HTTP ${response.status}`);
    }

    const bytes = await response.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) {
      throw fail("核心算法模块为空文件");
    }

    let module;
    try {
      module = await WebAssembly.instantiate(bytes, {
        env: {
          abort(msg, file, line, col) {
            throw fail(`模块内部中止 at ${line}:${col}`, { msg, file, line, col });
          },
        },
      });
    } catch (err) {
      throw fail("核心算法模块实例化失败", err);
    }

    const instance = module.instance;
    const missing = REQUIRED_EXPORTS.filter((name) => !instance.exports[name]);
    if (missing.length > 0) {
      throw fail(`核心算法模块导出缺失: ${missing.join(", ")}`);
    }

    if (instance.exports.moduleMagic() >>> 0 !== MODULE_MAGIC) {
      throw fail("核心算法模块标识校验不通过");
    }

    return instance;
  }

  async function initWasm() {
    if (wasmInstance) return wasmInstance;

    if (!wasmLoadingPromise) {
      wasmLoadingPromise = loadWasm().then(
        (instance) => {
          wasmInstance = instance;
          console.log("[SmartEdu WASM] 核心 WebAssembly 算法模块已装载并通过完整性校验");
          return instance;
        },
        (err) => {
          // 允许后续重试（网络抖动），但当前调用必须失败
          wasmLoadingPromise = null;
          console.error("[SmartEdu WASM] 加载核心算法模块失败:", err);
          throw err;
        },
      );
    }

    return wasmLoadingPromise;
  }

  function isReady() {
    return wasmInstance !== null;
  }

  /**
   * 把 JS 字节写入模块静态输入缓冲区。
   * 静态缓冲区在模块启动时分配，地址固定，不受 GC 与 memory.grow 影响。
   */
  function writeInput(exports, bytes) {
    const bufSize = exports.getBufSize();
    if (bytes.length > bufSize) {
      throw fail(`输入超出模块缓冲区上限 ${bufSize} 字节`);
    }
    const inPtr = exports.getInBufPtr();
    new Uint8Array(exports.memory.buffer).set(bytes, inPtr);
    return inPtr;
  }

  async function calculateWasmSign(nonce, keyId) {
    const { exports } = await initWasm();

    const inputBytes = new TextEncoder().encode(String(nonce) + String(keyId));
    const inPtr = writeInput(exports, inputBytes);
    const outPtr = exports.getOutBufPtr();

    const len = exports.calculateSignFromBuffer(inPtr, inputBytes.length, outPtr);
    if (len !== 16) {
      throw fail("签名计算失败，模块返回长度异常");
    }

    const sign = new TextDecoder().decode(
      new Uint8Array(exports.memory.buffer, outPtr, 16),
    );
    if (!/^[0-9a-f]{16}$/.test(sign)) {
      throw fail("签名计算失败，模块返回内容异常");
    }
    return sign;
  }

  async function getSequenceIvWasm(sequence) {
    const { exports } = await initWasm();
    const outPtr = exports.getOutBufPtr();

    exports.buildSequenceIv(sequence >>> 0, outPtr);
    return new Uint8Array(exports.memory.buffer.slice(outPtr, outPtr + 16));
  }

  async function sanitizeFilenameWasm(name) {
    const { exports } = await initWasm();

    const inputBytes = new TextEncoder().encode(name == null ? "" : String(name));
    const inPtr = writeInput(exports, inputBytes);
    const outPtr = exports.getOutBufPtr();

    const len = exports.sanitizeFilenameWasm(inPtr, inputBytes.length, outPtr);
    if (len < 0) {
      throw fail("文件名规范化失败，输入超出模块处理范围");
    }
    return new TextDecoder().decode(
      new Uint8Array(exports.memory.buffer, outPtr, len),
    );
  }

  async function hexToBytesWasm(hex) {
    const { exports } = await initWasm();

    const inputBytes = new TextEncoder().encode(hex == null ? "" : String(hex));
    const inPtr = writeInput(exports, inputBytes);
    const outPtr = exports.getOutBufPtr();

    const len = exports.hexToBytesWasm(inPtr, inputBytes.length, outPtr);
    if (len < 0) {
      throw fail("Hex 解析失败，输入超出模块处理范围");
    }
    return new Uint8Array(exports.memory.buffer.slice(outPtr, outPtr + len));
  }

  global.SmartEduWasm = {
    initWasm,
    isReady,
    calculateWasmSign,
    getSequenceIvWasm,
    sanitizeFilenameWasm,
    hexToBytesWasm,
  };
})(typeof window !== "undefined" ? window : globalThis);
