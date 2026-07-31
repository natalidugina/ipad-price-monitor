from __future__ import annotations

import os

import requests
from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()

DNS_URL = (
    "https://www.dns-shop.ru/product/"
    "959bbaf7f97ad21a/"
    "11-planset-apple-ipad-air-m3-wi-fi-256-gb-fioletovyj/"
)

UNIT_URL = (
    "https://spb.unit-store.com/catalog/apple/ipad/"
    "ipad-air-m3-2025/ipad-air-m3-11-/apple-ipad-air-m3-"
    "2025-11-256-gb-wi-fi-fioletovyy/"
)

APPS_SCRIPT_URL = os.getenv("APPS_SCRIPT_URL")
API_TOKEN = os.getenv("API_TOKEN")

if not APPS_SCRIPT_URL:
    raise RuntimeError(
        "В файле .env не найден APPS_SCRIPT_URL"
    )

if not API_TOKEN:
    raise RuntimeError(
        "В файле .env не найден API_TOKEN"
    )

def parse_price(text: str) -> int:
    digits = "".join(
        symbol
        for symbol in text
        if symbol.isdigit()
    )

    if not digits:
        raise ValueError(
            f"Не удалось разобрать цену: {text!r}"
        )

    price = int(digits)

    if not 40_000 <= price <= 150_000:
        raise ValueError(
            f"Подозрительная цена: {price}"
        )

    return price


def send_to_google_sheets(
    dns_status: str,
    dns_price: int | None,
    dns_message: str,
    unit_status: str,
    unit_price: int | None,
    unit_message: str,
) -> None:
    payload = {
        "token": API_TOKEN,

        "dnsStatus": dns_status,
        "dnsPrice": dns_price,
        "dnsMessage": dns_message,

        "unitStatus": unit_status,
        "unitPrice": unit_price,
        "unitMessage": unit_message,
    }

    print("\nОтправляю данные в Google Таблицу...")

    response = requests.post(
        APPS_SCRIPT_URL,
        json=payload,
        timeout=120,
    )

    print("HTTP-код Google:", response.status_code)
    print("Ответ Google:", response.text)

    response.raise_for_status()

    try:
        result = response.json()
    except ValueError as error:
        raise RuntimeError(
            "Google вернул не JSON: "
            f"{response.text[:500]}"
        ) from error

    if not result.get("success"):
        raise RuntimeError(
            "Apps Script сообщил об ошибке: "
            f"{result.get('error', result)}"
        )

    print(
        "Строка успешно добавлена:",
        result.get("row"),
    )


