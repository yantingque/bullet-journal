import { agenda, byTaskPriority, dayKey, sunday, trashExpiry, parseNumericDate, parseNumericTime, recurringOn, routineWeeks, voiceRoutineGoals, correctVoiceTerms, parseVoiceGlossary, reviseVoiceTranscript, shift, statuses, types, healthMetrics, meetingKinds } from './model.mjs';
import { createMeetingEditor } from './meeting.mjs';

const $ = selector => document.querySelector(selector);
const titles = { today: '今天', inbox: '捕捉箱', projects: '專案', week: '本週行事曆', future: '未來誌', alerts: '提醒', routines: '日常', notes: '日誌與筆記', meetings: '會議紀錄', health: '健康' };
let state = null;
let draft = null;
let inboxMode = 'open';
let taskFilter = 'all';
const taskFilters = { all: '全部', today: '今天', overdue: '逾期', upcoming: '即將開始', unscheduled: '未排程' };
let weekOffset = 0;
let futureMonth = '';
let futureMode = 'month';
let futureDay = '';
let installPrompt;
let syncing = false;
let revision = 0;
let renderAfterSettingsEdit = false;
let renderedOverdue = '';
const deadlineOnlyTimelines = new Set();
const fallbackId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
  const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
  return (character === 'x' ? random : (random & 3) | 8).toString(16);
});
const uuid = () => crypto.randomUUID?.() || fallbackId();
const device = localStorage.getItem('journal-device') || uuid();
localStorage.setItem('journal-device', device);
const escape = value => String(value ?? '').replace(/[&<>"']/g, symbol => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[symbol]));
const empty = label => `<p class="empty">${label}</p>`;

function addNumericFields(container) {
  for (const picker of container.querySelectorAll('input[type="date"], input[type="time"]')) {
    const label = picker.closest('label');
    const title = label.firstChild.textContent.trim();
    const date = picker.type === 'date';
    const wrapper = document.createElement('div');
    wrapper.className = 'numeric-field';
    label.before(wrapper);
    wrapper.append(label);
    const shorthand = document.createElement('input');
    shorthand.type = 'text';
    shorthand.inputMode = 'numeric';
    shorthand.autocomplete = 'off';
    shorthand.placeholder = date ? '輸入日期，例如 1114' : '輸入時間，例如 1300';
    shorthand.maxLength = date ? 8 : 4;
    shorthand.setAttribute('aria-label', title + '（數字速輸）');
    wrapper.append(shorthand);
    function apply() {
      if (wrapper.hidden || picker.disabled || !shorthand.value.trim()) return true;
      const normalized = date ? parseNumericDate(shorthand.value, state?.day ?? dayKey()) : parseNumericTime(shorthand.value);
      shorthand.setCustomValidity(normalized ? '' : date
        ? '請輸入有效日期，格式為 MDD、MMDD 或 YYYYMMDD。' : '請輸入有效時間，格式為 0000 至 2359。');
      if (!normalized) {
        const details = wrapper.closest('details');
        if (details) details.open = true;
        shorthand.reportValidity();
        shorthand.setCustomValidity('');
        return false;
      }
      shorthand.value = '';
      picker.value = normalized;
      picker.dispatchEvent(new Event('input', { bubbles: true }));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    shorthand.addEventListener('input', () => shorthand.setCustomValidity(''));
    shorthand.addEventListener('change', () => apply());
    shorthand.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      apply();
    });
    picker.addEventListener('change', () => {
      shorthand.value = '';
      shorthand.setCustomValidity('');
    });
    wrapper.applyNumericInput = apply;
  }
}

function applyNumericFields(container) {
  return [...container.querySelectorAll('.numeric-field')].every(field => field.applyNumericInput());
}

function syncNumericFields(container, reset = false) {
  for (const wrapper of container.querySelectorAll('.numeric-field')) {
    const picker = wrapper.querySelector('label input');
    const shorthand = wrapper.lastElementChild;
    wrapper.hidden = picker.closest('label').hidden;
    shorthand.disabled = picker.disabled || wrapper.hidden;
    if (reset || shorthand.disabled) {
      shorthand.value = '';
      shorthand.setCustomValidity('');
    }
  }
}
const form = $('#entry-form');
addNumericFields(form);
const editor = $('#editor');
const saveContinue = $('#save-continue');
const openBatch = $('#open-batch');
const deleteEntry = $('#delete-entry');
const journalAI = $('#journal-ai');
const journalAIResult = $('#journal-ai-result');
let journalReviewRequest = 0;
let savingEntry = false;
const quickTypes = $('#quick-types');
const quickSchedule = $('#quick-schedule');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const isWindows = (navigator.userAgentData?.platform || navigator.platform).startsWith('Win');

function wireVoiceInput(container, field, dialog, separator = ' ', onTranscript = null, language = null) {
  const button = container.querySelector('button');
  const status = container.querySelector('small');
  const interim = container.parentElement.querySelector('[data-voice-interim]');
  const fallback = isWindows ? '可點文字欄位後按 Win + H 使用 Windows 語音輸入。' : '請輸入文字或改用支援語音辨識的瀏覽器。';
  const initial = SpeechRecognition
    ? '瀏覽器可能會將語音送到其辨識服務。'
    : fallback;
  const errors = {
    'not-allowed': '請允許瀏覽器使用麥克風。',
    'service-not-allowed': '瀏覽器未開放語音辨識。',
    'audio-capture': '找不到可用的麥克風。',
    'no-speech': '沒有辨識到語音。',
    network: '無法連上瀏覽器的語音辨識服務。'
  };
  let session;
  let stopRequested = false;
  let previewOnStop = false;
  let afterStop;
  function stop(preview, callback) {
    if (!session || stopRequested) return;
    stopRequested = true;
    previewOnStop = preview;
    afterStop = callback;
    button.disabled = true;
    status.textContent = '正在辨識最後一句…';
    session.stop();
  }
  function reset() {
    const previous = session;
    session = undefined;
    previous?.abort();
    delete container.dataset.listening;
    stopRequested = false;
    previewOnStop = false;
    afterStop = undefined;
    if (interim) interim.textContent = '';
    button.disabled = false;
    button.textContent = '語音輸入';
    status.textContent = initial;
  }
  reset();
  button.onclick = () => {
    if (field.disabled) return;
    if (!SpeechRecognition) {
      field.focus();
      status.textContent = fallback;
      return;
    }
    if (session) {
      stop(true);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = language?.value || 'zh-TW';
    recognition.continuous = true;
    recognition.interimResults = Boolean(interim);
    let received = false;
    let message = '';
    recognition.onresult = event => {
      if (session !== recognition || field.disabled) return;
      const partial = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const phrase = result[0].transcript.trim();
        if (!phrase) continue;
        if (!result.isFinal) {
          partial.push(phrase);
          continue;
        }
        const joiner = field.value && !/\s$/u.test(field.value) ? separator : '';
        if (field.value.length + joiner.length + phrase.length > field.maxLength) {
          message = '欄位長度已達上限。請先調整已輸入的文字。';
          recognition.stop();
          break;
        }
        field.value += joiner + phrase;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        if (field === form.elements.title) $('#editor-error').textContent = '';
        received = true;
      }
      if (interim) interim.textContent = partial.join(' ');
    };
    recognition.onerror = event => {
      message = (errors[event.error] || '語音辨識中斷。') + ' ' + fallback;
    };
    recognition.onend = () => {
      if (session !== recognition) return;
      const shouldPreview = previewOnStop && received && !message;
      const callback = afterStop;
      session = undefined;
      reset();
      status.textContent = message || (received ? '語音已轉成文字，可以接著說或編輯文字。' : '沒有辨識到語音。');
      if (shouldPreview) onTranscript?.();
      callback?.();
    };
    try {
      session = recognition;
      recognition.start();
      container.dataset.listening = '';
      button.textContent = '停止語音輸入';
      status.textContent = '聆聽中…';
    } catch {
      session = undefined;
      reset();
      status.textContent = fallback;
    }
  };
  language?.addEventListener('change', () => stop(false));
  dialog.addEventListener('close', reset);
  return { reset, stop, listening: () => Boolean(session) };
}

const entryVoiceBox = $('#entry-voice');
const entryVoice = wireVoiceInput(entryVoiceBox, form.elements.title, editor);
form.elements.type.innerHTML = Object.entries(types).filter(([key]) => key !== 'A')
  .map(([key, label]) => `<option value="${key}">${key} · ${label}</option>`).join('');
form.elements.status.innerHTML = Object.entries(statuses).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
const registration = navigator.serviceWorker?.register('/sw.js').catch(() => null);
const moreNav = $('#nav-more');
const extraNav = $('#nav-extra');
const guide = $('#guide');
const guideOpen = $('#guide-open');
const guideSteps = [
  ['從今天開始', '嗨！先打開「今天」看看接下來要做什麼。完成一件事，就按旁邊的完成按鈕。', 'today', '前往今天'],
  ['先記下來，稍後再整理', '想到事情時，按「＋ 快速記錄」把它存進捕捉箱。打開捕捉箱後，點一筆記錄就能補上分類或日期。', 'inbox', '前往捕捉箱'],
  ['試試用說的', '在「今天」點右下角的麥克風，試著說「明天寄報價，附上修正版」。先核對項目、筆記和日期，再決定要不要儲存。', 'today', '前往語音入口'],
  ['把事情排進日曆', '安排哪天做就填排程日期，有交付期限才填截止日。到「本週」看接下來的安排，到「未來誌」可切換月曆和全年總覽。', 'week', '前往本週'],
  ['把大事拆成小步驟', '打開一個專案，按「新增子任務」。你可以在專案裡看完成進度和時間軸。', 'projects', '前往專案'],
  ['建立自己的日常', '固定星期做的事可以設排程。每週只想做滿幾天，就選「每週自選時間」，做完回來打卡。', 'routines', '前往日常'],
  ['留下日誌與量測', '到「日誌與筆記」記下今天的想法。到「健康」可以手動新增量測，或辨識體脂機截圖，確認數字後再儲存。', 'health', '前往健康'],
  ['準備好了', '下次想複習，打開「更多 → 教學」即可從頭再走一次。需要通知時，可以到「提醒」設定。', 'alerts', '前往提醒']
];
let guideStep = 0;

function renderGuide() {
  const [title, message, page, link] = guideSteps[guideStep];
  $('#guide-title').textContent = title;
  $('#guide-text').textContent = message;
  $('#guide-progress').textContent = '第 ' + (guideStep + 1) + ' 步，共 ' + guideSteps.length + ' 步';
  $('#guide-back').disabled = guideStep === 0;
  $('#guide-try').href = '#' + page;
  $('#guide-try').textContent = link;
  $('#guide-next').textContent = guideStep === guideSteps.length - 1 ? '完成教學' : '下一步';
  $('#guide-title').focus();
}

guideOpen.onclick = () => {
  guideStep = 0;
  moreNav.setAttribute('aria-expanded', 'false');
  moreNav.focus({ preventScroll: true });
  guide.showModal();
  renderGuide();
};
$('#guide-close').onclick = () => guide.close();
$('#guide-back').onclick = () => {
  if (guideStep > 0) {
    guideStep--;
    renderGuide();
  }
};
$('#guide-next').onclick = () => {
  if (guideStep === guideSteps.length - 1) guide.close();
  else {
    guideStep++;
    renderGuide();
  }
};
$('#guide-try').onclick = () => guide.close();
guide.addEventListener('close', () => moreNav.focus({ preventScroll: true }));
moreNav.onclick = () => {
  moreNav.setAttribute('aria-expanded', String(moreNav.getAttribute('aria-expanded') === 'false'));
};
document.addEventListener('click', event => {
  if (moreNav.getAttribute('aria-expanded') !== 'true' || moreNav.contains(event.target)) return;
  const insideMenu = extraNav.contains(event.target);
  if (insideMenu && !event.target.closest('a')) return;
  moreNav.setAttribute('aria-expanded', 'false');
  if (insideMenu) moreNav.focus({ preventScroll: true });
});
moreNav.closest('nav').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || moreNav.getAttribute('aria-expanded') !== 'true') return;
  moreNav.setAttribute('aria-expanded', 'false');
  moreNav.focus({ preventScroll: true });
});
addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('#install').hidden = false;
});
$('#install').onclick = async () => {
  await installPrompt?.prompt();
  $('#install').hidden = true;
};
const compact = new URLSearchParams(location.search).has('compact');
if (compact) {
  document.body.classList.add('compact');
  $('#add').textContent = '＋';
  $('#add').setAttribute('aria-label', '快速記錄');
}
$('#compact').onclick = async () => {
  try {
    await request('desktop', {});
  } catch (error) {
    showError(error);
  }
};

