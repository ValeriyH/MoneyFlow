/**
 * entryForm.js — expense entry card.
 *
 * Responsible for validation, category list insertion, and passing
 * collected data upwards via a callback. It knows nothing about
 * transmission to Google — that is handled by the store.
 *
 *
 * There is no operation type here: incomes are not entered at all, so
 * there is nothing to toggle between them.
 *
 *
 * On narrow screens, the form is collapsed into a single amount field:
 * categories, date, and note appear only when something is typed in.
 * On wide screens, there is no collapse — there is enough space,
 * and hiding categories is unnecessary.
 *
 *
 */

import { evaluateAmountExpression, canAppendOperator } from "../domain/amountExpression.js";
import { isCategoryActive } from "../domain/budget.js";
import { formatCurrency } from "../domain/formatters.js";
import { toLocalIso } from "../domain/period.js";
import { clearChildren, createElement, findById, on, setVisibility, setStatusMessage } from "./dom.js";

const MAX_SAFE_AMOUNT = 100_000_000;

/** Minimum amount of time to show a record in the strip, even if it's already synchronized. */
const RECENT_ENTRY_MIN_VISIBLE_MS = 15_000;

/** More than three lines in the strip are useless: beyond that — it's history. */
const MAX_RECENT_ENTRIES = 3;

/** Formats date and time as an ISO string (e.g., "2026-10-16T14:30" or just the date). */
function selectDateTime(datePart, timePart) {
  if (!timePart) return datePart;
  return `${datePart}T${timePart}`;
}

/**
 * Parses the time from a full ISO string (e.g., "2026-10-16T14:30") and returns the string "HH:MM".
 * Uses Date for reliability, not text parsing.
 *
 *
 */