def collect_dns(
    page: Page,
) -> tuple[str, int | None, str]:
    print("\nОткрываю DNS...")

    try:
        page.goto(
            DNS_URL,
            wait_until="domcontentloaded",
            timeout=60_000,
        )

        try:
            page.wait_for_selector(
                ".product-buy__price, button.buy-btn",
                timeout=15_000,
            )
        except Exception:
            print(
                "DNS — цена и кнопка не появились за 15 секунд"
            )

        print("DNS открыт")
        print("Адрес DNS:", page.url)

        title = page.locator(
            "h1.product-card-top__title"
        ).first

        print(
            "DNS — найдено заголовков:",
            title.count(),
        )

        if title.count() == 0:
            raise RuntimeError(
                "Не найден заголовок карточки DNS"
            )

        title_text = title.text_content()

        if not title_text:
            raise RuntimeError(
                "Заголовок DNS найден, но он пустой"
            )

        print("DNS — заголовок:", title_text)

        normalized_title = title_text.lower()

        required_parts = [
            "ipad air",
            "256",
            "фиолет",
        ]

        missing_parts = [
            part
            for part in required_parts
            if part not in normalized_title
        ]

        if missing_parts:
            raise RuntimeError(
                "Открылась неправильная карточка DNS. "
                "Не найдены признаки: "
                + ", ".join(missing_parts)
            )

        product_card = title.locator(
            "xpath=ancestor::*[contains(@class, "
            "'product-card-top')][1]"
        )

        if product_card.count() == 0:
            product_card = page.locator(
                ".product-card-top"
            ).filter(
                has=title
            ).first

        if product_card.count() == 0:
            raise RuntimeError(
                "Не найден основной блок товара DNS"
            )

        card_text = (
            product_card.text_content() or ""
        ).lower()

        out_of_stock_markers = [
            "нет в наличии",
            "товар закончился",
            "временно отсутствует",
            "сообщить о поступлении",
            "нет в продаже",
        ]

        found_out_of_stock_marker = next(
            (
                marker
                for marker in out_of_stock_markers
                if marker in card_text
            ),
            None,
        )

        if found_out_of_stock_marker:
            print("DNS — статус: out_of_stock")
            print(
                "DNS — признак отсутствия:",
                found_out_of_stock_marker,
            )

            return (
                "out_of_stock",
                None,
                (
                    "В основной карточке DNS найден "
                    f"статус: {found_out_of_stock_marker}"
                ),
            )

        price_elements = page.locator(
            ".product-buy__price"
        )

        print(
            "DNS — найдено элементов цены:",
            price_elements.count(),
        )

        price_text = None

        for index in range(
            price_elements.count()
        ):
            candidate_text = (
                price_elements
                .nth(index)
                .text_content()
            )

            print(
                f"DNS — цена-кандидат {index}:",
                repr(candidate_text),
            )

            if (
                candidate_text
                and any(
                    symbol.isdigit()
                    for symbol in candidate_text
                )
            ):
                price_text = candidate_text
                break

        buttons = page.locator(
            "button.buy-btn"
        )

        print(
            "DNS — найдено кнопок покупки:",
            buttons.count(),
        )

        button_text = None

        for index in range(buttons.count()):
            candidate_text = (
                buttons
                .nth(index)
                .text_content()
            )

            print(
                f"DNS — кнопка-кандидат {index}:",
                repr(candidate_text),
            )

            if not candidate_text:
                continue

            normalized_button = (
                candidate_text
                .strip()
                .lower()
            )

            if any(
                marker in normalized_button
                for marker in [
                    "в корзину",
                    "в корзине",
                    "купить",
                ]
            ):
                button_text = normalized_button
                break

        if price_text and button_text:
            price = parse_price(price_text)

            print("DNS — статус: available")
            print("DNS — цена:", price)
            print("DNS — кнопка:", button_text)

            return (
                "available",
                price,
                (
                    "Цена получена из карточки DNS; "
                    f"кнопка: {button_text}"
                ),
            )

        details = []

        if not price_text:
            details.append(
                "не найден числовой блок цены"
            )

        if not button_text:
            details.append(
                "не найдена активная кнопка покупки"
            )

        raise RuntimeError(
            "Не удалось определить состояние DNS: "
            + "; ".join(details)
        )

    except Exception as error:
        message = str(error)

        print("DNS — статус: error")
        print("DNS — ошибка:", message)

        try:
            page.screenshot(
                path="dns_error.png",
                full_page=True,
            )
        except Exception:
            pass

        return (
            "error",
            None,
            message,
        )