async function request(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function showError(error) {
  $('#message').textContent = error.message;
}

async function refresh() {
  if (syncing) return;
  syncing = true;
  const previousRevision = revision;
  try {
    const next = await request('state');
    if (previousRevision !== revision) return;
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    $('#login').hidden = true;
    $('#journal').hidden = false;
    guideOpen.hidden = compact;
    $('#sync').textContent = '● 已同步';
    const deadlineChanged = renderedOverdue !== overdueKey();
    if (changed || deadlineChanged || renderAfterSettingsEdit) {
      if ($('#view form')?.contains(document.activeElement)) {
        renderAfterSettingsEdit = true;
        return;
      }
      if (document.activeElement?.id === 'notes-search') $('#notes-results').innerHTML = notesResults();
      else render();
    }
  } catch (error) {
    if (error.status === 401 || !state) {
      $('#login').hidden = false;
      $('#journal').hidden = true;
      guideOpen.hidden = true;
      if (error.status !== 401) $('#login-error').textContent = '暫時無法連線。請確認筆記服務已啟動。';
    }
    $('#sync').textContent = error.status === 401 ? '尚未配對' : '○ 等待連線';
  } finally {
    syncing = false;
  }
}

$('#login-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await request('login', { code: event.target.elements.code.value });
    event.target.reset();
    $('#login-error').textContent = '';
    await refresh();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
};

const byTime = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') ||
  (a.time || '00:00').localeCompare(b.time || '00:00') || a.created.localeCompare(b.created);
const shortDate = day => day.slice(5).replace('-', '/');
const weekday = day => '週' + '日一二三四五六'[new Date(day + 'T00:00:00Z').getUTCDay()];
const dateLabel = day => `${Number(day.slice(5, 7))} 月 ${Number(day.slice(-2))} 日 · ${weekday(day)}`;
const deadlineLabel = item => item.dueDate
  ? '截止 ' + (item.dueDate.slice(0, 4) === state.day.slice(0, 4) ? shortDate(item.dueDate) : item.dueDate) +
    (item.dueTime ? ' ' + item.dueTime : '')
  : '';

function canMoveToTomorrow(item, today) {
  return item?.type === 'T' && item.status !== 'done' && (item.date || item.dueDate || '') <= today &&
    (!item.dueDate || item.dueDate > today);
}

function itemRow(item, actions = false) {
  const hasStatus = ['T', 'P'].includes(item.type);
  const meta = [item.type === 'A' ? meetingKinds[item.meetingKind ?? 'meeting']?.label : types[item.type], item.date && shortDate(item.date), item.time, deadlineLabel(item),
    item.priority && '優序 ' + item.priority, hasStatus && statuses[item.status]].filter(Boolean).join(' · ');
  const buttons = actions && item.type === 'T' && item.status !== 'done' ? `
    ${canMoveToTomorrow(item, state.day) ? `<button class="quiet" data-action="tomorrow" data-id="${item.id}">移到明天</button>` : ''}
    <button class="quiet done-button" data-action="done" data-id="${item.id}" aria-label="完成 ${escape(item.title)}">✓ <span>完成</span></button>` : '';
  const project = state.items.find(parent => parent.id === item.parentId);
  return `<li class="entry ${hasStatus && item.status === 'done' ? 'finished' : ''}">
    <span class="entry-dot type-${item.type}" aria-hidden="true"></span>
    <button class="entry-main" data-action="edit" data-id="${item.id}">
      <strong>${escape(item.title)}</strong><small>${escape(meta)}${project ? ' · ' + escape(project.title) : ''}</small>
      ${item.next ? `<span class="next-text">${escape(item.next)}</span>` : ''}
    </button>${buttons}</li>`;
}

function entryList(items, message, actions, order = byTime) {
  return items.length ? `<ul class="entries">${[...items].sort(order).map(item => itemRow(item, actions)).join('')}</ul>` : empty(message);
}

const isEvent = item => item.type === 'E' || item.type === 'M';

function compactEvents(events, emptyMessage) {
  return events.length ? `<ul class="compact-list">${[...events].sort(byTime).map(item => `<li>
    <button data-action="edit" data-id="${item.id}">
      <span class="event-time">${item.time || '全天'}</span><strong>${escape(item.title)}</strong>
    </button></li>`).join('')}</ul>` : empty(emptyMessage);
}

function compactFuture(items) {
  const plans = items.filter(item => item.month && !item.date && !item.archived && item.status !== 'done');
  const months = [...new Set(plans.map(item => item.month))].sort();
  return `<details id="compact-future" class="compact-section">
    <summary>未來誌 <span>${plans.length} 件待排程</span></summary>
    ${months.length ? months.map(month => `<section class="compact-day">
      <h3>${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月</h3>
      <ul class="entries">${plans.filter(item => item.month === month).sort(byTime).map(item => `<li class="entry">
        <button class="entry-main" data-action="schedule" data-id="${item.id}">
          <strong>${escape(item.title)}</strong><small>${types[item.type]}</small>
        </button>
      </li>`).join('')}</ul>
    </section>`).join('') : empty('沒有待排程的計畫')}
  </details>`;
}

function compactToday() {
  const { day, items } = state;
  const { today, next, focus, overdue } = agenda(items, day);
  const tasks = today.filter(item => item.type === 'T' && item.status !== 'done');
  const captures = items.filter(item => item.type === 'C' && !item.archived && item.status !== 'done');
  const weekEnd = shift(sunday(day), 6);
  const upcoming = items.filter(item => isEvent(item) && !item.archived && item.date > day && item.date <= weekEnd);
  const days = [...new Set(upcoming.map(item => item.date))].sort();
  return `<section class="compact-events" aria-labelledby="compact-events-heading">
    <h2 id="compact-events-heading">今日事件</h2>
    ${compactEvents(today.filter(isEvent), '今天沒有事件')}
  </section>
  ${next ? `<section class="compact-next">
    <button class="compact-task" data-action="edit" data-id="${next.id}">
      <span>${focus ? '今日焦點' : '下一件事'}</span>
      <strong>${escape(next.title)}</strong>
      ${next.dueDate ? `<small>${escape(deadlineLabel(next))}</small>` : ''}
      ${next.next ? `<small>${escape(next.next)}</small>` : ''}
    </button>
    <button class="quiet" data-action="done" data-id="${next.id}" aria-label="完成 ${escape(next.title)}">✓</button>
  </section>` : ''}
  <details id="compact-tasks" class="compact-section">
    <summary>今日待辦 <span>${tasks.length} 件未完成</span></summary>
    ${entryList(tasks, '今天沒有未完成的待辦', true, (a, b) =>
      Number(b.id === focus?.id) - Number(a.id === focus?.id) || byTaskPriority(a, b))}
    <button class="quiet compact-add-task" data-action="new-today">＋ 新增今日待辦</button>
  </details>
  <details id="compact-week" class="compact-section">
    <summary>本週接下來的行程 <span>${upcoming.length} 件</span></summary>
    ${days.length ? days.map(date => `<section class="compact-day">
      <h3>${weekday(date)} ${shortDate(date)}</h3>
      ${compactEvents(upcoming.filter(item => item.date === date), '')}
    </section>`).join('') : empty('本週沒有其他行程')}
  </details>
  ${overdue.length ? `<details id="compact-overdue" class="compact-section">
    <summary>逾期未完成 <span>${overdue.length} 件</span></summary>
    ${entryList(overdue, '', true)}
  </details>` : ''}
  ${recurringList(day, true)}
  ${compactFuture(items)}
  <details id="compact-inbox" class="compact-section">
    <summary>捕捉箱 <span>${captures.length} 件待整理</span></summary>
    ${entryList(captures, '沒有待整理的捕捉', false, (a, b) => b.created.localeCompare(a.created))}
  </details>
  <footer class="compact-footer">
    <a href="/#today" target="_blank" rel="noopener">完整筆記 ↗</a>
    <a href="/#projects" target="_blank" rel="noopener">專案 ↗</a>
  </footer>`;
}

function todayView() {
  if (compact) return compactToday();
  const { today, overdue, focus, next } = agenda(state.items, state.day);
  const hero = next ? `
    <button class="focus-title" data-action="edit" data-id="${next.id}">${escape(next.title)}</button>
    <p>${escape(next.next || '開啟筆記查看細節')}</p>
    <button class="focus-action" data-action="done" data-id="${next.id}">✓ 完成這件事</button>` : `
    <h3>今天沒有待執行的任務</h3><button class="focus-action" data-action="new-today">新增今日任務</button>`;
  const events = today.filter(isEvent);
  const list = today.filter(item => !events.includes(item));
  return `<div class="today-grid">
    <section class="focus"><div class="focus-label"><span>✦</span> ${focus ? '今日焦點' : '下一件事'}</div>${hero}</section>
    <section class="panel events"><h2>今日行程</h2>${entryList(events, '今天沒有排定行程。')}</section>
    <section class="panel tasks"><h2>今日事項 <span>${list.length}</span></h2>${entryList(list, '今天還沒有安排事項。', true)}</section>
    <section class="panel overdue"><h2>逾期未完成 <span>${overdue.length}</span></h2>${entryList(overdue, '沒有逾期的任務。', true)}</section>
    ${recurringList(state.day, true)}
    ${routineGoals(state.rules || [], { onlyQuota: true })}
  </div>`;
}

function inboxView() {
  const items = state.items.filter(item => inboxMode === 'archived' ? item.archived : !item.archived);
  return `<div class="toolbar">
    <button data-action="inbox-open" class="quiet ${inboxMode === 'open' ? 'selected' : ''}">使用中</button>
    <button data-action="inbox-archived" class="quiet ${inboxMode === 'archived' ? 'selected' : ''}">已封存</button>
    <button data-action="inbox-trash" class="quiet ${inboxMode === 'trash' ? 'selected' : ''}">垃圾桶</button>
  </div>${inboxMode === 'trash' ? trashView() : Object.entries(types).map(([key, label]) => {
    const group = items.filter(item => item.type === key);
    if (key === 'T' && inboxMode === 'open') return inboxTasks(group);
    return group.length ? `<section class="panel spaced"><h2>${label} <span>${group.length}</span></h2>${entryList(group, '', true)}</section>` : '';
  }).join('') || empty('這裡還沒有筆記。')}`;
}

function inboxTasks(tasks) {
  const { today, overdue } = agenda(tasks, state.day);
  const todayIds = new Set(today.map(task => task.id));
  const overdueIds = new Set(overdue.map(task => task.id));
  const groups = { all: tasks, today: [], overdue: [], upcoming: [], unscheduled: [] };
  for (const task of tasks) {
    if (task.status === 'done') continue;
    if (overdueIds.has(task.id)) groups.overdue.push(task);
    else if (todayIds.has(task.id)) groups.today.push(task);
    else if (task.date > state.day || task.dueDate > state.day) groups.upcoming.push(task);
    else if (!task.date && !task.dueDate) groups.unscheduled.push(task);
  }
  const visible = groups[taskFilter];
  return `<section class="panel spaced"><h2>任務 <span>${visible.length}</span></h2>
    <div class="toolbar" role="group" aria-label="任務篩選">
      ${Object.entries(taskFilters).map(([key, label]) => `<button type="button" class="quiet ${key === taskFilter ? 'selected' : ''}"
        data-action="task-filter" data-filter="${key}" aria-pressed="${key === taskFilter}">${label}</button>`).join('')}
    </div>
    ${entryList(visible, '目前沒有符合的任務。', true)}
  </section>`;
}

function trashView() {
  const rows = (state.trash || []).map(record => {
    const category = record.kind ? 'rule' : 'item';
    const label = record.kind === 'routine' ? '日常' : record.kind === 'birthday' ? '生日' : types[record.type];
    const expiry = record.deletedDay ? ' · ' + trashExpiry(record.deletedDay) + ' 00:00 永久刪除' : '';
    return `<li class="entry"><div class="entry-main"><strong>${escape(record.title)}</strong><small>${escape(label + expiry)}</small></div>
      <button class="quiet" data-action="restore-trash" data-id="${record.id}" data-category="${category}">復原</button></li>`;
  });
  return `<section class="panel spaced"><h2>垃圾桶</h2><p class="muted">移入當天算第 1 天，第 4 天 00:00 永久刪除（台北時間）。</p>${rows.length ? `<ul class="entries">${rows.join('')}</ul>` : empty('垃圾桶是空的。')}</section>`;
}

function projectTimeline(projectId, tasks) {
  const timelineId = 'project-timeline-' + projectId;
  const deadlineOnly = deadlineOnlyTimelines.has(timelineId);
  const milestones = tasks.flatMap(task => [
    { task, date: task.date, time: task.time, label: '排程' },
    { task, date: task.dueDate, time: task.dueTime, label: '截止' }
  ]).filter(event => event.date && (!deadlineOnly || event.label === '截止'));
  // Date-only schedules start the day, while date-only deadlines end it.
  const eventTime = event => event.time || (event.label === '截止' ? '24:00' : '00:00');
  milestones.sort((a, b) => a.date.localeCompare(b.date) ||
    eventTime(a).localeCompare(eventTime(b)) || a.label.localeCompare(b.label) ||
    a.task.title.localeCompare(b.task.title));
  return `<details id="${timelineId}" class="project-timeline">
    <summary>時間軸</summary>
    <div class="timeline-controls">
      <button type="button" class="quiet" data-action="timeline-filter" aria-pressed="${deadlineOnly}">只看截止</button>
      <button type="button" class="quiet" data-action="timeline-today" ${milestones.length ? '' : 'disabled'}>跳到今天</button>
    </div>
    ${milestones.length ? `<ol class="entries timeline-track" tabindex="0" aria-label="專案時間軸，可左右捲動">${milestones.map(({ task, date, time, label }) => `<li class="entry timeline-point ${task.status === 'done' ? 'finished' : ''}" data-date="${date}">
      <span class="timeline-marker ${label === '截止' ? 'is-deadline' : ''}" aria-hidden="true"></span>
      <button class="entry-main" data-action="edit" data-id="${task.id}" title="${escape(task.title)}">
        <small><span class="${label === '截止' ? 'timeline-deadline' : ''}">${label}</span> <time datetime="${date}${time ? 'T' + time + '+08:00' : ''}"${date === state.day ? ' aria-current="date"' : ''}>${date}${time ? ' ' + time : ''}</time></small>
        <strong>${escape(task.title)}</strong>
      </button>
    </li>`).join('')}</ol>` : empty(deadlineOnly ? '這個專案目前沒有截止日期。' : '子任務加上排程或截止日期後，就會顯示在這裡。')}
  </details>`;
}

function jumpToTimelineToday(button) {
  const track = button.closest('.project-timeline').querySelector('.timeline-track');
  const point = [...track.children].find(entry => entry.dataset.date >= state.day) ?? track.lastElementChild;
  track.scrollLeft = point.offsetLeft - track.firstElementChild.offsetLeft;
}

function toggleTimelineFilter(button) {
  const id = button.closest('.project-timeline').id;
  if (deadlineOnlyTimelines.has(id)) deadlineOnlyTimelines.delete(id);
  else deadlineOnlyTimelines.add(id);
  render(id);
  document.getElementById(id).querySelector('[data-action="timeline-filter"]').focus({ preventScroll: true });
}

function projectsView() {
  const projects = state.items.filter(item => item.type === 'P' && !item.archived).sort(byTime);
  return `<div class="toolbar"><button class="quiet selected" data-action="new-project">＋ 新增專案</button></div>
    ${projects.map(project => {
      const tasks = state.items.filter(item => item.type === 'T' && item.parentId === project.id);
      const completed = tasks.filter(item => item.status === 'done').length;
      const activeTasks = tasks.filter(task => !task.archived);
      const notes = state.items.filter(item => item.type === 'N' && item.parentId === project.id && !item.archived);
      const next = activeTasks.filter(task => task.status !== 'done').sort(byTaskPriority)[0];
      return `<details id="project-${project.id}" class="panel spaced project-tree">
        <summary><strong>${escape(project.title)}</strong><span>已完成 ${completed} / ${tasks.length}</span></summary>
        ${tasks.length ? `<progress value="${completed}" max="${tasks.length}" aria-label="已完成 ${completed} 件，共 ${tasks.length} 件"></progress>` : ''}
        ${next ? `<div class="project-next">
          <h3>下一個任務</h3>
          <button class="entry-main" data-action="edit" data-id="${next.id}">
            <strong>${escape(next.title)}</strong>
            ${next.next ? `<small>${escape(next.next)}</small>` : ''}
            ${next.date ? `<small>排程 ${escape([next.date, next.time].filter(Boolean).join(' '))}</small>` : ''}
          </button>
        </div>` : ''}
        ${projectTimeline(project.id, activeTasks)}
        ${entryList(activeTasks, '目前沒有使用中的子任務。', true, byTaskPriority)}
        ${notes.length ? `<h3>專案筆記</h3>${entryList(notes, '')}` : ''}
        ${tasks.some(task => task.archived) ? `<details id="project-archived-${project.id}" class="project-archived"><summary>已封存的子任務</summary>
          ${entryList(tasks.filter(task => task.archived), '')}</details>` : ''}
        <div class="toolbar project-actions">
          <button class="quiet selected" data-action="new-subtask" data-id="${project.id}">＋ 新增子任務</button>
          <button class="quiet" data-action="edit" data-id="${project.id}">編輯專案</button>
        </div>
      </details>`;
    }).join('') || empty('目前沒有使用中的專案。')}`;
}

function weekView() {
  const start = shift(sunday(state.day), weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, index) => shift(start, index));
  const items = state.items.filter(item => !item.archived);
  return `<div class="toolbar timeline">
    <button class="quiet" data-action="prior-week" aria-label="上一週">‹</button><strong>${shortDate(start)} – ${shortDate(days[6])}</strong>
    <button class="quiet" data-action="next-week" aria-label="下一週">›</button><button class="quiet" data-action="this-week">回本週</button>
  </div><div class="week">${days.map(day => `<section class="day ${day === state.day ? 'is-today' : ''}">
    <header><h2>${weekday(day)} <span>${shortDate(day)}</span></h2><button class="quiet" data-action="new-day" data-day="${day}" aria-label="新增 ${shortDate(day)} 的行程">＋</button></header>
    ${calendarDayEntries(items, day)}
  </section>`).join('')}</div>`;
}

function calendarDayEntries(items, day) {
  const entries = items.filter(item => item.date === day || (item.type === 'T' && item.dueDate === day));
  const recurring = recurringList(day);
  return (entries.length ? entryList(entries, '') : '') + recurring || empty('—');
}

function shiftMonth(month, offset) {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function futureView() {
  const month = futureMonth || state.day.slice(0, 7);
  const year = month.slice(0, 4);
  const yearly = futureMode === 'year';
  const items = state.items.filter(item => !item.archived);
  const onDay = day => items.filter(item => item.date === day || (item.type === 'T' && item.dueDate === day));
  const rules = state.rules || [];
  const monthPlans = month => items.filter(item => item.month === month && !item.date);
  const monthDays = month => {
    const next = shiftMonth(month, 1) + '-01';
    const days = Number(shift(next, -1).slice(-2));
    return Array.from({ length: days }, (_, index) => shift(month + '-01', index));
  };
  const toolbar = `<div class="toolbar timeline">
    <button class="quiet" data-action="prior-period" aria-label="${yearly ? '上一年' : '上個月'}">‹</button>
    <strong>${year} 年${yearly ? '' : ' ' + Number(month.slice(5)) + ' 月'}</strong>
    <button class="quiet" data-action="next-period" aria-label="${yearly ? '下一年' : '下個月'}">›</button>
    <button class="quiet" data-action="current-month">回本月</button>
    <button class="quiet ${yearly ? 'selected' : ''}" data-action="future-mode" aria-pressed="${yearly}">${yearly ? '月份日曆' : '全年總覽'}</button>
  </div>`;
  if (yearly) {
    const months = Array.from({ length: 12 }, (_, index) => shiftMonth(year + '-01', index));
    return toolbar + `<div class="months">${months.map((key, index) => {
      const days = monthDays(key);
      const plans = monthPlans(key).length;
      const daysWithItems = days.filter(day => onDay(day).length || recurringOn(rules, day).length).length;
      return `<button type="button" class="day year-month" data-action="open-month" data-month="${key}">
        <strong>${index + 1} 月</strong><small>${daysWithItems} 天有安排 · ${plans} 筆月規劃</small>
      </button>`;
    }).join('')}</div>`;
  }
  const days = monthDays(month);
  const todayInMonth = state.day.startsWith(month + '-');
  const selected = days.includes(futureDay) ? futureDay : todayInMonth ? state.day : days[0];
  const blanks = new Date(days[0] + 'T00:00:00Z').getUTCDay();
  const plans = monthPlans(month);
  const rows = days.map(day => {
    const records = onDay(day);
    const recurring = recurringOn(rules, day);
    const count = records.length + recurring.length;
    const names = [...records.map(item => item.title), ...recurring.map(({ rule }) => rule.title)];
    return `<button type="button" class="month-date ${day === state.day ? 'is-today' : ''}" data-action="select-month-day"
      data-day="${day}" aria-pressed="${day === selected}" aria-label="${dateLabel(day)}${count ? '，' + count + ' 筆' : ''}">
      <span>${Number(day.slice(-2))}</span>
      ${count ? `<span class="month-count">${count} 筆</span><small class="month-name">${escape(names[0])}</small>` : ''}
    </button>`;
  });
  const dailyEntries = onDay(selected);
  const recurring = recurringList(selected);
  return toolbar + `<div class="month-grid" aria-label="${year} 年 ${Number(month.slice(5))} 月日曆">
    ${[...'日一二三四五六'].map(day => `<div class="month-weekday">週${day}</div>`).join('')}
    ${'<span aria-hidden="true"></span>'.repeat(blanks)}${rows.join('')}
  </div>
  <section class="panel spaced"><div class="toolbar"><h2>${dateLabel(selected)}</h2>
    <button class="quiet" data-action="new-day" data-day="${selected}">＋ 新增事件</button></div>
    ${(dailyEntries.length ? entryList(dailyEntries, '') : '') + recurring || empty('當天沒有安排。')}
  </section>
  <section class="panel spaced"><div class="toolbar"><h2>本月規劃</h2>
    <button class="quiet" data-action="new-month" data-month="${month}">＋ 新增月規劃</button></div>
    ${entryList(plans, '目前沒有只指定月份的規劃。')}
  </section>`;
}

function recurringList(day, today = false, rules = state.rules || []) {
  const occurrences = recurringOn(rules, day);
  if (!occurrences.length) return '';
  const rows = occurrences.map(({ rule, id, time }) => {
    const status = state.marks?.[id];
    const buttons = today && rule.kind === 'routine' ? (status
      ? '<button class="quiet" data-action="recurring-mark" data-status="">復原</button>'
      : '<button class="quiet" data-action="recurring-mark" data-status="done">完成</button><button class="quiet" data-action="recurring-mark" data-status="skip">略過</button>') : '';
    const label = rule.kind === 'birthday' ? '生日 · ' + shortDate(day) : time;
    return `<li class="entry" data-occurrence="${id}">
      <button class="entry-main" data-action="edit-rule" data-id="${rule.id}">
        <strong>${escape(rule.title)}</strong><small>${label}${status ? ' · ' + (status === 'done' ? '已完成' : '已略過') : ''}</small>
      </button>${buttons}</li>`;
  }).join('');
  const list = `<ul class="entries">${rows}</ul>`;
  return today ? `<section class="panel"><h2>今日日常與生日</h2>${list}</section>` : list;
}

function routineGoals(rules, { history = false, onlyQuota = false } = {}) {
  const cards = rules.filter(rule => rule.kind === 'routine' && (!onlyQuota || rule.frequency === 'quota')).map(rule => {
    const marks = state.routineCounts?.[rule.id] || [];
    const weeks = routineWeeks(rule, marks, state.day);
    const { done, target, percent } = weeks.at(-1);
    const quota = rule.frequency === 'quota';
    const timing = quota ? '每週自選時間' : ({
      daily: '每天', weekly: rule.days.map(day => '週' + '日一二三四五六'[day]).join('、'),
      monthly: '每月 ' + rule.days.join('、') + ' 日'
    })[rule.frequency] + ' · ' + rule.times.join('、');
    const countToday = marks.filter(day => day === state.day).length;
    const unit = rule.targetUnit === 'days' ? '天' : '次';
    const label = target ? `${done} / ${target} ${unit} · ${percent}%` : `${done} ${unit} · ${rule.paused ? '已暫停' : '本週無排程'}`;
    const controls = quota && !rule.paused ? `<div class="routine-controls">
      <button class="quiet" data-action="routine-count" data-id="${rule.id}" data-change="1" ${unit === '天' && countToday ? 'disabled' : ''} aria-label="${unit === '天' ? '今天完成' : '記一次'} ${escape(rule.title)}">${unit === '天' ? (countToday ? '✓ 今天已完成' : '＋ 今天完成') : '＋ 記一次'}</button>
      <button class="quiet" data-action="routine-count" data-id="${rule.id}" data-change="-1" ${countToday ? '' : 'disabled'} aria-label="撤銷一次 ${escape(rule.title)}">撤銷一次</button>
    </div>` : '';
    return `<article class="routine-goal">
      <button class="entry-main" data-action="edit-rule" data-id="${rule.id}"><strong>${escape(rule.title)}</strong><small>${escape(timing)}${rule.paused ? ' · 已暫停' : ''}</small></button>
      <p>${label}</p>
      ${target ? `<progress value="${Math.min(done, target)}" max="${target}" aria-label="本週目標完成度"></progress>` : ''}
      ${controls}
      ${history ? `<details id="routine-history-${rule.id}"><summary>近 8 週完成率</summary>
        <ul class="routine-history">${weeks.map(week => `<li><span>${shortDate(week.start)} 起</span>
          <progress value="${Math.min(week.percent || 0, 100)}" max="100" aria-label="${shortDate(week.start)} 完成率"></progress>
          <span>${week.percent == null ? '—' : week.done + '/' + week.target + ' · ' + week.percent + '%'}</span></li>`).join('')}</ul>
      </details>` : ''}
    </article>`;
  });
  return cards.length ? `<section class="panel spaced"><h2>本週日常目標 <span>週日到週六</span></h2>${cards.join('')}</section>` : '';
}

let healthRows = null;
let healthLoading = false;
let healthLoadError = '';
let healthMetric = 'weight';
const healthEditor = $('#health-editor');
const healthForm = $('#health-form');
const healthDay = healthForm.elements.day;
const healthPhoto = healthForm.elements.photo;
const healthFeedback = $('#health-feedback');
const healthRead = $('#health-read');
const healthDelete = $('#health-delete');
const healthClose = $('#health-close');
let healthBusy = false;
let editedHealthReading = null;
$('#health-values').innerHTML = Object.entries(healthMetrics).map(([name, { label, unit, max }]) =>
  `<label>${label}${unit ? '（' + unit + '）' : ''}<input name="${name}" type="number" min="${name === 'weight' ? '.01' : 0}" max="${max}" step="any" inputmode="decimal"></label>`).join('');

async function loadHealth() {
  if (healthLoading) return;
  healthLoading = true;
  healthLoadError = '';
  try {
    healthRows = await request('health-readings');
  } catch (error) {
    healthLoadError = error.message;
  } finally {
    if (location.hash === '#health') render();
    healthLoading = false;
  }
}

function healthChart() {
  const { label, unit } = healthMetrics[healthMetric];
  const data = healthRows.filter(row => row.values[healthMetric] != null).slice(0, 30).reverse();
  if (!data.length) return empty('這項數值還沒有紀錄。');
  const values = data.map(row => row.values[healthMetric]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const dateX = day => Date.parse(day + 'T00:00:00Z');
  const first = dateX(data[0].day);
  const last = dateX(data.at(-1).day);
  const points = data.map((row, index) => [
    last === first ? 160 : 18 + (dateX(row.day) - first) / (last - first) * 284,
    low === high ? 67 : 114 - (values[index] - low) / (high - low) * 94
  ]);
  return `<figure class="health-chart">
    <svg viewBox="0 0 320 132" role="img" aria-label="${label}歷史趨勢圖">
      <polyline points="${points.map(point => point.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="2" />
      ${points.map(([x, y], index) => `<circle cx="${x}" cy="${y}" r="3.6" fill="currentColor"><title>${data[index].day} · ${values[index]} ${unit}</title></circle>`).join('')}
    </svg>
    <figcaption><span>${data[0].day}</span><strong>最新 ${values.at(-1)} ${unit}</strong><span>${data.at(-1).day}</span></figcaption>
    ${low !== high ? `<small>範圍 ${low}–${high} ${unit}</small>` : ''}
  </figure>`;
}

function healthView() {
  return `<div class="toolbar"><button class="primary" data-action="new-health">＋ 新增量測</button>
    <button class="quiet" data-action="refresh-health">重新整理</button></div>
    ${healthLoadError ? `<p role="alert">${escape(healthLoadError)}</p>` : ''}
    ${healthRows ? `<section class="panel spaced"><h2>量測趨勢 <span>最近 30 筆</span></h2>
      <div class="toolbar" role="group" aria-label="量測指標">${Object.entries(healthMetrics).map(([key, { label }]) =>
        `<button class="quiet ${healthMetric === key ? 'selected' : ''}" data-action="health-metric" data-metric="${key}" aria-pressed="${healthMetric === key}">${label}</button>`).join('')}</div>
      ${healthChart()}</section>
      <section class="panel spaced"><h2>歷史紀錄</h2>${healthRows.length ? `<ul class="entries">${healthRows.map(row =>
        `<li class="entry"><button class="entry-main" data-action="edit-health" data-day="${row.day}"><strong>${row.day}</strong>
          <small>${Object.entries(healthMetrics).filter(([key]) => row.values[key] != null).map(([key, metric]) =>
            `${metric.label} ${row.values[key]}${metric.unit}`).join(' · ')}</small></button></li>`).join('')}</ul>` : empty('尚未新增量測。')}</section>` :
      healthLoadError ? '' : '<p role="status">載入量測紀錄中…</p>'}`;
}

function openHealth(row) {
  editedHealthReading = row || null;
  healthForm.reset();
  healthDay.max = state.day;
  healthDay.value = row?.day || state.day;
  healthDay.readOnly = Boolean(row);
  healthDelete.hidden = !row;
  healthFeedback.textContent = '';
  for (const name of Object.keys(healthMetrics)) healthForm.elements[name].value = row?.values[name] ?? '';
  healthEditor.showModal();
}

async function healthAction(callback) {
  if (healthBusy) return;
  healthBusy = true;
  for (const button of healthForm.querySelectorAll('button')) button.disabled = true;
  healthFeedback.textContent = '';
  try {
    await callback();
  } catch (error) {
    healthFeedback.textContent = error.message;
  } finally {
    healthBusy = false;
    for (const button of healthForm.querySelectorAll('button')) button.disabled = false;
  }
}

healthClose.onclick = () => healthEditor.close();
healthEditor.addEventListener('cancel', event => {
  if (healthBusy) event.preventDefault();
});
healthRead.onclick = () => void healthAction(async () => {
  const file = healthPhoto.files[0];
  if (!file || !file.type.startsWith('image/') || file.size > 20000000) throw new Error('請選擇 20 MB 以內的圖片。');
  healthFeedback.textContent = '正在用電腦上的本地 AI 辨識…';
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('無法開啟這張圖片。請改用 JPG 或 PNG 截圖。');
  }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = canvas.toDataURL('image/jpeg', .9).split(',')[1];
  const { values } = await request('health-photo', { image });
  for (const name of Object.keys(healthMetrics)) healthForm.elements[name].value = values[name] ?? '';
  if (!healthDay.readOnly) healthDay.value = '';
  healthFeedback.textContent = '請核對辨識結果並自行填寫量測日期，再儲存。';
});
healthForm.onsubmit = event => {
  event.preventDefault();
  void healthAction(async () => {
    let version = editedHealthReading?.version || 0;
    if (!healthDay.readOnly) {
      const rows = await request('health-readings');
      const existing = rows.find(row => row.day === healthDay.value);
      if (existing) {
        if (!confirm('這天已有量測紀錄，要覆蓋嗎？')) return;
        version = existing.version;
      }
    }
    const values = Object.fromEntries(Object.keys(healthMetrics).flatMap(name => {
      const value = healthForm.elements[name].value;
      return value === '' ? [] : [[name, Number(value)]];
    }));
    await request('health-readings', { day: healthDay.value, values, version });
    healthEditor.close();
    await loadHealth();
  });
};
healthDelete.onclick = () => {
  if (!confirm('確定刪除這筆健康紀錄？')) return;
  void healthAction(async () => {
    await request('health-readings', { day: healthDay.value, version: editedHealthReading.version, remove: true });
    healthEditor.close();
    await loadHealth();
  });
};

function routinesView() {
  const rules = state.rules || [];
  return `<div class="toolbar">
    <button class="quiet selected" data-action="new-routine">＋ 新增日常</button>
    <button class="quiet" data-action="new-birthday">＋ 新增生日</button>
  </div>
  ${routineGoals(rules, { history: true })}
  ${recurringList(state.day, true, rules.filter(rule => rule.kind === 'routine'))}
  ${[['birthday', '生日']].map(([kind, label]) => {
    const rows = rules.filter(rule => rule.kind === kind).map(rule => {
      const timing = kind === 'birthday' ? rule.monthDay.replace('-', '/') + ' · 每年' :
        ({ daily: '每天', weekly: rule.days.map(day => '週' + '日一二三四五六'[day]).join('、'),
          monthly: '每月 ' + rule.days.join('、') + ' 日' })[rule.frequency] + ' · ' + rule.times.join('、');
      return `<li class="entry"><button class="entry-main" data-action="edit-rule" data-id="${rule.id}">
        <strong>${escape(rule.title)}</strong><small>${escape(timing)}${rule.paused ? ' · 已暫停' : ''}</small>
      </button></li>`;
    }).join('');
    return `<section class="panel spaced"><h2>${label}</h2>${rows ? `<ul class="entries">${rows}</ul>` : empty('目前沒有設定。')}</section>`;
  }).join('')}`;
}

let notesQuery = '';
function notesResults() {
  const terms = notesQuery.trim().toLocaleLowerCase().split(/\s+/);
  return [['J', '日誌'], ['N', '筆記']].map(([type, title]) => {
    const entries = state.items.filter(item => !item.archived && item.type === type &&
      terms.every(term => [item.title, item.notes].some(value => value.toLocaleLowerCase().includes(term))));
    return `<section class="panel spaced"><h2>${title}</h2>${entryList(entries, '沒有符合的記錄。', false, (a, b) => byTime(b, a))}</section>`;
  }).join('');
}

function notesView() {
  return `<div class="toolbar notes-toolbar">
    <button class="quiet selected" data-action="new-journal">＋ 新增日誌</button>
    <button class="quiet" data-action="new-note">＋ 新增筆記</button>
    <input id="notes-search" type="search" value="${escape(notesQuery)}" aria-label="搜尋日誌與筆記" placeholder="搜尋標題與內容">
  </div><div id="notes-results">${notesResults()}</div>`;
}

let meetingFilter = '';
function meetingsView() {
  const entries = state.items.filter(item => item.type === 'A' && !item.archived &&
    (!meetingFilter || (item.meetingKind ?? 'meeting') === meetingFilter));
  const filters = [['', '全部'], ...Object.entries(meetingKinds).map(([id, kind]) => [id, kind.label])];
  return `<div class="toolbar" role="group" aria-label="篩選紀錄類別">${filters.map(([id, label]) =>
    `<button class="quiet ${meetingFilter === id ? 'selected' : ''}" data-action="meeting-filter" data-kind="${id}" aria-pressed="${meetingFilter === id}">${label}</button>`).join('')}</div>
    <div class="toolbar"><button class="quiet selected" data-action="new-meeting">＋ 新增會議紀錄</button></div>
    <section class="panel spaced">${entryList(entries, '尚未新增會議紀錄。', false, (a, b) => byTime(b, a))}</section>`;
}

let aiStatusMessage = '';
function alertView() {
  const settings = state.settings;
  const pushText = state.pushDevice === device ? '這台是主要接收裝置。' :
    state.pushDevice ? '目前由另一台裝置接收系統推播。' : '尚未指定主要接收裝置。';
  return `<div class="alert-grid">
    <section class="panel spaced"><h2>提醒時間 <span>台北時間</span></h2>
      <form id="settings">
        <label>每日摘要<input name="daily" type="time" value="${settings.daily}"></label>
        <label>未完成事項<input name="review" type="time" value="${settings.review}"></label>
        <label>週日行程與未來規劃<input name="weekly" type="time" value="${settings.weekly}"></label>
        <p class="muted">將時間清空即可停用該類提醒。</p><button class="primary">儲存提醒</button>
      </form>
    </section>
    <section class="panel spaced"><h2>系統推播</h2><p class="muted">${state.pushKey ? pushText : '這個服務尚未啟用背景推播。提醒會顯示在下方紀錄。'}</p>
      <div class="toolbar"><button class="quiet" data-action="subscribe" ${state.pushKey ? '' : 'disabled'}>用這台接收</button>
      <button class="quiet" data-action="push-test" ${state.pushDevice === device ? '' : 'disabled'}>測試推播</button></div>
    </section>
  </div>
  <section class="panel spaced"><h2>本地 AI</h2>
    <p class="muted">${state.localAI ? '已設定模型 ' + escape(state.aiModel || '') : '尚未啟用，請先設定 Ollama 模型。'}</p>
    <button class="quiet" data-action="ai-status">測試 AI 連線</button>
    <p id="ai-status-result" role="status">${escape(aiStatusMessage)}</p>
  </section>
  <section class="panel spaced"><h2>提醒紀錄</h2>
    ${state.notices.length ? `<ul class="entries">${state.notices.map(notice => `<li class="notice"><strong>${escape(notice.title)}</strong><small>${escape(notice.body)}</small></li>`).join('')}</ul>` : empty('目前沒有到時間的提醒。')}
  </section>`;
}

const recurringEditor = $('#recurring-editor');
const recurringForm = $('#recurring-form');
addNumericFields(recurringForm);
const recurringClose = $('#recurring-close');
const deleteRule = $('#delete-rule');
const numbers = (length, first = 1) => Array.from({ length }, (_, index) => first + index);
const padDate = number => String(number).padStart(2, '0');
let ruleDraft;
recurringForm.querySelector('.weekday-options').innerHTML = [...'日一二三四五六'].map((day, index) =>
  `<label><input name="weekday" type="checkbox" value="${index}">週${day}</label>`).join('');
recurringForm.elements.birthdayMonth.innerHTML = numbers(12).map(number =>
  `<option value="${padDate(number)}">${number} 月</option>`).join('');

function syncRecurringFields() {
  const fields = recurringForm.elements;
  const isBirthday = ruleDraft.kind === 'birthday';
  const monthly = !isBirthday && fields.frequency.value === 'monthly';
  const quota = !isBirthday && fields.frequency.value === 'quota';
  $('#routine-target').hidden = !quota;
  fields.target.disabled = !quota;
  fields.targetUnit.disabled = !quota;
  fields.target.max = fields.targetUnit.value === 'days' ? 7 : 99;
  $('#routine-times').hidden = isBirthday || quota;
  $('#recurring-time-hint').hidden = isBirthday || quota;
  $('#recurring-weekdays').hidden = isBirthday || fields.frequency.value !== 'weekly';
  $('#recurring-monthdays').hidden = !monthly;
  $('#monthdays-hint').hidden = !monthly;
  if (!isBirthday) return;
  const selected = Number(fields.birthdayDay.value) || 1;
  const last = new Date(Date.UTC(2000, Number(fields.birthdayMonth.value), 0)).getUTCDate();
  fields.birthdayDay.innerHTML = numbers(last).map(number =>
    `<option value="${padDate(number)}">${number} 日</option>`).join('');
  fields.birthdayDay.value = padDate(Math.min(selected, last));
}

function openRule(kind, rule) {
  ruleDraft = rule ?? { id: uuid(), version: 0, kind };
  const fields = recurringForm.elements;
  const isBirthday = kind === 'birthday';
  $('#recurring-title').textContent = (rule ? '編輯' : '新增') + (isBirthday ? '生日' : '日常');
  deleteRule.hidden = !rule;
  recurringForm.reset();
  syncNumericFields(recurringForm, true);
  fields.title.value = rule?.title || '';
  fields.frequency.value = rule?.frequency || 'daily';
  fields.target.value = rule?.target ?? 4;
  fields.targetUnit.value = rule?.targetUnit || 'times';
  fields.monthdays.value = rule?.frequency === 'monthly' ? rule.days.join('、') : '';
  for (const checkbox of recurringForm.querySelectorAll('[name="weekday"]')) {
    checkbox.checked = rule?.frequency === 'weekly' && rule.days.includes(Number(checkbox.value));
  }
  fields.times.value = rule?.times.join('、') || '';
  const [month, day] = (rule?.monthDay || state.day.slice(5)).split('-');
  fields.birthdayMonth.value = month;
  fields.birthdayTime.value = rule?.times[0] || '09:00';
  fields.lead.value = String(rule?.lead ?? 0);
  fields.paused.checked = rule?.paused || false;
  recurringForm.querySelectorAll('[data-routine]').forEach(element => { element.hidden = isBirthday; });
  recurringForm.querySelector('[data-birthday]').hidden = !isBirthday;
  syncRecurringFields();
  fields.birthdayDay.value = day;
  $('#recurring-error').textContent = '';
  recurringEditor.showModal();
  fields.title.focus();
}

const splitOptions = value => value.trim().split(/[、，,\s]+/).filter(Boolean);
recurringForm.elements.frequency.onchange = syncRecurringFields;
recurringForm.elements.targetUnit.onchange = syncRecurringFields;
recurringForm.elements.birthdayMonth.onchange = syncRecurringFields;
recurringClose.onclick = () => recurringEditor.close();
recurringEditor.addEventListener('cancel', event => {
  if (recurringClose.disabled) event.preventDefault();
});
recurringForm.onsubmit = async event => {
  event.preventDefault();
  if (!applyNumericFields(recurringForm)) return;
  const fields = recurringForm.elements;
  const submit = recurringForm.querySelector('footer .primary');
  if (submit.disabled) return;
  const frequency = fields.frequency.value;
  const monthdays = frequency === 'monthly' ? splitOptions(fields.monthdays.value.normalize('NFKC')) : [];
  if (ruleDraft.kind === 'routine' && monthdays.some(day => !/^\d{1,2}$/.test(day))) {
    $('#recurring-error').textContent = '每月日期請填 1 到 31 的整數，例如 1、15、28。';
    return;
  }
  const days = frequency === 'weekly' ? new FormData(recurringForm).getAll('weekday').map(Number) : monthdays.map(Number);
  const schedule = ruleDraft.kind === 'birthday'
    ? { monthDay: fields.birthdayMonth.value + '-' + fields.birthdayDay.value, lead: Number(fields.lead.value), times: [fields.birthdayTime.value] }
    : { frequency, days, target: frequency === 'quota' ? Number(fields.target.value) : undefined,
        targetUnit: frequency === 'quota' ? fields.targetUnit.value : undefined,
        times: frequency === 'quota' ? [] : splitOptions(fields.times.value).map(value => parseNumericTime(value) || value) };
  submit.disabled = recurringClose.disabled = deleteRule.disabled = true;
  try {
    await request('recurring', { ...ruleDraft, ...schedule, title: fields.title.value, paused: fields.paused.checked });
    recurringEditor.close();
    await refreshAfterWrite();
  } catch (error) {
    $('#recurring-error').textContent = error.message;
  } finally {
    submit.disabled = recurringClose.disabled = deleteRule.disabled = false;
  }
};

async function refreshAfterWrite() {
  revision++;
  // A refresh that began before the write discards its stale response.
  if (syncing) {
    setTimeout(refresh, 300);
    return;
  }
  await refresh();
}

async function moveToTrash(record, category, dialog, errorBox) {
  const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
  if (!buttons.length) return;
  for (const button of buttons) button.disabled = true;
  errorBox.textContent = '';
  dialog.dataset.deleting = '';
  try {
    await request('trash', { id: record.id, version: record.version, category, deleted: true });
    dialog.close();
    $('#message').textContent = '已移到垃圾桶，可以在捕捉箱復原。';
    await refreshAfterWrite();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    delete dialog.dataset.deleting;
    for (const button of buttons) button.disabled = false;
  }
}
deleteRule.onclick = () => moveToTrash(ruleDraft, 'rule', recurringEditor, $('#recurring-error'));
deleteEntry.onclick = () => moveToTrash(draft, 'item', editor, $('#editor-error'));

const overdueKey = () => agenda(state.items, state.day).overdue.map(item => item.id).join(',');

function render(resetTimelineId) {
  if (!state) return;
  renderAfterSettingsEdit = false;
  renderedOverdue = overdueKey();
  const tab = !compact && Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  document.querySelectorAll('nav a').forEach(link => {
    if (link.hash === '#' + tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#date-label').textContent = dateLabel(state.day);
  $('#page-title').textContent = titles[tab];
  $('#voice-add').hidden = compact || !['today', 'inbox', 'notes'].includes(tab);
  $('#add').hidden = ['health', 'meetings'].includes(tab);
  const view = $('#view');
  const expanded = [...view.querySelectorAll('details[id][open]')].map(section => section.id);
  const timelineScroll = new Map([...view.querySelectorAll('.project-timeline[open] .timeline-track')]
    .map(track => [track.parentElement.id, track.scrollLeft]));
  view.innerHTML = { today: todayView, inbox: inboxView, projects: projectsView, week: weekView, future: futureView,
    alerts: alertView, routines: routinesView, notes: notesView, meetings: meetingsView, health: healthView }[tab]();
  if (tab === 'health' && healthRows === null && !healthLoading) void loadHealth();
  const settingsForm = view.querySelector('#settings');
  if (settingsForm) addNumericFields(settingsForm);
  for (const id of expanded) {
    const section = document.getElementById(id);
    if (section) section.open = true;
  }
  for (const [id, left] of timelineScroll) {
    if (id === resetTimelineId) continue;
    const track = document.getElementById(id)?.querySelector('.timeline-track');
    if (track) track.scrollLeft = left;
  }
}

const scheduleHints = {
  T: '預計哪天、幾點做，可提早開始。未設期限時，排程跨日仍未完成會列為逾期。',
  E: '填事件開始的日期和時間。只有日期時，會顯示為全天。',
  J: '填寫日誌記錄的日期，時間可留白。'
};

function syncFields() {
  const fields = form.elements;
  $('#polish-notes').hidden = !state.localAI;
  const canReview = state.localAI && fields.type.value === 'J';
  journalAI.hidden = !canReview;
  if (!canReview) journalAIResult.hidden = true;
  for (const button of quickTypes.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.type === fields.type.value));
  }
  const type = fields.type.value;
  const isTask = type === 'T';
  const hasStatus = isTask || type === 'P';
  const hasScheduleReminder = ['C', 'T', 'E', 'P', 'M'].includes(type) || Boolean(fields.remind.value);
  const fieldVisibility = {
    status: hasStatus,
    parentId: isTask || type === 'N',
    priority: isTask || Boolean(fields.priority.value),
    next: ['C', 'T', 'P', 'J'].includes(type) || Boolean(fields.next.value),
    month: !fields.date.value && (['C', 'T', 'E', 'P', 'I', 'M'].includes(type) || Boolean(fields.month.value)),
    remind: hasScheduleReminder,
    focus: isTask
  };
  for (const [name, visible] of Object.entries(fieldVisibility)) fields[name].closest('label').hidden = !visible;
  form.classList.toggle('journal-entry', type === 'J');
  form.classList.toggle('entry-without-status', !hasStatus);
  fields.status.disabled = !hasStatus;
  quickSchedule.hidden = quickTypes.hidden || (!isTask && type !== 'E');
  for (const button of quickSchedule.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(fields.date.value === shift(state.day, Number(button.dataset.offset))));
  }
  for (const element of form.querySelectorAll('[data-deadline]')) element.hidden = !isTask;
  fields.dueDate.disabled = !isTask;
  fields.dueTime.disabled = !isTask || !fields.dueDate.value;
  fields.dueRemind.disabled = fields.dueTime.disabled;
  const purpose = scheduleHints[type] || '設定這筆記錄要顯示在哪一天。時間可留白。';
  $('#schedule-hint').textContent = purpose + (hasScheduleReminder ? ' 排程提醒須先填時間。' : '');
  fields.focus.disabled = fields.type.value !== 'T' || fields.date.value !== state.day || fields.status.value === 'done';
  if (fields.focus.disabled) fields.focus.checked = false;
  fields.time.disabled = !fields.date.value;
  if (fields.time.disabled) fields.time.value = '';
  fields.remind.disabled = !fields.time.value;
  if (fields.remind.disabled) fields.remind.value = '';
  fields.parentId.disabled = !['T', 'N'].includes(fields.type.value);
  if (fields.parentId.disabled) fields.parentId.value = '';
  syncNumericFields(form);
}
form.onchange = syncFields;
quickTypes.onclick = event => {
  const button = event.target.closest('button[data-type]');
  if (!button) return;
  form.elements.type.value = button.dataset.type;
  syncFields();
};
quickSchedule.onclick = event => {
  const button = event.target.closest('button[data-offset]');
  if (!button) return;
  form.elements.date.value = shift(state.day, Number(button.dataset.offset));
  form.elements.date.dispatchEvent(new Event('change', { bubbles: true }));
};
function openEditor(item, initial = {}, { quick = false } = {}) {
  syncNumericFields(form, true);
  resetPolish();
  journalReviewRequest++;
  journalAI.disabled = false;
  journalAIResult.hidden = true;
  draft = item ?? { id: uuid(), version: 0, type: 'C', status: 'open', archived: false, ...initial };
  const options = state.items.filter(project => project.type === 'P' && (!project.archived || project.id === draft.parentId));
  form.elements.parentId.innerHTML = '<option value="">無</option>' + options.map(project => `<option value="${project.id}">${escape(project.title)}</option>`).join('');
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') field.checked = Boolean(draft[field.name]);
    else field.value = draft[field.name] ?? '';
  }
  quickTypes.hidden = !quick;
  saveContinue.hidden = !quick;
  openBatch.hidden = !quick;
  entryVoice.reset();
  entryVoiceBox.hidden = !quick;
  syncFields();
  $('#editor-title').textContent = item ? '編輯筆記' : '快速記錄';
  $('#editor-hint').textContent = '';
  $('#voice-source').hidden = true;
  $('#voice-source').open = false;
  $('#voice-source-text').textContent = '';
  $('#voice-corrected').hidden = true;
  $('#voice-corrected').open = false;
  $('#voice-corrected p').textContent = '';
  $('#archive').hidden = !item;
  deleteEntry.hidden = !item;
  $('#archive').textContent = draft.archived ? '解除封存' : '封存';
  $('#editor-error').textContent = '';
  if (!editor.open) editor.showModal();
  form.elements.title.focus();
}

async function save(data) {
  const item = await request('item', data);
  revision++;
  state.items = state.items.filter(existing => existing.id !== item.id).concat(item);
  if (item.focus) {
    for (const other of state.items.filter(existing => existing.id !== item.id && existing.focus && existing.date === item.date)) {
      other.focus = false;
      other.version++;
    }
  }
  render();
}

const batchEditor = $('#batch-editor');
const batchForm = $('#batch-form');
const batchSave = $('#batch-save');
const batchReview = $('#batch-review');
const batchClose = $('#batch-close');
const batchAI = $('#batch-ai');
const batchVoiceBox = $('#batch-voice');
const batchVoice = wireVoiceInput(batchVoiceBox, batchForm.elements.tasks, batchEditor, '\n');
let batchTasks = [];
let batchProject = null;
const batchList = $('#batch-list');
const batchProjectDetails = $('#batch-project');
const taskDates = [['date', '開始日期', 'date'], ['time', '開始時間', 'time'],
  ['dueDate', '截止日期', 'date'], ['dueTime', '截止時間', 'time']];

function taskSummary(task) {
  const dates = taskDates.filter(([key]) => !task[key]).map(([, label]) => label);
  const start = [task.date, task.time].filter(Boolean).join(' ');
  const deadline = [task.dueDate, task.dueTime].filter(Boolean).join(' ');
  return task.title + (start ? ' · 開始 ' + start : '') + (deadline ? ' · 截止 ' + deadline : '') +
    (dates.length ? ' · 待確認 ' + dates.join('、') : '');
}

function showBatchPreview(tasks, projectName = '', structured = false) {
  batchTasks = tasks.map((task, index) => ({ id: batchTasks[index]?.id || uuid(), ...task }));
  batchProject = projectName ? { id: uuid(), title: projectName } : null;
  batchProjectDetails.hidden = !batchProject;
  batchProjectDetails.open = false;
  $('#batch-project-name').value = projectName;
  batchProjectDetails.querySelector('summary').textContent = '新專案 · ' + projectName;
  $('#batch-count').textContent = batchProject ? `1 個專案 · ${tasks.length} 筆子任務` : `${tasks.length} 筆任務`;
  batchList.innerHTML = structured ? batchTasks.map((task, index) => `<li><details data-task-index="${index}">
    <summary>${escape(taskSummary(task))}</summary>
    <label>任務名稱<input data-key="title" maxlength="160" value="${escape(task.title)}"></label>
    <div class="fields">${taskDates.map(([key, label, type]) => `<label>${label}<input data-key="${key}" type="${type}" value="${escape(task[key])}"></label>`).join('')}</div>
    </details></li>`).join('') : tasks.map(task => `<li>${escape(task.title)}</li>`).join('');
  addNumericFields(batchList);
  $('#batch-preview').hidden = false;
  $('#batch-error').textContent = structured && tasks.some(task => taskDates.some(([key]) => !task[key]))
    ? '要安排哪天、幾點開始與截止？點開「待確認」的任務補填，也可以留白。' : '';
  batchSave.disabled = false;
}

batchList.oninput = event => {
  const details = event.target.closest('[data-task-index]');
  if (!details || !event.target.dataset.key) return;
  const task = batchTasks[Number(details.dataset.taskIndex)];
  task[event.target.dataset.key] = event.target.value;
  details.querySelector('summary').textContent = taskSummary(task);
};
$('#batch-project-name').oninput = event => {
  if (!batchProject) return;
  batchProject.title = event.target.value;
  batchProjectDetails.querySelector('summary').textContent = '新專案 · ' + batchProject.title;
};
function clearBatchPreview() {
  batchTasks = [];
  batchProject = null;
  $('#batch-preview').hidden = true;
  $('#batch-error').textContent = '';
  batchSave.disabled = true;
}
openBatch.onclick = () => {
  entryVoice.reset();
  batchForm.reset();
  clearBatchPreview();
  batchVoiceBox.hidden = false;
  batchVoice.reset();
  batchAI.hidden = !state.localAI;
  batchEditor.showModal();
  batchForm.elements.tasks.focus();
};
batchClose.onclick = () => batchEditor.close();
batchEditor.addEventListener('cancel', event => {
  if (batchClose.disabled) event.preventDefault();
});
batchForm.elements.tasks.oninput = clearBatchPreview;
batchAI.onclick = async () => {
  const textarea = batchForm.elements.tasks;
  if (!textarea.value.trim() || batchClose.disabled) return;
  if (batchVoice.listening()) {
    $('#batch-error').textContent = '請先停止語音輸入，再使用 AI 拆分。';
    return;
  }
  const original = textarea.value;
  batchAI.disabled = batchReview.disabled = batchClose.disabled = textarea.disabled = true;
  clearBatchPreview();
  $('#batch-error').textContent = '正在用本地 AI 整理…';
  try {
    const { tasks, project } = await request('local-ai', { mode: 'plan', text: original });
    if (!tasks.length && !project) throw new Error('找不到可新增的項目，請補充後再試。');
    showBatchPreview(tasks, project, true);
  } catch (error) {
    $('#batch-error').textContent = error.message;
  } finally {
    batchAI.disabled = batchReview.disabled = batchClose.disabled = textarea.disabled = false;
  }
};
batchReview.onclick = () => {
  if (batchVoice.listening()) {
    $('#batch-error').textContent = '請先停止語音輸入，再預覽清單。';
    return;
  }
  const titles = batchForm.elements.tasks.value.split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[-*•]|\d+[.)、])\s+/u, '').trim()).filter(Boolean);
  if (titles.length < 1 || titles.length > 50 || titles.some(title => title.length > 160)) {
    $('#batch-error').textContent = '請輸入 1 到 50 筆任務，每筆最多 160 個字。';
    return;
  }
  showBatchPreview(titles.map(title => ({ title })));
};
batchForm.onsubmit = async event => {
  event.preventDefault();
  if (!applyNumericFields(batchForm)) return;
  if ((!batchTasks.length && !batchProject) || batchSave.disabled || batchVoice.listening()) return;
  batchSave.disabled = batchReview.disabled = batchClose.disabled = batchAI.disabled = batchForm.elements.tasks.disabled = true;
  try {
    const { count, projectId } = await request('task-batch', { tasks: batchTasks, project: batchProject });
    clearBatchPreview();
    batchEditor.close();
    editor.close();
    $('#message').textContent = projectId ? `已新增專案與 ${count} 筆子任務，可在「專案」查看。` : `已新增 ${count} 筆任務。`;
    await refreshAfterWrite();
  } catch (error) {
    $('#batch-error').textContent = error.message;
  } finally {
    batchSave.disabled = !batchTasks.length && !batchProject;
    batchReview.disabled = batchClose.disabled = batchAI.disabled = batchForm.elements.tasks.disabled = false;
  }
};
const polishButton = $('#polish-notes');
const polishPreview = $('#polish-preview');
const polishText = $('#polish-text');
const polishApply = $('#polish-apply');
const polishStatus = $('#polish-status');
let polishRequest = 0;
let polishSource = '';
function resetPolish() {
  polishRequest++;
  polishButton.disabled = false;
  polishPreview.hidden = true;
  polishApply.disabled = true;
}
polishButton.onclick = async () => {
  const source = form.elements.notes.value;
  const requestId = ++polishRequest;
  polishPreview.hidden = false;
  polishText.value = '';
  polishApply.disabled = true;
  if (!source.trim()) {
    polishStatus.textContent = '先在「筆記」欄輸入要修飾的文字。';
    return;
  }
  polishButton.disabled = true;
  polishStatus.textContent = '正在修飾語句…';
  try {
    const result = await request('local-ai', { mode: 'polish', text: source });
    if (requestId !== polishRequest) return;
    polishSource = source;
    polishText.value = result.text;
    polishStatus.textContent = '可先編輯建議，再按「套用修飾」。';
    polishApply.disabled = false;
  } catch (error) {
    if (requestId === polishRequest) polishStatus.textContent = error.message;
  } finally {
    if (requestId === polishRequest) polishButton.disabled = false;
  }
};
polishApply.onclick = () => {
  if (form.elements.notes.value !== polishSource || !polishText.value.trim()) {
    polishStatus.textContent = '原稿已變更或建議為空，請重新修飾。';
    return;
  }
  form.elements.notes.value = polishText.value;
  resetPolish();
  form.elements.notes.focus();
};
journalAI.onclick = async () => {
  const text = form.elements.notes.value;
  if (!text.trim()) {
    journalAIResult.hidden = false;
    journalAIResult.textContent = '先輸入日誌內容。';
    return;
  }
  const currentRequest = ++journalReviewRequest;
  journalAI.disabled = true;
  journalAIResult.hidden = false;
  journalAIResult.textContent = '正在產生日誌回顧…';
  try {
    const result = await request('local-ai', { mode: 'review', text });
    if (currentRequest === journalReviewRequest) journalAIResult.textContent = result.text;
  } catch (error) {
    if (currentRequest === journalReviewRequest) journalAIResult.textContent = error.message;
  } finally {
    if (currentRequest === journalReviewRequest) journalAI.disabled = false;
  }
};

