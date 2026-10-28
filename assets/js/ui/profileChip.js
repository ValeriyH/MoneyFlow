/**
 * profileChip.js — shows who is currently managing the budget.
 *
 * The name comes from the server with the snapshot: it is determined
 * by the access code the user logged in with. Therefore, there is no
 * separate "Who" field in the expense form — it is not needed.
 *
 *
 */

import { findById } from "./dom.js";

/** Gets the first letter for the avatar. */
function toInitial(userName) {
  return userName ? userName.trim().charAt(0).toUpperCase() : "—";
}

/** @returns {{ render: (state: Readonly<object>) => void }} */
export function initProfileChip() {
  const profileAvatarElement = findById("profileAvatar");
  const profileNameElement = findById("profileName");

  /**
   * @param {Readonly<object>} state
   *
   */
  function render(state) {
    const { viewer } = state;

    profileAvatarElement.textContent = toInitial(viewer.name);
    profileAvatarElement.style.backgroundColor = viewer.color;
    profileNameElement.textContent = viewer.name;
  }

  return { render };
}