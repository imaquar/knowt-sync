import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const runtime = join(root, 'runtime');
const profile = join(runtime, 'browser-profile');
const mode = process.argv[2] || '--sync';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(runtime, 'browsers');
const { chromium } = await import('playwright');

function key(text) {
  return String(text).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('Незакрытая кавычка в CSV таблицы');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

async function sheetCsvUrl() {
  const text = String(config.googleSheetUrl || '').trim();
  let url;
  try { url = new URL(text); }
  catch { throw new Error('В config.json поле googleSheetUrl должно содержать ссылку на Google Таблицу'); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
  if (url.hostname !== 'docs.google.com' || !match) {
    throw new Error('В config.json поле googleSheetUrl должно содержать ссылку вида https://docs.google.com/spreadsheets/d/...');
  }
  const gid = url.searchParams.get('gid') || url.hash.match(/gid=(\d+)/)?.[1] || '0';
  if (!/^\d+$/.test(gid)) throw new Error('Некорректный gid в ссылке Google Таблицы');
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

async function sheetCards() {
  const rows = parseCsv(await getText(await sheetCsvUrl()));
  const cards = [];
  const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const term = String(rows[i][0] || '').trim();
    const definition = String(rows[i][1] || '').trim();
    if (!term && !definition) continue;
    if (!term || !definition) throw new Error(`Неполная строка таблицы: ${i + 1}`);
    if (/[\t\r\n]/.test(term + definition)) throw new Error(`Табуляция или перевод строки в карточке: ${i + 1}`);
    const id = key(term);
    if (seen.has(id)) {
      if (key(seen.get(id)) !== key(definition)) throw new Error(`Разные переводы для слова ${term}`);
      continue;
    }
    seen.set(id, definition);
    cards.push({ term, definition });
  }
  if (!cards.length) throw new Error('В таблице нет карточек');
  return cards;
}

function htmlText(html) {
  return String(html || '').replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(\d+)|#x([a-f\d]+));/gi, (m, dec, hex) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[m.toLowerCase()] || m;
    }).replace(/\s+/g, ' ').trim();
}

function findSet(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.serverFlashcardSet?.flashcards) return value.serverFlashcardSet;
  for (const child of Object.values(value)) {
    const found = findSet(child);
    if (found) return found;
  }
  return null;
}

async function knowtCards() {
  const html = await getText(config.knowtSetUrl);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for (const [, script] of scripts) {
    if (!script.includes('serverFlashcardSet')) continue;
    const match = script.match(/^self\.__next_f\.push\((\[[\s\S]*\])\)$/);
    if (!match) continue;
    const flight = JSON.parse(match[1]);
    const record = flight[1];
    const colon = record.indexOf(':');
    if (colon < 0) continue;
    const set = findSet(JSON.parse(record.slice(colon + 1)));
    if (set) {
      const urlId = new URL(config.knowtSetUrl).pathname.split('/')[2];
      if (set.flashcardSetId !== urlId) throw new Error('Knowt вернул другой набор');
      return set.flashcards.filter(card => !card.disabled).map(card => ({
        term: htmlText(card.term), definition: htmlText(card.definition)
      }));
    }
  }
  throw new Error('Не удалось прочитать карточки Knowt. Возможно, набор больше не публичный или формат страницы изменился.');
}

const editUrl = config.knowtSetUrl + '/edit';

async function openEditor(headless) {
  await mkdir(runtime, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { headless, channel: 'chromium' });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function editorReady(page, timeout = 2000) {
  if (page.url() !== editUrl) return false;
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).first().waitFor({ timeout });
    return !(await page.getByRole('button', { name: 'Login', exact: true }).isVisible());
  } catch { return false; }
}

async function waitForLogin(page) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Окно входа Knowt было закрыто. Запусти синхронизацию снова.');
    if (await editorReady(page)) return;
    const url = new URL(page.url());
    if (url.hostname === 'knowt.com' && ['/', '/home', '/materials'].includes(url.pathname) &&
        !(await page.getByRole('button', { name: 'Login', exact: true }).isVisible())) {
      await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Вход в Knowt не подтверждён за 10 минут. Запусти синхронизацию снова.');
}