form.onsubmit = async event => {
  event.preventDefault();
  if (savingEntry) return;
  if (!applyNumericFields(form)) return;
  if (entryVoice.listening()) {
    $('#editor-error').textContent = '請先停止語音輸入，再儲存。';
    return;
  }
  const keepRecording = event.submitter === saveContinue;
  const inputs = Object.fromEntries(new FormData(form));
  const data = { ...draft, ...inputs, status: inputs.status || 'open', time: inputs.time || '', remind: inputs.remind || '',
    dueDate: inputs.dueDate || '', dueTime: inputs.dueTime || '', dueRemind: inputs.dueRemind || '',
    parentId: inputs.parentId || '', focus: form.elements.focus.checked };
  const buttons = form.querySelectorAll('button[type="submit"], #close, #archive, #open-batch, #delete-entry, #voice-skip, #voice-edit-transcript');
  savingEntry = true;
  buttons.forEach(button => { button.disabled = true; });
  $('#editor-error').textContent = '';
  try {
    await save(data);
    if (voiceDrafts && voiceDrafts.index + 1 < voiceDrafts.entries.length) {
      voiceDrafts.index++;
      showVoiceDraft();
      editor.scrollTop = 0;
      return;
    }
    if (keepRecording) {
      openEditor(null, { type: data.type }, { quick: true });
      editor.scrollTop = 0;
      return;
    }
    editor.close();
    if (compact && draft.version === 0 && data.type === 'C') {
      $('#compact-inbox').open = true;
    }
  } catch (error) {
    $('#editor-error').textContent = error.message;
  } finally {
    savingEntry = false;
    buttons.forEach(button => { button.disabled = false; });
  }
};
$('#archive').onclick = async () => {
  try {
    await save({ ...draft, archived: !draft.archived });
    $('#editor').close();
  } catch (error) {
    $('#editor-error').textContent = error.message;
  }
};
$('#add').onclick = () => openEditor(null, {}, { quick: !compact });
const voiceEditor = $('#voice-editor');
const voiceForm = $('#voice-form');
const voiceText = voiceForm.elements.transcript;
const voiceClose = $('#voice-close');
const voiceError = $('#voice-error');
const voiceRecord = $('#home-voice button');
const voiceSubmit = voiceForm.querySelector('[type="submit"]');
const voiceLanguage = $('#voice-language');
const voiceTerms = $('#voice-terms');
const voiceGlossaryKey = 'journal-voice-glossary';
voiceTerms.defaultValue = localStorage.getItem(voiceGlossaryKey) || '';
voiceTerms.value = voiceTerms.defaultValue;
voiceTerms.addEventListener('input', () => {
  try {
    parseVoiceGlossary(voiceTerms.value);
  } catch {
    return;
  }
  localStorage.setItem(voiceGlossaryKey, voiceTerms.value);
  voiceTerms.defaultValue = voiceTerms.value;
});
const voiceInput = wireVoiceInput($('#home-voice'), voiceText, voiceEditor, ' ', () => voiceForm.requestSubmit(), voiceLanguage);
const insertDatasheet = $('#voice-insert-datasheet');
insertDatasheet.onclick = () => {
  const wasListening = voiceInput.listening();
  const insert = () => {
    const start = wasListening ? voiceText.value.length : voiceText.selectionStart;
    const end = wasListening ? start : voiceText.selectionEnd;
    const before = start && !/\s/u.test(voiceText.value[start - 1]) ? ' ' : '';
    const after = end < voiceText.value.length && !/\s/u.test(voiceText.value[end]) ? ' ' : '';
    const word = before + 'datasheet' + after;
    if (voiceText.value.length - (end - start) + word.length > voiceText.maxLength) {
      voiceError.textContent = '辨識文字已達長度上限，請先縮短內容。';
      return;
    }
    voiceText.setRangeText(word, start, end, 'end');
    voiceText.dispatchEvent(new Event('input', { bubbles: true }));
    voiceError.textContent = '';
    if (wasListening) $('#home-voice button').focus();
    else voiceText.focus();
  };
  if (wasListening) voiceInput.stop(false, insert);
  else insert();
};
const voiceProofread = $('#voice-proofread');
const voiceProofreadResult = $('#voice-proofread-result');
const voiceProofreadText = $('#voice-proofread-text');
const voiceProofreadIssues = $('#voice-proofread-issues');
const voiceProofreadStatus = $('#voice-proofread-status');

