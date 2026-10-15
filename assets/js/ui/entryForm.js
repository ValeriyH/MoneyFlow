/**
 * entryForm.js — картка введення витрати.
 *
 * Відповідає за валідацію, підстановку списку категорій і передачу
 * зібраних даних наверх через колбек. Про відправку в Google нічого
 * не знає — це робить store.
 *
 * Типу операції тут немає: доходи не вводяться взагалі, тому й
 * перемикати між ними нічого.
 *
 * На вузькому екрані форма згорнута до одного поля суми: категорії,
 * дата й нотатка з'являються, як тільки починають вводити. На
 * широкому екрані згортання немає — місця вистачає, і ховати
 * категорії зайве.
 */

import { evaluateAmountExpression, canAppendOperator } from "../domain/amountExpression.js";
import { isCategoryActive } from "../domain/budget.js";
import { formatCurrency } from "../domain/formatters.js";
import { todayAsIsoDate } from "../domain/period.js";
import { clearChildren, createElement, findById, on, setVisibility, setStatusMessage } from "./dom.js";

const MAX_SAFE_AMOUNT = 100_000_000;

/** Скільки щонайменше показувати запис у смузі, навіть якщо синхронізувався. */
const RECENT_ENTRY_MIN_VISIBLE_MS = 15_000;

