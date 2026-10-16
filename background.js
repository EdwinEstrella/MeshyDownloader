// Extension background service worker (Manifest v3)
const TARGET_PATTERNS = [
  "https://www.meshy.ai/*",
  "https://meshy.ai/*",
  "https://*.meshy.ai/*",
  "https://studio.tripo3d.ai/*",
  "https://tripo3d.ai/*",
  "https://*.tripo3d.ai/*"
];

async function injectScriptsIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TARGET_PATTERNS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["page-hook.js"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-bridge.js"]
        });
      } catch (err) {
        // Tab might be restricted or unloaded
      }
    }
  } catch (err) {
    console.warn("[Background] Error querying tabs for injection:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectScriptsIntoExistingTabs();
});

// Robust download handler in service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DOWNLOAD_FILE") {
    const { url, filename } = request;
    if (!url) {
      sendResponse({ ok: false, error: "Missing download URL" });
      return true;
    }

    chrome.downloads.download({
      url,
      filename: filename || "model.glb",
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.warn("[Background] Download error:", chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });
    return true; // Keep sendResponse open for async callback
  }
});