function setVoiceBusy(busy) {
  for (const control of [voiceClose, voiceRecord, voiceSubmit, voiceText, voiceLanguage, insertDatasheet, voiceProofread]) {
    control.disabled = busy;
  }
}

function clearVoiceProofread() {
  voiceProofreadResult.hidden = true;
  voiceProofreadText.replaceChildren();
  voiceProofreadIssues.replaceChildren();
  voiceProofreadStatus.textContent = '';
}

voiceText.addEventListener('input', clearVoiceProofread);
voiceForm.addEventListener('reset', clearVoiceProofread);

function showVoiceProofread(transcript, issues, unmatched) {
  voiceProofreadText.replaceChildren();
  voiceProofreadIssues.replaceChildren();
  voiceProofreadResult.hidden = !issues.length;
  voiceProofreadStatus.textContent = [
    issues.length ? `有 ${issues.length} 處建議核對。` : '',
    unmatched ? `另有 ${unmatched} 處建議無法定位，請直接核對原文。` : '',
    !issues.length && !unmatched ? '未找出明顯不通順或疑似誤聽的片段。' : ''
  ].filter(Boolean).join(' ');
  if (!issues.length) return;
  let cursor = 0;
  for (const [index, issue] of issues.entries()) {
    const { start, end, reason, suggestion } = issue;
    const quote = transcript.slice(start, end);
    const mark = document.createElement('mark');
    mark.textContent = quote;
    voiceProofreadText.append(transcript.slice(cursor, start), mark);
    cursor = end;

    const item = document.createElement('li');
    item.append(`「${quote}」 ${reason}`);
    if (suggestion) {
      const proposed = document.createElement('div');
      proposed.textContent = '建議改為「' + suggestion + '」';
      item.append(proposed);
    }
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'quiet';
    action.textContent = suggestion ? '套用建議' : '定位原文';
    action.setAttribute('aria-label', action.textContent + '「' + quote + '」');
    action.onclick = () => {
      if (voiceText.disabled || voiceInput.listening() || voiceText.value !== transcript) return;
      if (suggestion && voiceText.value.length + suggestion.length - quote.length > voiceText.maxLength) {
        voiceProofreadStatus.textContent = '套用後會超出長度上限，請先縮短辨識文字。';
        return;
      }
      if (suggestion) {
        voiceText.setRangeText(suggestion, start, end, 'select');
        const delta = suggestion.length - quote.length;
        const remaining = issues.filter(part => part !== issue).map(part => part.start > start
          ? { ...part, start: part.start + delta, end: part.end + delta } : part);
        showVoiceProofread(voiceText.value, remaining, unmatched);
        if (!remaining.length && !unmatched) voiceProofreadStatus.textContent = '已套用所有修改建議。';
      } else {
        voiceText.setSelectionRange(start, end);
      }
      voiceText.focus();
    };
    item.append(action);
    voiceProofreadIssues.append(item);
  }
  voiceProofreadText.append(transcript.slice(cursor));
}

