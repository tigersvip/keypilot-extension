import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseReminderText } from '../src/shared/reminderParser';
import { acknowledgeReminders, applyReminderReceipts, buildReminderIndex, dateFromInput, localDateInput, overlayReminderIndex, pendingReminders, readReminderIndex, reminderTimes, updateReminderIndex, validateReminder } from '../src/shared/reminders';
import { createEmptyVault } from '../src/shared/defaults';
import { clearVaultSessionCache, createVaultSession, persistVaultSession, unlockVaultSession } from '../src/shared/vault';
import { initializeVaultFromBackup, mergeBackup, previewBackup, validateBackup } from '../src/shared/backup';
import { prepareEncryptedBackup } from '../src/shared/backupStatus';
import { unlockEncryptedVault } from '../src/shared/crypto';
import { clearEncryptedVault } from '../src/shared/storage';
import type { Reminder } from '../src/shared/types';

const base = new Date(2026, 10, 10, 12).getTime();
const reminder = (patch: Partial<Reminder> = {}): Reminder => ({ id: 'synthetic-reminder', revision: 'version-a', title: 'Synthetic renewal', dueAt: base + 86400000, leadDays: 1, acknowledged: [], createdAt: base, updatedAt: base, ...patch });
function area() {
  const values: Record<string, unknown> = {};
  return { async get(key: string) { return structuredClone({ [key]: values[key] }); }, async set(value: Record<string, unknown>) { Object.assign(values, structuredClone(value)); }, async remove(key: string) { delete values[key]; } };
}
beforeEach(() => Object.assign(globalThis, { chrome: { storage: { local: area(), session: area() } } }));

