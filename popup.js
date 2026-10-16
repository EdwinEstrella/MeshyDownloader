import {
  convertGlb,
  packageObjZip,
  packageFbxZip,
  packageTexturesZip,
  packageFullBundleZip
} from "./converters.js";

const STORAGE_KEY = "active3DModel";
const FORMATS = ["GLB", "OBJ", "FBX", "3MF", "STL"];
const TEXTURE_MAPS = [
  { key: "colorMapUrl", label: "Color" },
  { key: "metallicMapUrl", label: "Metallic" },
  { key: "roughnessMapUrl", label: "Roughness" },
  { key: "normalMapUrl", label: "Normal" },
];

// Elements
const navTabsEl = document.getElementById("nav-tabs");
const tabActiveEl = document.getElementById("tab-active");
const tabGalleryEl = document.getElementById("tab-gallery");
const emptyStateEl = document.getElementById("empty-state");
const detailEl = document.getElementById("detail");
const dashboardEl = document.getElementById("dashboard");
const gridEl = document.getElementById("grid");

const detailPreviewEl = document.getElementById("detail-preview");
const genTitleEl = document.getElementById("gen-title");
const formatsEl = document.getElementById("formats");
const downloadModelEl = document.getElementById("download-model");
const downloadFullBundleEl = document.getElementById("download-full-bundle");
const downloadNoteEl = document.getElementById("download-note");
const texturesPanelEl = document.getElementById("textures-panel");
const texturesEl = document.getElementById("textures");
const downloadAllTexturesEl = document.getElementById("download-all-textures");

let activeTab = null;
let currentModel = null;
let selectedFormat = "GLB";
let isProcessing = false;
const glbBufferCache = new Map();

function showNote(text) {
  downloadNoteEl.hidden = false;
  downloadNoteEl.textContent = text;
}

function hideNote() {
  downloadNoteEl.hidden = true;
  downloadNoteEl.textContent = "";
}

function sanitizeFilename(name) {
  return String(name || "model").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadFile(url, filename) {
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "DOWNLOAD_FILE", url, filename }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: true });
      });
    });
    if (res?.ok) return true;
  } catch (err) {}

  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
    if (id !== undefined) return true;
  } catch (err) {}

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch (err) {
    showNote("Download failed.");
    return false;
  }
}

async function getGlbArrayBuffer(model) {
  if (glbBufferCache.has(model.id)) {
    return glbBufferCache.get(model.id);
  }

  if (model.modelUrl && typeof model.modelUrl === "string") {
    try {
      const res = await fetch(model.modelUrl);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        glbBufferCache.set(model.id, buffer);
        return buffer;
      }
    } catch (err) {}
  }

  if (activeTab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(activeTab.id, {
        action: "GET_CAPTURED_GLB_BUFFER"
      });
      if (response?.ok && response.data) {
        const uint8 = new Uint8Array(response.data);
        const buffer = uint8.buffer;
        glbBufferCache.set(model.id, buffer);
        return buffer;
      }
    } catch (err) {}
  }

  throw new Error("Model data unavailable.");
}

async function executeFormatDownload(model, format) {
  if (isProcessing) return;
  isProcessing = true;
  downloadModelEl.disabled = true;
  downloadFullBundleEl.disabled = true;
  downloadModelEl.textContent = "Downloading...";
  hideNote();

  try {
    const cleanName = sanitizeFilename(model.name || model.id);

    if (format === "GLB" && model.modelUrl && typeof model.modelUrl === "string") {
      await downloadFile(model.modelUrl, `${cleanName}.glb`);
      return;
    }

    const glbBuffer = await getGlbArrayBuffer(model);

    if (format === "GLB") {
      const blob = new Blob([glbBuffer], { type: "model/gltf-binary" });
      const dataUrl = await blobToDataUrl(blob);
      await downloadFile(dataUrl, `${cleanName}.glb`);
    } else if (format === "OBJ") {
      const zipBlob = await packageObjZip(glbBuffer, cleanName, model.textureUrls);
      const dataUrl = await blobToDataUrl(zipBlob);
      await downloadFile(dataUrl, `${cleanName}_obj.zip`);
    } else if (format === "FBX") {
      const zipBlob = await packageFbxZip(glbBuffer, cleanName, model.textureUrls);
      const dataUrl = await blobToDataUrl(zipBlob);
      await downloadFile(dataUrl, `${cleanName}_fbx.zip`);
    } else if (format === "STL" || format === "3MF") {
      const blob = await convertGlb(glbBuffer, format);
      const dataUrl = await blobToDataUrl(blob);
      await downloadFile(dataUrl, `${cleanName}.${format.toLowerCase()}`);
    }
  } catch (error) {
    showNote("Export failed.");
  } finally {
    isProcessing = false;
    updateDownloadButtonState();
  }
}

