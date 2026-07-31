const API_TOKEN = 'YOUR_SECRET_TOKEN';

const CONFIG = {
  mainSheetName: 'Цены iPad',
  logSheetName: 'Лог',

  minPrice: 40000,
  maxPrice: 150000,

  // Если цена изменилась более чем на 35%, скрипт не запишет её автоматически.
  maxPriceChange: 0.35,

  products: [
    {
      id: 'pitergsm-purple',
      columnName: 'PiterGSM — Purple',
      store: 'pitergsm',
      url: 'https://pitergsm.ru/catalog/tablets/ipad/ipad-air/ipad-air-11-2025/64139/',
      expectedTokens: [
        'ipad air',
        '11',
        '256',
        'фиолет'
      ]
    },
    {
      id: 'dns-purple',
      columnName: 'DNS — Purple',
      store: 'dns',
      url: 'https://www.dns-shop.ru/product/959bbaf7f97ad21a/11-planset-apple-ipad-air-m3-wi-fi-256-gb-fioletovyj/',
      expectedTokens: [
        'ipad air',
        'm3',
        '256',
        'фиолет'
      ]
    },
    {
      id: 'unit-purple',
      columnName: 'Unit Store — Purple',
      store: 'unit',
      url: 'https://spb.unit-store.com/catalog/apple/ipad/ipad-air-m3-2025/ipad-air-m3-11-/apple-ipad-air-m3-2025-11-256-gb-wi-fi-fioletovyy/',
      expectedTokens: [
        'ipad air',
        'm3',
        '256',
        'фиолет'
      ]
    },
    {
      id: 'ipiter-purple',
      columnName: 'iPiter — Purple',
      store: 'ipiter',
      url: 'https://ipiter.ru/shop/apple_ipad_air_7_2025_11_dyujmov_wi-fi_256gb_purple',
      expectedTokens: [
        'ipad air',
        '2025',
        '256',
        'purple'
      ]
    },
    {
      id: 'ipiter-blue',
      columnName: 'iPiter — Blue',
      store: 'ipiter',
      url: 'https://ipiter.ru/shop/apple_ipad_air_7_2025_11_dyujmov_wi-fi_256gb_color_blue',
      expectedTokens: [
        'ipad air',
        '2025',
        '256',
        'blue'
      ]
    }
  ]
};


/**
 * Основная ежедневная функция.
 */
/**
 * Ручной запуск без данных от Python.
 * DNS в таком случае вернёт «Не удалось получить».
 */
function collectPrices() {
  collectPricesWithBrowserResults_(null, null);
}


/**
 * Собирает все магазины и при необходимости
 * использует результат DNS, полученный из Python.
 */
function collectPricesWithBrowserResults_(dnsResult, unitResult) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error('Другой сбор цен уже выполняется.');
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const mainSheet = getOrCreateMainSheet_(spreadsheet);
    const logSheet = getOrCreateLogSheet_(spreadsheet);

    const row = [new Date()];

    CONFIG.products.forEach((product, index) => {
      let result;

      if (product.store === 'dns' && dnsResult) {
        result = dnsResult;

      } else if (product.store === 'unit' && unitResult) {
        result = unitResult;

      } else {
        result = processProduct_(product);
      }

      const checkedResult = validateAgainstHistory_(
        mainSheet,
        index + 2,
        result
      );

      row.push(resultToCellValue_(checkedResult));
      writeLog_(logSheet, product, checkedResult);
    });

    mainSheet.appendRow(row);

    const lastRow = mainSheet.getLastRow();

    mainSheet
      .getRange(lastRow, 1)
      .setNumberFormat('dd.MM.yyyy HH:mm');

    for (let column = 2; column <= row.length; column++) {
      if (typeof row[column - 1] === 'number') {
        mainSheet
          .getRange(lastRow, column)
          .setNumberFormat('0');
      }
    }

    return {
      success: true,
      row: lastRow,
      values: row
    };

  } finally {
    lock.releaseLock();
  }
}


/**
 * Запрашивает страницу и передаёт её обработчику конкретного магазина.
 */
