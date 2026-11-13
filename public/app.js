const $ = (selector) => document.querySelector(selector);
const views = { loading: $('#loading-view'), login: $('#login-view'), app: $('#app-view') };
const dashboard = $('#dashboard-view');
const settingsView = $('#settings-view');
const expenseDialog = $('#expense-dialog');
let csrfToken = '';
let state = { expenses: [], settings: { currency: 'EUR', period: 'month' } };
let selectedExpense = null;
let selectedPeriod = null;
const BAR_HEIGHTS = ['h-[3px]', 'h-[10%]', 'h-[20%]', 'h-[30%]', 'h-[40%]', 'h-[50%]', 'h-[60%]', 'h-[70%]', 'h-[80%]', 'h-[90%]', 'h-full'];
const BAR_COLORS = ['bg-[#98722f]', 'bg-[#315e70]', 'bg-[#62542e]', 'bg-[#513c68]'];
const SELECTED_BAR_COLORS = ['bg-[#f4bd57] shadow-[0_0_18px_#f4bd5744]', 'bg-[#55badd]', 'bg-[#e7bb44]', 'bg-[#a778d5]'];
const LEGEND_COLORS = ['bg-[#f4bd57]', 'bg-[#55badd]', 'bg-[#e7bb44]', 'bg-[#a778d5]'];
const AXIS_POSITIONS = ['top-0 -translate-y-1/2', 'top-1/4 -translate-y-1/2', 'top-1/2 -translate-y-1/2', 'top-3/4 -translate-y-1/2', 'bottom-0 translate-y-1/2'];
const GRID_POSITIONS = ['top-0', 'top-1/4', 'top-1/2', 'top-3/4', 'bottom-0'];
const PERIOD_PLOTS = {
  week: 'w-[max(100%,1352px)] grid-cols-[repeat(26,minmax(48px,1fr))] min-[680px]:w-[max(100%,1872px)] min-[680px]:grid-cols-[repeat(26,minmax(64px,1fr))]',
  month: 'w-[max(100%,1248px)] grid-cols-[repeat(24,minmax(48px,1fr))] min-[680px]:w-[max(100%,1728px)] min-[680px]:grid-cols-[repeat(24,minmax(64px,1fr))]',
  year: 'w-[max(100%,520px)] grid-cols-[repeat(10,minmax(48px,1fr))] min-[680px]:w-[max(100%,720px)] min-[680px]:grid-cols-[repeat(10,minmax(64px,1fr))]',
};

function showView(name) {
  for (const [viewName, view] of Object.entries(views)) view.hidden = viewName !== name;
  if (name === 'login') $('#password').focus();
}

async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    csrfToken = '';
    showView('login');
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Something went wrong');
  }
  return response.status === 204 ? null : response.json();
}

function startOfPeriod(date, period) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === 'month') start.setDate(1);
  if (period === 'year') start.setMonth(0, 1);
  return start;
}

function addPeriod(date, period, amount) {
  const result = new Date(date);
  if (period === 'week') result.setDate(result.getDate() + (7 * amount));
  if (period === 'month') result.setMonth(result.getMonth() + amount);
  if (period === 'year') result.setFullYear(result.getFullYear() + amount);
  return result;
}

function periodName(period, capital = false) {
  const name = `this ${period}`;
  return capital ? name[0].toUpperCase() + name.slice(1) : name;
}

function periodLabel(date, period) {
  if (period === 'week') return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (period === 'month') return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return String(date.getFullYear());
}

function selectedPeriodLabel(date, period) {
  const current = startOfPeriod(new Date(), period);
  if (date.getTime() === current.getTime()) return periodName(period, true);
  if (period === 'year') return String(date.getFullYear());
  if (period === 'month') return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const end = addPeriod(date, period, 1);
  end.setDate(end.getDate() - 1);
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function niceMaximum(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => normalized <= candidate);
  return step * magnitude;
}

function scaleLabel(value) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function money(value, currency, decimals = true) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency,
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(value);
}

function spentMoney(value, currency, decimals = true) {
  return money(value ? -value : 0, currency, decimals);
}

function totalsByCurrency(expenses) {
  const totals = new Map();
  for (const expense of expenses) totals.set(expense.currency, (totals.get(expense.currency) || 0) + expense.amount);
  if (!totals.size) totals.set(state.settings.currency, 0);
  return new Map([...totals].sort(([left], [right]) => {
    if (left === state.settings.currency) return -1;
    if (right === state.settings.currency) return 1;
    return left.localeCompare(right);
  }));
}