async function executeFullBundleDownload(model) {
  if (isProcessing) return;
  isProcessing = true;
  downloadModelEl.disabled = true;
  downloadFullBundleEl.disabled = true;
  downloadFullBundleEl.textContent = "Packing...";
  hideNote();

  try {
    const cleanName = sanitizeFilename(model.name || model.id);
    const glbBuffer = await getGlbArrayBuffer(model);
    const zipBlob = await packageFullBundleZip(glbBuffer, cleanName, model.textureUrls);
    const dataUrl = await blobToDataUrl(zipBlob);
    await downloadFile(dataUrl, `${cleanName}_full_pack.zip`);
  } catch (error) {
    showNote("Bundle failed.");
  } finally {
    isProcessing = false;
    updateDownloadButtonState();
  }
}

async function executeAllTexturesDownload(model) {
  if (isProcessing) return;
  isProcessing = true;
  downloadAllTexturesEl.disabled = true;
  downloadAllTexturesEl.textContent = "Packing...";

  try {
    const cleanName = sanitizeFilename(model.name || model.id);
    let glbBuffer = null;
    try { glbBuffer = await getGlbArrayBuffer(model); } catch (e) {}

    const zipBlob = await packageTexturesZip(glbBuffer, cleanName, model.textureUrls);
    const dataUrl = await blobToDataUrl(zipBlob);
    await downloadFile(dataUrl, `${cleanName}_textures.zip`);
  } catch (error) {
    showNote("Textures failed.");
  } finally {
    isProcessing = false;
    downloadAllTexturesEl.disabled = false;
    downloadAllTexturesEl.textContent = "Download All (.zip)";
  }
}

function updateDownloadButtonState() {
  if (!currentModel || isProcessing) return;

  const hasGlbSource = !!currentModel.availableFormats?.GLB || !!currentModel.modelUrl || !!currentModel.hasCapturedGlbBuffer;
  const nativeUrl = currentModel.availableFormats?.[selectedFormat];
  const canConvert = ["OBJ", "FBX", "3MF", "STL"].includes(selectedFormat);
  const isAvailable = !!nativeUrl || (canConvert && hasGlbSource);

  const isZip = selectedFormat === "OBJ" || selectedFormat === "FBX";
  downloadModelEl.textContent = isZip ? `Download ${selectedFormat} (.zip)` : `Download ${selectedFormat}`;
  downloadModelEl.disabled = !isAvailable;
  downloadFullBundleEl.disabled = !hasGlbSource;
  downloadFullBundleEl.textContent = "Download All (.zip)";

  downloadModelEl.onclick = () => executeFormatDownload(currentModel, selectedFormat);
  downloadFullBundleEl.onclick = () => executeFullBundleDownload(currentModel);
  downloadAllTexturesEl.onclick = () => executeAllTexturesDownload(currentModel);
}

function renderFormats() {
  formatsEl.replaceChildren();

  const hasGlbSource = !!currentModel?.availableFormats?.GLB || !!currentModel?.modelUrl || !!currentModel?.hasCapturedGlbBuffer;

  for (const format of FORMATS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "format";
    chip.textContent = format;

    const nativeUrl = currentModel?.availableFormats?.[format];
    const canConvert = ["OBJ", "FBX", "3MF", "STL"].includes(format);
    const isAvailable = !!nativeUrl || (canConvert && hasGlbSource);

    chip.classList.toggle("active", format === selectedFormat);
    if (!isAvailable) chip.disabled = true;

    chip.addEventListener("click", () => {
      selectedFormat = format;
      renderFormats();
      updateDownloadButtonState();
    });

    formatsEl.append(chip);
  }
}

function renderTextures(texturesList) {
  texturesEl.replaceChildren();

  let activeMap = null;
  if (Array.isArray(texturesList) && texturesList.length > 0) activeMap = texturesList[0];
  else if (texturesList && typeof texturesList === "object" && !Array.isArray(texturesList)) activeMap = texturesList;

  const validMaps = TEXTURE_MAPS.filter((m) => activeMap && activeMap[m.key]);

  if (validMaps.length === 0) {
    texturesPanelEl.hidden = true;
    return;
  }

  texturesPanelEl.hidden = false;

  for (const map of validMaps) {
    const url = activeMap[map.key];
    const tile = document.createElement("div");
    tile.className = "texture";

    const img = document.createElement("img");
    img.src = url;
    img.alt = map.label;
    img.loading = "lazy";

    const label = document.createElement("span");
    label.className = "texture-label";
    label.textContent = map.label;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "texture-download";
    btn.textContent = "Download";
    btn.addEventListener("click", () => {
      const suffix = map.label.toLowerCase();
      const filename = `${sanitizeFilename(currentModel.name || currentModel.id)}_${suffix}.png`;
      downloadFile(url, filename);
    });

    tile.append(img, label, btn);
    texturesEl.append(tile);
  }
}

