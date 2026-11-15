export const types = { C: '捕捉', T: '任務', E: '事件', P: '專案', I: '想法', M: '重要日子', R: '反思', J: '日誌', N: '筆記', A: '會議紀錄' };
export const meetingKinds = {
  class: { label: '上課', sections: '課程重點、範例與觀念、作業與期限、待複習' },
  meeting: { label: '會議', sections: '摘要、決議、待辦、待確認' },
  work: { label: '工作進度', sections: '已完成、進行中、阻礙、下一步' }
};
export const statuses = { open: '未開始', active: '進行中', done: '完成' };
export const dayKey = (date = new Date()) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(date);
export const shift = (day, offset) => {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
export const sunday = day => shift(day, -new Date(day + 'T00:00:00Z').getUTCDay());
export const trashExpiry = deletedDay => shift(deletedDay, 3);
export const healthMetrics = {
  weight: { label: '體重', unit: 'kg', max: 700 },
  bmi: { label: 'BMI', unit: '', max: 250 },
  fat: { label: '體脂率', unit: '%', max: 100 },
  boneWeight: { label: '骨骼重量', unit: 'kg', max: 700 },
  water: { label: '水分率', unit: '%', max: 100 },
  muscleRate: { label: '肌肉率', unit: '%', max: 100 }
};

export function parseNumericDate(value, today) {
  const digits = value.trim().normalize('NFKC');
  if (!/^(?:\d{3,4}|\d{8})$/.test(digits)) return '';
  const month = digits.slice(-4, -2).padStart(2, '0');
  const day = digits.slice(-2);
  const year = Number(digits.length === 8 ? digits.slice(0, 4) : today.slice(0, 4));
  if (year < 1) return '';
  const lastYear = digits.length === 8 ? year : Math.min(year + 8, 9999);
  for (let candidate = year; candidate <= lastYear; candidate++) {
    const date = `${String(candidate).padStart(4, '0')}-${month}-${day}`;
    if (digits.length !== 8 && date < today) continue;
    const parsed = new Date(date + 'T00:00:00Z');
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) return date;
  }
  return '';
}

export function parseNumericTime(value) {
  const digits = value.trim().normalize('NFKC');
  return /^(?:[01]\d|2[0-3])[0-5]\d$/.test(digits) ? digits.slice(0, 2) + ':' + digits.slice(2) : '';
}

export function recurringOn(rules, day) {
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  const date = Number(day.slice(8, 10));
  const monthDay = day.slice(5);
  return rules.filter(rule => {
    if (rule.paused || day < rule.start || rule.frequency === 'quota') return false;
    if (rule.kind === 'birthday') return rule.monthDay === monthDay;
    if (rule.frequency === 'weekly') return rule.days.includes(weekday);
    if (rule.frequency === 'monthly') return rule.days.includes(date);
    return true;
  }).flatMap(rule => (rule.kind === 'birthday' ? [''] : rule.times).map(time => ({
    rule, day, time, id: `${rule.id}:${day}:${time}`
  }))).sort((a, b) => a.time.localeCompare(b.time) || a.rule.title.localeCompare(b.rule.title));
}

export function routineWeeks(rule, completions, today) {
  const history = rule.history || [];
  const on = day => history.findLast(plan => plan.from <= day) || (history.length ? null : rule);
  return Array.from({ length: 8 }, (_, index) => {
    const start = shift(sunday(today), (index - 7) * 7);
    const end = shift(start, 6);
    const plan = on(end < today ? end : today);
    const marks = completions.filter(day => day >= start && day <= end);
    const done = plan?.targetUnit === 'days' ? new Set(marks).size : marks.length;
    const target = plan?.frequency === 'quota' ? (plan.paused ? 0 : plan.target) :
      Array.from({ length: 7 }, (_, offset) => {
        const day = shift(start, offset);
        const schedule = on(day > today ? today : day);
        return schedule ? recurringOn([{ ...rule, ...schedule }], day).length : 0;
      }).reduce((total, count) => total + count, 0);
    return { start, done, target, percent: target ? Math.round(100 * done / target) : null };
  });
}