voiceProofread.onclick = async () => {
  if (voiceInput.listening()) {
    voiceInput.stop(false, () => voiceProofread.click());
    return;
  }
  clearVoiceProofread();
  voiceError.textContent = '';
  const transcript = voiceText.value;
  if (!transcript.trim()) {
    voiceProofreadStatus.textContent = '請先說出或輸入要檢查的文字。';
    return;
  }
  setVoiceBusy(true);
  voiceProofreadStatus.textContent = '本地 AI 正在檢查語句…';
  try {
    const { issues, unmatched } = await request('local-ai', { mode: 'proofread', text: transcript });
    showVoiceProofread(transcript, issues, unmatched);
  } catch (error) {
    voiceProofreadStatus.textContent = error.message || '語句檢查暫時無法使用。';
  } finally {
    setVoiceBusy(false);
  }
};

let voiceDrafts = null;
const voiceSkip = $('#voice-skip');
const voiceEditTranscript = $('#voice-edit-transcript');
voiceEditTranscript.onclick = () => {
  if (savingEntry || voiceDrafts?.index !== 0) return;
  const { transcript } = voiceDrafts;
  editor.close();
  const language = voiceLanguage.value;
  voiceForm.reset();
  voiceLanguage.value = language;
  voiceInput.reset();
  voiceText.value = transcript;
  voiceError.textContent = '';
  voiceEditor.showModal();
  voiceText.focus();
};
voiceSkip.onclick = () => {
  if (savingEntry || !voiceDrafts || voiceDrafts.index + 1 >= voiceDrafts.entries.length) return;
  voiceDrafts.index++;
  showVoiceDraft();
  editor.scrollTop = 0;
};
function showVoiceDraft() {
  const { entries, index, transcript, hint, corrected } = voiceDrafts;
  const entry = entries[index];
  openEditor(null, {
    ...entry, date: entry.date || (entry.type === 'J' ? state.day : ''),
    notes: entry.notes ?? transcript
  });
  $('#editor-title').textContent = entries.length > 1 ? '語音預覽 ' + (index + 1) + ' / ' + entries.length : '語音預覽';
  $('#editor-hint').textContent = hint || (index + 1 < entries.length ?
    '確認這筆後儲存，即可預覽下一筆。' : '請確認項目、筆記和日期後再儲存。');
  $('#voice-source-text').textContent = transcript;
  $('#voice-source').hidden = false;
  $('#voice-corrected').hidden = !corrected;
  $('#voice-corrected p').textContent = corrected;
  voiceSkip.hidden = index + 1 >= entries.length;
  voiceEditTranscript.hidden = index !== 0;
}
editor.addEventListener('close', () => {
  if (editor.open) return;
  voiceDrafts = null;
  voiceSkip.hidden = true;
  voiceEditTranscript.hidden = true;
});