function parseTimeFromOccurred(occurredOn) {
  if (!occurredOn) return '';
  try {
    // Create a Date object from an ISO string and get the time in "HH:MM" format.
    const date = new Date(occurredOn);
    if (isNaN(date)) return ''; // An invalid string won't give a valid object
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch (e) {
    return '';
  }
}

/**
 * @param {object} dependencies
 * @param {import('../core/budgetStore.js').budgetStore} dependencies.store
 * @param {(draft: object) => Promise<void>} dependencies.onSubmit
 * @param {(draft: object) => Promise<void>} dependencies.onUpdateSubmit
 * @param {(transaction: object) => void} dependencies.onEditRequest
 * @param {() => void} [dependencies.onEditCancel]
 * @returns {{
 *   render: (state: Readonly<object>) => void,
 *   loadForEdit: (transaction: object) => void,
 *   cancelEdit: () => void,
 * }}
 *
 *
 */
export function initEntryForm({ store, onSubmit, onUpdateSubmit, onEditRequest, onEditCancel }) {
  const formElement = findById("entryForm");
  const detailsElement = findById("entryDetails");

  const amountInputElement = findById("entryAmountInput");
  const amountPreviewElement = findById("amountPreview");
  const amountErrorElement = findById("entryAmountError");
  const amountAddButtonElement = findById("entryAmountAddButton");
  const amountClearButtonElement = findById("entryAmountClearButton");

  const categoryChipsElement = findById("categoryChips");
  const categoryErrorElement = findById("entryCategoryError");
  const categoryEmptyElement = findById("categoryChipsEmpty");
  const categoryToggleElement = findById("categoryToggleButton");

  const dateInputElement = findById("entryDateInput");
  const timeInputElement = findById("entryTimeInput");
  const noteInputElement = findById("entryNoteInput");

  // Add element for time errors.
  const entryTimeErrorElement = findById("entryTimeError");

  const submitButtonElement = findById("entrySubmitButton");
  const statusElement = findById("entryStatus");
  const recentEntriesElement = findById("recentEntries");
  const editingBannerElement = findById("entryEditingBanner");
  const editingTextElement = findById("entryEditingText");
  const cancelEditButtonElement = findById("entryCancelEditButton");

  /** State of the form, which is not stored in DOM attributes. */
  const formState = {
    selectedCategoryName: null,
    /** id of the transaction being edited; null — it's a new record. */
    editingTransactionId: null,
    /**
     * Show inactive categories.
     *
     *
     * Lives only until page reload: sometimes a person needs to input
     * an expense for the previous month, where the category was already
     * disabled, so remembering this state would mean keeping all
     * categories in the form forever.
     */
    showAllCategories: false,
    /**
     * Date that we set ourselves when clearing the form.
     *
     *
     * Needed to distinguish "user did nothing" from
     * "user intentionally set yesterday's date". Without it, returning
     * to the tab would overwrite manual selection.
     */
    autoFilledDate: null,
  };

  /** Whether there is anything to offer to select. */
  let hasActiveCategories = false;

  /** Just saved records: category, amount, time and queue id. */
  let recentEntries = [];

  /** Timer for removing the strip when fifteen seconds have passed. */
  let recentEntriesTimer = null;

  const compactMediaQuery = window.matchMedia("(max-width: 899px)");

  initAmountEditor();
  initCompactMode();
  initEditMode();
  initCategoryToggle();
  initDateTimeRefresh();

  // Initial state: field is empty, so the button should be gray
  // already before the first click, not after it.
  refreshAmountPreview();

  on(formElement, "submit", handleSubmit);

  // Initialize the form with the correct current time.
  resetFormFields();

  /* ── Editing the existing operation ────────────────────────────────────────── */

  /**
   * Form is the same — there is no separate "edit" form. Therefore
   * addition and editing share one validation, one sum expression analysis
   * and one expansion.
   */
  function initEditMode() {
    on(cancelEditButtonElement, "click", cancelEdit);
  }

  /**
   * Unfolds inactive categories — and vice versa.
   *
   *
   * State remains only until page reload: sometimes someone enters
   * an expense for the previous month, where the required category
   * was already disabled, and remembering this switch would mean
   * leaving all categories in the form forever.
   */
  function initCategoryToggle() {
    on(categoryToggleElement, "click", () => {
      formState.showAllCategories = !formState.showAllCategories;
      renderCategoryChips(store.getState().categories);
    });
  }

  /**
   * Fills the form with values from the existing record.
   *
   *
   * Form is intentionally left expanded: the user came here to
   * change something, so hiding fields immediately would be
   * inconvenient.
   *
   * @param {object} transaction
   *
   */
  function loadForEdit(transaction) {
    formState.editingTransactionId = transaction.id;
    formState.selectedCategoryName = transaction.category;

    amountInputElement.value = String(transaction.amount ?? "");
    const occurredOn = transaction.occurredOn ?? toLocalIso(new Date()).slice(0, 10);

    dateInputElement.value = occurredOn.split('T')[0] ?? occurredOn;
    timeInputElement.value = parseTimeFromOccurred(occurredOn) || toLocalIso(new Date()).slice(11, 16); // If no time — set current
    noteInputElement.value = transaction.note ?? "";

    submitButtonElement.textContent = "Зберегти зміни";
    editingTextElement.textContent = `${transaction.category} · ${formatCurrency(transaction.amount)}`;
    setVisibility(editingBannerElement, true);

    renderCategoryChips(store.getState().categories);
    refreshAmountPreview();
    // Editing — means fields must be on the screen: so the state
    // "compact" would only hinder: one would have to click in the sum
    // to see it.
    setFormState("expanded");
    clearFieldError(amountInputElement, amountErrorElement);
    clearFieldError(categoryChipsElement, categoryErrorElement);

    // Form is collapsed only at 899px, where it stands above the tabs.
    // Without scrolling, a tap on "edit" on a phone would not
    // give anything: the user would be looking away from the just-filled form.
    if (compactMediaQuery.matches) {
      formElement.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    amountInputElement.focus();
  }

  function cancelEdit() {
    formState.editingTransactionId = null;
    formState.selectedCategoryName = null;

    submitButtonElement.textContent = "Зберегти витрату";
    setVisibility(editingBannerElement, false);

    resetFormFields();
    onEditCancel?.();
  }

  /** Whether the form is currently editing an existing record, not creating a new one. */
  function isEditing() {
    return formState.editingTransactionId !== null;
  }

  /* ── Compact mode ─────────────────────────────────────────────────────────── */

  /**
   * When the screen is cramped, the form shows only the amount and the button.
   *
   * Expansion is tied to the presence of text in the amount field, not to
   * focus: a person can go to another app to clarify the amount and
   * return — the field must keep what they entered.
   */
  function initCompactMode() {
    // Collapses only where the form is actually collapsed.
    // On wide screens, loss of focus doesn't hide fields: there
    // is enough space, and hiding categories is unnecessary.
    on(amountInputElement, "blur", () => {
      if (!compactMediaQuery.matches) return;
      if (amountInputElement.value.trim() === "") setFormState("compact");
    });

    on(compactMediaQuery, "change", syncFormState);
    syncFormState();
  }

  /** Recalculates the form state under the current screen width and field content. */
  function syncFormState() {
    const isCompactAllowed = compactMediaQuery.matches;
    const hasAmountText = amountInputElement.value.trim() !== "";

    setFormState(isCompactAllowed && !hasAmountText ? "compact" : "expanded");
  }

  /** @param {"compact" | "expanded"} state */
  function setFormState(state) {
    // On wide screens, "compact" state doesn't hide fields: there
    // is no collapse at all, and hiding categories is unnecessary.
    const isCompact = state === "compact" && compactMediaQuery.matches;

    formElement.dataset.formState = isCompact ? "compact" : "expanded";

    // Expanded fields are inaccessible via keyboard while they are hidden:
    // otherwise Tab would skip over invisible elements.
    setVisibility(detailsElement, !isCompact);
  }

  /* ── Amount editor ────────────────────────────────────────────────────────── */

  /**
   * Field accepts numbers ("120") and expressions ("120+80+50").
   * Below the field, a line with the calculation result appears —
   * precisely this result will end up in the table.
   */
  function initAmountEditor() {
    on(amountInputElement, "input", () => {
      refreshAmountPreview();
      clearFieldError(amountInputElement, amountErrorElement);
      syncFormState();
    });

    // "+" button is needed for phones: on the iOS keyboard
    // there is no "+" key, so an expression cannot be typed there.
    on(amountAddButtonElement, "click", () => {
      if (!canAppendOperator(amountInputElement.value)) return;

      const currentInput = amountInputElement.value.trim();
      const isEmpty = currentInput === '';

      amountInputElement.value = isEmpty ? '+' : `${currentInput}+`;
      refreshAmountPreview();
      amountInputElement.focus();
    });

    on(amountClearButtonElement, "click", () => {
      amountInputElement.value = '';
      refreshAmountPreview();
      clearFieldError(amountInputElement, amountErrorElement);
      amountInputElement.focus();
    });

    // Enter in the amount field should not hijack the form — otherwise it's
    // inconvenient to move to the category selection.
    on(amountInputElement, "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        categoryChipsElement.querySelector(".chip")?.focus();
      }
    });
  }

  /** Re-reads the field and updates the line below it. */
  function refreshAmountPreview() {
    const parsedExpression = evaluateAmountExpression(amountInputElement.value);
    const isFieldEmpty = parsedExpression.status === "empty";

    amountClearButtonElement.disabled = isFieldEmpty;
    amountAddButtonElement.disabled = !isFieldEmpty && !canAppendOperator(amountInputElement.value);

    refreshSubmitAvailability();

    if (isFieldEmpty || (parsedExpression.status === 'valid' && !parsedExpression.isExpression)) {
      setVisibility(amountPreviewElement, false);
      return;
    }

    if (parsedExpression.status === 'valid') {
      amountPreviewElement.dataset.tone = 'result';
      amountPreviewElement.textContent = `= ${formatCurrency(parsedExpression.value)}`;
    } else {
      amountPreviewElement.dataset.tone = 'hint';
      amountPreviewElement.textContent = parsedExpression.message;
    }

    setVisibility(amountPreviewElement, true);
  }

  /* ── Categories ────────────────────────────────────────────────────────────── */

  /**
   * Gray button while there is nothing to save.
   *
   * This isn't a "broken" state, but a hint: no amount, so nothing
   * to save. If the amount is already there, but no category — the button
   * turns on, and the missing category will already be pointed out by
   * the validation error.
   */
  function refreshSubmitAvailability() {
    const parsedExpression = evaluateAmountExpression(amountInputElement.value);
    const hasAmount = parsedExpression.status === "valid" && parsedExpression.value > 0;

    // Gray is not a failure, but a hint: no amount, so nothing
    // to save. If the amount is already there, but no category — the button
    // turns on, and the missing category will already be pointed out by
    // the validation error.
    submitButtonElement.disabled = !hasAmount || !hasActiveCategories;
  }

  /**
   * Which categories the form sees.
   *
   * Typically — only active ones: inactive ones accumulate, and they
   * only clutter the form. But two things force them to be shown:
   *
   *   the category of the record being edited — required. Otherwise the form
   *     would silently show an empty selection while editing, which is clearly
   *     visible in the list: the old value would be kept, and the person
   *     wouldn't see what they are changing;
   *
   *   the "show all" button — when the person enters an expense for the
   *     previous month, where the required category was already disabled.
   *
   * The list **does not depend on the month**: if an inactive category
   * appears in the records of this month, it is not raised to
   * "temporarily active". Otherwise the list would blink when switching
   * months, and the person wouldn't be able to say which categories they
   * currently see.
   *
   * @param {Array<object>} categories
   * @returns {Array<object>}
   */
  function visibleCategories(categories) {
    return categories.filter(
      (category) =>
        isCategoryActive(category) ||
        formState.showAllCategories ||
        category.name === formState.selectedCategoryName,
    );
  }

  /**
   * Button appears only when there's something to unfold.
   *
   * @param {number} inactiveCount
   *
   */
  function renderCategoryToggle(inactiveCount) {
    if (inactiveCount === 0) {
      setVisibility(categoryToggleElement, false);
      return;
    }

    setVisibility(categoryToggleElement, true);
    categoryToggleElement.textContent = formState.showAllCategories
      ? "Показати лише активні"
      : `Показати всі категорії (${inactiveCount})`;
  }

  /**
   * @param {Readonly<object>} state
   *
   */
  function render(state) {
    renderCategoryChips(state.categories);

    if (!dateInputElement.value) {
      dateInputElement.value = toLocalIso(new Date()).slice(0, 10);
    }

    renderRecentEntries();
  }

  /**
   * Shows only active categories.
   *
   * If there are none — empty and a separate explanation. Categories
   * "for the sake of it" are not there: they are hidden exactly when
   * they are not being entered into, and no limit is set on them.
   *
   * @param {Array<object>} categories
   *
   */
  function renderCategoryChips(categories) {
    const categoriesToRender = visibleCategories(categories);
    const inactiveCount = categories.filter((category) => !isCategoryActive(category)).length;

    clearChildren(categoryChipsElement);

    // Without any category, it's impossible to save, so no button
    // is needed — otherwise it would lead to a validation error.
    const hasCategories = categoriesToRender.length > 0;
    hasActiveCategories = hasCategories;
    refreshSubmitAvailability();
    setVisibility(categoryEmptyElement, !hasCategories);

    renderCategoryToggle(inactiveCount);

    for (const category of categoriesToRender) {
      const isCategorySelectable = isCategoryActive(category);

      const categoryChipElement = createElement("button", {
        className: "chip",
        attributes: { type: "button", role: "radio", "aria-checked": "false" },
      });

      // An inactive category remains available — just visibly
      // and otherwise. The label is needed, so it doesn't look
      // disabled: gray text would mean "cannot click", but
      // you can click, even if it's rarely needed.
      if (!isCategorySelectable) {
        categoryChipElement.classList.add("chip--inactive");
        categoryChipElement.title = "Неактивна категорія — її вже не пропонують, але можна вибрати";
      }

      const categoryIconElement = createElement("span", {
        className: "chip__icon",
        textContent: category.icon ?? "•",
        attributes: { "aria-hidden": "true" },
      });
      const categoryLabelElement = createElement("span", {
        className: "chip__label",
        textContent: category.name,
      });

      categoryChipElement.append(categoryIconElement, categoryLabelElement);

      if (category.name === formState.selectedCategoryName) {
        categoryChipElement.classList.add("is-selected");
        categoryChipElement.setAttribute("aria-checked", "true");
      }

      on(categoryChipElement, "click", () => selectCategory(category.name, categoriesToRender));

      categoryChipsElement.append(categoryChipElement);
    }
  }

  /**
   * @param {string} categoryName
   * @param {Array<object>} categoriesToRender
   *
   */
  function selectCategory(categoryName, categoriesToRender) {
    formState.selectedCategoryName = categoryName;
    clearFieldError(categoryChipsElement, categoryErrorElement);

    for (const [chipIndex, chipElement] of [...categoryChipsElement.children].entries()) {
      const chipCategoryName = categoriesToRender[chipIndex]?.name;
      const isSelected = chipCategoryName === categoryName;
      chipElement.classList.toggle("is-selected", isSelected);
      chipElement.setAttribute("aria-checked", String(isSelected));
    }
  }

  /* ── Validation ────────────────────────────────────────────────────────── */

  /**
   * @param {HTMLElement} inputElement
   * @param {HTMLElement} errorElement
   * @param {string} message
   *
   */
  function showFieldError(inputElement, errorElement, message) {
    inputElement.setAttribute("aria-invalid", "true");
    errorElement.textContent = message;
    setVisibility(errorElement, true);
  }

  /**
   * @param {HTMLElement} inputElement
   * @param {HTMLElement} errorElement
   *
   */
  function clearFieldError(inputElement, errorElement) {
    inputElement.removeAttribute("aria-invalid");
    setVisibility(errorElement, false);
  }

  /**
   * @returns {{ isValid: boolean, draft: object | null }}
   *
   */
  function collectAndValidate() {
    const parsedExpression = evaluateAmountExpression(amountInputElement.value);

    if (parsedExpression.status !== 'valid') {
      const messageByStatus = {
        empty: 'Введіть суму.',
        incomplete: 'Вираз не дописано — потрібне число в кінці.',
        invalid: parsedExpression.message ?? 'Невірний вираз.',
      };
      showFieldError(amountInputElement, amountErrorElement, messageByStatus[parsedExpression.status]);
      amountInputElement.focus();
      return { isValid: false, draft: null };
    }

    if (parsedExpression.value <= 0) {
      showFieldError(amountInputElement, amountErrorElement, 'Сума має бути більшою за нуль.');
      amountInputElement.focus();
      return { isValid: false, draft: null };
    }

    if (parsedExpression.value > MAX_SAFE_AMOUNT) {
      showFieldError(amountInputElement, amountErrorElement, 'Завелика сума — перевірте, чи не пропущено нуль.');
      amountInputElement.focus();
      return { isValid: false, draft: null };
    }

    clearFieldError(amountInputElement, amountErrorElement);

    const selectedCategory = formState.selectedCategoryName;
    if (!selectedCategory) {
      showFieldError(categoryChipsElement, categoryErrorElement, 'Оберіть категорію.');
      return { isValid: false, draft: null };
    }
    clearFieldError(categoryChipsElement, categoryErrorElement);

    const selectedTime = timeInputElement.value || undefined; // For existing record, time may be missing

    // Time format validation: HH:MM (24-hour)
    // For type=time input, the browser handles validation.
    // Our check is not needed here, but we must clear the error in case of successful correction.
    clearFieldError(timeInputElement, entryTimeErrorElement);

    return {
      isValid: true,
      draft: {
        amount: parsedExpression.value,
        category: selectedCategory,
        occurredOn: selectDateTime(dateInputElement.value, selectedTime),
        note: noteInputElement.value.trim(),
      },
    };
  }

  /* ── Submission ────────────────────────────────────────────────────────── */

  /** @param {SubmitEvent} event */
  function handleSubmit(event) {
    event.preventDefault();

    const { isValid, draft } = collectAndValidate();
    if (!isValid) return;

    // The status strip is the same for addition and edit: it tells
    // not "what this row is", but "program accepted the record and sent
    // it for processing". Thus it appears in both cases.
    rememberRecentEntry(draft);

    if (isEditing()) {
      submitEdit(draft);
      return;
    }

    resetFormFields();

    // Submission happens in the background. If something goes wrong, we'll update the status.
    onSubmit(draft).then(({ deliveredImmediately, error }) => {
      renderRecentEntries();
      if (deliveredImmediately) return;

      setStatusMessage(
        statusElement,
        error?.message ?? "Немає мережі — відправимо автоматично",
        "warning",
      );
    });
  }

  /** @param {object} draft */
  function submitEdit(draft) {
    const transactionId = formState.editingTransactionId;

    formState.editingTransactionId = null;
    formState.selectedCategoryName = null;
    submitButtonElement.textContent = "Зберегти витрату";
    setVisibility(editingBannerElement, false);
    resetFormFields();
    onEditRequest?.();

    onUpdateSubmit(transactionId, draft).then(({ deliveredImmediately, error }) => {
      renderRecentEntries();
      if (deliveredImmediately) return;

      setStatusMessage(
        statusElement,
        error?.message ?? "Немає мережі — відправимо автоматично",
        "warning",
      );
    });
  }

  function resetFormFields() {
    amountInputElement.value = '';

    refreshDateTimeFields();
    noteInputElement.value = '';
    formState.selectedCategoryName = null;
    refreshAmountPreview();
    syncFormState();
    renderCategoryChips(store.getState().categories);
    clearFieldError(amountInputElement, amountErrorElement);
    clearFieldError(categoryChipsElement, categoryErrorElement);
  }

  /**
   * Sets the current date and time in the form fields.
   *
   *
   * Date is taken from `toLocalIso`, not from `toISOString()`: the latter
   * converts to UTC, and in Kyiv, this means from 00:00 to 03:00
   * it would show yesterday's date — and no refresh would have fixed it.
   */
  function refreshDateTimeFields() {
    const currentDateTime = toLocalIso(new Date());
    const currentDate = currentDateTime.slice(0, 10);

    dateInputElement.value = currentDate;
    formState.autoFilledDate = currentDate;
    timeInputElement.value = currentDateTime.slice(11, 16);
  }

  /**
   * Whether the user has entered anything in this form yet.
   *
   *
   * Returning to the tab updates the fields, so it must skip the form
   * where something is already entered. "Something entered" is not only
   * the amount: a manual change of the date should also remain, because
   * a person might have intentionally entered an expense for yesterday,
   * and it should not be overwritten.
   */
  function isFormUntouched() {
    if (isEditing()) return false;
    if (formState.selectedCategoryName !== null) return false;
    if (amountInputElement.value.trim() !== '') return false;
    if (noteInputElement.value.trim() !== '') return false;
    return !formState.autoFilledDate || dateInputElement.value === formState.autoFilledDate;
  }

  /**
   * Returning to the tab updates the date and time.
   *
   *
   * The fields live in the form, not in the markup: they are filled
   * during initialization. Therefore, a tab that sat for an hour
   * shows yesterday's date and old time, until it is refreshed.
   */
  function initDateTimeRefresh() {
    on(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (!isFormUntouched()) return;
      refreshDateTimeFields();
    });
  }

  /* ── Recently saved ────────────────────────────────────────────────────── */

  /**
   * Confirmation that the record reached the server stands under the save button —
   * where the eye looks immediately after the click. Otherwise, one
   * would have to switch to another section to check if it worked.
   *
   *
   * The line stays while the record is in the queue, but at least
   * RECENT_ENTRY_MIN_VISIBLE_MS: otherwise a blink of synchronization
   * would make the confirmation disappear faster than it could be noticed.
   *
   * @param {{ category: string, amount: number }} draft
   *
   */
  function rememberRecentEntry(draft) {
    recentEntries = [
      { category: draft.category, amount: draft.amount, occurredOn: draft.occurredOn, savedAtMs: Date.now() },
      ...recentEntries,
    ].slice(0, MAX_RECENT_ENTRIES);

    renderRecentEntries();
  }

  /**
   * Whether the strip line matches the optimistic record from the state.
   *
   *
   * We compare by content, not by id: the queue id only
   * appears after the server's response, but during the whole
   * synchronization period, the strip should show the record as
   * delivered. The state already contains the same draft record,
   * so a match by sum, category, and date is sufficient.
   *
   * @param {object} entry
   * @param {ReadonlyArray<object>} transactions
   * @returns {boolean}
   *
   */
  function isStillPending(entry, transactions) {
    return transactions.some(
      (transaction) =>
        transaction.pending === true &&
        transaction.amount === entry.amount &&
        transaction.category === entry.category &&
        transaction.occurredOn === entry.occurredOn,
    );
  }

  function renderRecentEntries() {
    const state = store.getState();
    const now = Date.now();

    recentEntries = recentEntries.filter(
      (entry) => isStillPending(entry, state.transactions) ||
        now - entry.savedAtMs < RECENT_ENTRY_MIN_VISIBLE_MS,
    );

    scheduleRecentEntriesRefresh(state.transactions);

    if (recentEntries.length === 0) {
      clearChildren(recentEntriesElement);
      setVisibility(recentEntriesElement, false);
      return;
    }

    clearChildren(recentEntriesElement);

    for (const entry of recentEntries) {
      const category = state.categories.find((item) => item.name === entry.category);
      const isPending = isStillPending(entry, state.transactions);

      const itemElement = createElement("li", {
        className: "recent-entry",
        attributes: { "data-pending": String(isPending) },
      });

      itemElement.append(
        createElement("span", {
          className: "recent-entry__icon",
          textContent: category?.icon ?? "•",
          attributes: { "aria-hidden": "true" },
        }),
        createElement("span", {
          className: "recent-entry__name",
          textContent: entry.category,
        }),
        createElement("span", {
          className: "recent-entry__status",
          textContent: isPending ? "очікується" : "записано",
        }),
        createElement("span", {
          className: "recent-entry__amount",
          textContent: formatCurrency(entry.amount),
        }),
      );

      recentEntriesElement.append(itemElement);
    }

    setVisibility(recentEntriesElement, true);
  }

  /**
   * Sets a timer for the nearest expiration of a strip.
   *
   *
   * For records still in the queue, the timer is not needed: the next
   * state render will notify them. Therefore, the timer is only set
   * for synchronized records, for which fifteen seconds — is a hard
   * limit.
   *
   * @param {ReadonlyArray<object>} transactions
   *
   */
  function scheduleRecentEntriesRefresh(transactions) {
    if (recentEntriesTimer !== null) {
      clearTimeout(recentEntriesTimer);
      recentEntriesTimer = null;
    }

    const expiryTimes = recentEntries
      .filter((entry) => !isStillPending(entry, transactions))
      .map((entry) => entry.savedAtMs + RECENT_ENTRY_MIN_VISIBLE_MS);

    if (expiryTimes.length === 0) return;

    const delay = Math.min(...expiryTimes) - Date.now();
    if (delay <= 0) return;

    recentEntriesTimer = setTimeout(() => {
      recentEntriesTimer = null;
      renderRecentEntries();
    }, delay);
  }

  return { render, loadForEdit, cancelEdit };
}