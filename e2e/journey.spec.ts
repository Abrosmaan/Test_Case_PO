import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Main user journey of a procurement specialist, through the real UI, server and database.
const TEST_DIR = join(import.meta.dirname, '..', 'Test Files');
type Upload = { name: string; mimeType: string; buffer: Buffer };
const txt = (name: string, text: string | Buffer): Upload => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const referenceFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.txt')).sort().map((f) => txt(f, readFileSync(join(TEST_DIR, f))));

const cell = (page: Page, contract: string, field: string) => page.locator(`td[data-contract="${contract}"][data-field="${field}"]`);
const row = (page: Page, contract: string) => page.locator('#contracts tr', { has: page.locator(`td b:text-is("${contract}")`) });

async function upload(page: Page, files: Upload[]) {
  await page.locator('#files').setInputFiles(files);
  await expect(page.locator('#drop')).not.toHaveClass(/busy/);
  await expect(page.locator('#upload-summary')).toContainText('Загружено');
}

test.beforeEach(async ({ page, request }) => {
  await request.delete('/api/documents');
  page.on('dialog', (d) => d.accept()); // «Удалить все?»
  await page.goto('/');
});

test('empty state explains the three steps', async ({ page }) => {
  await expect(page.locator('.steps .step')).toHaveText([/Загрузите документы/, /Выберите дату проверки/, /Проверьте источник/]);
  await expect(page.locator('#contracts')).toBeHidden();
});

test('batch upload: bad files are rejected with a reason, the rest are processed; re-upload is a duplicate', async ({ page }) => {
  await upload(page, [
    ...referenceFiles,
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    txt('empty.txt', '  \n'),
    { name: 'contract.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\x03\x04') },
    txt('huge.txt', Buffer.alloc(2 * 1024 * 1024, 0x41)), // used to fail the whole batch with "internal error"
  ]);
  const summary = page.locator('#upload-summary');
  await expect(summary).toContainText('Загружено 10 файлов');
  await expect(summary).toContainText('принято 6');
  await expect(summary).toContainText('отклонено 4');
  // Details are open when something was rejected.
  await expect(summary.locator('details')).toHaveAttribute('open', '');
  await expect(summary.locator('li.rejected')).toHaveText([
    'scan.pdf: Формат .pdf не поддерживается: загрузите файл .txt',
    'empty.txt: Файл пустой',
    'contract.docx: Формат .docx не поддерживается: загрузите файл .txt',
    'huge.txt: Файл больше 1024 КБ',
  ]);
  await expect(page.locator('#contracts tr')).toHaveCount(3);

  await upload(page, [referenceFiles[0]!]);
  await expect(summary).toContainText('уже были загружены: 1');
  await expect(page.locator('#documents tr')).toHaveCount(6);
});

test('drag & drop uploads at once', async ({ page }) => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['ДОГОВОР ПОСТАВКИ № STN-301\nСтатус: подписан обеими сторонами 01.02.2026.\n1.1. Поставщик: ООО «Тест».\n'
      + '2.1. Общая стоимость поставки составляет 10 000 рублей.\n3.1. Поставщик обязуется поставить товар не позднее 01.05.2026.'], 'dropped.txt'));
    document.getElementById('drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#upload-summary')).toContainText('принято 1');
  await expect(cell(page, 'STN-301', 'total_amount')).toContainText('10 000 ₽');
});