const voiceItemMarker = /(?:另一個|[一1]個|第[一二三四五六七八九十\d]+個)是/gu;
const voiceCancel = /上一個不算|上一個取消|取消上一個/gu;

export function parseVoiceGlossary(text) {
  const terms = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [heard, spelling, ...extra] = line.split(/\s*[=＝→]\s*/u).map(value => value.trim());
    if (!heard || !spelling || extra.length || terms.has(heard)) {
      throw new Error('自訂詞彙請每行填一組，例如「帕森 = Python」。每種誤聽寫法只能設定一次。');
    }
    terms.set(heard, spelling);
  }
  return terms;
}

export function correctVoiceTerms(text, terms = new Map()) {
  // The same sounds may be a person's name, so only correct homophones in a technical context.
  const builtInCorrection = value => value
    .replace(/\bdata[\s-]*sheet\b/giu, 'datasheet')
    .replace(/(?:元件規格書|晶片資料手冊|數據手冊)/gu, 'datasheet')
    .replace(/\bpython\b/giu, 'Python')
    .replace(/(學習|學|讀|練習)\s*(?:帕森|派森|派桑)(?!\s*(?:先生|小姐|老師))/gu, '$1 Python')
    .replace(/(?:帕森|派森|派桑)(?=\s*(?:程式|腳本|語法|爬蟲|套件|教學影片))/gu, 'Python')
    .replace(/(?:帕森|派森|派桑)(?=\s*(?:tutorial|script|code|programming)\b)/giu, 'Python');
  if (!terms.size) return builtInCorrection(text);
  const alternatives = [...terms.keys()].sort((a, b) => b.length - a.length).map(term => {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const start = /^[A-Za-z0-9]/u.test(term) ? '(?<![A-Za-z0-9_])' : '';
    const end = /[A-Za-z0-9]$/u.test(term) ? '(?![A-Za-z0-9_])' : '';
    return start + literal + end;
  });
  // Correct untouched text separately so a user's spelling takes precedence.
  const chunks = text.split(new RegExp('(' + alternatives.join('|') + ')', 'gu'));
  return chunks.map((chunk, index) => index % 2 ? terms.get(chunk) : builtInCorrection(chunk)).join('');
}

export function reviseVoiceTranscript(text) {
  const normalized = text.normalize('NFKC');
  const parts = normalized.split(voiceCancel);
  if (parts.length === 1) return { text, changed: false };

  const intro = parts[0].match(/^\s*((?:(?:請|幫我)\s*)?(?:新增|建立|設定)\s*)(?:[一二兩三四五六七八九十\d]+個|幾個)?\s*(日常|待辦|任務|事件|行程)\s*[，,\s]*/u);
  if (intro) parts[0] = parts[0].slice(intro[0].length);
  const items = [];
  for (const [index, part] of parts.entries()) {
    const clauses = part.replace(voiceItemMarker, '\n')
      .split(/[。；;！？\n]+|(?:然後)?還有|另外|以及|(?:[，,]\s*(?:然後)?)?(?<!一)再(?:新增|加|來|記)(?:一個|一筆)?|[，,]\s*(?:然後)?再(?=\S)|(?:[，,]\s*(?:然後)?|跟)\s*(?=(?:每天|每日|明天|後天|今天|買|寄|交|開會|回覆|整理))/u);
    items.push(...clauses.map(clause => clause.replace(/^[，,\s]+|[，,\s]+$/gu, '')).filter(Boolean));
    if (index < parts.length - 1) items.pop();
  }
  if (!items.length) return { text: '', changed: true };
  return { text: (intro ? intro[1] + intro[2] + '，' : '') + items.join('，'), changed: true };
}