test('paste separates server blocks and mixed separators without retaining login secrets', () => {
  const result = parseReminderText('IP Address\t192.0.2.10\n帳號\tSynthetic-user\n密碼\tSynthetic-secret!\n到期时间 2026-11-17\n---------\nIP Address\t192.0.2.20\n账号 test-user\npassword: fake-secret\n到期時間 2026-12.1', base);
  assert.equal(result.length, 2); assert.equal(result[0].date, '2026-11-17T09:00'); assert.equal(result[1].date, '2026-12-01T09:00');
  assert.equal(result[0].title, '192.0.2.10 · 到期'); assert.equal(result[1].title, '192.0.2.20 · 到期');
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('Synthetic-user'));
});
test('recognizes Chinese, relative, unambiguous day-first, local time and offset dates', () => {
  const input = ['续费 2026年11月17日 下午3:30', '开会 明天上午10点', '交报告 3天后14:20', '合同 17/11/2026 16:00', '发布 2026-11-18T02:30:00Z', '采购 后天', '相同月日 12/12/2026'];
  const result = parseReminderText(input.join('\n'), base);
  assert.deepEqual(result.map(item => item.date).slice(0, 4), ['2026-11-17T15:30', '2026-11-11T10:00', '2026-11-13T14:20', '2026-11-17T16:00']);
  assert.equal(result[4].date, localDateInput(Date.UTC(2026, 10, 18, 2, 30))); assert.equal(result[5].date, '2026-11-12T09:00');
  assert.ok(result.every(item => !item.issue));
});
test('ambiguous, incomplete, impossible and out of range dates require explicit correction', () => {
  for (const input of ['03/04/2027', '11月17日', '11/17', '2026-02-30', '2026-13-01', '2026-11-17 25:00', '2026-11-17 12:60', '999999天后']) {
    const result = parseReminderText('事件 '+input, base); assert.equal(result.length, 1, input); assert.ok(result[0].issue, input); assert.equal(result[0].date, '', input);
  }
  assert.equal(dateFromInput('2026-02-30T09:00'), null);
  assert.equal(parseReminderText('没有日期的文字', base).length, 0);
  assert.throws(() => parseReminderText('a'.repeat(50001)), /5 万/);
  assert.throws(() => parseReminderText(Array.from({length:101}, () => '事项 2026-11-17').join('\n')), /100/);
});
test('explicit Chinese times, AM/PM and seconds are retained; bare IPv4 is not a date', () => {
  const result = parseReminderText('192.0.2.10\n到期 2026年11月17日 下午3点20分\n会议 2026-11-18 04:30 PM\n发布 2026-11-19T12:00:25+08:00', base);
  assert.equal(result.length,3); assert.equal(result[0].date,'2026-11-17T15:20'); assert.equal(result[1].date,'2026-11-18T16:30');
  assert.equal(result[2].date,localDateInput(Date.UTC(2026,10,19,4,0,25)));
  assert.equal(dateFromInput(result[2].date),Date.UTC(2026,10,19,4,0,25));
  assert.ok(parseReminderText('事项 2026-11-17 12:00:99',base)[0].issue);
});
test('explicit UTC dates remain valid during a local daylight-saving gap', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const result = parseReminderText('会议 2026-03-08T02:30:00z', base);
    assert.equal(result.length, 1); assert.equal(result[0].issue, undefined);
    assert.equal(result[0].date, localDateInput(Date.UTC(2026, 2, 8, 2, 30)));
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
test('persistent projection omits content, batches due times, retains exact receipts and cancels changed schedules', () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [reminder()];
  const index = buildReminderIndex(vault, 'salt', null), first = reminderTimes(vault.reminders[0])[0];
  assert.ok(!JSON.stringify(index).includes('Synthetic renewal')); assert.equal(pendingReminders(index, first-1).length, 0); assert.equal(pendingReminders(index, first).length, 1);
  const ack = acknowledgeReminders(index, [{ id: reminder().id, revision: 'version-a', times: index.items[0].times }], first);
  assert.deepEqual(ack.items[0].acknowledged, [first]); assert.equal(pendingReminders(ack, first).length, 0); assert.equal(pendingReminders(ack, reminder().dueAt).length, 1);
  assert.deepEqual(buildReminderIndex(vault, 'salt', ack).items[0].acknowledged, [first]);
  assert.deepEqual(overlayReminderIndex(vault, 'salt', ack).reminders![0].acknowledged, [first]);
  assert.deepEqual(overlayReminderIndex(vault, 'other-vault', ack), vault);
  vault.reminders[0].revision = 'edited'; assert.deepEqual(buildReminderIndex(vault, 'salt', ack).items[0].acknowledged, []);
  assert.deepEqual(acknowledgeReminders(index, [{ id: reminder().id, revision: 'stale', times: [first] }], first), index);
  vault.settings.remindersEnabled = false; assert.equal(pendingReminders(buildReminderIndex(vault, 'salt', ack), base+86400000).length, 0);
});
test('locked confirmations survive unlock, unrelated writes, full backup and fresh restore', async () => {
  const master = 'Synthetic-reminder!42';
  let session = await createVaultSession(master);
  const item = reminder({ dueAt: Date.now()-1000, leadDays: 0 });
  session = await persistVaultSession(session, { ...session.vault, reminders: [item], settings: { ...session.vault.settings, remindersEnabled: true, reminderSound: 'bell', reminderVolume: 80 } });
  await clearVaultSessionCache();
  await updateReminderIndex(index => acknowledgeReminders(index!, [{ id:item.id, revision:item.revision, times:[item.dueAt] }]));
  session = await unlockVaultSession(master); assert.deepEqual(session.vault.reminders![0].acknowledged, [item.dueAt]);
  session = await persistVaultSession(session, { ...session.vault, settings: { ...session.vault.settings, autoFill:false } });
  const exported = await prepareEncryptedBackup(session);
  assert.deepEqual((await unlockEncryptedVault(master, exported.encryptedVault)).vault.reminders, exported.vault.reminders);
  assert.ok(!JSON.stringify(exported.encryptedVault).includes(item.title));
  const file = new File([JSON.stringify(exported.encryptedVault)], 'synthetic.json');
  await clearEncryptedVault(); assert.equal(await readReminderIndex(), null);
  const restored = await initializeVaultFromBackup(await previewBackup(file, master));
  assert.deepEqual(restored.vault.reminders, exported.vault.reminders); assert.equal(restored.vault.settings.reminderSound, 'bell');
  assert.equal(pendingReminders(await readReminderIndex()).length, 0);
});
test('export folds in confirmations made after the page loaded; reminder links follow backup conflicts', async () => {
  const session = await createVaultSession('Synthetic-reminder!42');
  const item = reminder({dueAt:Date.now()-1000,leadDays:0});
  const saved = await persistVaultSession(session, {...session.vault,reminders:[item],settings:{...session.vault.settings,remindersEnabled:true}});
  await updateReminderIndex(index => acknowledgeReminders(index!, [{id:item.id,revision:item.revision,times:[item.dueAt]}]));
  const exported = await prepareEncryptedBackup(saved); assert.deepEqual(exported.vault.reminders![0].acknowledged,[item.dueAt]);
  const current = createEmptyVault(), incoming = createEmptyVault();
  current.credentials=[{id:'login',title:'Existing',url:'https://example.test',domain:'example.test',username:'a',password:'fake',createdAt:1,updatedAt:1}];
  incoming.credentials=[{...current.credentials[0],title:'Incoming',password:'new-fake'}];incoming.reminders=[reminder({credentialId:'login'})];
  const merged = mergeBackup(current,incoming);assert.notEqual(merged.reminders![0].credentialId,'login');assert.equal(merged.reminders![0].credentialId,merged.credentials[1].id);
});
test('backup validates reminders and preserves older backups', () => {
  validateBackup(createEmptyVault()); validateReminder(reminder());
  for (const patch of [{dueAt:NaN},{leadDays:-1},{title:''},{acknowledged:[NaN]},{completedAt:Infinity},{revision:''}]) assert.throws(()=>validateReminder(reminder(patch)));
  const vault=createEmptyVault(); vault.reminders=[reminder()];validateBackup(vault);
  vault.settings.reminderVolume=0;assert.throws(()=>validateBackup(vault));
});