function totalStrings(expenses, decimals = true) {
  return [...totalsByCurrency(expenses)].map(([currency, total]) => spentMoney(total, currency, decimals));
}

function inRange(expense, start, end) {
  const time = new Date(expense.spentAt).getTime();
  return time >= start.getTime() && time < end.getTime();
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChart() {
  const chart = $('#chart');
  const period = state.settings.period;
  const dragState = { moved: false };
  const oldScroller = chart.querySelector('[data-chart-scroll]');
  const distanceFromRight = oldScroller && chart.dataset.period === period
    ? oldScroller.scrollWidth - oldScroller.clientWidth - oldScroller.scrollLeft
    : 0;
  chart.dataset.period = period;
  const currentStart = startOfPeriod(new Date(), period);
  const activeStart = selectedPeriod || currentStart;
  const intervalCount = { week: 26, month: 24, year: 10 }[period];
  const intervals = Array.from({ length: intervalCount }, (_, index) => {
    const from = addPeriod(currentStart, period, index - intervalCount + 1);
    const to = addPeriod(from, period, 1);
    const totals = totalsByCurrency(state.expenses.filter((expense) => inRange(expense, from, to)));
    return { from, totals };
  });
  const currencies = [...new Set([state.settings.currency, ...intervals.flatMap(({ totals }) => [...totals.keys()])])];
  currencies.sort((left, right) => left === state.settings.currency ? -1 : right === state.settings.currency ? 1 : left.localeCompare(right));
  $('#chart-legend').replaceChildren(...currencies.map((currency, index) => {
    const item = element('span', 'flex items-center gap-1.5', currency);
    item.prepend(element('i', `size-2 rounded-full ${LEGEND_COLORS[index % 4]}`));
    return item;
  }));
  const columns = intervals.map(({ from, totals }) => {
    const isSelected = from.getTime() === activeStart.getTime();
    const column = element('button', 'relative z-1 flex h-[60px] min-w-0 cursor-pointer flex-col items-center justify-end border-0 bg-transparent p-0 text-inherit hover:bg-white/[.03] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#f4bd57]');
    column.dataset.chartColumn = '';
    column.type = 'button';
    column.setAttribute('aria-pressed', String(isSelected));
    column.setAttribute('aria-label', `Show ${selectedPeriodLabel(from, period)}`);
    const wrap = element('div', 'flex h-[60px] w-full items-end justify-center gap-[3px]');
    for (const [currencyIndex, currency] of currencies.entries()) {
      const total = totals.get(currency) || 0;
      if (!total && currency !== state.settings.currency) continue;
      const colorIndex = currencyIndex % 4;
      const color = isSelected ? SELECTED_BAR_COLORS[colorIndex] : BAR_COLORS[colorIndex];
      const bar = element('div', `h-[3px] min-h-[3px] w-[min(22px,28%)] rounded-t-[3px] ${color}`);
      bar.dataset.chartBar = '';
      bar.dataset.value = String(total);
      bar.dataset.height = BAR_HEIGHTS[0];
      bar.title = `${currency}: ${money(total, currency)}`;
      wrap.append(bar);
    }
    const labelClasses = isSelected
      ? 'absolute top-[calc(100%_+_10px)] w-full text-center text-xs leading-[1.2] font-bold text-[#f5f7fa]'
      : 'absolute top-[calc(100%_+_10px)] w-full text-center text-xs leading-[1.2] text-[#5f6065]';
    column.append(wrap, element('span', labelClasses, periodLabel(from, period)));
    column.addEventListener('click', () => {
      if (dragState.moved) return;
      selectedPeriod = from;
      render();
    });
    return column;
  });
  const axis = element('div', 'relative h-[60px] text-[9px] leading-none text-[#70838e]');
  const axisLabels = Array.from({ length: 5 }, (_, index) => element('span', `absolute right-2 ${AXIS_POSITIONS[index]}`));
  axis.append(...axisLabels);
  const plot = element('div', `relative grid h-[60px] gap-1 min-[680px]:gap-2 ${PERIOD_PLOTS[period]}`);
  const gridLines = Array.from({ length: 5 }, (_, index) => element('span', `pointer-events-none absolute right-0 left-0 z-0 border-t border-dashed border-[#45606d77] ${GRID_POSITIONS[index]}`));
  plot.append(...gridLines, ...columns);
  const scroller = element('div', 'min-w-0 cursor-grab touch-pan-x overflow-x-auto overflow-y-hidden select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden');
  scroller.dataset.chartScroll = '';
  scroller.append(plot);
  chart.replaceChildren(axis, scroller);
  let pointerStart = 0;
  let scrollStart = 0;
  let activePointer = null;
  scroller.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    activePointer = event.pointerId;
    pointerStart = event.clientX;
    scrollStart = scroller.scrollLeft;
    dragState.moved = false;
  });
  scroller.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointer) return;
    const distance = event.clientX - pointerStart;
    if (Math.abs(distance) > 4 && !dragState.moved) {
      dragState.moved = true;
      scroller.setPointerCapture(event.pointerId);
      scroller.classList.remove('cursor-grab');
      scroller.classList.add('cursor-grabbing');
    }
    if (dragState.moved) scroller.scrollLeft = scrollStart - distance;
  });
  const stopDragging = (event) => {
    if (event.pointerId !== activePointer) return;
    if (scroller.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    activePointer = null;
    scroller.classList.remove('cursor-grabbing');
    scroller.classList.add('cursor-grab');
    setTimeout(() => { dragState.moved = false; });
  };
  scroller.addEventListener('pointerup', stopDragging);
  scroller.addEventListener('pointercancel', stopDragging);
  let scaleFrame = null;
  const updateScale = () => {
    if (scaleFrame !== null) return;
    scaleFrame = requestAnimationFrame(() => {
      scaleFrame = null;
      const left = scroller.scrollLeft;
      const right = left + scroller.clientWidth;
      const visibleBars = [...plot.querySelectorAll('[data-chart-column]')]
        .filter((column) => column.offsetLeft < right && column.offsetLeft + column.offsetWidth > left)
        .flatMap((column) => [...column.querySelectorAll('[data-chart-bar]')]);
      const maximum = niceMaximum(Math.max(...visibleBars.map((bar) => Number(bar.dataset.value)), 0));
      axisLabels.forEach((label, index) => {
        label.textContent = scaleLabel(maximum * (4 - index) / 4);
      });
      for (const bar of plot.querySelectorAll('[data-chart-bar]')) {
        const value = Number(bar.dataset.value);
        const level = value ? Math.min(10, Math.max(1, Math.round(value / maximum * 10))) : 0;
        bar.classList.remove(bar.dataset.height);
        bar.dataset.height = BAR_HEIGHTS[level];
        bar.classList.add(bar.dataset.height);
      }
    });
  };
  scroller.addEventListener('scroll', updateScale, { passive: true });
  requestAnimationFrame(() => {
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth - distanceFromRight;
    updateScale();
  });
}

function dayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = Math.round((today - day) / 86400000);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderExpenses() {
  const list = $('#expense-list');
  const now = new Date();
  const period = state.settings.period;
  const start = selectedPeriod || startOfPeriod(now, period);
  const end = addPeriod(start, period, 1);
  const query = $('#search-input').value.trim().toLocaleLowerCase();
  const visible = state.expenses.filter((expense) => query
    ? expense.description.toLocaleLowerCase().includes(query)
    : inRange(expense, start, end));

  if (!visible.length) {
    list.replaceChildren(element('p', 'px-4 py-[42px] text-center text-[#7e8792]', query ? 'No matching expenses.' : `No expenses for ${periodName(period)}.`));
    return;
  }

  const groups = new Map();
  for (const expense of visible) {
    const date = new Date(expense.spentAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!groups.has(key)) groups.set(key, { date, expenses: [] });
    groups.get(key).expenses.push(expense);
  }

  const days = [...groups.values()].map((group) => {
    const section = element('section', 'mt-4 min-[680px]:mt-[26px]');
    const heading = element('div', 'flex items-baseline justify-between px-2 pt-0 pb-2 min-[680px]:px-2.5 min-[680px]:pb-2.5');
    heading.append(
      element('h2', 'm-0 text-[22px] text-[#b6bec8]', dayLabel(group.date)),
      element('strong', 'text-right text-[19px] text-[#b6bec8]', totalStrings(group.expenses).join(' · ')),
    );
    const card = element('div', 'grid gap-2 min-[680px]:gap-2.5');
    for (const expense of group.expenses) {
      const row = element('button', 'grid w-full cursor-pointer grid-cols-[42px_1fr_auto] items-center gap-3 rounded-[14px] border border-[#263b47] bg-[#13212b] p-3 text-left text-inherit hover:border-[#526c79] hover:bg-[#172833] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#f4bd5755] min-[680px]:grid-cols-[48px_1fr_auto] min-[680px]:gap-3.5 min-[680px]:px-[26px] min-[680px]:py-[22px]');
      row.type = 'button';
      row.setAttribute('aria-label', `Edit ${expense.description}`);
      const details = element('div');
      details.append(
        element('div', 'min-w-0 text-lg font-bold break-words', expense.description),
        element('div', 'mt-1 text-sm text-[#87909b]', new Date(expense.spentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      );
      const value = element('div', 'text-right text-lg whitespace-nowrap');
      value.append(element('div', '', spentMoney(expense.amount, expense.currency)));
      row.append(element('span', 'grid size-[42px] place-items-center rounded-xl bg-[#3b3221] text-[21px] text-[#f4bd57] min-[680px]:size-12 min-[680px]:text-2xl', '▣'), details, value);
      row.addEventListener('click', () => openExpenseDialog(expense));
      card.append(row);
    }
    section.append(heading, card);
    return section;
  });
  list.replaceChildren(...days);
}

function render() {
  const period = state.settings.period;
  const start = selectedPeriod || startOfPeriod(new Date(), period);
  const end = addPeriod(start, period, 1);
  const currentExpenses = state.expenses.filter((expense) => inRange(expense, start, end));
  const totals = totalStrings(currentExpenses, false);
  $('#total').replaceChildren(...totals.flatMap((text, index) => [
    ...(index ? [element('span', 'text-[#5a707c]', '/')] : []),
    element('span', '', text),
  ]));
  $('#period-caption').textContent = `Cash Flow · ${selectedPeriodLabel(start, period)}`;
  $('#default-currency').value = state.settings.currency;
  $('#aggregation-period').value = period;
  renderChart();
  renderExpenses();
}

async function loadExpenses() {
  const previousPeriod = state.settings.period;
  state = await api('api/expenses');
  if (state.settings.period !== previousPeriod) selectedPeriod = null;
  render();
}

async function checkSession() {
  try {
    const response = await fetch('api/session', { headers: { Accept: 'application/json' } });
    if (!response.ok) return showView('login');
    csrfToken = (await response.json()).csrfToken;
    await loadExpenses();
    showView('app');
  } catch {
    $('#login-error').textContent = 'Unable to connect to the server.';
    $('#login-error').hidden = false;
    showView('login');
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-button');
  button.disabled = true;
  $('#login-error').hidden = true;
  try {
    const response = await fetch('api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: $('#password').value }),
    });
    if (!response.ok) {
      const messages = { 429: 'Too many attempts. Please try again later.', 503: 'The server is busy. Please try again in a few seconds.' };
      throw new Error(messages[response.status] || 'The password is incorrect.');
    }
    csrfToken = (await response.json()).csrfToken;
    $('#login-form').reset();
    await loadExpenses();
    showView('app');
  } catch (error) {
    $('#login-error').textContent = error.message === 'Failed to fetch' ? 'Unable to connect to the server.' : error.message;
    $('#login-error').hidden = false;
  } finally { button.disabled = false; }
});

$('#settings-button').addEventListener('click', () => { dashboard.hidden = true; settingsView.hidden = false; });
$('#back-button').addEventListener('click', () => { settingsView.hidden = true; dashboard.hidden = false; render(); });
$('#search-input').addEventListener('input', renderExpenses);

function localDateTime(iso = new Date().toISOString()) {
  const date = new Date(iso);
  return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
}

let dialogViewportFrame = null;

function updateExpenseDialogViewport() {
  dialogViewportFrame = null;
  if (!expenseDialog.open) return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  const keyboardOpen = viewport.height < window.innerHeight - 100;
  expenseDialog.style.maxHeight = `${Math.max(240, viewport.height - 16)}px`;
  if (keyboardOpen) {
    expenseDialog.style.inset = `${viewport.offsetTop + 8}px 0 auto`;
    expenseDialog.style.margin = '0 auto';
  } else {
    expenseDialog.style.inset = '';
    expenseDialog.style.margin = '';
  }
}

function queueExpenseDialogViewportUpdate() {
  if (dialogViewportFrame !== null) cancelAnimationFrame(dialogViewportFrame);
  dialogViewportFrame = requestAnimationFrame(updateExpenseDialogViewport);
}

function openExpenseDialog(expense = null) {
  selectedExpense = expense;
  $('#expense-form').reset();
  $('#expense-dialog-title').textContent = expense ? 'Edit expense' : 'Add expense';
  $('#save-expense').textContent = expense ? 'Save changes' : 'Add expense';
  $('#delete-expense').hidden = !expense;
  $('#expense-description').value = expense?.description || '';
  $('#expense-amount').value = expense ? Number(expense.amount).toFixed(2) : '';
  $('#expense-date').value = localDateTime(expense?.spentAt);
  if (expense && ![...$('#expense-currency').options].some(({ value }) => value === expense.currency)) {
    $('#expense-currency').append(new Option(expense.currency, expense.currency));
  }
  $('#expense-currency').value = expense?.currency || state.settings.currency;
  $('#expense-error').hidden = true;
  expenseDialog.showModal();
  queueExpenseDialogViewportUpdate();
  $('#expense-amount').focus();
}

$('#add-button').addEventListener('click', () => openExpenseDialog());
$('#close-dialog').addEventListener('click', () => expenseDialog.close());
expenseDialog.addEventListener('click', (event) => { if (event.target === expenseDialog) expenseDialog.close(); });
expenseDialog.addEventListener('close', () => {
  expenseDialog.style.inset = '';
  expenseDialog.style.margin = '';
  expenseDialog.style.maxHeight = '';
});
window.visualViewport?.addEventListener('resize', queueExpenseDialogViewportUpdate);
window.visualViewport?.addEventListener('scroll', queueExpenseDialogViewportUpdate);

$('#expense-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#save-expense');
  button.disabled = true;
  $('#expense-error').hidden = true;
  try {
    await api(selectedExpense ? `api/expenses/${selectedExpense.id}` : 'api/expenses', {
      method: selectedExpense ? 'PUT' : 'POST',
      body: JSON.stringify({
        description: $('#expense-description').value,
        amount: $('#expense-amount').value,
        currency: $('#expense-currency').value,
        spentAt: new Date($('#expense-date').value).toISOString(),
      }),
    });
    $('#expense-dialog').close();
    await loadExpenses();
  } catch (error) {
    $('#expense-error').textContent = error.message;
    $('#expense-error').hidden = false;
  } finally { button.disabled = false; }
});