export function voiceRoutineGoals(text) {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '');
  const explicitRoutine = /(?:新增|建立|設定).{0,12}日常/u.test(normalized);
  const clauses = normalized.split(/[，,。；;！？、\n]|然後|另外|還有|以及|跟|和|再(?:新增|加|來|記)(?:一個|一筆)?|再(?=每天|每日|天天)/u)
    .flatMap(clause => explicitRoutine
      ? clause.replace(voiceItemMarker, '，').split('，')
      : [clause]);
  const routinePrefix = /^(?:幫我|請|我想要?|我要|新增|建立|設定|[幾一二兩三四五六七八九十\d]+個|日常(?:任務)?|目標|一個是|另一個是|是)+/u;
  const dailyPrefix = /^(?:每天|每日|天天|每一[天日])/u;
  const goals = [];
  let dailyMentions = 0;
  for (const clause of clauses) {
    const daily = clause.replace(routinePrefix, '');
    if (explicitRoutine && dailyPrefix.test(daily)) {
      dailyMentions++;
      const title = daily.replace(dailyPrefix, '');
      if (title && title.length <= 160) goals.push({ title, target: 7, targetUnit: 'days' });
      continue;
    }
    const match = clause.match(/^(.+?)(?:就是|是|要|目標)?(?:每[週周]|(?:[一1]|這)[週周])([一二兩三四五六七八九十\d]{1,2})(天|次|練)$/u);
    if (!match) continue;
    const title = match[1]
      .replace(routinePrefix, '')
      .replace(/(?:就是|是|要|目標)$/u, '');
    const target = Number(match[2]) || (match[2] === '兩' ? 2 : '零一二三四五六七八九十'.indexOf(match[2]));
    const targetUnit = match[3] === '天' ? 'days' : 'times';
    if (!title || title.length > 160 || target < 1 || target > (targetUnit === 'days' ? 7 : 99)) continue;
    goals.push({ title, target, targetUnit });
  }
  if (!goals.length) return [];
  const mentioned = [...normalized.matchAll(/(?:每[週周]|[一1這][週周])[一二兩三四五六七八九十\d]+(?:天|次|練)/gu)].length;
  const declared = normalized.match(/([二兩三四五六七八九十\d]+)個日常/u)?.[1];
  const expected = declared ? Number(declared) || (declared === '兩' ? 2 : '零一二三四五六七八九十'.indexOf(declared)) : 0;
  if (goals.length < mentioned + dailyMentions || goals.length < expected) return [];
  return goals;
}

export function recurringNotices(rules, marks, now) {
  const day = dayKey(now);
  const birthdays = rules.filter(rule => rule.kind === 'birthday' && rule.start <= day);
  const routines = recurringOn(rules, day).filter(({ rule }) => rule.kind === 'routine');
  const reminders = routines.map(occurrence => ({ ...occurrence, noticeDay: day, noticeTime: occurrence.time }));
  for (const lead of new Set(birthdays.map(rule => rule.lead))) {
    for (const occurrence of recurringOn(birthdays.filter(rule => rule.lead === lead), shift(day, lead))) {
      reminders.push({ ...occurrence, noticeDay: day, noticeTime: occurrence.rule.times[0] });
    }
  }
  return reminders.filter(({ id, noticeDay, noticeTime }) => {
    const elapsed = now.getTime() - Date.parse(`${noticeDay}T${noticeTime}:00+08:00`);
    return !marks[id] && elapsed >= 0 && elapsed < 300000;
  }).map(({ id, rule, day, noticeTime }) => ({
    id: 'recurring:' + id,
    title: rule.kind === 'birthday' ? '生日提醒 · ' + rule.title : rule.title,
    body: rule.kind === 'birthday' ? `生日 · ${day}` : `日常 · ${noticeTime}`
  }));
}
export const byTaskPriority = (a, b) =>
  Number(a.priority || 4) - Number(b.priority || 4) ||
  a.date.localeCompare(b.date) || a.created.localeCompare(b.created);