$('#voice-add').onclick = () => {
  const language = voiceLanguage.value;
  voiceForm.reset();
  voiceLanguage.value = language;
  voiceError.textContent = '';
  voiceInput.reset();
  voiceEditor.showModal();
  voiceRecord.focus();
  voiceRecord.click();
};
voiceClose.onclick = () => voiceEditor.close();
voiceEditor.addEventListener('cancel', event => {
  if (voiceClose.disabled) event.preventDefault();
});

const voiceRoutines = $('#voice-routines');
const voiceRoutineForm = $('#voice-routine-form');
const voiceRoutineList = $('#voice-routine-list');
const voiceRoutineError = $('#voice-routine-error');
const voiceRoutineClose = $('#voice-routines-close');
const voiceRoutineSave = voiceRoutineForm.querySelector('[type="submit"]');
function previewVoiceRoutines(goals) {
  voiceRoutineError.textContent = '';
  voiceRoutineList.innerHTML = goals.map((goal, index) => `<fieldset data-id="${uuid()}">
    <legend>日常 ${index + 1}</legend>
    <label>名稱<input name="title" value="${escape(goal.title)}" maxlength="160" required></label>
    <div class="fields"><label>每週目標<input name="target" type="number" value="${goal.target}" min="1" max="${goal.targetUnit === 'days' ? 7 : 99}" required></label>
    <label>計算方式<select name="targetUnit"><option value="days" ${goal.targetUnit === 'days' ? 'selected' : ''}>天</option>
    <option value="times" ${goal.targetUnit === 'times' ? 'selected' : ''}>次</option></select></label></div>
  </fieldset>`).join('');
  voiceRoutines.showModal();
}
voiceRoutineList.onchange = event => {
  if (event.target.name !== 'targetUnit') return;
  event.target.closest('fieldset').querySelector('[name="target"]').max = event.target.value === 'days' ? 7 : 99;
};
voiceRoutineClose.onclick = () => voiceRoutines.close();
voiceRoutines.addEventListener('cancel', event => {
  if (voiceRoutineSave.disabled) event.preventDefault();
});
voiceRoutineForm.onsubmit = async event => {
  event.preventDefault();
  if (voiceRoutineSave.disabled) return;
  const goals = [...voiceRoutineList.querySelectorAll('fieldset')].map(row => ({
    id: row.dataset.id, title: row.querySelector('[name="title"]').value,
    target: Number(row.querySelector('[name="target"]').value), targetUnit: row.querySelector('[name="targetUnit"]').value
  }));
  voiceRoutineError.textContent = '';
  voiceRoutineSave.disabled = voiceRoutineClose.disabled = true;
  try {
    const { count } = await request('routine-batch', { goals });
    voiceRoutines.close();
    if (location.hash !== '#routines') location.hash = 'routines';
    else $('#message').textContent = `已新增 ${count} 個日常目標。`;
    await refreshAfterWrite();
  } catch (error) {
    voiceRoutineError.textContent = error.message;
  } finally {
    voiceRoutineSave.disabled = voiceRoutineClose.disabled = false;
  }
};