function processProduct_(product) {
  try {
    const page = fetchPage_(product.url);

    if (page.statusCode < 200 || page.statusCode >= 400) {
      return makeResult_(
        'error',
        null,
        `Сайт вернул HTTP ${page.statusCode}`,
        page.statusCode
      );
    }

    const pageProblem = detectBlockedOrBrokenPage_(page.html);

    if (pageProblem) {
      return makeResult_(
        'error',
        null,
        pageProblem,
        page.statusCode
      );
    }

    const identityProblem = validateProductIdentity_(
      page.html,
      product.expectedTokens
    );

    if (identityProblem) {
      return makeResult_(
        'error',
        null,
        identityProblem,
        page.statusCode
      );
    }

    let result;

    switch (product.store) {
      case 'pitergsm':
        result = parsePiterGSM_(page.html);
        break;

      case 'unit':
        result = parseUnitStore_(page.html);
        break;

      case 'ipiter':
        result = parseIPiter_(page.html);
        break;

      case 'dns':
        result = parseDNS_(page.html);
        break;

      default:
        result = makeResult_(
          'error',
          null,
          `Неизвестный магазин: ${product.store}`,
          page.statusCode
        );
    }

    result.httpCode = page.statusCode;

    if (result.status === 'available') {
      const priceProblem = validatePrice_(result.price);

      if (priceProblem) {
        return makeResult_(
          'error',
          null,
          priceProblem,
          page.statusCode
        );
      }
    }

    return result;

  } catch (error) {
    return makeResult_(
      'error',
      null,
      error.message || String(error),
      null
    );
  }
}


/**
 * Получает исходный HTML.
 */
function fetchPage_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,

    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/150.0.0.0 Safari/537.36',

      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,*/*;q=0.8',

      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',

      'Cache-Control': 'no-cache'
    }
  });

  return {
    statusCode: response.getResponseCode(),
    html: response.getContentText('UTF-8')
  };
}


/**
 * PiterGSM:
 * наличие проверяем раньше цены.
 */
function parsePiterGSM_(html) {
  const mainBlock = extractMainProductBlock_(
    html,
    'Планшет Apple iPad Air',
    'Защитите устройство'
  );

  const text = htmlToText_(mainBlock);

  if (
    containsAny_(text, [
      'сообщить о поступлении',
      'нет в наличии',
      'товар отсутствует',
      'ожидается поступление'
    ])
  ) {
    return makeResult_(
      'out_of_stock',
      null,
      'На основной карточке найден признак отсутствия товара'
    );
  }

  const available = containsAny_(text, [
    'в наличии',
    'добавить в корзину',
    'в корзину'
  ]);

  if (!available) {
    return makeResult_(
      'error',
      null,
      'Не удалось достоверно определить наличие PiterGSM'
    );
  }

  /*
   * Цена ищется только внутри основного блока и только до дополнительных
   * услуг и рекомендаций.
   */
  const price = extractFirstPrice_(text, [
    /(\d{2,3}(?:[\s\u00A0]\d{3})+)\s*₽/i,
    /(\d{5,6})\s*₽/i
  ]);

  if (price === null) {
    return makeResult_(
      'error',
      null,
      'Товар доступен, но цена PiterGSM не найдена в основной карточке'
    );
  }

  return makeResult_(
    'available',
    price,
    'Цена найдена в основной карточке PiterGSM'
  );
}


/**
 * Unit Store:
 * цена должна стоять перед «₽/шт» в основном блоке.
 */

