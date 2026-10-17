/**
 * sw.js — офлайн-оболонка MoneyFlow.
 *
 * Роль вузька й свідома: **мережа перша, кеш запасний**. Тобто
 * при наявності мережі віддаємо те, що прийшло, і одночасно
 * оновлюємо кеш; без мережі віддаємо останнє відоме.
 *
 * Чому не «кеш перший». У проєкті немає збірки, тож в іменах
 * файлів немає відбитка вмісту, і «кеш перший» означав би, що
 * виправлення доходить до родини за тиждень, аж поки хтось не
 * видалить застосунок вручну. Мережа перша вбиває весь клас
 * таких проблем ціною одного запиту, а застосунок і так чекає на
 * мережу за знімком.
 *
 * Що не кешується: запити POST до Apps Script (вони й так
 * йдуть на інший домен), усе зовнішнє і некешовані відповіді.
 */

const CACHE_NAME = "moneyflow-shell-v1";

self.addEventListener("install", (event) => {
  // Оболонку не переносимо попередньо: вона і так завантажиться
  // першого ж відкриття. Список файлів у коді — це список,
  // який забувають оновити, а без нього кеш сам збирає все, що
  // реально потрібне.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Скрипт самого worker'а не з кешу: інакше нова версія
  // sw.js не потрапила б у браузер ніколи.
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(networkFirst(request));
});

/**
 * Мережа перша, кеш запасний.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });

  try {
    const response = await fetch(request);

    // Помилковий HTTP-відповідь — це для офлайну те саме, що
    // обрив: 502 від проксі, сторінка «піймав портал», збій CDN.
    // `fetch` тут не кидає, а віддає 5xx — і без цієї перевірки
    // користувач бачив би сторінку помилки замість свого бюджету.
    if (!response.ok) {
      if (cached) return cached;
      return response;
    }

    if (response.type === "basic") {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    // ignoreSearch: у запиті може бути query, якого в кеші немає
    // (перевірка версії, редирект із трекувальника). Це той самий
    // файл, тож мітка після «?» не має значення для офлайну.
    if (cached) return cached;

    // Офлайн, а такого файлу в кеші ще немає — перше відкриття
    // без мережі. Кажемо про це прямо, бо порожня сторінка
    // виглядала б як зламаний застосунок.
    return new Response("Офлайн, і цієї сторінки ще немає в кеші.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}