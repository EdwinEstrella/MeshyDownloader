// Runs in the webpage (MAIN world) at document_start.
// Intercepts API requests and 3D viewer Web Workers for Meshy and Tripo3D
// to capture model URLs, texture maps, project metadata, and GLB buffers.
(() => {
  if (window.__meshCaptureInjected) return;
  window.__meshCaptureInjected = true;

  const SOURCE = "mesh-capture-page";
  let capturedGlbBuffer = null;

  // ---------------------------------------------------------
  // 1. Worker Interceptor (Captures raw GLB from 3D viewer)
  // ---------------------------------------------------------
  const OriginalWorker = window.Worker;
  if (OriginalWorker) {
    function isGlbHeader(buffer, offset, length) {
      if (!buffer || length < 12) return false;
      const u8 = new Uint8Array(buffer, offset, 4);
      // 'glTF' in ASCII: 103, 108, 84, 70 (0x46546C67)
      return u8[0] === 103 && u8[1] === 108 && u8[2] === 84 && u8[3] === 70;
    }

    window.Worker = function (scriptURL, options) {
      const worker = new OriginalWorker(scriptURL, options);
      worker.addEventListener("message", (event) => {
        try {
          const data = event?.data;
          if (!data) return;

          let buf = null;
          let offset = 0;
          let len = 0;

          if (data instanceof ArrayBuffer) {
            buf = data;
            offset = 0;
            len = data.byteLength;
          } else if (ArrayBuffer.isView(data)) {
            buf = data.buffer;
            offset = data.byteOffset;
            len = data.byteLength;
          } else if (data?.buffer instanceof ArrayBuffer) {
            buf = data.buffer;
            offset = data.byteOffset || 0;
            len = data.byteLength || data.buffer.byteLength;
          }

          if (buf && isGlbHeader(buf, offset, len)) {
            const copy = buf.slice(offset, offset + len);
            capturedGlbBuffer = copy;
            window.__meshCaptureGlbBuffer = copy;
            window.postMessage({
              source: SOURCE,
              type: "GLB_BUFFER_CAPTURED",
              payload: { byteLength: copy.byteLength }
            }, "*");
          }
        } catch (err) {
          // Silent catch to prevent breaking web application
        }
      });
      return worker;
    };
    window.Worker.prototype = OriginalWorker.prototype;
    Object.setPrototypeOf(window.Worker, OriginalWorker);
  }

  // ---------------------------------------------------------
  // 2. Meshy & Tripo URL Patterns
  // ---------------------------------------------------------
  const MESHY_TASK_V1 = /\/meshyd-api\/web\/v1\/tasks\/([^/?#]+)(?:\/(status|downloadable-status))?(?:\?|$)/;
  const MESHY_TASK_V2 = /\/meshyd-api\/web\/(?:public\/)?v2\/tasks\/([^/?#]+)(?:[?#].*)?$/;
  const MESHY_COMMUNITY_POST = /\/meshyd-api\/web\/v1\/(?:community\/)?posts\/([^/?#]+)/;
  const TRIPO_DETAIL = /\/v2\/studio\/project\/detail\/v\d+\/([a-zA-Z0-9_-]+)/;
  const TRIPO_RELATED = /\/v2\/studio\/project\/related_models\/([a-zA-Z0-9_-]+)/;

  function urlString(input) {
    if (typeof input === "string") return input;
    if (input && typeof input === "object" && "url" in input) return String(input.url);
    return "";
  }

  function handleMeshyTask(url, body) {
    if (!body || typeof body !== "object") return;
    const match = url.match(MESHY_TASK_V1) || url.match(MESHY_TASK_V2);
    const taskIdFallback = match?.[1] || null;

    window.postMessage({
      source: SOURCE,
      type: "MESHY_TASK_INTERCEPTED",
      payload: { url, taskId: taskIdFallback, data: body }
    }, "*");
  }

  function handleMeshyCommunity(url, body) {
    if (!body || typeof body !== "object") return;
    const match = url.match(MESHY_COMMUNITY_POST);
    const postId = match?.[1] || null;

    window.postMessage({
      source: SOURCE,
      type: "MESHY_COMMUNITY_INTERCEPTED",
      payload: { url, postId, data: body }
    }, "*");
  }

  function handleTripoDetail(url, body) {
    if (!body || typeof body !== "object") return;
    const match = url.match(TRIPO_DETAIL);
    const projectId = match?.[1] || null;

    window.postMessage({
      source: SOURCE,
      type: "TRIPO_DETAIL_INTERCEPTED",
      payload: { url, projectId, data: body }
    }, "*");
  }

  function inspectNetwork(url, body) {
    if (MESHY_TASK_V1.test(url) || MESHY_TASK_V2.test(url)) {
      handleMeshyTask(url, body);
    } else if (MESHY_COMMUNITY_POST.test(url)) {
      handleMeshyCommunity(url, body);
    } else if (TRIPO_DETAIL.test(url)) {
      handleTripoDetail(url, body);
    }
  }

  // ---------------------------------------------------------
  // 3. Fetch & XHR Interception
  // ---------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = urlString(args[0]);
    const response = await originalFetch.apply(this, args);

    if (
      MESHY_TASK_V1.test(url) ||
      MESHY_TASK_V2.test(url) ||
      MESHY_COMMUNITY_POST.test(url) ||
      TRIPO_DETAIL.test(url)
    ) {
      try {
        response.clone().json().then((body) => {
          inspectNetwork(url, body);
        }).catch(() => {});
      } catch (err) {}
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__meshCaptureUrl = urlString(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__meshCaptureUrl || "";
    if (
      MESHY_TASK_V1.test(url) ||
      MESHY_TASK_V2.test(url) ||
      MESHY_COMMUNITY_POST.test(url) ||
      TRIPO_DETAIL.test(url)
    ) {
      this.addEventListener("load", function () {
        try {
          const body = JSON.parse(this.responseText);
          inspectNetwork(url, body);
        } catch (err) {}
      });
    }
    return originalSend.apply(this, args);
  };

  // ---------------------------------------------------------
  // 4. Message Bus for Buffer Retrieval
  // ---------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === "mesh-capture-bridge" && event.data.type === "REQUEST_CAPTURED_GLB") {
      if (capturedGlbBuffer) {
        window.postMessage({
          source: SOURCE,
          type: "RESPONSE_CAPTURED_GLB",
          requestId: event.data.requestId,
          buffer: capturedGlbBuffer
        }, "*");
      } else {
        window.postMessage({
          source: SOURCE,
          type: "RESPONSE_CAPTURED_GLB",
          requestId: event.data.requestId,
          buffer: null
        }, "*");
      }
    }
  });
})();