function parseUnitStore_(html) {
  const source = String(html)
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/\u00A0/g, ' ');

  /*
   * Находим заголовок именно нужного товара.
   */
  const titleMatch = source.match(
    /<h1[^>]*>[\s\S]*?Apple\s+iPad\s+Air\s+M3\s+2025[\s\S]*?11[\s\S]*?256[\s\S]*?Wi-?Fi[\s\S]*?фиолетов[\s\S]*?<\/h1>/i
  );

  if (!titleMatch || titleMatch.index === undefined) {
    return makeResult_(
      'error',
      null,
      'Не найден заголовок нужного товара Unit Store'
    );
  }

  /*
   * Цена расположена вскоре после h1.
   * Ограничиваем область поиска, чтобы не взять цену похожего товара.
   */
  const productBlock = source.substring(
    titleMatch.index,
    titleMatch.index + 25000
  );

  const productText = htmlToText_(productBlock);

  /*
   * Сначала явное отсутствие.
   */
  if (
    containsAny_(productText, [
      'нет в наличии',
      'сообщить о поступлении',
      'товар отсутствует',
      'ожидается поступление'
    ])
  ) {
    return makeResult_(
      'out_of_stock',
      null,
      'Unit Store сообщает об отсутствии товара'
    );
  }

  /*
   * Подтверждаем наличие.
   */
  if (!containsAny_(productText, ['в наличии'])) {
    return makeResult_(
      'error',
      null,
      'Не найден подтверждённый статус наличия Unit Store'
    );
  }

  let price = null;

  /*
   * Основной и самый надёжный вариант со скрина:
   *
   * <div class="price ..."
   *      data-currency="RUB"
   *      data-value="69290">
   *
   * Порядок атрибутов иногда может меняться,
   * поэтому предусмотрены оба варианта.
   */
  let match = productBlock.match(
    /class=["'][^"']*\bprice\b[^"']*["'][^>]*data-currency=["']RUB["'][^>]*data-value=["'](\d{5,6})["']/i
  );

  if (!match) {
    match = productBlock.match(
      /class=["'][^"']*\bprice\b[^"']*["'][^>]*data-value=["'](\d{5,6})["'][^>]*data-currency=["']RUB["']/i
    );
  }

  /*
   * Запасной вариант: структурированная цена content="69290".
   */
  if (!match) {
    match = productBlock.match(
      /itemprop=["']price["'][^>]*content=["'](\d{5,6})["']/i
    );
  }

  if (!match) {
    match = productBlock.match(
      /content=["'](\d{5,6})["'][^>]*itemprop=["']price["']/i
    );
  }

  /*
   * Ещё один запасной вариант из JSON страницы.
   */
  if (!match) {
    match = productBlock.match(
      /["'](?:PRICE|price)["']\s*:\s*["'](\d{5,6})["']/i
    );
  }

  if (match) {
    price = Number(match[1]);
  }

  if (!Number.isFinite(price)) {
    return makeResult_(
      'error',
      null,
      'Цена Unit Store не найдена в data-value, content или JSON'
    );
  }

  return makeResult_(
    'available',
    price,
    'Цена взята из атрибута карточки Unit Store; наличие подтверждено'
  );
}


/**
 * iPiter:
 * берём цену непосредственно перед текстом
 * «со скидкой за наличные».
 */

function parseIPiter_(html) {
  /*
   * На iPiter цена основного товара записана примерно так:
   *
   * 76<u>330</u>
   *
   * Поэтому ищем цену в исходном HTML, а не в очищенном тексте.
   */

  const normalizedHtml = String(html)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\u00A0/g, ' ');

  /*
   * Находим основной блок покупки товара.
   * Он начинается с id="buyBlock".
   */
  const buyBlockMatch = normalizedHtml.match(
    /<div[^>]+id=["']buyBlock["'][\s\S]*?(?=<div[^>]+class=["'][^"']*(?:accessories|similar|recommend)|$)/i
  );

  const buyBlock = buyBlockMatch
    ? buyBlockMatch[0]
    : normalizedHtml;

  const buyBlockText = htmlToText_(buyBlock);

  /*
   * Явные признаки отсутствия товара.
   */
  if (
    containsAny_(buyBlockText, [
      'нет в наличии',
      'сообщить о поступлении',
      'товар закончился',
      'нет на складе'
    ])
  ) {
    return makeResult_(
      'out_of_stock',
      null,
      'iPiter сообщает об отсутствии товара'
    );
  }

  /*
   * Подтверждаем, что в блоке основного товара есть кнопка покупки.
   */
  const hasAddToCart =
    /добавить\s+в\s+корзину/i.test(buyBlockText) ||
    /id=["']addbutton["']/i.test(buyBlock) ||
    /class=["'][^"']*\bgreen\b[^"']*["']/i.test(buyBlock);

  if (!hasAddToCart) {
    return makeResult_(
      'error',
      null,
      'У основного товара iPiter не найдена кнопка добавления в корзину'
    );
  }

  /*
   * Основной формат iPiter:
   *
   * 76<u>330</u>
   * 67<u>460</u>
   *
   * Первая группа — тысячи, вторая — последние три цифры.
   */
  let match = buyBlock.match(
    /(?:^|[^\d])(\d{2,3})\s*<u[^>]*>\s*(\d{3})\s*<\/u>/i
  );

  let price = null;

  if (match) {
    price = Number(match[1] + match[2]);
  }

  /*
   * Запасной вариант: после удаления тегов цена может выглядеть
   * как «76 330».
   */
  if (!Number.isFinite(price)) {
    match = buyBlockText.match(
      /(?:^|[^\d])(\d{2,3})\s+(\d{3})(?:\s*₽|\s*руб|\s|$)/i
    );

    if (match) {
      price = Number(match[1] + match[2]);
    }
  }

  if (!Number.isFinite(price)) {
    return makeResult_(
      'error',
      null,
      'Цена основного товара iPiter не найдена'
    );
  }

  return makeResult_(
    'available',
    price,
    'Цена найдена в основном блоке iPiter; кнопка покупки присутствует'
  );
}


/**
 * DNS:
 * в HTML, который получает Apps Script, сейчас нет достоверной
 * цены и статуса наличия.
 *
 * Поэтому здесь нельзя возвращать случайное число или делать вывод,
 * что товара нет.
 */
function parseDNS_(html) {
  const text = htmlToText_(html);

  /*
   * На случай, если DNS в будущем начнёт отдавать явный статус
   * отсутствия товара в исходном HTML.
   */
  if (
    containsAny_(text, [
      'товара нет в наличии',
      'нет в наличии',
      'товар закончился',
      'временно отсутствует'
    ])
  ) {
    return makeResult_(
      'out_of_stock',
      null,
      'DNS явно сообщил об отсутствии товара'
    );
  }

  /*
   * Не используем общий поиск цены:
   * в HTML могут быть посторонние числа, характеристики,
   * идентификаторы и рекламные блоки.
   */
  return makeResult_(
    'error',
    null,
    'DNS не передал Apps Script подтверждённые данные о цене и наличии'
  );
}


/**
 * Проверяет, что магазин не вернул капчу, заглушку или ошибку.
 */
function detectBlockedOrBrokenPage_(html) {
  if (!html || html.length < 500) {
    return 'Получена пустая или слишком короткая страница';
  }

  const text = htmlToText_(html);

  const blockedMarkers = [
    'доступ ограничен',
    'access denied',
    'forbidden',
    'captcha',
    'подтвердите, что вы не робот',
    'проверка браузера',
    'cloudflare ray id',
    'слишком много запросов'
  ];

  if (containsAny_(text, blockedMarkers)) {
    return 'Магазин заблокировал автоматический запрос';
  }

  return null;
}


/**
 * Проверяет, что пришла страница нужного iPad,
 * а не капча, каталог или другой товар.
 */
function validateProductIdentity_(html, expectedTokens) {
  const text = htmlToText_(html);

  const missingTokens = expectedTokens.filter(token =>
    !text.includes(normalizeText_(token))
  );

  if (missingTokens.length > 0) {
    return (
      'Страница не прошла проверку товара. ' +
      'Не найдены признаки: ' +
      missingTokens.join(', ')
    );
  }

  return null;
}


/**
 * Проверка допустимого диапазона.
 */
function validatePrice_(price) {
  if (!Number.isFinite(price)) {
    return 'Полученная цена не является числом';
  }

  if (price < CONFIG.minPrice || price > CONFIG.maxPrice) {
    return (
      `Подозрительная цена: ${price}. ` +
      `Допустимый диапазон: ${CONFIG.minPrice}–${CONFIG.maxPrice}`
    );
  }

  return null;
}


/**
 * Сравнивает новую цену с последней числовой ценой в колонке.
 */
function validateAgainstHistory_(sheet, column, result) {
  if (result.status !== 'available') {
    return result;
  }

  const previousPrice = findLastNumericValue_(sheet, column);

  if (previousPrice === null) {
    return result;
  }

  const change = Math.abs(result.price - previousPrice) / previousPrice;

  if (change > CONFIG.maxPriceChange) {
    return makeResult_(
      'suspicious',
      null,
      `Цена изменилась с ${previousPrice} до ${result.price}, ` +
      `что больше допустимых ${Math.round(CONFIG.maxPriceChange * 100)}%`,
      result.httpCode
    );
  }

  return result;
}


/**
 * Находит последнюю числовую цену в колонке.
 */
function findLastNumericValue_(sheet, column) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return null;
  }

  const values = sheet
    .getRange(2, column, lastRow - 1, 1)
    .getValues();

  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index][0];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}


/**
 * Вырезает основной блок карточки между двумя текстовыми признаками.
 */
function extractMainProductBlock_(html, startMarker, endMarker) {
  const lowerHtml = html.toLowerCase();

  const startIndex = lowerHtml.indexOf(startMarker.toLowerCase());

  if (startIndex === -1) {
    return html;
  }

  const endIndex = lowerHtml.indexOf(
    endMarker.toLowerCase(),
    startIndex + startMarker.length
  );

  if (endIndex === -1) {
    return html.substring(startIndex);
  }

  return html.substring(startIndex, endIndex);
}


/**
 * Извлекает первую цену по строго заданным шаблонам.
 */
function extractFirstPrice_(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const price = normalizePrice_(match[1]);

    if (Number.isFinite(price)) {
      return price;
    }
  }

  return null;
}


/**
 * Преобразует «69 290» в число 69290.
 */
function normalizePrice_(value) {
  const cleaned = String(value)
    .replace(/\u00A0/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d]/g, '');

  if (!cleaned) {
    return null;
  }

  const price = Number(cleaned);

  return Number.isFinite(price) ? price : null;
}


/**
 * Преобразует HTML в обычный текст.
 */
function htmlToText_(html) {
  return normalizeText_(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
  );
}


/**
 * Нормализует текст для поиска.
 */
function normalizeText_(value) {
  return String(value)
    .toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function containsAny_(text, variants) {
  const normalizedText = normalizeText_(text);

  return variants.some(variant =>
    normalizedText.includes(normalizeText_(variant))
  );
}


function makeResult_(status, price, message, httpCode) {
  return {
    status: status,
    price: price,
    message: message || '',
    httpCode: httpCode || ''
  };
}


function resultToCellValue_(result) {
  switch (result.status) {
    case 'available':
      return result.price;

    case 'out_of_stock':
      return 'Нет в наличии';

    case 'suspicious':
      return 'Проверить вручную';

    case 'error':
    default:
      return 'Не удалось получить';
  }
}


/**
 * Создаёт основной лист.
 */
function getOrCreateMainSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(CONFIG.mainSheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.mainSheetName);
  }

  const headers = [
    'Дата',
    ...CONFIG.products.map(product => product.columnName)
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    /*
     * Обновляет заголовки, если добавили новый товар.
     */
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 150);

  for (let column = 2; column <= headers.length; column++) {
    sheet.setColumnWidth(column, 165);
  }

  return sheet;
}


