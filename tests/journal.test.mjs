import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dayKey, shift, sunday, trashExpiry, agenda, reminders, recurringOn, recurringNotices, routineWeeks } from '../public/model.mjs';

const directory = mkdtempSync(resolve(tmpdir(), 'journal-test-'));
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const key = randomUUID();
let server;
let origin;

async function start(skipTimer = true) {
  server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, JOURNAL_DATA: directory, JOURNAL_KEY: key,
      JOURNAL_HOST: '127.0.0.1', JOURNAL_PORT: '0', JOURNAL_HTTPS: '', JOURNAL_CERT: '', JOURNAL_CERT_KEY: '',
      JOURNAL_SKIP_TIMER: skipTimer ? '1' : '' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const [data] = await once(server.stdout, 'data');
  origin = data.toString().match(/http:\/\/localhost:\d+/)[0];
}
async function stop() {
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  server = null;
}
async function query(path, { cookie, data } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(data) });
}
async function login() {
  const result = await query('/api/login', { data: { code: key } });
  assert.equal(result.status, 200);
  return result.headers.get('set-cookie').split(';')[0];
}
async function json(path, options, status = 200) {
  const result = await query(path, options);
  const body = await result.json();
  assert.equal(result.status, status, JSON.stringify(body));
  return body;
}

