/* Shared by the public site and workspace; run before styles to avoid theme flash. */
(function () {
  "use strict";
  const KEY = "jobpilot-theme";
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const bound = new WeakSet();
  let current = "system";

  function normalize(value) {
    if (value === "light" || value === "light-pro") return "light";
    if (value === "dark" || value === "dark-pro") return "dark";
    return "system";
  }

  function syncControls() {
    document.querySelectorAll("[data-theme-select]").forEach(function (select) {
      select.value = current;
    });
  }

  function apply(value, persist = true) {
    current = normalize(value);
    const resolved = current === "system" ? (media && media.matches ? "dark" : "light") : current;
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
    if (document.body) document.body.setAttribute("data-theme", resolved);
    if (persist) {
      try { localStorage.setItem(KEY, current); }
      catch (_) { console.warn("Theme preference could not be saved in this browser."); }
    }
    syncControls();
    return resolved;
  }

  function initControls() {
    document.querySelectorAll("[data-theme-select]").forEach(function (select) {
      if (bound.has(select)) return;
      bound.add(select);
      select.addEventListener("change", function () { apply(select.value); });
    });
    apply(current, false);
  }

  try { current = normalize(localStorage.getItem(KEY)); }
  catch (_) { console.warn("Theme preference could not be read; using the system theme."); }
  window.JobsPilotTheme = { normalize, apply, preference: function () { return current; }, initControls };
  apply(current, false);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initControls);
  else initControls();
  window.addEventListener("storage", function (event) {
    if (event.key === KEY || event.key === null) apply(event.newValue, false);
  });
  if (media) {
    const onChange = function () { if (current === "system") apply("system", false); };
    if (media.addEventListener) media.addEventListener("change", onChange);
    else if (media.addListener) media.addListener(onChange);
  }
})();
