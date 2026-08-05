/**
 * 国家中小学智慧教育平台 - 独立资源下载插件 (Content Script)
 * 支持 WASM 核心算法加解密签名 & 全树递归解析课时/课本/视频资源
 */

(function () {
  "use strict";

  if (window.doudouSmarteduDownloaderInjected) return;
  window.doudouSmarteduDownloaderInjected = true;

  // ==================== 全局状态 ====================

  const resourceMap = new Map();

  let panelEl = null;
  let isDownloading = false;
  let isDownloadingAll = false;
  const downloadingResources = new Set(); // 跟踪正在下载的资源，防止重复下载
  let ballEl = null;
  let isCollapsed = false;
  let autoScanTimer = null;
  let wasmError = null; // WASM 核心模块不可用时的错误信息，非空即禁止一切下载
  let hasUpdate = false;
  let updateUrl = "https://github.com/undsky/doudou-smartedu-down";

  // 可下载的目标有效文件格式
  const ALLOW_FORMATS = new Set([
    "pdf",
    "mp4",
    "m3u8",
    "mp3",
    "m4a",
    "wav",
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "zip",
    "epub",
  ]);

  const DETAIL_PATHS = [
    "zxx/ndrv2/resources/tch_material/details/{id}.json",
    "zxx/ndrv2/national_lesson/resources/details/{id}.json",
    "zxx/ndrv2/prepare_lesson/resources/details/{id}.json",
    "zxx/ndrv2/thematic_course/resources/details/{id}.json",
    "zxx/ndrv2/special_edu/resources/details/{id}.json",
    "zxx/ndrv2/resources/details/{id}.json",
    "zxx/ndrv2/national_lesson/lesson_activity/details/{id}.json",
  ];

  const FILE_HOSTS = [
    "https://s-file-1.ykt.cbern.com.cn/",
    "https://s-file-2.ykt.cbern.com.cn/",
  ];

  // ==================== 工具函数 ====================

  function appendToBody(element) {
    if (!element) return;
    const parent = document.body || document.documentElement;
    if (parent) {
      parent.appendChild(element);
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          (document.body || document.documentElement).appendChild(element);
        },
        { once: true },
      );
    }
  }

  function showToast(message, duration = 3000) {
    const existing = document.querySelector(".doudou-smartedu-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "doudou-smartedu-toast";
    toast.textContent = message;
    appendToBody(toast);
    setTimeout(() => toast.remove(), duration);
  }

  function createProgress(title) {
    const existing = document.querySelector(".doudou-smartedu-progress");
    if (existing) existing.remove();

    const progress = document.createElement("div");
    progress.className = "doudou-smartedu-progress";
    progress.innerHTML = `
      <div class="doudou-smartedu-progress-title"></div>
      <div class="doudou-smartedu-progress-bar">
        <div class="doudou-smartedu-progress-fill"></div>
      </div>
      <div class="doudou-smartedu-progress-text">准备中...</div>
    `;
    progress.querySelector(".doudou-smartedu-progress-title").textContent = title;
    appendToBody(progress);

    return {
      update: (percent, text) => {
        const fill = progress.querySelector(".doudou-smartedu-progress-fill");
        if (fill) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        const textEl = progress.querySelector(".doudou-smartedu-progress-text");
        if (textEl && text) textEl.textContent = text;
      },
      setTitle: (text) => {
        const titleEl = progress.querySelector(".doudou-smartedu-progress-title");
        if (titleEl) titleEl.textContent = text;
      },
      close: () => setTimeout(() => progress.remove(), 600),
    };
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)}${units[index]}`;
  }

  // ==================== 核心算法（全部由 WASM 模块提供） ====================
  //
  // 签名、IV 推导、文件名规范化、Hex 解析等算法只存在于 WebAssembly 模块内。
  // 此处仅保留薄桥接，JS 侧不实现任何等价逻辑，模块不可用时一律抛错，绝不降级。

  function requireWasm() {
    const api = window.SmartEduWasm;
    if (!api || typeof api.initWasm !== "function") {
      throw new Error("WASM 核心算法模块未载入，插件无法工作");
    }
    return api;
  }

  // 下载能力的唯一闸门：WASM 就绪才允许继续，失败时记录原因并整体禁用
  async function ensureWasmReady() {
    try {
      await requireWasm().initWasm();
      wasmError = null;
      return true;
    } catch (err) {
      wasmError = err && err.message ? err.message : "WASM 核心算法模块不可用";
      console.error("[SmartEdu] WASM 核心算法模块不可用，已禁用全部下载能力:", err);
      return false;
    }
  }

  function sanitizeFilename(name) {
    return requireWasm().sanitizeFilenameWasm(name);
  }

  function hexToBytes(hex) {
    return requireWasm().hexToBytesWasm(hex);
  }

  function sequenceIv(sequence) {
    return requireWasm().getSequenceIvWasm(sequence);
  }

  // ==================== 鉴权 ====================

  function getAuthToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.includes("ND_UC_AUTH")) continue;

        const raw = localStorage.getItem(key);
        if (!raw) continue;

        const data = safeParse(raw);
        if (!data) continue;

        let inner = data.value !== undefined ? data.value : data;
        if (typeof inner === "string") inner = safeParse(inner) || {};

        const token = inner?.access_token || data?.access_token;
        if (token) return token;
      }
    } catch (e) {
      console.warn("[SmartEdu] 读取智慧教育平台登录态失败:", e);
    }
    return null;
  }

  function buildAuthHeaders() {
    const token = getAuthToken();
    if (!token) return {};
    return { "X-ND-AUTH": `MAC id="${token}",nonce="0",mac="0"` };
  }

  // ==================== HLS 视频（m3u8）算法与 WASM 模块 ====================

  function base64ToBytes(base64) {
    const binary = atob(base64);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff);
  }

  async function makePaddingBlock(key, lastBlock) {
    const target = new Uint8Array(16);
    for (let i = 0; i < 16; i++) target[i] = 0x10 ^ lastBlock[i];
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: new Uint8Array(16) },
        key,
        target,
      ),
    );
    return encrypted.slice(0, 16);
  }

  async function aesEcbDecrypt(key, cipher) {
    const total = cipher.length;
    const padding = await makePaddingBlock(key, cipher.slice(total - 16));
    const buffer = new Uint8Array(total + 16);
    buffer.set(cipher);
    buffer.set(padding, total);

    const cbc = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: new Uint8Array(16) },
        key,
        buffer,
      ),
    );

    const out = new Uint8Array(total);
    for (let block = 0; block * 16 < total; block++) {
      for (let i = 0; i < 16; i++) {
        const index = block * 16 + i;
        out[index] = cbc[index] ^ (block === 0 ? 0 : cipher[index - 16]);
      }
    }

    const pad = out[total - 1];
    return pad >= 1 && pad <= 16 ? out.slice(0, total - pad) : out;
  }

  const hlsKeyCache = new Map();

  async function fetchHlsKey(keyUri) {
    if (!keyUri) throw new Error("播放列表未提供密钥地址");
    if (hlsKeyCache.has(keyUri)) return hlsKeyCache.get(keyUri);

    const keyId = keyUri.split("?")[0].split("/").filter(Boolean).pop();

    const signRes = await fetch(`${keyUri}/signs`);
    if (!signRes.ok) throw new Error(`获取密钥签名失败 HTTP ${signRes.status}`);
    const nonce = (await signRes.json())?.nonce;
    if (!nonce) throw new Error("密钥签名接口返回异常");

    // 解密签名只能由 WASM 字节码计算，模块缺失时直接失败
    const sign = await requireWasm().calculateWasmSign(nonce, keyId);
    console.log("[SmartEdu] 核心 WASM 模块成功计算导出视频密钥解密签名:", sign);

    const keyRes = await fetch(
      `${keyUri}?nonce=${encodeURIComponent(nonce)}&sign=${sign}`,
    );
    if (!keyRes.ok) throw new Error(`获取视频密钥失败 HTTP ${keyRes.status}`);

    const payload = await keyRes.json();
    if (!payload?.key) throw new Error("视频密钥接口返回异常");

    const signKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(sign),
      "AES-CBC",
      false,
      ["encrypt", "decrypt"],
    );
    const plain = await aesEcbDecrypt(signKey, base64ToBytes(payload.key));
    const keyBytes = Uint8Array.from(
      new TextDecoder().decode(plain),
      (ch) => ch.charCodeAt(0) & 0xff,
    );

    hlsKeyCache.set(keyUri, keyBytes);
    return keyBytes;
  }

  function parseM3u8(text, baseUrl) {
    const result = { variants: [], segments: [], key: null, mediaSequence: 0 };
    let pendingVariant = null;

    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bandwidth = line.match(/BANDWIDTH=(\d+)/);
        pendingVariant = { bandwidth: bandwidth ? Number(bandwidth[1]) : 0 };
        return;
      }

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        result.mediaSequence = Number(line.split(":")[1]) || 0;
        return;
      }

      if (line.startsWith("#EXT-X-KEY:")) {
        const method = line.match(/METHOD=([^,\s]+)/);
        const uri = line.match(/URI="([^"]+)"/);
        const iv = line.match(/IV=0x([0-9a-fA-F]+)/);
        result.key = {
          method: method ? method[1] : "NONE",
          uri: uri ? new URL(uri[1], baseUrl).href : null,
          iv: iv ? iv[1] : null,
        };
        return;
      }

      if (line.startsWith("#")) return;

      const url = new URL(line, baseUrl).href;
      if (pendingVariant) {
        result.variants.push({ ...pendingVariant, url });
        pendingVariant = null;
      } else {
        result.segments.push(url);
      }
    });

    return result;
  }

  function withAccessToken(url) {
    if (!url || !url.toLowerCase().includes(".m3u8")) return url;
    const token = getAuthToken();
    if (!token) return url;
    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.has("accessToken")) {
        parsed.searchParams.set("accessToken", token);
      }
      return parsed.href;
    } catch (e) {
      return url;
    }
  }

  async function fetchPlaylist(urls) {
    let lastError = null;

    for (const rawUrl of urls) {
      const url = withAccessToken(rawUrl);
      try {
        const response = await fetch(url, { headers: buildAuthHeaders() });
        if (response.ok) return { url, text: await response.text() };
        lastError =
          response.status === 401 || response.status === 403
            ? new Error("需要登录，请先登录国家中小学智慧教育平台后重试")
            : new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("播放列表下载失败");
  }

  async function fetchSegment(url) {
    let response = null;
    try {
      response = await fetch(url);
    } catch (e) {
      response = null;
    }
    if (!response || !response.ok) {
      response = await fetch(url, { headers: buildAuthHeaders() });
    }
    if (!response.ok) throw new Error(`分片下载失败 HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function decryptSegment(key, data, ivHexBytes, sequence) {
    const iv = ivHexBytes ? ivHexBytes : await sequenceIv(sequence);

    try {
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data),
      );
    } catch (e) {
      const padding = await makePaddingBlock(key, data.slice(data.length - 16));
      const buffer = new Uint8Array(data.length + 16);
      buffer.set(data);
      buffer.set(padding, data.length);
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, buffer),
      );
    }
  }

  const SEGMENT_CONCURRENCY = 6;

  async function downloadHlsVideo(res, progress) {
    const filename =
      (await sanitizeFilename(
        `${res.title}${res.quality ? `-${res.quality}` : ""}`,
      )) + ".ts";

    if (progress) {
      progress.setTitle(filename);
      progress.update(0, "解析播放列表...");
    }

    const urls = res.urls && res.urls.length ? res.urls : [res.url];
    let playlist = await fetchPlaylist(urls);
    let info = parseM3u8(playlist.text, playlist.url);

    if (info.segments.length === 0 && info.variants.length > 0) {
      const best = info.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      playlist = await fetchPlaylist([best.url]);
      info = parseM3u8(playlist.text, playlist.url);
    }

    if (info.segments.length === 0) {
      throw new Error("播放列表中没有找到视频分片");
    }

    info.segments = info.segments.map((url) => {
      const clean = new URL(url);
      clean.search = "";
      clean.hash = "";
      return clean.href;
    });

    let cryptoKey = null;
    if (info.key && info.key.method && info.key.method !== "NONE") {
      if (info.key.method !== "AES-128") {
        throw new Error(`暂不支持的加密方式：${info.key.method}`);
      }
      if (progress) progress.update(0, "获取解密密钥(WASM)...");
      const keyBytes = await fetchHlsKey(info.key.uri);
      cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, [
        "encrypt",
        "decrypt",
      ]);
    }

    const parsedIvBytes =
      info.key && info.key.iv ? await hexToBytes(info.key.iv) : null;
    const total = info.segments.length;
    const chunks = new Array(total);
    let finished = 0;
    let bytes = 0;

    const worker = async (offset) => {
      for (let i = offset; i < total; i += SEGMENT_CONCURRENCY) {
        try {
          let data = await fetchSegment(info.segments[i]);
          if (cryptoKey) {
            data = await decryptSegment(
              cryptoKey,
              data,
              parsedIvBytes,
              info.mediaSequence + i,
            );
          }
          chunks[i] = data;
          finished++;
          bytes += data.length;
          if (progress) {
            progress.update(
              (finished / total) * 100,
              `分片 ${finished}/${total} · ${formatSize(bytes)}`,
            );
          }
        } catch (err) {
          console.error(`[SmartEdu] 分片 ${i} 下载或解密失败:`, err);
          throw err;
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(SEGMENT_CONCURRENCY, total) }, (_, i) =>
          worker(i),
        ),
      );

      if (progress) progress.update(100, `合并中 · ${formatSize(bytes)}`);
      downloadBlob(new Blob(chunks, { type: "video/mp2t" }), filename);
    } catch (err) {
      console.error("[SmartEdu] 视频全量合并失败:", err);
      if (progress && progress.error) {
        progress.error(err.message || "视频解密失败");
      }
      throw err;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  async function downloadNormalFile(res, progress) {
    const filename =
      (await sanitizeFilename(res.title)) + (res.ext ? `.${res.ext}` : "");

    if (progress) {
      progress.setTitle(filename);
      progress.update(0, "连接服务器...");
    }

    let response = null;
    try {
      response = await fetch(res.url, { headers: buildAuthHeaders() });
    } catch (e) {}
    if (!response || !response.ok) {
      response = await fetch(res.url);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (progress) {
        const percent = contentLength ? (received / contentLength) * 100 : 50;
        progress.update(
          percent,
          `已下载 ${formatSize(received)}${contentLength ? ` / ${formatSize(contentLength)}` : ""}`,
        );
      }
    }

    const blob = new Blob(chunks);
    downloadBlob(blob, filename);
  }

  // ==================== 资源全树递归解析 ====================

  function pickStorageUrls(item) {
    const raw = item.ti_storages || item.ti_storage || item.ti_url;
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((url) => typeof url === "string" && url.startsWith("http"));
  }

  function normalizeFormat(item, url) {
    let format = String(item.ti_format || "").toLowerCase();
    if (format.includes("/")) format = format.split("/").pop();
    if (!format) {
      const match = url.split("?")[0].match(/\.([a-z0-9]+)$/i);
      format = match ? match[1].toLowerCase() : "";
    }
    return format;
  }

  function pickQuality(item) {
    const flag = String(item.ti_file_flag || "");
    const flagMatch = flag.match(/(\d{3,4})p/i);
    if (flagMatch) return `${flagMatch[1]}p`;

    const urls = pickStorageUrls(item);
    const urlMatch = urls[0] && urls[0].match(/-\d{3,4}x(\d{3,4})-/);
    if (urlMatch) return `${urlMatch[1]}p`;

    return "";
  }

  function isPreviewItem(item) {
    const flag = String(item.ti_file_flag || "").toLowerCase();
    const format = String(item.ti_format || "").toLowerCase();
    return (
      flag.includes("thumbnail") ||
      flag.includes("cover") ||
      flag === "image" ||
      flag.includes("preview") ||
      format === "txt" ||
      format === "folder"
    );
  }

  function buildResourceName(node, inherited) {
    const own =
      node?.title ||
      node?.custom_properties?.alias_name ||
      node?.resource_type_code_name ||
      "";
    const lesson =
      node?.global_title?.["zh-CN"] ||
      node?.global_title?.zh_CN ||
      node?.custom_properties?.original_title ||
      "";

    if (own && lesson && own !== lesson) return `${lesson}-${own}`;
    return own || lesson || inherited || "";
  }

  // 全树深层递归提取（解决同步课堂 classActivity 课时活动嵌套资源的匹配问题）
  function collectResources(root) {
    const found = [];
    const visited = new WeakSet();

    (function walk(node, depth, inheritedTitle) {
      if (!node || typeof node !== "object" || depth > 10) return;
      if (visited.has(node)) return;
      visited.add(node);

      const name = buildResourceName(node, inheritedTitle);

      if (Array.isArray(node.ti_items)) {
        node.ti_items.forEach((item) => {
          if (!item || typeof item !== "object") return;
          if (isPreviewItem(item)) return;

          const urls = pickStorageUrls(item);
          if (urls.length === 0) return;

          const format = normalizeFormat(item, urls[0]);
          if (!ALLOW_FORMATS.has(format)) return;

          const quality = pickQuality(item);

          found.push({
            key: `${format}|${urls[0]}`,
            title: name || "未命名资源",
            quality,
            format,
            ext: format,
            urls,
            url: urls[0],
            size: Number(item.ti_size) || 0,
          });
        });
      }

      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const value = node[key];
        if (value && typeof value === "object") walk(value, depth + 1, name);
      }
    })(root, 0, "");

    return found;
  }

  // 唯一判重键：如果是带清晰度的视频，按 title+format+quality 判重；普通静态文件（如 MP3、PDF 等），按 title+format 判重
  function buildResourceKey(res) {
    return res.quality
      ? `${res.title.trim()}|${res.format}|${res.quality}`
      : `${res.title.trim()}|${res.format}`;
  }

  function dedupResources(list) {
    const map = new Map();
    list.forEach((res) => {
      const uniqueKey = buildResourceKey(res);

      if (!map.has(uniqueKey)) {
        map.set(uniqueKey, res);
      } else {
        // 同名同格式出现多个时，优先选取体积 size 更大且最新的有效资源
        const existing = map.get(uniqueKey);
        if ((res.size || 0) > (existing.size || 0)) {
          map.set(uniqueKey, res);
        }
      }
    });
    return Array.from(map.values());
  }

  function addResources(list) {
    let added = 0;
    const cleanList = dedupResources(list);
    cleanList.forEach((res) => {
      const deduppedKey = buildResourceKey(res);

      if (!resourceMap.has(deduppedKey)) {
        resourceMap.set(deduppedKey, res);
        added++;
      } else {
        const existing = resourceMap.get(deduppedKey);
        if ((res.size || 0) > (existing.size || 0)) {
          resourceMap.set(deduppedKey, res);
        }
      }
    });
    return added;
  }

  function getSortedResources() {
    const weight = { pdf: 0, mp4: 1, m3u8: 2, mp3: 3, m4a: 3 };
    const all = Array.from(resourceMap.values());
    const dedupped = dedupResources(all);

    return dedupped.sort((a, b) => {
      const wa = weight[a.format] ?? 5;
      const wb = weight[b.format] ?? 5;
      if (wa !== wb) return wa - wb;

      const titleDiff = a.title.localeCompare(b.title, "zh-CN");
      if (titleDiff !== 0) return titleDiff;

      return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0);
    });
  }

  // 从 URL 获取潜在资源 ID（包含 activityId, chapterId, contentId 等全量参数）
  function getResourceIds() {
    const ids = new Set();
    const keys = [
      "contentId",
      "activityId",
      "resourceId",
      "courseId",
      "chapterId",
      "id",
    ];

    const collect = (search) => {
      if (!search) return;
      const params = new URLSearchParams(
        search.startsWith("?") ? search.slice(1) : search,
      );
      keys.forEach((key) => {
        const value = params.get(key);
        if (value && /^[0-9a-zA-Z-]{8,}$/.test(value)) ids.add(value);
      });
    };

    collect(location.search);

    const hashQueryIndex = location.hash.indexOf("?");
    if (hashQueryIndex !== -1) collect(location.hash.slice(hashQueryIndex));

    return Array.from(ids);
  }

  async function fetchDetailJson(id) {
    const headers = buildAuthHeaders();

    for (const path of DETAIL_PATHS) {
      for (const host of FILE_HOSTS) {
        const url = host + path.replace("{id}", id);
        try {
          const response = await fetch(url, { headers });
          if (!response.ok) continue;

          const text = await response.text();
          if (text.indexOf("ti_items") === -1) continue;

          const data = safeParse(text);
          if (data) return data;
        } catch (e) {}
      }
    }
    return null;
  }

  async function scanResources() {
    const ids = getResourceIds();
    let added = 0;

    for (const id of ids) {
      const data = await fetchDetailJson(id);
      if (data) added += addResources(collectResources(data));
    }

    return added;
  }

  // ==================== 面板 UI 与事件 ====================

  function renderList() {
    if (!panelEl) return;
    const listEl = panelEl.querySelector(".doudou-smartedu-list");
    const countEl = panelEl.querySelector(".doudou-smartedu-count");

    if (!listEl) return;
    listEl.innerHTML = "";

    const resources = getSortedResources();
    if (countEl) countEl.textContent = `共 ${resources.length} 个资源`;

    // WASM 不可用时下载能力整体停用，面板明确告知而不是悄悄退化
    const downloadAllBtn = panelEl.querySelector('[data-action="download-all"]');
    if (downloadAllBtn) downloadAllBtn.disabled = Boolean(wasmError) || isDownloadingAll;

    if (wasmError) {
      const warn = document.createElement("div");
      warn.className = "doudou-smartedu-error";
      warn.textContent = `核心算法模块不可用，下载已停用：${wasmError}`;
      listEl.appendChild(warn);
    }

    if (resources.length === 0) {
      const empty = document.createElement("div");
      empty.className = "doudou-smartedu-empty";
      empty.innerHTML = `
        未发现可下载资源<br>
        <span style="font-size:12px;color:#94a3b8;">请打开电子课本、课程视频或课件页面</span>
      `;
      listEl.appendChild(empty);
      return;
    }

    resources.forEach((res) => {
      const item = document.createElement("div");
      item.className = "doudou-smartedu-item";

      const info = document.createElement("div");
      info.className = "doudou-smartedu-item-info";

      const title = document.createElement("div");
      title.className = "doudou-smartedu-item-title";
      title.textContent = res.title;

      const meta = document.createElement("div");
      meta.className = "doudou-smartedu-item-meta";
      const badgeFormat = (res.format || "文件").toUpperCase();
      const isVideo = res.format === "m3u8" || res.format === "mp4" || (res.url && res.url.includes(".m3u8"));
      const metaText = [
        res.quality ? `分辨率: ${res.quality}` : "",
        (!isVideo && res.size) ? `大小: ${formatSize(res.size)}` : "",
      ]
        .filter(Boolean)
        .join(" | ");

      meta.innerHTML = `<span class="doudou-smartedu-badge">${badgeFormat}</span> ${metaText}`;

      info.appendChild(title);
      info.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "doudou-smartedu-btn";
      btn.textContent = "下载";

      // 资源唯一键，用于跟踪该资源是否正在下载
      const resourceKey = buildResourceKey(res);

      btn.addEventListener("click", () => downloadOne(res, btn, resourceKey));

      // 批量下载中、该资源正在下载、或 WASM 不可用时，保持按钮禁用
      if (isDownloadingAll || downloadingResources.has(resourceKey) || wasmError) {
        btn.disabled = true;
        btn.setAttribute("disabled", "disabled");
      }

      item.appendChild(info);
      item.appendChild(btn);
      listEl.appendChild(item);
    });
  }

  function createPanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement("div");
    panelEl.className = "doudou-smartedu-panel";
    panelEl.innerHTML = `
      <div class="doudou-smartedu-panel-header">
        <div>
          <div class="doudou-smartedu-panel-title">资源下载</div>
          <a class="doudou-smartedu-panel-subtitle" href="https://www.undsky.com" target="_blank" rel="noopener noreferrer">关于作者</a>
        </div>
        <div class="doudou-smartedu-panel-actions">
          <button class="doudou-smartedu-icon-btn" data-action="refresh" title="重新扫描">⟳</button>
          <button class="doudou-smartedu-icon-btn" data-action="collapse" title="收起">—</button>
        </div>
      </div>
      <div class="doudou-smartedu-list"></div>
      <div class="doudou-smartedu-panel-footer">
        <span class="doudou-smartedu-count">共 0 个资源</span>
        <button class="doudou-smartedu-btn doudou-smartedu-btn-send" data-action="download-all">全部下载</button>
      </div>
    `;

    panelEl
      .querySelector('[data-action="collapse"]')
      .addEventListener("click", () => collapsePanel());

    panelEl
      .querySelector('[data-action="refresh"]')
      .addEventListener("click", () => openPanel(true));

    panelEl
      .querySelector('[data-action="download-all"]')
      .addEventListener("click", () => downloadAll());

    renderUpdateBtn();

    appendToBody(panelEl);
    return panelEl;
  }

  function checkVersion() {
    fetch("https://www.undsky.com/v.json")
      .then((res) => res.json())
      .then((data) => {
        const info = data?.["doudou-smartedu"];
        if (!info || !info.version) return;

        const currentVersion =
          (typeof chrome !== "undefined" &&
            chrome.runtime?.getManifest?.()?.version) ||
          "1.0.3";

        if (info.version !== currentVersion) {
          hasUpdate = true;
          if (info.url) updateUrl = info.url;
          renderUpdateBtn();
        }
      })
      .catch((err) => {
        console.warn("[SmartEdu] 版本检测失败:", err);
      });
  }

  function renderUpdateBtn() {
    if (!panelEl || !hasUpdate) return;
    const actionsEl = panelEl.querySelector(".doudou-smartedu-panel-actions");
    if (!actionsEl) return;

    let updateBtn = actionsEl.querySelector('[data-action="update"]');
    if (!updateBtn) {
      const refreshBtn = actionsEl.querySelector('[data-action="refresh"]');
      updateBtn = document.createElement("button");
      updateBtn.className = "doudou-smartedu-icon-btn";
      updateBtn.setAttribute("data-action", "update");
      updateBtn.title = "下载最新版本";
      updateBtn.innerHTML = "↓";
      updateBtn.addEventListener("click", () => {
        window.open(updateUrl, "_blank", "noopener,noreferrer");
      });
      if (refreshBtn) {
        actionsEl.insertBefore(updateBtn, refreshBtn);
      } else {
        actionsEl.appendChild(updateBtn);
      }
    }
  }

  function updateBallCount() {
    if (!ballEl) return;
    const countEl = ballEl.querySelector(".doudou-smartedu-ball-count");
    if (countEl) countEl.textContent = resourceMap.size;
  }

  function showBall() {
    if (ballEl) {
      updateBallCount();
      return;
    }

    ballEl = document.createElement("div");
    ballEl.className = "doudou-smartedu-ball";
    ballEl.title = "展开教育资源下载";
    ballEl.innerHTML = `
      <span class="doudou-smartedu-ball-icon">📚</span>
      <span class="doudou-smartedu-ball-count">0</span>
    `;
    ballEl.addEventListener("click", () => expandPanel());
    appendToBody(ballEl);
    updateBallCount();
  }

  function hideBall() {
    if (!ballEl) return;
    ballEl.remove();
    ballEl = null;
  }

  function collapsePanel() {
    isCollapsed = true;
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    showBall();
  }

  function expandPanel() {
    isCollapsed = false;
    hideBall();
    createPanel();
    renderList();
  }

  async function openPanel(forceScan = false) {
    expandPanel();

    if (forceScan || resourceMap.size === 0) {
      const countEl = panelEl.querySelector(".doudou-smartedu-count");
      if (countEl) countEl.textContent = "正在扫描资源...";

      try {
        await scanResources();
      } catch (e) {
        console.warn("[SmartEdu] 扫描教育资源失败:", e);
      }

      renderList();

      if (resourceMap.size === 0) {
        showToast("未发现资源，请打开电子课本或课程详情页后重试", 4000);
      }
    }
  }

  function autoShowPanel() {
    if (isCollapsed) {
      showBall();
      return;
    }

    if (panelEl) {
      renderList();
      return;
    }

    if (resourceMap.size > 0) {
      createPanel();
      renderList();
    } else {
      showBall();
    }
  }

  function scheduleAutoScan(delay = 500) {
    clearTimeout(autoScanTimer);
    autoScanTimer = setTimeout(async () => {
      try {
        await scanResources();
      } catch (e) {
        console.warn("[SmartEdu] 自动扫描教育资源失败:", e);
      }

      autoShowPanel();
    }, delay);
  }

  async function downloadOne(res, btnEl, resourceKey) {
    if (!res) return;

    const key = resourceKey || buildResourceKey(res);

    // 防止重复点击
    if ((btnEl && btnEl.disabled) || downloadingResources.has(key)) {
      console.log("[SmartEdu] 按钮已禁用或资源正在下载，忽略点击");
      return;
    }

    if (isDownloading || isDownloadingAll) {
      showToast("已有正在进行的下载任务，请稍候...");
      return;
    }

    // WASM 核心算法模块是硬依赖，未就绪一律拒绝下载
    if (!(await ensureWasmReady())) {
      showToast(`无法下载：${wasmError}`, 5000);
      renderList();
      return;
    }

    isDownloading = true;
    downloadingResources.add(key); // 标记为正在下载
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.setAttribute("disabled", "disabled");
    }

    const progress = createProgress(res.title);

    try {
      if (res.format === "m3u8" || (res.url && res.url.includes(".m3u8"))) {
        await downloadHlsVideo(res, progress);
      } else {
        await downloadNormalFile(res, progress);
      }
      showToast(`《${res.title}》已完成下载并保存`);
    } catch (e) {
      console.error("[SmartEdu] 下载失败:", e);
      showToast(`下载失败: ${e.message || "网络请求异常"}`);
    } finally {
      isDownloading = false;
      downloadingResources.delete(key); // 移除下载标记
      progress.close();
      // 不直接操作 btnEl，重新渲染列表让按钮状态自动恢复
      renderList();
    }
  }

  // 批量下载时同一标题的视频仅保留清晰度最高的那一个
  function filterBestQualityResources(resources) {
    const seenVideoTitles = new Set();
    const filtered = [];

    for (const res of resources) {
      const isVideo = res.format === "m3u8" || res.format === "mp4" || (res.url && res.url.includes(".m3u8"));
      if (isVideo) {
        const groupKey = `${res.title}_video`;
        if (seenVideoTitles.has(groupKey)) continue;
        seenVideoTitles.add(groupKey);
      }
      filtered.push(res);
    }

    return filtered;
  }

  async function downloadAll() {
    if (resourceMap.size === 0) return;
    if (isDownloadingAll) {
      showToast("正在批量下载中，请稍候...");
      return;
    }
    if (isDownloading) {
      showToast("已有任务下载中，请稍候...");
      return;
    }

    // WASM 核心算法模块是硬依赖，未就绪一律拒绝下载
    if (!(await ensureWasmReady())) {
      showToast(`无法下载：${wasmError}`, 5000);
      renderList();
      return;
    }

    const allResources = getSortedResources();
    const resources = filterBestQualityResources(allResources);

    isDownloading = true;
    isDownloadingAll = true;

    // 禁用"全部下载"按钮
    const downloadAllBtn = panelEl && panelEl.querySelector('[data-action="download-all"]');
    if (downloadAllBtn) downloadAllBtn.disabled = true;

    // 禁用所有单个下载按钮
    const allDownloadBtns = panelEl && panelEl.querySelectorAll(".doudou-smartedu-item .doudou-smartedu-btn");
    if (allDownloadBtns) {
      allDownloadBtns.forEach((btn) => (btn.disabled = true));
    }

    const progress = createProgress("批量下载中");

    try {
      for (let i = 0; i < resources.length; i++) {
        const res = resources[i];
        progress.setTitle(`(${i + 1}/${resources.length}) ${res.title}${res.quality ? ` (${res.quality})` : ""}`);
        if (res.format === "m3u8" || (res.url && res.url.includes(".m3u8"))) {
          await downloadHlsVideo(res, progress);
        } else {
          await downloadNormalFile(res, progress);
        }
      }
      showToast(`已完成 ${resources.length} 个核心资源的下载并保存`);
    } catch (e) {
      showToast(`批量下载中断: ${e.message}`);
    } finally {
      isDownloading = false;
      isDownloadingAll = false;
      progress.close();
      // 重新渲染列表，由 renderList 统一恢复按钮状态（含 WASM 失效时的禁用）
      renderList();
    }
  }

  // ==================== 初始化 ====================

  function init() {
    if (!location.hostname.includes("smartedu.cn")) return;

    checkVersion();

    // 预热 WASM 核心模块。失败不影响资源扫描展示，
    // 但会让面板进入"不可下载"状态——下载路径没有任何 JS 兜底。
    ensureWasmReady().then((ok) => {
      if (!ok) renderList();
    });

    showBall();

    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("src/inject.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn("[SmartEdu] 注入智慧教育平台拦截脚本失败:", e);
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "DOUDOU_SMARTEDU_RESOURCE_DATA") return;

      try {
        const added = addResources(collectResources(event.data.data));
        if (added > 0) {
          updateBallCount();
          autoShowPanel();
        }
      } catch (e) {}
    });

    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resourceMap.clear();
        if (panelEl) renderList();
        updateBallCount();
        scheduleAutoScan();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => scheduleAutoScan(), {
        once: true,
      });
    } else {
      scheduleAutoScan();
    }
  }

  init();
  console.log("[SmartEdu] 独立教育资源下载插件已成功注入");
})();