test.describe('with reference files', () => {
  test.beforeEach(async ({ page }) => {
    await upload(page, referenceFiles);
  });

  test('table matches the reference on 10.03.2026', async ({ page }) => {
    await expect(page.locator('#date-label')).toHaveText('10.03.2026');
    await expect(page.locator('#contracts tr')).toHaveCount(3);

    await expect(cell(page, 'STN-101', 'supplier')).toContainText('ООО «Вектор Прибор»');
    await expect(cell(page, 'STN-101', 'total_amount')).toContainText('1 380 000 ₽');
    await expect(cell(page, 'STN-101', 'total_amount')).toContainText('изменено ДС №1');
    await expect(cell(page, 'STN-101', 'delivery_date')).toContainText('30.04.2026');
    await expect(cell(page, 'STN-101', 'delivery_date')).toContainText('⚠');

    await expect(cell(page, 'STN-102', 'total_amount')).toHaveText('840 000 ₽');
    await expect(cell(page, 'STN-102', 'delivery_date')).toContainText('20.03.2026');

    await expect(cell(page, 'STN-103', 'supplier')).toContainText('ООО «ПромСнаб Сервис»');
    await expect(cell(page, 'STN-103', 'total_amount')).toHaveText('нет данных');
    await expect(cell(page, 'STN-103', 'delivery_date')).toHaveText('30.04.2026');

    await expect(row(page, 'STN-101')).toContainText('⚠ предложений: 2');
    await expect(row(page, 'STN-102')).toContainText('⚠ предложений: 1');
    await expect(page.locator('#unlinked')).toBeEmpty();
  });

  test('clicking a value opens the source with the highlighted quote and the change chain', async ({ page }) => {
    await expect(page.locator('#detail')).toBeHidden();
    await cell(page, 'STN-101', 'delivery_date').click();

    const detail = page.locator('#detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('h2')).toHaveText('STN-101 · Срок поставки: 30.04.2026');
    await expect(detail.locator('mark')).toHaveText('Поставщик обязуется поставить оборудование не позднее 30.04.2026');
    await expect(detail).toContainText('Цепочка изменений: 15.04.2026');
    await expect(detail).toContainText('02_amendment_signed.txt');
    await expect(detail).toContainText('10.05.2026 — Проект ДС №2');

    // A proposal's own source opens too.
    await detail.getByRole('button', { name: 'показать' }).first().click();
    await expect(detail.locator('mark')).toHaveText('2. Предлагается изменить срок поставки на 10.05.2026.');

    await detail.locator('#close-detail').click();
    await expect(detail).toBeHidden();
  });

  test('"нет данных" shows the reason from the text', async ({ page }) => {
    await cell(page, 'STN-103', 'total_amount').click();
    await expect(page.locator('#detail mark')).toContainText('Приложение № 1 в предоставленный комплект документов не входит');
  });

  test('the four reference questions', async ({ page }) => {
    const answer = page.locator('#answer');
    const select = page.locator('#q-contract');

    // 1. Срок STN-101 → 30.04.2026 (ДС №1)
    await select.selectOption('STN-101');
    await page.getByRole('button', { name: 'Срок поставки по договору' }).click();
    await expect(answer).toContainText('Срок поставки по STN-101 на 10.03.2026: 30.04.2026');
    await expect(answer).toContainText('изменено ДС №1');

    // 2. Сумма STN-102 → 840 000 ₽
    await select.selectOption('STN-102');
    await page.getByRole('button', { name: 'Сумма по договору' }).click();
    await expect(answer).toContainText('Сумма по STN-102 на 10.03.2026: 840 000 ₽');

    // 3. Сумма STN-103 → нет данных
    await select.selectOption('STN-103');
    await page.getByRole('button', { name: 'Сумма по договору' }).click();
    await expect(answer).toContainText('Сумма по STN-103 на 10.03.2026: нет данных');
    await expect(answer).toContainText('Приложение № 1');

    // 4. Поставка раньше 01.04.2026 → только STN-102, с несогласованным переносом из письма
    await page.locator('#q-before').fill('2026-04-01');
    await page.getByRole('button', { name: 'Найти' }).click();
    await expect(answer.locator('li')).toHaveCount(1);
    await expect(answer.locator('li')).toContainText('STN-102 — 20.03.2026');
    await expect(answer.locator('li')).toContainText('есть несогласованное изменение срока: 27.03.2026 (Письмо');
  });

  test('check date before amendment 1 → original contract values', async ({ page }) => {
    await page.locator('#check-date').fill('2026-02-28');
    await expect(page.locator('#date-label')).toHaveText('28.02.2026');
    await expect(cell(page, 'STN-101', 'total_amount')).toHaveText('1 200 000 ₽ ⚠');
    await expect(cell(page, 'STN-101', 'delivery_date')).toHaveText('15.04.2026 ⚠');
  });

  test('termination by a signed amendment', async ({ page }) => {
    await upload(page, [txt('ds2_termination.txt', 'ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 2 К ДОГОВОРУ STN-102\nДата: 05.03.2026\n'
      + 'Статус: подписано обеими сторонами 05.03.2026.\n1. Стороны договорились расторгнуть договор STN-102 с 06.03.2026.\n'
      + '2. Настоящее соглашение вступает в силу 05.03.2026.')]);

    await expect(row(page, 'STN-102')).toHaveClass(/terminated/);
    await expect(row(page, 'STN-102')).toContainText('расторгнут с 06.03.2026');

    await page.locator('#q-before').fill('2026-04-01');
    await page.getByRole('button', { name: 'Найти' }).click();
    await expect(page.locator('#answer')).toContainText('нет таких договоров');
    await expect(page.locator('#answer')).toContainText('Не учитываются — расторгнуты: STN-102');

    // Contract card shows the termination with its source.
    await page.locator('td[data-contract-detail="STN-102"]').click();
    await expect(page.locator('#detail')).toContainText('расторгнут с 06.03.2026');

    // Before the termination date it is still in force.
    await page.locator('#check-date').fill('2026-03-05');
    await expect(row(page, 'STN-102')).not.toHaveClass(/terminated/);
    await expect(row(page, 'STN-102')).toContainText('расторгается с 06.03.2026');
  });

  test('a letter without values becomes a note on the contract', async ({ page }) => {
    await upload(page, [txt('letter_delay.txt', 'ПИСЬМО ПОСТАВЩИКА\nДата: 07.03.2026\nТема: договор STN-103\n'
      + 'Сообщаем о возможной задержке поставки запасных частей, точную дату сообщим дополнительно.')]);
    await expect(row(page, 'STN-103')).toContainText('📝 заметок: 1');
    await page.locator('td[data-contract-detail="STN-103"]').click();
    await expect(page.locator('#detail')).toContainText('Сообщаем о возможной задержке поставки');
  });

  test('trace shows rejected candidates', async ({ page }) => {
    await page.locator('#documents tr', { hasText: '03_contract.txt' }).getByRole('button', { name: 'Трасса' }).click();
    await expect(page.locator('#detail tr.rejected')).toContainText(['отброшено 252 000 ₽ — «аванс»', 'отброшено 10.04.2026 — «оплат»']);
  });

  test('clear all returns to the empty state', async ({ page }) => {
    await page.getByRole('button', { name: 'Удалить все' }).click();
    await expect(page.locator('body')).toHaveClass(/empty/);
    await expect(page.locator('.steps')).toBeVisible();
    await expect(page.locator('#upload-summary')).toBeEmpty();
  });
});