try {
  await start();
  await json('/api/state', {}, 401);
  await json('/api/login', { data: { code: 'wrong' } }, 401);
  const mobile = await login();
  const desktop = await login();
  const today = dayKey();
  const tomorrow = shift(today, 1);
  const dailyPlan = { kind: 'routine', start: '2026-11-15', frequency: 'daily', days: [], times: ['08:00'] };
  assert.deepEqual(routineWeeks(dailyPlan, ['2026-11-15', '2026-11-16', '2026-11-17'], '2026-11-18').at(-1),
    { start: '2026-11-15', done: 3, target: 7, percent: 43 });
  const quotaPlan = { kind: 'routine', start: '2026-11-08', frequency: 'quota', target: 5, history: [
    { from: '2026-11-08', frequency: 'quota', target: 4 },
    { from: '2026-11-15', frequency: 'quota', target: 5 }
  ] };
  const quotaWeeks = routineWeeks(quotaPlan, ['2026-11-08', '2026-11-08', '2026-11-14'], '2026-11-15');
  assert.deepEqual(quotaWeeks.slice(-2).map(({ done, target, percent }) => [done, target, percent]), [[3, 4, 75], [0, 5, 0]]);
  const capture = { id: randomUUID(), version: 0, title: '準備簡報', type: 'C', status: 'open',
    date: '', time: '', month: '', notes: '', next: '', priority: '', remind: '', parentId: '' };
  const saved = await json('/api/item', { cookie: mobile, data: capture });
  const shared = await json('/api/state', { cookie: desktop });
  assert.deepEqual(shared.items, [saved]);
  const task = await json('/api/item', { cookie: desktop, data: {
    ...saved, type: 'T', date: today, month: today.slice(0, 7), next: '列出三個重點', priority: '1', focus: true
  } });
  const backup = await json('/api/item', { cookie: desktop, data: { ...capture, id: randomUUID(), title: '檢查投影', type: 'T', date: today, priority: '2' } });
  const snapshot = await json('/api/state', { cookie: mobile });
  assert.equal(agenda(snapshot.items, today).next.id, task.id);
  await json('/api/item', { cookie: mobile, data: { ...saved, status: 'done' } }, 409);
  const postponed = await json('/api/item', { cookie: mobile, data: { ...task, date: tomorrow } });
  assert.equal(postponed.focus, false);
  assert.equal(agenda((await json('/api/state', { cookie: desktop })).items, today).next.id, backup.id);
  const done = await json('/api/item', { cookie: desktop, data: { ...postponed, status: 'done' } });
  await json('/api/item', { cookie: desktop, data: { ...done, archived: true } });
  const monthOnly = await json('/api/item', { cookie: mobile, data: { ...capture, id: randomUUID(), type: 'P', month: '2027-02' } });
  assert.equal(monthOnly.date, '');
  await json('/api/settings', { cookie: desktop, data: { daily: '00:00', review: '', weekly: '' } });
  const scheduled = reminders([{ ...backup, date: '2026-11-16', time: '08:15', remind: '15' }],
    { daily: '08:00', weekly: '08:00', review: '' }, new Date('2026-11-16T08:00:00+08:00'));
  assert.equal(sunday('2026-11-21'), '2026-11-15');
  assert.equal(sunday('2026-11-22'), '2026-11-22');
  assert.deepEqual(scheduled.map(item => item.id.split(':')[0]), ['daily', 'item']);
  assert.equal(reminders([], { weekly: '08:00' }, new Date('2026-11-15T08:00:00+08:00'))[0]?.id, 'weekly:2026-11-15');
  const deadlineDay = '2026-11-16';
  const deadline = { ...backup, date: '2026-11-15', dueDate: deadlineDay, dueTime: '10:00' };
  assert.equal(agenda([deadline], deadlineDay, new Date('2026-11-16T09:59:00+08:00')).overdue.length, 0);
  assert.equal(agenda([deadline], deadlineDay, new Date('2026-11-16T10:00:00+08:00')).overdue.length, 1);
  assert.equal(agenda([{ ...deadline, dueTime: '' }], deadlineDay).overdue.length, 0);
  assert.equal(agenda([{ ...deadline, dueTime: '' }], '2026-11-17').overdue.length, 1);
  assert.equal(agenda([{ ...backup, date: '2026-11-15' }], deadlineDay).overdue.length, 1);
  const ongoing = { ...backup, date: '2026-11-15', dueDate: '2026-11-18', focus: false };
  const activeAgenda = agenda([ongoing], deadlineDay, new Date('2026-11-16T09:00:00+08:00'));
  assert.deepEqual(activeAgenda.today, [ongoing]);
  assert.equal(activeAgenda.next?.id, ongoing.id);
  assert.equal(activeAgenda.overdue.length, 0);
  assert.equal(agenda([{ ...ongoing, status: 'done' }], deadlineDay).today.length, 0);
  await json('/api/item', { cookie: desktop, data: { ...backup, dueTime: '10:00' } }, 400);
  await json('/api/item', { cookie: desktop, data: { ...backup, dueDate: shift(today, -1) } }, 400);
  await json('/api/item', { cookie: desktop, data: { ...backup, time: '13:00', dueDate: today, dueTime: '10:00' } }, 400);
  const deadlineReminder = { ...deadline, date: '', time: '', dueRemind: '60' };
  const deadlineNotices = (item, time) => reminders([item], {}, new Date(time));
  assert.equal(deadlineNotices(deadlineReminder, '2026-11-16T08:59:59+08:00').length, 0);
  const due = deadlineNotices(deadlineReminder, '2026-11-16T09:00:00+08:00');
  assert.equal(due.length, 1);
  assert.match(due[0].id, /^deadline:/);
  assert.equal(deadlineNotices(deadlineReminder, '2026-11-16T09:05:00+08:00').length, 0);
  assert.equal(deadlineNotices({ ...deadlineReminder, status: 'done' }, '2026-11-16T09:00:00+08:00').length, 0);
  assert.equal(deadlineNotices({ ...deadlineReminder, dueTime: '', dueRemind: '1440' }, '2026-11-16T00:00:00+08:00').length, 1);
  const both = deadlineNotices({ ...deadlineReminder, date: deadlineDay, time: '09:00', remind: '0' }, '2026-11-16T09:00:00+08:00');
  assert.deepEqual(both.map(notice => notice.id.split(':')[0]), ['item', 'deadline']);
  const routine = { id: randomUUID(), version: 0, kind: 'routine', title: '讀英文',
    frequency: 'weekly', days: [3], times: ['08:00', '20:00'] };
  const weeklyRule = await json('/api/recurring', { cookie: desktop, data: routine });
  const birthday = await json('/api/recurring', { cookie: mobile, data: {
    id: randomUUID(), version: 0, kind: 'birthday', title: '小安', monthDay: '01-01', lead: 1, times: ['09:00']
  } });
  await json('/api/recurring', { cookie: mobile, data: { ...routine, days: [7] } }, 409);
  await json('/api/recurring', { cookie: mobile, data: { ...routine, id: randomUUID(), days: [7] } }, 400);
  const monthlyRule = await json('/api/recurring', { cookie: desktop, data: {
    ...routine, id: randomUUID(), frequency: 'monthly', days: [15, 31], times: ['20:00']
  } });
  assert.equal(recurringOn([monthlyRule], '2027-02-28').length, 0);
  assert.equal(recurringOn([monthlyRule], '2027-03-31').length, 1);
  const wednesday = '2027-01-06';
  const [morning, evening] = recurringOn([weeklyRule], wednesday);
  assert.equal(recurringOn([weeklyRule], '2027-01-07').length, 0);
  const morningTime = new Date(wednesday + 'T08:00:00+08:00');
  assert.equal(recurringNotices([weeklyRule], {}, morningTime)[0].id, 'recurring:' + morning.id);
  assert.equal(recurringNotices([weeklyRule], { [morning.id]: 'skip' }, morningTime).length, 0);
  assert.equal(recurringNotices([weeklyRule], { [morning.id]: 'done' }, new Date(wednesday + 'T20:00:00+08:00'))[0].id,
    'recurring:' + evening.id);
  assert.equal(recurringNotices([birthday], {}, new Date('2026-12-31T09:00:00+08:00'))[0].body, '生日 · 2027-01-01');
  const batch = [{ id: randomUUID(), title: '寄出報價' }, { id: randomUUID(), title: '買筆記本' }];
  await json('/api/task-batch', { cookie: desktop, data: { tasks: batch } });
  await json('/api/task-batch', { cookie: desktop, data: { tasks: batch } });
  const invalid = { id: randomUUID(), title: '不應儲存' };
  await json('/api/task-batch', { cookie: desktop, data: { tasks: [invalid, { id: randomUUID(), title: '' }] } }, 400);
  const updatedState = await json('/api/state', { cookie: mobile });
  assert.equal(updatedState.items.filter(item => batch.some(task => task.id === item.id)).length, 2);
  assert.equal(updatedState.items.some(item => item.id === invalid.id), false);
  await json('/api/trash', { cookie: desktop, data: {
    id: weeklyRule.id, version: weeklyRule.version, category: 'rule', deleted: true
  } });
  const trashed = await json('/api/state', { cookie: mobile });
  assert.equal(trashed.rules.some(rule => rule.id === weeklyRule.id), false);
  const removed = trashed.trash.find(rule => rule.id === weeklyRule.id);
  assert.equal(removed.deletedDay, today);
  assert.equal(trashExpiry('2026-12-30'), '2027-01-02');
  await json('/api/trash', { cookie: mobile, data: {
    id: removed.id, version: removed.version, category: 'rule', deleted: false
  } });
  if (process.env.JOURNAL_AI_MODEL) {
    assert.equal(updatedState.localAI, true);
    assert.equal((await json('/api/ai-status', { cookie: desktop, data: {} })).status, 'ready');
    const plan = await json('/api/local-ai', { cookie: desktop, data: {
      mode: 'plan', text: '新增專案「BikeShare 需求預測」。子任務是 11 月 16 日至 17 日取得範例資料、18 日至 19 日分析、20 日彙整。'
    } });
    assert.match(plan.project, /BikeShare/i);
    const year = today.slice(0, 4);
    assert.deepEqual(plan.tasks.map(task => [task.date, task.dueDate, task.time, task.dueTime]), [
      [year + '-11-16', year + '-11-17', '', ''],
      [year + '-11-18', year + '-11-19', '', ''],
      [year + '-11-20', '', '', '']
    ]);
    const draft = {
      project: { id: randomUUID(), title: plan.project },
      tasks: plan.tasks.map(task => ({ id: randomUUID(), ...task }))
    };
    const saved = await json('/api/task-batch', { cookie: desktop, data: draft });
    assert.equal(saved.projectId, draft.project.id);
    const projectEntries = (await json('/api/state', { cookie: mobile })).items;
    assert.equal(projectEntries.find(item => item.id === saved.projectId).type, 'P');
    assert.equal(projectEntries.filter(item => item.parentId === saved.projectId && item.dueDate).length, 2);
    const polished = await json('/api/local-ai', { cookie: desktop, data: {
      mode: 'polish', text: '我11月16日要抓資料然後要分析一下。'
    } });
    assert.match(polished.text, /11\s*月\s*16\s*日/);
    const split = await json('/api/local-ai', { cookie: desktop, data: {
      mode: 'tasks', text: '待辦有兩筆，買咖啡豆，然後寄出報價。'
    } });
    assert.match(split.text, /咖啡豆/);
    assert.match(split.text, /報價/);
    const review = await json('/api/local-ai', { cookie: mobile, data: {
      mode: 'review', text: '今天完成了英文作業。明天要寄出報價。'
    } });
    assert.match(review.text, /報價/);
  }
  const updated = await json('/api/item', { cookie: desktop, data: { ...backup, dueDate: tomorrow, dueRemind: '60' } });
  const { dueRemind, ...olderClient } = updated;
  assert.equal(dueRemind, '60');
  const migrated = await json('/api/item', { cookie: mobile, data: { ...olderClient, date: tomorrow } });
  assert.equal(migrated.dueRemind, '60');
  assert.equal((await json('/api/item', { cookie: desktop, data: { ...migrated, dueDate: '' } })).dueRemind, '');
  await stop();
  const database = new DatabaseSync(resolve(directory, 'journal.sqlite'));
  const expired = { ...capture, id: randomUUID(), deleted: true, deletedDay: shift(today, -3) };
  const stillRecoverable = { ...expired, id: randomUUID(), deletedDay: shift(today, -2), version: 1 };
  const legacy = { ...expired, id: randomUUID(), deletedDay: undefined };
  const insert = database.prepare('INSERT INTO entries VALUES (?, ?)');
  for (const item of [expired, stillRecoverable, legacy]) insert.run(item.id, JSON.stringify(item));
  const oldRule = { ...weeklyRule, id: randomUUID(), deleted: true, deletedDay: shift(today, -3) };
  const config = database.prepare("SELECT value FROM config WHERE name = 'recurring'").get();
  database.prepare("UPDATE config SET value = ? WHERE name = 'recurring'").run(JSON.stringify([...JSON.parse(config.value), oldRule]));
  const mark = oldRule.id + ':' + today + ':08:00';
  database.prepare('INSERT INTO recurring_marks VALUES (?, ?, ?)').run(mark, today, 'done');
  database.close();
  await start(false);
  const after = await json('/api/state', { cookie: mobile });
  assert(!after.trash.some(record => record.id === expired.id || record.id === oldRule.id));
  assert(!Object.hasOwn(after.marks, mark));
  assert.equal(after.trash.find(record => record.id === legacy.id)?.deletedDay, today);
  assert(after.trash.some(record => record.id === stillRecoverable.id));
  await json('/api/trash', { cookie: mobile, data: { category: 'item', id: stillRecoverable.id, version: 1, deleted: false } });
  const restored = (await json('/api/state', { cookie: mobile })).items.find(record => record.id === stillRecoverable.id);
  assert(restored && !Object.hasOwn(restored, 'deletedDay'));
  assert.equal(after.items.find(item => item.id === done.id).archived, true);
  assert.equal(after.rules.length, 3);
  assert.equal(after.notices.filter(notice => notice.id === 'daily:' + today).length, 1);
  await stop();
  await start(false);
  assert.equal((await json('/api/state', { cookie: mobile })).notices.filter(notice => notice.id === 'daily:' + today).length, 1);
  for (const asset of ['/', '/app.mjs', '/model.mjs', '/meeting.mjs', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/style.css']) {
    assert.equal((await query(asset)).status, 200);
  }
  console.log('PASS: pairing, independent sessions, capture, focus, version conflict, migration, archive, future month, schedules, reminder deduplication, restart, install assets');
} finally {
  if (server) await stop();
  rmSync(directory, { recursive: true });
}