/**
 * Создаёт лист технического журнала.
 */
function getOrCreateLogSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(CONFIG.logSheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.logSheetName);
  }

  const headers = [
    'Дата',
    'Товар',
    'Магазин',
    'Статус',
    'Цена',
    'HTTP-код',
    'Причина',
    'Ссылка'
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}


function writeLog_(sheet, product, result) {
  sheet.appendRow([
    new Date(),
    product.columnName,
    product.store,
    result.status,
    result.price === null ? '' : result.price,
    result.httpCode,
    result.message,
    product.url
  ]);

  const lastRow = sheet.getLastRow();

  sheet
    .getRange(lastRow, 1)
    .setNumberFormat('dd.MM.yyyy HH:mm:ss');

  if (typeof result.price === 'number') {
    sheet
      .getRange(lastRow, 5)
      .setNumberFormat('0');  }
}


/**
 * Тест без записи в основную таблицу.
 * Результаты выводятся в журнал выполнения Apps Script.
 */
function testAllProducts() {
  CONFIG.products.forEach(product => {
    const result = processProduct_(product);

    console.log(
      JSON.stringify({
        product: product.columnName,
        status: result.status,
        price: result.price,
        message: result.message,
        httpCode: result.httpCode
      })
    );
  });
}


/**
 * Один раз запускается вручную после успешной проверки.
 */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger =>
      trigger.getHandlerFunction() === 'collectPrices'
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp
    .newTrigger('collectPrices')
    .timeBased()
    .atHour(11)
    .nearMinute(0)
    .everyDays(1)
    .create();
}