function classifyVoiceText(text) {
  const type = [
    ['P', /^(?:新[增建]|建立|開啟).*專案/u],
    ['J', /^(?:新增|寫|記錄|今天的)?日誌|^日記/u],
    ['R', /^(?:寫|新增)?反思/u],
    ['N', /^(?:寫|新增|記錄)?筆記/u],
    ['I', /^(?:新增)?(?:想法|點子)|^我想到/u],
    ['M', /^(?:新增)?重要日子/u],
    ['T', /^(?:新增)?(?:任務|待辦)|(?:要記得|記得|截止|之前要|要交|得完成)/u],
    ['E', /(?:開會|會議|聚餐|約診|行程|活動)/u],
    ['T', /(?:要|請)(?:買|寄|交|完成|整理|準備|回覆)|^(?:買|寄|交|整理|準備|回覆)/u]
  ].find(([, pattern]) => pattern.test(text))?.[0] ?? 'C';
  const relative = text.match(/今天|今日|明天|明日|後天|後日|昨天|昨日/u)?.[0];
  const offset = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 後天: 2, 後日: 2, 昨天: -1, 昨日: -1 }[relative];
  const explicit = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/u);
  const date = explicit
    ? parseNumericDate(explicit[1] + explicit[2].padStart(2, '0') + explicit[3].padStart(2, '0'), state.day)
    : offset !== undefined || type === 'J' ? shift(state.day, offset ?? 0) : '';
  const clock = text.match(/(?:^|\D)(\d{1,2})[:：](\d{2})(?!\d)/u);
  const chineseClock = text.match(/(凌晨|早上|上午|中午|下午|晚上)\s*([0-9]{1,2}|十二|十一|[一二兩三四五六七八九十])[點点](半|整|[0-9]{1,2}分)?/u);
  let time = date && clock ? parseNumericTime(clock[1].padStart(2, '0') + clock[2]) : '';
  if (date && !time && chineseClock) {
    const [, period, hourText, minuteText] = chineseClock;
    const hour = Number(hourText) || ({ 兩: 2, 十一: 11, 十二: 12 }[hourText] ?? '零一二三四五六七八九十'.indexOf(hourText));
    const minutes = minuteText === '半' ? 30 : Number.parseInt(minuteText, 10) || 0;
    if (hour >= 1 && hour <= 12) {
      const pm = ['下午', '晚上'].includes(period) || (period === '中午' && hour !== 11);
      time = parseNumericTime(String(hour % 12 + (pm ? 12 : 0)).padStart(2, '0') + String(minutes).padStart(2, '0'));
    }
  }
  const title = text.split(/[。！？\r\n]/u)[0].trim().slice(0, 160) || text.slice(0, 160);
  if (type === 'T' && /截止|之前要|前要交/u.test(text)) return { type, title, dueDate: date, dueTime: time };
  return { type, title, date, time };
}