export function agenda(items, day, now = new Date()) {
  const available = items.filter(item => !item.archived);
  const open = available.filter(item => item.type === 'T' && item.status !== 'done');
  const overdue = open.filter(item => {
    const lastDay = item.dueDate || item.date;
    return lastDay && (lastDay < day || (item.dueDate === day && item.dueTime &&
      now.getTime() >= Date.parse(day + 'T' + item.dueTime + ':00+08:00')));
  });
  const today = available.filter(item => item.date === day || (item.type === 'T' &&
    (item.dueDate === day || (item.status !== 'done' && item.date && item.date < day && item.dueDate > day))));
  const todayIds = new Set(today.map(item => item.id));
  const overdueIds = new Set(overdue.map(item => item.id));
  const tasks = open.filter(item => todayIds.has(item.id) || overdueIds.has(item.id));
  const focus = open.find(item => item.focus && item.date === day);
  const next = focus ?? tasks.sort(byTaskPriority)[0];
  return { today, overdue, next, focus };
}

export function reminders(items, settings, now) {
  const day = dayKey(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(now);
  const { today, overdue, next } = agenda(items, day, now);
  const due = today.filter(item => item.type === 'T' && item.status !== 'done');
  const events = today.filter(item => item.type === 'E');
  const result = [];
  if (settings.daily && time >= settings.daily) {
    result.push({ id: 'daily:' + day, title: '今日筆記',
      body: `待辦 ${due.length} 件 · 行程 ${events.length} 件 · 逾期 ${overdue.length} 件${next ? ' · 下一步：' + (next.next || next.title) : ''}` });
  }
  if (settings.review && time >= settings.review && (due.length || overdue.length)) {
    result.push({ id: 'review:' + day, title: '還沒完成的事項',
      body: `今天 ${due.length} 件 · 逾期 ${overdue.length} 件` });
  }
  const start = sunday(day);
  if (settings.weekly && day === start && time >= settings.weekly) {
    const weekEvents = items.filter(item => !item.archived && item.type === 'E' && item.date >= start && item.date <= shift(start, 6))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const future = items.filter(item => !item.archived && item.status !== 'done' && item.month >= day.slice(0, 7) && !item.date)
      .sort((a, b) => a.month.localeCompare(b.month));
    const firstEvent = weekEvents[0];
    const firstPlan = future[0];
    result.push({ id: 'weekly:' + start, title: '本週行程與未來規劃',
      body: `本週 ${weekEvents.length} 個事件${firstEvent ? ' · 最近：' + firstEvent.title : ''}。未來誌 ${future.length} 筆待排程${firstPlan ? ' · ' + firstPlan.month + ' ' + firstPlan.title : ''}。` });
  }
  for (const item of items) {
    if (item.archived || item.status === 'done') continue;
    if (item.date && item.time && item.remind) {
      const minutes = (Date.parse(item.date + 'T' + item.time + ':00+08:00') - now.getTime()) / 60000;
      if (minutes <= Number(item.remind) && minutes > -5) {
        result.push({ id: `item:${item.id}:${item.date}:${item.time}:${item.remind}`, title: item.title, body: item.next || `${types[item.type]} · ${item.date} ${item.time}` });
      }
    }
    if (item.type !== 'T' || !item.dueDate || !item.dueRemind) continue;
    const deadline = item.dueTime
      ? Date.parse(`${item.dueDate}T${item.dueTime}:00+08:00`)
      : Date.parse(`${shift(item.dueDate, 1)}T00:00:00+08:00`);
    const reminderAt = deadline - Number(item.dueRemind) * 60000;
    if (now.getTime() >= reminderAt && now.getTime() < reminderAt + 300000) {
      result.push({ id: `deadline:${item.id}:${item.dueDate}:${item.dueTime || 'end'}:${item.dueRemind}`,
        title: '截止提醒 · ' + item.title, body: `${item.dueDate} ${item.dueTime || '當天結束'}截止` });
    }
  }
  return result;
}
