export const themeStorageKey = "social-theme";

/**
 * Runs before paint so a stored dark theme never flashes a light screen. It is
 * a fixed literal — nothing is interpolated into it — because the layout
 * injects it with `dangerouslySetInnerHTML`.
 */
export const themeScript =
  '(function(){try{var t=localStorage.getItem("social-theme")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();';