/** Більше трьох рядків у смузі некорисні: далі — це вже історія. */
const MAX_RECENT_ENTRIES = 3;

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
  const noteInputElement = findById("entryNoteInput");

  const submitButtonElement = findById("entrySubmitButton");
  const statusElement = findById("entryStatus");
  const recentEntriesElement = findById("recentEntries");
  const editingBannerElement = findById("entryEditingBanner");
  const editingTextElement = findById("entryEditingText");
  const cancelEditButtonElement = findById("entryCancelEditButton");

  /** Стан форми, який не зберігається в DOM-атрибутах. */
  const formState = {
    selectedCategoryName: null,
    /** id операції, яку зараз правимо; null — це новий запис. */
    editingTransactionId: null,
    /**
     * Показувати неактивні категорії.
     *
     * Живе лише до перезавантаження: потреба рідка (внести витрату
     * за минулий місяць, де категорію уже вимкнули), тож запам'ятовувати
     * такий стан означало б назавжди залишити в формі всі категорії.
     */
    showAllCategories: false,
  };

  /** Чи є взагалі що запропонувати вибрати. */
  let hasActiveCategories = false;

  /** Щойно збережені записи: категорія, сума, час і id черги. */
  let recentEntries = [];

  /** Таймер на зняття смуги, коли мине п'ятнадцять секунд. */
  let recentEntriesTimer = null;

  const compactMediaQuery = window.matchMedia("(max-width: 899px)");

  initAmountEditor();
  initCompactMode();
  initEditMode();
  initCategoryToggle();

  // Стартовий стан: поле порожнє, тож кнопка має бути сіра вже
  // до першого натискання, а не після нього.
  refreshAmountPreview();

  on(formElement, "submit", handleSubmit);

  /* ── Редагування наявної операції ────────────────────────────────────── */

  /**
   * Форма одна й та сама — окремої форми «правки» немає. Тому
   * додавання й редагування діляться однією валідацією, одним
   * розбором виразу суми й одним розгортанням.
   */
  function initEditMode() {
    on(cancelEditButtonElement, "click", cancelEdit);
  }

  /**
   * Розкриває неактивні категорії — і навпаки.
   *
   * Стан лишається тільки до перезавантаження сторінки: раз на
   * кілька місяців хтось вносить витрату за минулий тиждень, і
   * запам'ятовувати такий перемикач означало б назавжди залишити
   * в формі весь каталог.
   */
  function initCategoryToggle() {
    on(categoryToggleElement, "click", () => {
      formState.showAllCategories = !formState.showAllCategories;
      renderCategoryChips(store.getState().categories);
    });
  }

  /**
   * Заповнює форму значеннями наявного запису.
   *
   * Форма навмисно лишається розгорнутою до збереження чи скасування:
   * людина прийшла сюди щось змінити, тож ховати поля одразу було б
   * незручно.
   *
   * @param {object} transaction
   */
  function loadForEdit(transaction) {
    formState.editingTransactionId = transaction.id;
    formState.selectedCategoryName = transaction.category;

    amountInputElement.value = String(transaction.amount ?? "");
    dateInputElement.value = transaction.occurredOn ?? todayAsIsoDate();
    noteInputElement.value = transaction.note ?? "";

    submitButtonElement.textContent = "Зберегти зміни";
    editingTextElement.textContent = `${transaction.category} · ${formatCurrency(transaction.amount)}`;
    setVisibility(editingBannerElement, true);

    renderCategoryChips(store.getState().categories);
    refreshAmountPreview();
    // Правитимуть — значить поля мають бути на екрані. Стан
    // «compact» тут лише заважав би: довелося б ще клацнути в суму.
    setFormState("expanded");
    clearFieldError(amountInputElement, amountErrorElement);
    clearFieldError(categoryChipsElement, categoryErrorElement);

    // Форма згорнута лише до 899px, де вона стоїть над табами.
    // Без прокрутки тап по «редагувати» на телефоні нічого не
    // дав би: користувач дивився б у бік від щойно заповненої форми.
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

  /** Чи зараз форма править наявний запис, а не створює новий. */
  function isEditing() {
    return formState.editingTransactionId !== null;
  }

  /* ── Компактний режим ─────────────────────────────────────────────────── */

  /**
   * Коли на екрані тісно, форма показує лише суму й кнопку.
   *
   * Розгортання прив'язане до наявності тексту в полі суми, а не до
   * фокусу: людина може піти в сусідній застосунок уточнити суму й
   * повернутися — поле має зберегти те, що вона ввела.
   */
  function initCompactMode() {
    // Згортається лише там, де форма взагалі буває згорнутою.
    // На широкому екрані втрата фокусу не має ховати поля: там
    // перемикання між полями — звичайна річ, а не «погляд убік».
    on(amountInputElement, "blur", () => {
      if (!compactMediaQuery.matches) return;
      if (amountInputElement.value.trim() === "") setFormState("compact");
    });

    on(compactMediaQuery, "change", syncFormState);
    syncFormState();
  }

  /** Перераховує стан форми під поточну ширину екрана й вміст поля. */
  function syncFormState() {
    const isCompactAllowed = compactMediaQuery.matches;
    const hasAmountText = amountInputElement.value.trim() !== "";

    setFormState(isCompactAllowed && !hasAmountText ? "compact" : "expanded");
  }

  /** @param {"compact" | "expanded"} state */
  function setFormState(state) {
    // На широкому екрані стан «compact» не приховує полів: там
    // згортання немає взагалі, і ховати категорії зайве.
    const isCompact = state === "compact" && compactMediaQuery.matches;

    formElement.dataset.formState = isCompact ? "compact" : "expanded";

    // Розгорнуті поля недоступні з клавіатури, поки вони сховані:
    // інакше Tab проскакував би по невидим елементах.
    setVisibility(detailsElement, !isCompact);
  }

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
      syncFormState();
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

    refreshSubmitAvailability();

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

  /* ── Категорії ────────────────────────────────────────────────────────── */

  /**
   * Кнопка збереження сіра, поки немає що зберігати.
   *
   * Це не «зламаний» стан, а підказка: сіре каже «введіть суму».
   * Якщо сума вже є, а категорії ні — кнопка вмикається, і про
   * відсутню категорію скаже вже сама помилка валідації.
   */
  function refreshSubmitAvailability() {
    const parsedExpression = evaluateAmountExpression(amountInputElement.value);
    const hasAmount = parsedExpression.status === "valid" && parsedExpression.value > 0;

    // Сіра — це не поломка, а підказка: немає суми, тож немає чого
    // зберігати. Якщо сума вже є, а категорії ні — кнопка вмикається,
    // і про відсутню категорію скаже вже сама помилка валідації.
    submitButtonElement.disabled = !hasAmount || !hasActiveCategories;
  }

  /**
   * Які категорії бачить форма.
   *
   * Типово — лише активні: неактивних у з часом набирається, і вони
   * лише засмічують форму. Але дві речі змушують їх показувати:
   *
   *   категорія запису, який правиться, — обов'язково. Інакше форма
   *     мовчки показала б порожній вибір під час запису, який цілком
   *     видимий у списку: збереглося б старе значення, а людина не
   *     бачила б, що саме вона змінює;
   *
   *   кнопка «показати всі» — коли людина вносить витрату за минулий
   *     місяць, де потрібну категорію вже вимкнули.
   *
   * Список **не залежить від місяця**: якщо неактивна категорія
   * трапляється в записах цього місяця, вона не піднімається до
   * «тимчасово активних». Інакше список мигав би при перемиканні
   * місяців, а людина не мала б змоги сказати, які категорії вона
   * зараз бачить.
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
   * Кнопка з'являється лише тоді, коли є що розкривати.
   *
   * @param {number} inactiveCount
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
   */
  function render(state) {
    renderCategoryChips(state.categories);

    if (!dateInputElement.value) {
      dateInputElement.value = todayAsIsoDate();
    }

    renderRecentEntries();
  }

  /**
   * Показує лише активні категорії.
   *
   * Якщо активних немає — порожньо й окреме пояснення. Категорій
   * «про запас» немає: вони приховуються саме тоді, коли в них
   * не записують, а ліміт на них не задають.
   *
   * @param {Array<object>} categories
   */
  function renderCategoryChips(categories) {
    const categoriesToRender = visibleCategories(categories);
    const inactiveCount = categories.filter((category) => !isCategoryActive(category)).length;

    clearChildren(categoryChipsElement);

    // Без жодної категорії зберегти витрату неможливо, тож і кнопка
    // не потрібна — інакше вона вела б у помилку валідації.
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

      // Неактивна категорія лишається доступною — просто її видно
      // інакше. Помітка потрібна, щоб не виглядало заблокованим:
      // сірий текст означав би «не можна натиснути», а натиснути
      // можна, хоча це рідко потрібно - випадок реальний.
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

    // Смуга під кнопкою однакова для додавання й правки: вона каже
    // не «що це за рядок», а «програма прийняла запис і відправила
    // його в обробку». Тому з'являється в обох випадках.
    rememberRecentEntry(draft);

    if (isEditing()) {
      submitEdit(draft);
      return;
    }

    resetFormFields();

    // Відправка йде у фоні. Якщо щось піде не так, статус допишемо.
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
    noteInputElement.value = '';
    dateInputElement.value = todayAsIsoDate();
    formState.selectedCategoryName = null;
    refreshAmountPreview();
    syncFormState();
    renderCategoryChips(store.getState().categories);
    clearFieldError(amountInputElement, amountErrorElement);
    clearFieldError(categoryChipsElement, categoryErrorElement);
  }

  /* ── Щойно записані ──────────────────────────────────────────────────── */

  /**
   * Підтвердження, що запис дійшов, стоїть під кнопкою збереження —
   * там, куди дивиться око просто після натискання. Інакше довелося
   * б перемикатися на інший розділ, щоб перевірити, що вийшло.
   *
   * Рядок тримається, поки запис у черзі, але щонайменше
   * RECENT_ENTRY_MIN_VISIBLE_MS: інакше за мить синхронізації
   * підтвердження зникало б раніше, ніж його встигли помітити.
   *
   * @param {{ category: string, amount: number }} draft
   */
  function rememberRecentEntry(draft) {
    recentEntries = [
      { category: draft.category, amount: draft.amount, occurredOn: draft.occurredOn, savedAtMs: Date.now() },
      ...recentEntries,
    ].slice(0, MAX_RECENT_ENTRIES);

    renderRecentEntries();
  }

  /**
   * Чи відповідає рядок смуги оптимістичному запису зі стану.
   *
   * Звіряємо за вмістом, а не за id: id черги з'являється лише
   * після відповіді сервера, а весь час синхронізації смуга мала б
   * рахувати запис доставленим. Поле стану вже містить той самий
   * чернетковий запис, тож збіг за сумою, категорією й датою
   * достатній.
   *
   * @param {object} entry
   * @param {ReadonlyArray<object>} transactions
   * @returns {boolean}
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
   * Ставить таймер на найближчий строк дозрікання.
   *
   * Запису, який досі в черзі, таймер не потрібен: про нього нагадає
   * наступний рендер стану. Тому таймер ставиться лише на синхронізовані
   * рядки, для яких fifteen секунд — це жорсткий термін.
   *
   * @param {ReadonlyArray<object>} transactions
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