/**
 * Удаляет ежедневный триггер, если потребуется остановить сбор.
 */
function deleteDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger =>
      trigger.getHandlerFunction() === 'collectPrices'
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function diagnoseDynamicStores() {
  const stores = [
    {
      name: 'iPiter Purple',
      url: 'https://ipiter.ru/shop/apple_ipad_air_7_2025_11_dyujmov_wi-fi_256gb_purple'
    },
    {
      name: 'iPiter Blue',
      url: 'https://ipiter.ru/shop/apple_ipad_air_7_2025_11_dyujmov_wi-fi_256gb_color_blue'
    },
    {
      name: 'DNS',
      url: 'https://www.dns-shop.ru/product/959bbaf7f97ad21a/11-planset-apple-ipad-air-m3-wi-fi-256-gb-fioletovyj/'
    }
  ];

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  let sheet = spreadsheet.getSheetByName('Диагностика HTML');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('Диагностика HTML');
  }

  sheet.clear();

  sheet.appendRow([
    'Магазин',
    'Длина HTML',
    'Найдены числа 40–150 тыс.',
    'Фрагменты рядом с price',
    'Фрагменты рядом с наличием'
  ]);

  stores.forEach(store => {
    try {
      const page = fetchPage_(store.url);
      const html = page.html;

      const prices = findPossiblePricesInHtml_(html);
      const priceFragments = findFragments_(html, [
        'price',
        'currentprice',
        'saleprice',
        'finalprice',
        'productprice'
      ]);

      const stockFragments = findFragments_(html, [
        'налич',
        'stock',
        'available',
        'availability',
        'quantity'
      ]);

      sheet.appendRow([
        store.name,
        html.length,
        prices.join(', '),
        priceFragments.join('\n\n').substring(0, 45000),
        stockFragments.join('\n\n').substring(0, 45000)
      ]);

    } catch (error) {
      sheet.appendRow([
        store.name,
        '',
        '',
        '',
        'Ошибка: ' + error.message
      ]);
    }
  });

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 250);
  sheet.setColumnWidth(4, 600);
  sheet.setColumnWidth(5, 600);
}


