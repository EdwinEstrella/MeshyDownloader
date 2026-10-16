// Runs in the webpage (ISOLATED world) at document_start.
// Bridges captured data between page-hook.js (MAIN world), chrome.storage.local,
// and the extension popup.
(() => {
  if (window.__meshBridgeInjected) return;
  window.__meshBridgeInjected = true;

  const STORAGE_KEY = "active3DModel";
  let currentActiveId = null;

  // ---------------------------------------------------------
  // Helper: Extract Supabase Auth Token from Cookies
  // ---------------------------------------------------------
  function getSupabaseAuthToken() {
    try {
      const cookies = document.cookie.split(";").map((c) => c.trim()).filter(Boolean);
      const tokenParts = [];

      for (const cookie of cookies) {
        const eqIdx = cookie.indexOf("=");
        if (eqIdx === -1) continue;
        const name = cookie.slice(0, eqIdx);
        const value = cookie.slice(eqIdx + 1);

        const match =
          name.match(/^sb-(?:auth-)?[a-z0-9_-]*-?auth-token(?:\.(\d+))?$/i) ||
          name.match(/^sb-[a-z0-9_-]+-auth-token(?:\.(\d+))?$/i) ||
          name.match(/auth-token(?:\.(\d+))?$/i);

        if (match) {
          tokenParts.push({ index: match[1] ? Number(match[1]) : 0, value });
        }
      }

      if (tokenParts.length === 0) return null;
      tokenParts.sort((a, b) => a.index - b.index);
      const combined = tokenParts.map((p) => p.value).join("");

      const candidates = [combined];
      try { candidates.push(decodeURIComponent(combined)); } catch {}
      if (combined.startsWith("base64-")) {
        try { candidates.push(atob(combined.slice(7))); } catch {}
      }

      for (const cand of candidates) {
        try {
          const parsed = JSON.parse(cand);
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.access_token === "string" && parsed.access_token.length > 0) {
              return parsed.access_token;
            }
            if (typeof parsed?.session?.access_token === "string" && parsed.session.access_token.length > 0) {
              return parsed.session.access_token;
            }
            if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].split(".").length === 3) {
              return parsed[0];
            }
          }
        } catch {}

        const trimmed = cand.trim();
        if (trimmed.split(".").length === 3 && trimmed.length > 50) {
          return trimmed;
        }
      }
    } catch (err) {
      console.warn("[Bridge] Error extracting auth token:", err);
    }
    return null;
  }

  // ---------------------------------------------------------
  // Helper: Normalize Meshy Task Output
  // ---------------------------------------------------------
  function normalizeMeshyTask(body, taskIdFallback) {
    if (!body || typeof body !== "object") return null;
    const data = (body.result && typeof body.result === "object") ? body.result :
                 (body.data && typeof body.data === "object") ? body.data : body;
    if (!data || typeof data !== "object") return null;

    const res = (data.result && typeof data.result === "object") ? data.result : data;
    const texture = res.texture || data.texture || body.result?.texture || body.texture;

    // 1. Textures
    const candidateTextureLists = [
      texture?.textureUrls, texture?.texture_urls,
      res.textureUrls, res.texture_urls,
      data.textureUrls, data.texture_urls,
      body.result?.textureUrls, body.result?.texture_urls,
      data.coverItem?.textureUrls, data.coverItem?.texture_urls,
      body.coverItem?.textureUrls, body.coverItem?.texture_urls,
    ];
    let textureList = null;
    for (const list of candidateTextureLists) {
      if (Array.isArray(list) && list.length > 0) {
        textureList = list;
        break;
      }
    }

    let textures = null;
    if (Array.isArray(textureList)) {
      const list = [];
      for (const item of textureList) {
        if (item && typeof item === "object") {
          const entry = {};
          let hasUrl = false;
          for (const [k, v] of Object.entries(item)) {
            if (typeof v === "string" && (v.startsWith("https://") || v.startsWith("http://"))) {
              entry[k] = v;
              hasUrl = true;
            }
          }
          if (hasUrl) list.push(entry);
        }
      }
      if (list.length > 0) textures = list;
    }

    // 2. Model URLs
    const rawModelUrl =
      texture?.modelUrl || texture?.model_url || res.texture_model_url || data.texture_model_url ||
      res.modelUrl || res.model_url || res.model_urls?.glb || res.model_urls?.meshy ||
      res.generate?.modelUrl || res.generate?.model_url || data.modelUrl || data.model_url ||
      data.model_urls?.glb || data.model_urls?.meshy || body.model_urls?.glb;

    const taskId = taskIdFallback ||
      (typeof data.id === "string" ? data.id : null) ||
      (typeof res.id === "string" ? res.id : null);

    const previewUrl =
      texture?.previewUrl || texture?.preview_url || texture?.thumbnail_url ||
      res.previewUrl || res.preview_url || res.thumbnail_url ||
      data.previewUrl || data.preview_url || data.thumbnail_url ||
      body.previewUrl || body.preview_url || body.thumbnail_url;

    const modelName =
      (typeof res.name === "string" ? res.name : null) ||
      (typeof res.modelName === "string" ? res.modelName : null) ||
      (typeof res.taskName === "string" ? res.taskName : null) ||
      (typeof data.name === "string" ? data.name : null) ||
      (taskId ? `Meshy Model ${taskId.slice(0, 8)}` : "Meshy Model");

    const status =
      (typeof data.status === "string" ? data.status : null) ||
      (typeof res.status === "string" ? res.status : null) ||
      "SUCCEEDED";

    const quadJsonUrl = res.quadJsonUrl || data.quadJsonUrl || body.result?.quadJsonUrl || null;

    const availableFormats = {
      GLB: (typeof rawModelUrl === "string" && rawModelUrl.startsWith("http")) ? rawModelUrl : null,
      OBJ: null,
      FBX: null,
      STL: null,
      "3MF": null
    };

    return {
      id: taskId,
      platform: "meshy",
      mode: "workspace",
      name: modelName,
      status: status.toUpperCase(),
      previewUrl: (typeof previewUrl === "string" && previewUrl.startsWith("http")) ? previewUrl : null,
      modelUrl: (typeof rawModelUrl === "string" && rawModelUrl.startsWith("http")) ? rawModelUrl : null,
      availableFormats,
      textureUrls: textures,
      quadJsonUrl: (typeof quadJsonUrl === "string" && quadJsonUrl.startsWith("http")) ? quadJsonUrl : null,
      updatedAt: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------
  // Helper: Normalize Meshy Community Post
  // ---------------------------------------------------------
  function normalizeMeshyCommunity(body, postIdFallback) {
    if (!body || typeof body !== "object") return null;
    const data = body.result || body.data || body;
    const res = data.result || data;

    const postId = postIdFallback ||
      (typeof res.id === "string" ? res.id : null) ||
      (typeof data.id === "string" ? data.id : null);

    const coverItem = res.coverItem || res.cover_item || data.coverItem || {};
    const refId = coverItem.refId || coverItem.ref_id || res.refId || null;

    const previewUrl =
      res.previewUrl || res.preview_url || res.thumbnailUrl || res.thumbnail_url ||
      data.previewUrl || data.preview_url || coverItem.previewUrl || coverItem.thumbnailUrl;

    const modelUrl =
      res.modelUrl || res.model_url || res.texture?.modelUrl || data.modelUrl || null;

    const title =
      res.title || res.name || coverItem.title || data.title ||
      (postId ? `Community Model ${postId.slice(0, 8)}` : "Community Model");

    const availableFormats = {
      GLB: (typeof modelUrl === "string" && modelUrl.startsWith("http")) ? modelUrl : null,
      OBJ: null,
      FBX: null,
      STL: null,
      "3MF": null
    };

    return {
      id: postId,
      refId,
      platform: "meshy",
      mode: "community",
      name: title,
      status: "SUCCEEDED",
      previewUrl: (typeof previewUrl === "string" && previewUrl.startsWith("http")) ? previewUrl : null,
      modelUrl: (typeof modelUrl === "string" && modelUrl.startsWith("http")) ? modelUrl : null,
      availableFormats,
      hasCapturedGlbBuffer: false,
      textureUrls: null,
      updatedAt: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------
  // Helper: Normalize Tripo Project Detail
  // ---------------------------------------------------------
  function normalizeTripo(body, projectIdFallback) {
    if (!body || typeof body !== "object") return null;
    const data = body.data || body;
    const id = projectIdFallback || (typeof data.id === "string" ? data.id : null);
    if (!id) return null;

    const op = data.operator || {};
    const name = data.project_name || data.name || `Tripo Model ${id.slice(0, 8)}`;
    const previewUrl = data.biz_info?.display_image || op.display_image || data.display_image || null;

    const availableFormats = {
      GLB: op.glb_url || data.glb_url || (op.format === "glb" ? op.model_url : null) || null,
      FBX: op.fbx_url || data.fbx_url || (op.format === "fbx" ? op.model_url : null) || null,
      OBJ: op.obj_url || data.obj_url || (op.format === "obj" ? op.model_url : null) || null,
      STL: op.stl_url || data.stl_url || (op.format === "stl" ? op.model_url : null) || null,
      USDZ: op.usdz_url || data.usdz_url || (op.format === "usdz" ? op.model_url : null) || null,
      "3MF": null
    };

    const mainModelUrl = op.model_url || data.model_url || availableFormats.GLB || availableFormats.FBX || availableFormats.OBJ;
    const status = (op.status || data.status || "ready").toUpperCase();

    return {
      id,
      platform: "tripo",
      mode: "tripo",
      name,
      status: status === "SUCCESS" || status === "READY" ? "SUCCEEDED" : status,
      previewUrl: (typeof previewUrl === "string" && previewUrl.startsWith("http")) ? previewUrl : null,
      modelUrl: (typeof mainModelUrl === "string" && mainModelUrl.startsWith("http")) ? mainModelUrl : null,
      availableFormats,
      hasCapturedGlbBuffer: false,
      textureUrls: null,
      updatedAt: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------
  // Save or Merge Active Model State
  // ---------------------------------------------------------
  async function persistActiveModel(modelUpdate) {
    if (!modelUpdate || !modelUpdate.id) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const prev = stored[STORAGE_KEY] || {};

      let merged = modelUpdate;
      if (prev.id === modelUpdate.id) {
        merged = {
          ...prev,
          ...modelUpdate,
          previewUrl: modelUpdate.previewUrl || prev.previewUrl,
          modelUrl: modelUpdate.modelUrl || prev.modelUrl,
          textureUrls: modelUpdate.textureUrls || prev.textureUrls,
          hasCapturedGlbBuffer: modelUpdate.hasCapturedGlbBuffer || prev.hasCapturedGlbBuffer || false,
          availableFormats: {
            ...(prev.availableFormats || {}),
            ...(modelUpdate.availableFormats || {})
          }
        };
      }

      currentActiveId = merged.id;
      await chrome.storage.local.set({ [STORAGE_KEY]: merged });
      return merged;
    } catch (err) {
      console.warn("[Bridge] Error saving active model:", err);
      return modelUpdate;
    }
  }

  // ---------------------------------------------------------
  // Fetch Full Task Details Directly
  // ---------------------------------------------------------
  async function fetchTaskDirectly(taskId) {
    if (!taskId) return null;
    const token = getSupabaseAuthToken();
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const [resStatus, resV2] = await Promise.all([
        fetch(`/meshyd-api/web/v1/tasks/${encodeURIComponent(taskId)}/status`, {
          headers,
          credentials: "include"
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`/meshyd-api/web/v2/tasks/${encodeURIComponent(taskId)}`, {
          headers,
          credentials: "include"
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      ]);

      const source = resStatus || resV2;
      if (source) {
        const norm = normalizeMeshyTask(source, taskId);
        if (norm) {
          return await persistActiveModel(norm);
        }
      }
    } catch (err) {
      console.warn("[Bridge] Error fetching task directly:", err);
    }
    return null;
  }

  // ---------------------------------------------------------
  // Listen for Messages from page-hook.js (MAIN world)
  // ---------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    const { source, type, payload } = event.data;
    if (source !== "mesh-capture-page") return;

    if (type === "MESHY_TASK_INTERCEPTED") {
      const normalized = normalizeMeshyTask(payload.data, payload.taskId);
      if (normalized) persistActiveModel(normalized);
    } else if (type === "MESHY_COMMUNITY_INTERCEPTED") {
      const normalized = normalizeMeshyCommunity(payload.data, payload.postId);
      if (normalized) persistActiveModel(normalized);
    } else if (type === "TRIPO_DETAIL_INTERCEPTED") {
      const normalized = normalizeTripo(payload.data, payload.projectId);
      if (normalized) persistActiveModel(normalized);
    } else if (type === "GLB_BUFFER_CAPTURED") {
      chrome.storage.local.get(STORAGE_KEY).then((data) => {
        const current = data[STORAGE_KEY];
        if (current) {
          persistActiveModel({ ...current, hasCapturedGlbBuffer: true });
        }
      });
    }
  });

  // ---------------------------------------------------------
  // Proactive Route / URL Inspection
  // ---------------------------------------------------------
  async function inspectCurrentRoute() {
    try {
      const url = new URL(window.location.href);

      // Check Meshy Workspace
      if (url.hostname.includes("meshy.ai")) {
        const taskId = url.searchParams.get("id") || url.searchParams.get("taskId");
        if (taskId && taskId !== currentActiveId) {
          currentActiveId = taskId;
          await fetchTaskDirectly(taskId);
        }

        // Check Meshy Community Post
        const postMatch = url.pathname.match(/\/posts\/([^/?#]+)/);
        if (postMatch && postMatch[1]) {
          const postId = postMatch[1];
          if (postId !== currentActiveId) {
            currentActiveId = postId;
            fetch(`/meshyd-api/web/v1/community/posts/${encodeURIComponent(postId)}`, {
              credentials: "include"
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((body) => {
                if (body) {
                  const norm = normalizeMeshyCommunity(body, postId);
                  if (norm) persistActiveModel(norm);
                }
              })
              .catch(() => {});
          }
        }
      }

      // Check Tripo 3D Model
      if (url.hostname.includes("tripo3d.ai")) {
        const tripoMatch = url.pathname.match(/\/3d-model\/([^/?#]+)/);
        if (tripoMatch && tripoMatch[1]) {
          const projectId = tripoMatch[1];
          if (projectId !== currentActiveId) {
            currentActiveId = projectId;
            fetch(`/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`, {
              credentials: "include"
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((body) => {
                if (body) {
                  const norm = normalizeTripo(body, projectId);
                  if (norm) persistActiveModel(norm);
                }
              })
              .catch(() => {});
          }
        }
      }
    } catch (err) {}
  }

  window.addEventListener("popstate", inspectCurrentRoute);
  let lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      inspectCurrentRoute();
    }
  }, 500);
  inspectCurrentRoute();

  // ---------------------------------------------------------
  // Handle Extension Requests (from Popup or Background)
  // ---------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING") {
      sendResponse({ ok: true, url: window.location.href });
      return true;
    }

    if (request.action === "GET_ASSET_DETAILS") {
      fetchTaskDirectly(request.taskId).then((model) => {
        if (model) {
          sendResponse({ ok: true, model });
        } else {
          sendResponse({ ok: false, error: "Task details not found" });
        }
      });
      return true;
    }

    if (request.action === "GET_CURRENT_OR_TASK_DETAILS") {
      const url = new URL(window.location.href);
      const taskId = request.taskId || url.searchParams.get("id") || url.searchParams.get("taskId");

      if (taskId) {
        fetchTaskDirectly(taskId).then((model) => {
          sendResponse({ ok: !!model, model });
        });
        return true;
      }

      // Fallback to storage
      chrome.storage.local.get(STORAGE_KEY).then((data) => {
        sendResponse({ ok: !!data[STORAGE_KEY], model: data[STORAGE_KEY] || null });
      });
      return true;
    }

    if (request.action === "GET_CAPTURED_GLB_BUFFER") {
      const requestId = Math.random().toString(36).slice(2);

      const handler = (event) => {
        if (
          event.source === window &&
          event.data?.source === "mesh-capture-page" &&
          event.data?.type === "RESPONSE_CAPTURED_GLB" &&
          event.data?.requestId === requestId
        ) {
          window.removeEventListener("message", handler);
          const buf = event.data.buffer;
          if (buf && buf.byteLength > 0) {
            const u8 = new Uint8Array(buf);
            sendResponse({ ok: true, byteLength: buf.byteLength, data: Array.from(u8) });
          } else {
            sendResponse({ ok: false, error: "No GLB buffer captured in page memory." });
          }
        }
      };

      window.addEventListener("message", handler);
      window.postMessage(
        { source: "mesh-capture-bridge", type: "REQUEST_CAPTURED_GLB", requestId },
        "*"
      );

      setTimeout(() => {
        window.removeEventListener("message", handler);
      }, 3000);

      return true;
    }
  });
})();