function renderActiveModel(model) {
  currentModel = model;
  emptyStateEl.hidden = true;
  detailEl.hidden = false;

  if (model.previewUrl) {
    detailPreviewEl.src = model.previewUrl;
    detailPreviewEl.hidden = false;
  } else {
    detailPreviewEl.src = "";
    detailPreviewEl.hidden = true;
  }

  genTitleEl.textContent = model.name || "3D Model";

  selectedFormat = "GLB";
  renderFormats();
  updateDownloadButtonState();
  renderTextures(model.textureUrls);
}

function collectOwnAssetsFromPage() {
  const datePattern = /\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}/;
  const cards = document.querySelectorAll('[data-testid="assets-card"]');

  return [...cards]
    .map((card) => {
      const date = card.innerText.match(datePattern)?.[0];
      const img = card.querySelector("img");
      const image = img ? img.currentSrc || img.src : null;
      const taskId = image?.match(/\/tasks\/([^/]+)\//)?.[1] ?? null;
      return { date, image, taskId };
    })
    .filter((asset) => asset.date && asset.taskId);
}

function renderGallery(assets) {
  gridEl.replaceChildren();
  if (!assets || assets.length === 0) return;

  for (const asset of assets) {
    const button = document.createElement("button");
    button.className = "card";
    button.type = "button";
    button.addEventListener("click", async () => {
      renderActiveModel({
        id: asset.taskId,
        platform: "meshy",
        mode: "workspace",
        name: `Asset ${asset.date}`,
        previewUrl: asset.image,
        modelUrl: null,
        availableFormats: { GLB: null, OBJ: null, FBX: null, STL: null, "3MF": null },
        hasCapturedGlbBuffer: false,
        textureUrls: null,
        updatedAt: new Date().toISOString()
      });
      switchToActiveTab();

      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          action: "GET_ASSET_DETAILS",
          taskId: asset.taskId
        });
        if (response?.ok && response.model) {
          renderActiveModel(response.model);
        }
      } catch (err) {}
    });

    const img = document.createElement("img");
    img.className = "thumb";
    if (asset.image) img.src = asset.image;

    const caption = document.createElement("span");
    caption.className = "caption";
    caption.textContent = asset.date;

    button.append(img, caption);
    gridEl.append(button);
  }
}

function switchToActiveTab() {
  tabActiveEl.classList.add("active");
  tabGalleryEl.classList.remove("active");
  dashboardEl.hidden = true;
  if (currentModel) {
    detailEl.hidden = false;
    emptyStateEl.hidden = true;
  } else {
    emptyStateEl.hidden = false;
    detailEl.hidden = true;
  }
}

function switchToGalleryTab() {
  tabGalleryEl.classList.add("active");
  tabActiveEl.classList.remove("active");
  detailEl.hidden = true;
  emptyStateEl.hidden = true;
  dashboardEl.hidden = false;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab?.url) {
    emptyStateEl.hidden = false;
    return;
  }

  const isMeshy = tab.url.includes("meshy.ai");
  const isTripo = tab.url.includes("tripo3d.ai");

  if (!isMeshy && !isTripo) {
    emptyStateEl.hidden = false;
    return;
  }

  try {
    const liveResponse = await chrome.tabs.sendMessage(tab.id, {
      action: "GET_CURRENT_OR_TASK_DETAILS"
    });
    if (liveResponse?.ok && liveResponse.model) {
      renderActiveModel(liveResponse.model);
    }
  } catch (err) {}

  if (!currentModel) {
    const storage = await chrome.storage.local.get(STORAGE_KEY);
    const storedModel = storage[STORAGE_KEY];
    if (storedModel && storedModel.id) {
      renderActiveModel(storedModel);
    } else {
      emptyStateEl.hidden = false;
    }
  }

  if (isMeshy) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectOwnAssetsFromPage,
      });

      if (result && result.length > 0) {
        navTabsEl.hidden = false;
        renderGallery(result);
        tabActiveEl.addEventListener("click", switchToActiveTab);
        tabGalleryEl.addEventListener("click", switchToGalleryTab);
      }
    } catch (err) {}
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]?.newValue) {
      renderActiveModel(changes[STORAGE_KEY].newValue);
    }
  });
}

// Ensure all external links open cleanly in a new browser tab
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="http"]');
  if (link) {
    e.preventDefault();
    chrome.tabs.create({ url: link.href });
  }
});

init();

