/* Apply the cached preference before first paint; desktop settings are authoritative. */
const systemColors = window.matchMedia("(prefers-color-scheme: dark)");
let themeMode = "system";
try { themeMode = localStorage.getItem("agent-hub-theme") || "system"; } catch { /* optional paint cache */ }
function applyTheme(mode = themeMode) {
  themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  document.documentElement.dataset.theme = themeMode === "system" ? (systemColors.matches ? "dark" : "light") : themeMode;
  document.querySelectorAll("[data-theme-choice]").forEach((choice) => { choice.value = themeMode; });
  try { localStorage.setItem("agent-hub-theme", themeMode); } catch { /* settings still persist in the desktop profile */ }
}
applyTheme();
systemColors.addEventListener("change", () => { if (themeMode === "system") applyTheme(); });