async function openAuthenticatedEditor() {
  let session;
  try {
    session = await openEditor(true);
    if (await editorReady(session.page, 12000)) {
      console.log('Вход в Knowt уже сохранён. Добавляю карточки без окна браузера.');
      return session;
    }
  } catch (error) {
    console.log(`Не удалось проверить вход без окна: ${error.message.split('\n')[0]}`);
  }
  if (session) await session.context.close();

  console.log('Войди в Knowt в открывшемся браузере. После входа синхронизация продолжится сама (до 10 минут).');
  session = await openEditor(false);
  try {
    await waitForLogin(session.page);
    console.log('Вход подтверждён. Продолжаю синхронизацию.');
    return session;
  } catch (error) {
    await session.context.close();
    throw error;
  }
}

async function login() {
  const { context, page } = await openEditor(false);
  console.log('Войди в Knowt в открывшемся браузере. Ожидание: до 10 минут.');
  try {
    await waitForLogin(page);
    console.log('Вход подтверждён.');
  } finally { await context.close(); }
}

async function sync() {
  const source = await sheetCards();
  const current = await knowtCards();
  const currentTerms = new Set(current.map(card => key(card.term)));
  const missing = source.filter(card => !currentTerms.has(key(card.term)));
  console.log(`Таблица: ${source.length}; Knowt: ${current.length}; новых: ${missing.length}`);
  if (mode === '--check' || !missing.length) {
    if (missing.length) console.log(missing.map(card => card.term).join('\n'));
    return;
  }

  const { context, page } = await openAuthenticatedEditor();
  try {
    const writes = [];
    page.on('response', response => {
      if (['POST', 'PUT', 'PATCH'].includes(response.request().method())) {
        writes.push(`${response.request().method()} ${new URL(response.url()).hostname}: ${response.status()}`);
      }
    });
    const importButton = page.getByRole('button', { name: 'Import', exact: true });
    try { await importButton.waitFor({ timeout: 20000 }); }
    catch { throw new Error('Нет доступа к редактору Knowt. Проверь ссылку на набор и права аккаунта.'); }
    await importButton.click();
    const pasteBox = page.getByPlaceholder('Paste copied text here!');
    try { await pasteBox.waitFor({ timeout: 10000 }); }
    catch {
      await page.screenshot({ path: join(runtime, 'import-error.png') });
      throw new Error('Не открылось окно импорта Knowt. Снимок сохранён в runtime/import-error.png');
    }
    await pasteBox.fill(
      missing.map(card => `${card.term}\t${card.definition}`).join('\n')
    );
    await page.getByRole('button', { name: 'Add to bottom' }).click();
    await page.getByRole('button', { name: 'Add to bottom' }).waitFor({ state: 'hidden', timeout: 10000 });
    await page.getByText('Flashcards imported successfully', { exact: true }).waitFor({ timeout: 15000 });
    const search = page.getByPlaceholder('Search terms/definitions');
    await search.fill(missing.at(-1).term);
    try {
      await page.getByText(missing.at(-1).term, { exact: true }).last().waitFor({ timeout: 15000 });
      await page.getByText(missing.at(-1).definition, { exact: true }).last().waitFor({ timeout: 15000 });
    } catch {
      await page.screenshot({ path: join(runtime, 'import-error.png') });
      throw new Error('Импортированная карточка или её перевод не видны в редакторе. Снимок: runtime/import-error.png');
    }
    await search.fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.getByText('Saved!', { exact: true }).waitFor({ timeout: 30000 });

    // Проверяем результат на сервере, а не по локальному состоянию браузера.
    let confirmed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const terms = new Set((await knowtCards()).map(card => key(card.term)));
      if (missing.every(card => terms.has(key(card.term)))) { confirmed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!confirmed) {
      await page.screenshot({ path: join(runtime, 'save-error.png') });
      console.error(`Запросы записи: ${writes.join('; ') || 'не обнаружены'}`);
      throw new Error('Knowt не подтвердил все новые карточки после сохранения. Снимок: runtime/save-error.png');
    }
    console.log(`Добавлено и проверено: ${missing.length}`);
  } finally { await context.close(); }
}

if (mode === '--login') await login();
else if (mode === '--sync' || mode === '--check') await sync();
else throw new Error('Используй --login, --check или --sync');