function findPossiblePricesInHtml_(html) {
  const normalized = String(html)
    .replace(/\\u00a0/gi, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\u00A0/g, ' ');

  const matches = normalized.match(
    /(?:^|[^\d])(\d{2,3}(?:[\s.,]\d{3})|\d{5,6})(?:[^\d]|$)/g
  ) || [];

  const prices = matches
    .map(value => normalizePrice_(value))
    .filter(value =>
      Number.isFinite(value) &&
      value >= CONFIG.minPrice &&
      value <= CONFIG.maxPrice
    );

  return [...new Set(prices)];
}


function findFragments_(html, keywords) {
  const source = String(html);
  const lower = source.toLowerCase();
  const fragments = [];

  keywords.forEach(keyword => {
    let position = 0;
    let count = 0;

    while (count < 10) {
      const index = lower.indexOf(keyword.toLowerCase(), position);

      if (index === -1) {
        break;
      }

      const from = Math.max(0, index - 250);
      const to = Math.min(source.length, index + 500);

      fragments.push(
        `[${keyword}] ` +
        source
          .substring(from, to)
          .replace(/\s+/g, ' ')
      );

      position = index + keyword.length;
      count++;
    }
  });

  return fragments;
}

function diagnoseUnitStore() {
  const url =
    'https://unit-store.com/catalog/apple/ipad/ipad-air-m3-2025/ipad-air-m3-11-/apple-ipad-air-m3-2025-11-256-gb-wi-fi-fioletovyy/';

  const page = fetchPage_(url);
  const html = String(page.html);

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  let sheet = spreadsheet.getSheetByName('Диагностика Unit Store');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('Диагностика Unit Store');
  }

  sheet.clear();

  sheet.appendRow([
    'Тип',
    'Найденное значение',
    'Фрагмент HTML'
  ]);

  const searches = [
    {
      type: 'Слово price',
      regex: /price/gi
    },
    {
      type: 'Знак рубля',
      regex: /₽|&#8381;|&#x20bd;|\\u20bd/gi
    },
    {
      type: 'Возможная цена',
      regex: /\d{2,3}(?:[\s\u00A0]|&nbsp;|&#160;|<[^>]+>)*\d{3}/gi
    },
    {
      type: 'Наличие',
      regex: /в наличии|нет в наличии|сообщить о поступлении/gi
    },
    {
      type: 'Корзина',
      regex: /в корзину|добавить в корзину|buy|basket|cart/gi
    }
  ];

  searches.forEach(search => {
    let match;
    let count = 0;

    while (
      (match = search.regex.exec(html)) !== null &&
      count < 30
    ) {
      const start = Math.max(0, match.index - 350);
      const end = Math.min(
        html.length,
        match.index + match[0].length + 500
      );

      const fragment = html
        .substring(start, end)
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ');

      sheet.appendRow([
        search.type,
        match[0],
        fragment
      ]);

      count++;
    }
  });

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 900);

  console.log(
    'Диагностика завершена. Длина HTML: ' + html.length
  );
}

