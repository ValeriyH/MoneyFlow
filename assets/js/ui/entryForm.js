/**
 * entryForm.js — картка вводу операції.
 *
 * Відповідає за валідацію, перемикання типу операції, підстановку
 * списку категорій і передачу зібраних даних наверх через колбек.
 * Про відправку в Google нічого не знає — це робить store.
 */

import { TRANSACTION_KIND } from "../config.js";
import { evaluateAmountExpression, canAppendOperator } from "../domain/amountExpression.js";
import { formatCurrency } from "../domain/formatters.js";
import { todayAsIsoDate } from "../domain/period.js";
import { normalizeTransactionKind } from "../domain/statistics.js";
import { clearChildren, createElement, findById, on, setVisibility, setStatusMessage } from "./dom.js";

const MAX_SAFE_AMOUNT = 100_000_000;

export function initEntryForm({ store, onSubmit }) {
  const formElement = findById("entryForm");

  const segmentedElement = formElement.querySelector(".segmented");
  const expenseKindButtonElement = findById("kindExpenseButton");
  const incomeKindButtonElement = findById("kindIncomeButton");

  const amountInputElement = findById("entryAmountInput");
  const amountPreviewElement = findById("amountPreview");
  const amountErrorElement = findById("entryAmountError");
  const amountAddButtonElement = findById("entryAmountAddButton");
  const amountClearButtonElement = findById("entryAmountClearButton");

  const categoryChipsElement = findById("categoryChips");
  const categoryErrorElement = findById("entryCategoryError");

  const dateInputElement = findById("entryDateInput");
  const noteInputElement = findById("entryNoteInput");

  const submitButtonElement = findById("entrySubmitButton");
  const statusElement = findById("entryStatus");

  /** Стан форми, який не зберігається в DOM-атрибутах. */
  const formState = {
    kind: TRANSACTION_KIND.expense,
    selectedCategoryName: null,
  };

  initAmountEditor();
  initKindSwitcher();

  on(formElement, "submit", handleSubmit);

  /* ── Редактор суми ───────────────────────────────────────────────────── */

  /**
   * Поле приймає і число («120»), і вираз («120+80+50»).
   * Під полем з'являється рядок із результатом обчислення —
   * саме цей результат і потрапить у таблицю.
   */
  function initAmountEditor() {
    on(amountInputElement, "input", () => {
      refreshAmountPreview();
      clearFieldError(amountInputElement, amountErrorElement);
    });

    // Кнопка «+» потрібна для телефонів: на екранній клавіатурі iOS
    // клавіші «+» немає, тож вираз там набрати неможливо.
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

    // Enter у полі суми не має перехоплювати форму — інакше не зручно
    // перейти до вибору категорії.
    on(amountInputElement, "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        categoryChipsElement.querySelector(".chip")?.focus();
      }
    });
  }

  /** Перечитує поле і оновлює рядок під ним. */
  function refreshAmountPreview() {
    const parsedExpression = evaluateAmountExpression(amountInputElement.value);
    const isFieldEmpty = parsedExpression.status === "empty";

    amountClearButtonElement.disabled = isFieldEmpty;
    amountAddButtonElement.disabled = !isFieldEmpty && !canAppendOperator(amountInputElement.value);

    if (isFieldEmpty || (parsedExpression.status === "valid" && !parsedExpression.isExpression)) {
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

  /* ── Перемикання типу операції ───────────────────────────────────────── */

  function initKindSwitcher() {
    segmentedElement.dataset.activeKind = formState.kind;

    for (const kindButtonElement of [expenseKindButtonElement, incomeKindButtonElement]) {
      on(kindButtonElement, "click", () => {
        const selectedKind = kindButtonElement.dataset.kind;
        if (selectedKind === formState.kind) return;

        formState.kind = selectedKind;
        segmentedElement.dataset.activeKind = selectedKind;

        const isIncomeSelected = selectedKind === TRANSACTION_KIND.income;

        expenseKindButtonElement.classList.toggle("is-active", !isIncomeSelected);
        expenseKindButtonElement.setAttribute("aria-checked", String(!isIncomeSelected));
        incomeKindButtonElement.classList.toggle("is-active", isIncomeSelected);
        incomeKindButtonElement.setAttribute("aria-checked", String(isIncomeSelected));

        submitButtonElement.textContent = isIncomeSelected ? 'Зберегти дохід' : 'Зберегти витрату';

        formState.selectedCategoryName = null;
        renderCategoryChips(store.getState().categories);
        clearFieldError(categoryChipsElement, categoryErrorElement);
      });
    }
  }

  /* ── Категорії ────────────────────────────────────────────────────────── */

  /**
   * @param {Readonly<object>} state
   */
  function render(state) {
    renderCategoryChips(state.categories);

    if (!dateInputElement.value) {
      dateInputElement.value = todayAsIsoDate();
    }
  }

  /**
   * @param {Array<object>} categories
   */
  function renderCategoryChips(categories) {
    const categoriesOfCurrentKind = categories.filter(
      (category) => normalizeTransactionKind(category.kind) === formState.kind,
    );

    // Якщо категорій цього типу немає в таблиці — показуємо перші з будь-яких,
    // щоб форма лишалася придатною.
    const categoriesToRender =
      categoriesOfCurrentKind.length > 0 ? categoriesOfCurrentKind : categories.slice(0, 8);

    clearChildren(categoryChipsElement);

    for (const category of categoriesToRender) {
      const categoryChipElement = createElement("button", {
        className: "chip",
        attributes: { type: "button", role: "radio", "aria-checked": "false" },
      });

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

  /* ── Валідація ────────────────────────────────────────────────────────── */

  /**
   * @param {HTMLElement} inputElement
   * @param {HTMLElement} errorElement
   * @param {string} message
   */
  function showFieldError(inputElement, errorElement, message) {
    inputElement.setAttribute("aria-invalid", "true");
    errorElement.textContent = message;
    setVisibility(errorElement, true);
  }

  /**
   * @param {HTMLElement} inputElement
   * @param {HTMLElement} errorElement
   */
  function clearFieldError(inputElement, errorElement) {
    inputElement.removeAttribute("aria-invalid");
    setVisibility(errorElement, false);
  }

  /**
   * @returns {{ isValid: boolean, draft: object | null }}
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

    return {
      isValid: true,
      draft: {
        amount: parsedExpression.value,
        kind: formState.kind,
        category: selectedCategory,
        occurredOn: dateInputElement.value || todayAsIsoDate(),
        note: noteInputElement.value.trim(),
      },
    };
  }

  /* ── Надсилання ──────────────────────────────────────────────────────── */

  /** @param {SubmitEvent} event */
  function handleSubmit(event) {
    event.preventDefault();

    const { isValid, draft } = collectAndValidate();
    if (!isValid) return;

    // Запис уже в черзі й показаний у списку. Повідомляємо негайно
    // й звільняємо форму: чекати три секунди на Google нічого не дає,
    // адже черга доставить запис і без цього.
    setStatusMessage(statusElement, "Записано", "success");
    resetFormFields();

    // Відправка йде у фоні. Якщо щось піде не так, статус допишемо.
    onSubmit(draft).then(({ deliveredImmediately, error }) => {
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
    noteInputElement.value = '';
    dateInputElement.value = todayAsIsoDate();
    formState.selectedCategoryName = null;
    refreshAmountPreview();
    renderCategoryChips(store.getState().categories);
    clearFieldError(amountInputElement, amountErrorElement);
    clearFieldError(categoryChipsElement, categoryErrorElement);
  }

  return { render };
}