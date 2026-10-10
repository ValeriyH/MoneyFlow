/**
 * profileChip.js — показує, хто зараз вів бюджет.
 *
 * Ім'я приходить із сервера разом зі знімком: воно визначається
 * кодом доступу, яким користувач увійшов. Тому окремого поля «Хто»
 * у формі витрати немає — воно й не потрібне.
 */

import { findById } from "./dom.js";

/** Бере першу літеру для аватарки. */
function toInitial(userName) {
  return userName ? userName.trim().charAt(0).toUpperCase() : "—";
}

export function initProfileChip({ onSwitchUser }) {
  const profileChipElement = findById("profileChip");
  const profileAvatarElement = findById("profileAvatar");
  const profileNameElement = findById("profileName");

  profileChipElement.addEventListener("click", onSwitchUser);

  /**
   * @param {Readonly<object>} state
   */
  function render(state) {
    const { viewer } = state;

    profileAvatarElement.textContent = toInitial(viewer.name);
    profileAvatarElement.style.backgroundColor = viewer.color;
    profileNameElement.textContent = viewer.name;
    profileChipElement.title = `Записано як «${viewer.name}». Натисніть, щоб змінити користувача.`;
  }

  return { render };
}