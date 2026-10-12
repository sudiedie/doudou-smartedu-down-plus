/**
 * 国家中小学智慧教育平台 - 资源接口拦截 (MAIN World)
 * 捕获页面请求到的资源详情 JSON（含 ti_items 结构），转发给 content script
 */
(function () {
  if (window.__doudouSmarteduInjected2) return;
  window.__doudouSmarteduInjected2 = true;

  function isTargetApi(urlString) {
    if (!urlString || typeof urlString !== "string") return false;
    return (
      urlString.includes("ykt.cbern.com.cn") ||
      urlString.includes("/resources/") ||
      urlString.includes("/details/") ||
      urlString.includes("lesson") ||
      urlString.includes("tch_material")
    );
  }

  function post(data) {
    try {
      window.postMessage({ type: "DOUDOU_SMARTEDU_RESOURCE_DATA", data }, "*");
    } catch (e) {}
  }

  function handleText(text) {
    if (!text || text.indexOf("ti_items") === -1) return;
    try {
      post(JSON.parse(text));
    } catch (e) {}
  }

  const originalFetch = window.fetch;
  window.fetch = function (url, options) {
    const urlString = typeof url === "string" ? url : url?.url || "";
    const promise = originalFetch.apply(this, arguments);

    if (isTargetApi(urlString)) {
      promise
        .then((response) => {
          response
            .clone()
            .text()
            .then(handleText)
            .catch(() => {});
        })
        .catch(() => {});
    }

    return promise;
  };

  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function (method, url) {
    this._doudouUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function () {
    this.addEventListener("load", function () {
      const urlString =
        typeof this._doudouUrl === "string"
          ? this._doudouUrl
          : this._doudouUrl?.url || "";
      if (!isTargetApi(urlString)) return;
      try {
        if (this.responseType === "" || this.responseType === "text") {
          handleText(this.responseText);
        } else if (this.responseType === "json" && this.response) {
          const text = JSON.stringify(this.response);
          handleText(text);
        }
      } catch (e) {}
    });
    return originalSend.apply(this, arguments);
  };
})();