/**
 * Принимает данные DNS из Python.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({
        success: false,
        error: 'Пустой запрос'
      });
    }

    const data = JSON.parse(e.postData.contents);

    if (data.token !== API_TOKEN) {
      return jsonResponse_({
        success: false,
        error: 'Неверный токен'
      });
    }

    const dnsResult = validateBrowserPayload_(
      data.dnsStatus,
      data.dnsPrice,
      data.dnsMessage,
      'DNS'
    );

    const unitResult = validateBrowserPayload_(
      data.unitStatus,
      data.unitPrice,
      data.unitMessage,
      'Unit Store'
    );

    const result = collectPricesWithBrowserResults_(
      dnsResult,
      unitResult
    );

    return jsonResponse_({
      success: true,
      row: result.row,
      dnsStatus: dnsResult.status,
      dnsPrice: dnsResult.price,
      unitStatus: unitResult.status,
      unitPrice: unitResult.price
    });

  } catch (error) {
    return jsonResponse_({
      success: false,
      error: error.message || String(error)
    });
  }
}

/**
 * Проверяет данные, присланные Python.
 */

function validateBrowserPayload_(
  status,
  rawPrice,
  message,
  storeName
) {
  const allowedStatuses = [
    'available',
    'out_of_stock',
    'error'
  ];

  if (!allowedStatuses.includes(status)) {
    throw new Error(
      'Некорректный статус ' + storeName + ': ' + status
    );
  }

  if (status === 'available') {
    const price = Number(rawPrice);

    if (!Number.isFinite(price)) {
      throw new Error(
        'Цена ' + storeName + ' не является числом'
      );
    }

    if (
      price < CONFIG.minPrice ||
      price > CONFIG.maxPrice
    ) {
      throw new Error(
        'Цена ' + storeName +
        ' вне допустимого диапазона: ' +
        price
      );
    }

    return makeResult_(
      'available',
      price,
      message || 'Цена получена через Python',
      200
    );
  }

  if (status === 'out_of_stock') {
    return makeResult_(
      'out_of_stock',
      null,
      message || storeName + ': товар отсутствует',
      200
    );
  }

  return makeResult_(
    'error',
    null,
    message || storeName + ': не удалось получить данные',
    200
  );
}


function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
