export const themeStorageKey = "social-theme";

/**
 * Runs before paint so a stored dark theme never flashes a light screen.
 * Kept as a string because the layout injects it with `dangerouslySetInnerHTML`.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  themeStorageKey,
)})||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