$('#delete-expense').addEventListener('click', async () => {
  if (!selectedExpense || !window.confirm(`Delete “${selectedExpense.description}”?`)) return;
  const button = $('#delete-expense');
  button.disabled = true;
  $('#expense-error').hidden = true;
  try {
    await api(`api/expenses/${selectedExpense.id}`, { method: 'DELETE' });
    $('#expense-dialog').close();
    await loadExpenses();
  } catch (error) {
    $('#expense-error').textContent = error.message;
    $('#expense-error').hidden = false;
  } finally { button.disabled = false; }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#settings-status').textContent = '';
  try {
    await api('api/settings', {
      method: 'PUT',
      body: JSON.stringify({ currency: $('#default-currency').value, period: $('#aggregation-period').value }),
    });
    await loadExpenses();
    $('#settings-status').textContent = 'Settings saved.';
  } catch (error) { $('#settings-status').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#import-button').addEventListener('click', async () => {
  const file = $('#csv-file').files[0];
  const button = $('#import-button');
  $('#import-status').textContent = '';
  if (!file) return void ($('#import-status').textContent = 'Choose a CSV file first.');
  button.disabled = true;
  try {
    const result = await api('api/import', { method: 'POST', body: JSON.stringify({ csv: await file.text() }) });
    await loadExpenses();
    $('#import-status').textContent = `Imported ${result.imported}; skipped ${result.skipped} row${result.skipped === 1 ? '' : 's'}.`;
    $('#csv-file').value = '';
  } catch (error) { $('#import-status').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  const button = $('#logout-button');
  button.disabled = true;
  try { await api('api/session', { method: 'DELETE' }); } catch {}
  csrfToken = '';
  showView('login');
  button.disabled = false;
});

if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations()
  .then((registrations) => registrations.forEach((registration) => registration.unregister()))
  .catch(() => {});
checkSession();
