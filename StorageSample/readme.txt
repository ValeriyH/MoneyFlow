Як це працює:
Власний доступ: У налаштуваннях доступу до самої Google Таблиці ви додаєте Google-акаунт дружини (надаєте їй права редактора).
Налаштування Web App: При розгортанні скрипта вказуєте, що він виконується від імені того, хто тисне кнопку (Execute as: User accessing the web app).
Автоматична перевірка: Коли додаток робить запит, Google перевіряє: якщо користувач залогінений у свій Gmail і має доступ до цієї таблиці — запис проходить. Якщо це сторонній акаунт чи анонім — Google навіть не дасть виконати скрипт.

Крок 1. Налаштування Google Таблиці та Бекенду
	Створіть нову Google Таблицю на своєму Google Диску (назвіть її, наприклад, MoneyFlow).
	У першому рядку зробіть шапку: A1: Дата, B1: Категорія, C1: Сума, D1: Користувач.
	У верхньому меню відкрийте Розширення (Extensions) -> Apps Script.
	Вставте наступний код і збережіть проєкт:

	function doPost(e) {
	  try {
		// Отримуємо email користувача, який викликав скрипт
		const activeUserEmail = Session.getActiveUser().getEmail();

		// Відкриваємо активну таблицю
		const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

		const data = JSON.parse(e.postData.contents);

		// Записуємо дату, категорію, суму та реальний Google Email того, хто вніс запис
		sheet.appendRow([
		  new Date(),
		  data.category,
		  Number(data.amount),
		  activeUserEmail // Google сам підставить email (вашій чи дружини)
		]);

		return ContentService.createTextOutput(JSON.stringify({ status: 'success' }))
		  .setMimeType(ContentService.MimeType.JSON);

	  } catch (err) {
		return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
		  .setMimeType(ContentService.MimeType.JSON);
	  }
	}

	Натисніть кнопку Розгорнути (Deploy) -> Нове розгортання (New deployment).
	Виберіть тип: Веб-застосунок (Web app).
	Execute as (Виконувати від імені): виберіть User accessing the web app (Користувач, який відкриває веб-застосунок).
	Who has access (Хто має доступ): виберіть Anyone with Google account (Будь-хто з акаунтом Google) або Only users within account.
	Натисніть Deploy, надайте дозволи та скопіюйте Web App URL (він знадобиться для JS-коду).