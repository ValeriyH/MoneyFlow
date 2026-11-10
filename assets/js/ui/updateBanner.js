/**
 * updateBanner.js — "a new version is ready" notice.
 * A new offline shell is switched on only with the user's consent: reloading
 * by itself could wipe a half-filled form. Knows nothing about the service
 * worker; main.js decides when to show it and what applying means.
 */

import { findById, on, setVisibility } from "./dom.js";

/**
 * @param {{ onApply: () => void }} dependencies
 * @returns {{ show: () => void }}
 */
export function initUpdateBanner({ onApply }) {
  const bannerElement = findById("updateBanner");
  const applyButtonElement = findById("updateBannerButton");

  on(applyButtonElement, "click", () => {
    // Applying ends with a reload; a second click must not send a second request.
    applyButtonElement.disabled = true;
    onApply();
  });

  return {
    show() {
      applyButtonElement.disabled = false;
      setVisibility(bannerElement, true);
    },
  };
}