voiceForm.onsubmit = async event => {
  event.preventDefault();
  const transcript = voiceText.value.trim();
  if (voiceSubmit.disabled || voiceInput.listening()) return;
  if (!transcript) {
    voiceError.textContent = '請先說出或輸入想新增的內容。';
    return;
  }
  const revised = reviseVoiceTranscript(transcript);
  let terms;
  try {
    terms = parseVoiceGlossary(voiceTerms.value);
  } catch (error) {
    $('#voice-glossary').open = true;
    voiceError.textContent = error.message;
    voiceTerms.focus();
    return;
  }
  const activeText = correctVoiceTerms(revised.text, terms);
  if (!activeText) {
    voiceError.textContent = '這次語音的項目已取消。可以修改文字或繼續說。';
    return;
  }
  const goals = voiceRoutineGoals(activeText);
  if (goals.length && goals.length <= 10) {
    voiceEditor.close();
    previewVoiceRoutines(goals);
    return;
  }
  if (/(?:新增|建立|設定).{0,12}日常/u.test(activeText)) {
    voiceError.textContent = '請說出每個日常的名稱和頻率，例如「新增日常，每日飲水 2000 cc」或「讀英文每週五天」。';
    return;
  }
  setVoiceBusy(true);
  voiceError.textContent = '正在分類…';
  try {
    let entries = [{ ...classifyVoiceText(activeText), notes: activeText }];
    let hint = state.localAI ? '' : '已用關鍵字初步分類，請確認分類與日期。';
    if (state.localAI) {
      try {
        const result = await request('local-ai', { mode: 'voice', text: activeText, multiple: true });
        entries = result.entries || [result];
      } catch {
        hint = '本地 AI 暫時無法使用，已用關鍵字初步分類。';
      }
    }
    voiceEditor.close();
    const correctionHint = activeText !== revised.text ? '已校正術語，可展開辨識原文核對。' : '';
    voiceDrafts = {
      entries, index: 0, transcript, corrected: activeText !== revised.text ? activeText : '',
      hint: (revised.changed ? '已略過取消的項目。' : '') + correctionHint + hint
    };
    showVoiceDraft();
  } finally {
    setVoiceBusy(false);
  }
};
$('#close').onclick = () => editor.close();
editor.addEventListener('cancel', event => {
  if (savingEntry || editor.hasAttribute('data-deleting')) event.preventDefault();
});

async function subscribe() {
  if (!registration || !window.Notification || !window.PushManager) throw new Error('這個裝置需要用 HTTPS 開啟。iPhone 請先將 App 加入主畫面。');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知尚未允許，請查看裝置的通知設定。');
  const worker = await registration;
  if (!worker) throw new Error('無法啟動推播服務');
  const ready = await navigator.serviceWorker.ready;
  const key = state.pushKey.replace(/-/g, '+').replace(/_/g, '/');
  const applicationServerKey = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, '=')), char => char.charCodeAt(0));
  const subscription = await ready.pushManager.getSubscription() ??
    await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await request('push', { device, subscription: subscription.toJSON() });
  await refresh();
}

const openMeeting = createMeetingEditor({ request, uuid, today: () => state.day, model: () => state.aiModel, refresh: refreshAfterWrite });
$('#view').onclick = async event => {
  const button = event.target.closest('[data-action]');
  if (!button || !state) return;
  const { action, id, day, month } = button.dataset;
  if (action === 'timeline-filter') {
    toggleTimelineFilter(button);
    return;
  }
  if (action === 'timeline-today') {
    jumpToTimelineToday(button);
    return;
  }
  const item = state.items.find(entry => entry.id === id);
  $('#message').textContent = '';
  try {
    switch (action) {
      case 'edit': if (item?.type === 'A') await openMeeting(item.id); else openEditor(item); break;
      case 'new-meeting': await openMeeting(undefined, meetingFilter || 'meeting'); break;
      case 'meeting-filter':
        meetingFilter = button.dataset.kind;
        render();
        $('#view').querySelector('[data-action="meeting-filter"][aria-pressed="true"]')?.focus();
        break;
      case 'new-routine': openRule('routine'); break;
      case 'routine-count': {
        button.disabled = true;
        try {
          await request('routine-count', { id, day: state.day, change: Number(button.dataset.change) });
          await refreshAfterWrite();
        } finally {
          button.disabled = false;
        }
        break;
      }
      case 'new-health': openHealth(); break;
      case 'edit-health': openHealth(healthRows.find(row => row.day === day)); break;
      case 'refresh-health': void loadHealth(); break;
      case 'health-metric':
        if (Object.hasOwn(healthMetrics, button.dataset.metric)) {
          healthMetric = button.dataset.metric;
          render();
          $('#view [data-metric="' + healthMetric + '"]').focus();
        }
        break;
      case 'new-birthday': openRule('birthday'); break;
      case 'edit-rule': {
        const rule = state.rules.find(entry => entry.id === id);
        if (rule) openRule(rule.kind, rule);
        break;
      }
      case 'recurring-mark':
        await request('recurring-mark', { id: button.closest('[data-occurrence]').dataset.occurrence, status: button.dataset.status });
        await refreshAfterWrite();
        break;
      case 'new-journal': openEditor(null, { type: 'J', date: state.day }); break;
      case 'new-note': openEditor(null, { type: 'N' }); break;
      case 'new-project': openEditor(null, { type: 'P' }); break;
      case 'new-subtask':
        if (item) openEditor(null, { type: 'T', parentId: item.id });
        break;
      case 'schedule':
        if (item) {
          openEditor(item);
          form.elements.date.focus();
        }
        break;
      case 'new-today': openEditor(null, { type: 'T', date: state.day }); break;
      case 'new-day': openEditor(null, { type: 'E', date: day }); break;
      case 'new-month': openEditor(null, { month }); break;
      case 'done': await save({ ...item, status: 'done' }); break;
      case 'tomorrow':
        if (canMoveToTomorrow(item, state.day)) await save({ ...item, date: shift(state.day, 1), focus: false });
        break;
      case 'prior-week': weekOffset--; render(); break;
      case 'next-week': weekOffset++; render(); break;
      case 'this-week': weekOffset = 0; render(); break;
      case 'prior-period':
      case 'next-period': {
        const direction = action === 'prior-period' ? -1 : 1;
        futureMonth = shiftMonth(futureMonth || state.day.slice(0, 7), direction * (futureMode === 'year' ? 12 : 1));
        futureDay = '';
        render();
        break;
      }
      case 'current-month':
        futureMonth = futureDay = '';
        futureMode = 'month';
        render();
        break;
      case 'future-mode':
        futureMode = futureMode === 'month' ? 'year' : 'month';
        render();
        break;
      case 'open-month':
        futureMonth = month;
        futureDay = '';
        futureMode = 'month';
        render();
        break;
      case 'select-month-day':
        futureDay = day;
        render();
        document.querySelector(`[data-action="select-month-day"][data-day="${day}"]`)?.focus({ preventScroll: true });
        break;
      case 'inbox-open': inboxMode = 'open'; render(); break;
      case 'task-filter': {
        const filter = button.dataset.filter;
        if (!Object.hasOwn(taskFilters, filter)) break;
        taskFilter = filter;
        render();
        document.querySelector(`[data-action="task-filter"][data-filter="${filter}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'inbox-archived': inboxMode = 'archived'; render(); break;
      case 'ai-status': {
        $('#ai-status-result').textContent = aiStatusMessage = '檢查中…';
        try {
          const { status } = await request('ai-status', {});
          aiStatusMessage = { ready: '已連線，模型可用。', disabled: '尚未設定模型。',
            offline: '無法連到 Ollama，請確認 Ollama 已啟動。', missing: 'Ollama 已連線，但找不到已設定的模型。' }[status];
        } catch (error) {
          aiStatusMessage = error.message;
        }
        const result = $('#ai-status-result');
        if (result) result.textContent = aiStatusMessage;
        break;
      }
      case 'inbox-trash': inboxMode = 'trash'; render(); break;
      case 'restore-trash': {
        const category = button.dataset.category;
        const record = state.trash.find(row => row.id === id && (row.kind ? 'rule' : 'item') === category);
        if (!record) break;
        button.disabled = true;
        try {
          await request('trash', { id, version: record.version, category, deleted: false });
          await refreshAfterWrite();
          $('#message').textContent = '已復原。';
        } finally {
          button.disabled = false;
        }
        break;
      }
      case 'subscribe': await subscribe(); break;
      case 'push-test':
        await request('push-test', { device });
        $('#message').textContent = '已送出測試推播。';
        break;
    }
  } catch (error) {
    showError(error);
  }
};
$('#view').onsubmit = async event => {
  if (event.target.id !== 'settings') return;
  event.preventDefault();
  if (!applyNumericFields(event.target)) return;
  try {
    state.settings = await request('settings', Object.fromEntries(new FormData(event.target)));
    revision++;
    $('#message').textContent = '已儲存提醒時間。';
    render();
  } catch (error) {
    showError(error);
  }
};
$('#view').addEventListener('input', event => {
  if (event.target.id !== 'notes-search') return;
  notesQuery = event.target.value;
  $('#notes-results').innerHTML = notesResults();
});
addEventListener('hashchange', () => {
  $('#message').textContent = '';
  render();
  if (location.hash === '#health') void loadHealth();
});
addEventListener('focus', () => {
  void refresh();
  if (state && location.hash === '#health') void loadHealth();
});
setInterval(refresh, 3000);
await refresh();