def collect_unit_store(
    page: Page,
) -> tuple[str, int | None, str]:
    print("\nОткрываю Unit Store...")

    try:
        page.goto(
            UNIT_URL,
            wait_until="domcontentloaded",
            timeout=60_000,
        )

        page.wait_for_timeout(4_000)

        # Если Unit Store спрашивает город — выбираем Санкт-Петербург автоматически.
        body_text = (page.locator("body").text_content() or "").lower()

        if "ваш город москва" in body_text:
            print(
                "Unit Store предлагает Москву — "
                "переключаю на Санкт-Петербург..."
            )

            choose_other = page.locator(
                ".js_city_change:visible"
            ).first

            choose_other.wait_for(
                state="visible",
                timeout=15_000,
            )

            try:
                choose_other.click(timeout=5_000)
            except Exception:
                print(
                    "Unit Store — попап перекрыл кнопку, "
                    "нажимаю принудительно..."
                )
                choose_other.click(force=True).click()

            city_option = page.get_by_text(
                "Санкт-Петербург",
                exact=True,
            ).first

            city_option.wait_for(
                state="visible",
                timeout=15_000,
            )

            try:
                city_option.click(timeout=5_000)
            except Exception:
                print(
                    "Unit Store — попап перекрыл выбор города, "
                    "нажимаю принудительно..."
                )
                city_option.click(force=True)

            page.wait_for_timeout(5_000)

            print(
                "Unit Store переключён "
                "на Санкт-Петербург"
            )

        print("Unit Store открыт")
        print("Адрес Unit Store:", page.url)

        body_text = (
            page.locator("body").text_content()
            or ""
        )

        normalized_body = body_text.lower()

        # Не позволяем записать московскую цену как петербургскую.
        if "ваш город москва" in normalized_body:
            raise RuntimeError(
                "Unit Store предлагает город Москва. "
                "В специальном Chrome нужно выбрать "
                "Санкт-Петербург и обновить страницу."
            )

        title = page.locator("h1").first

        if title.count() == 0:
            raise RuntimeError(
                "Не найден заголовок Unit Store"
            )

        title_text = title.text_content() or ""

        print(
            "Unit Store — заголовок:",
            title_text,
        )

        normalized_title = title_text.lower()

        required_parts = [
            "ipad air",
            "256",
        ]

        missing_parts = [
            part
            for part in required_parts
            if part not in normalized_title
        ]

        if missing_parts:
            raise RuntimeError(
                "Открылась неправильная карточка "
                "Unit Store. Не найдены признаки: "
                + ", ".join(missing_parts)
            )

        # Пробуем взять крупный контейнер товара,
        # чтобы не спутать статус с рекомендациями.
        product_block = title.locator(
            "xpath=ancestor::*["
            ".//*[contains(text(), 'Артикул')]"
            "][1]"
        )

        if product_block.count() > 0:
            product_text = (
                product_block.text_content()
                or ""
            ).lower()
        else:
            # Запасной вариант, если сайт поменяет контейнер.
            product_text = normalized_body

        out_of_stock_markers = [
            "нет в наличии",
            "товар отсутствует",
            "временно отсутствует",
            "сообщить о поступлении",
            "нет в продаже",
        ]

        found_marker = next(
            (
                marker
                for marker in out_of_stock_markers
                if marker in product_text
            ),
            None,
        )

        if found_marker:
            print(
                "Unit Store — статус: out_of_stock"
            )
            print(
                "Unit Store — признак отсутствия:",
                found_marker,
            )

            return (
                "out_of_stock",
                None,
                (
                    "Unit Store, Санкт-Петербург: "
                    f"найден статус «{found_marker}»"
                ),
            )

        price_elements = page.locator(
            "[data-value]"
        )

        print(
            "Unit Store — элементов data-value:",
            price_elements.count(),
        )

        price = None

        for index in range(
            price_elements.count()
        ):
            raw_value = (
                price_elements
                .nth(index)
                .get_attribute("data-value")
            )

            if not raw_value:
                continue

            cleaned_value = "".join(
                symbol
                for symbol in raw_value
                if symbol.isdigit()
            )

            if not cleaned_value:
                continue

            candidate_price = int(
                cleaned_value
            )

            if (
                40_000
                <= candidate_price
                <= 150_000
            ):
                price = candidate_price

                print(
                    "Unit Store — цена-кандидат:",
                    candidate_price,
                )

                break

        buy_markers = [
            "в корзину",
            "купить",
        ]

        has_buy_marker = any(
            marker in product_text
            for marker in buy_markers
        )

        if (
            price is not None
            and has_buy_marker
        ):
            print(
                "Unit Store — статус: available"
            )
            print(
                "Unit Store — цена:",
                price,
            )

            return (
                "available",
                price,
                (
                    "Цена получена через Chrome; "
                    "выбран Санкт-Петербург"
                ),
            )

        details = []

        if price is None:
            details.append(
                "не найдена корректная цена"
            )

        if not has_buy_marker:
            details.append(
                "не найдена возможность покупки"
            )

        raise RuntimeError(
            "Не удалось определить состояние "
            "Unit Store: "
            + "; ".join(details)
        )

    except Exception as error:
        message = str(error)

        print("Unit Store — статус: error")
        print("Unit Store — ошибка:", message)

        try:
            page.screenshot(
                path="unit_store_error.png",
                full_page=True,
            )
        except Exception:
            pass

        return (
            "error",
            None,
            message,
        )


def main() -> None:
    with sync_playwright() as playwright:
        print("Подключаюсь к Chrome...")

        browser = (
            playwright.chromium
            .connect_over_cdp(
                "http://127.0.0.1:9222"
            )
        )

        print("Подключение выполнено")

        if not browser.contexts:
            raise RuntimeError(
                "Не найден открытый контекст Chrome"
            )

        context = browser.contexts[0]

        # Оба сайта получают отдельные вкладки,
        # но используют один сохранённый Chrome-профиль.
        dns_page = context.new_page()
        unit_page = context.new_page()

        try:
            (
                dns_status,
                dns_price,
                dns_message,
            ) = collect_dns(dns_page)

            (
                unit_status,
                unit_price,
                unit_message,
            ) = collect_unit_store(unit_page)

            print("\nИтоги проверки:")
            print(
                "DNS:",
                dns_status,
                dns_price,
            )
            print(
                "Unit Store:",
                unit_status,
                unit_price,
            )

            send_to_google_sheets(
                dns_status=dns_status,
                dns_price=dns_price,
                dns_message=dns_message,
                unit_status=unit_status,
                unit_price=unit_price,
                unit_message=unit_message,
            )

        finally:
            dns_page.close()
            unit_page.close()


if __name__ == "__main__":
    main()