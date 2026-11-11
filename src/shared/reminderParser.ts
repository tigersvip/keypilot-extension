import { localDateInput } from './reminders';

export interface ReminderCandidate { title: string; date: string; source: string; note: string; issue?: string }
const privateLine = /(?:密[码碼]|password|passwd|secret|token|验证码|驗證碼|帳號|账号|username|account)\s*[:：\t ]/i;
// Explicit patterns only: do not let Date.parse silently reinterpret ambiguous dates or roll invalid dates over.
const clockPattern = String.raw`(?:上午|下午|晚上)?\s*\d{1,2}(?:[:：]\d{2}(?::\d{2})?|[点點](?:\d{1,2}分?)?)(?:\s*(?:am|pm))?(?:Z|[+-]\d{2}:?\d{2})?`;
const datePattern = new RegExp(String.raw`\b\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?!\d)日?(?:[T\s]+${clockPattern})?|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b(?:\s+${clockPattern})?|(?:今天|明天|后天|後天|\d+\s*天[后後])(?:\s*${clockPattern})?|\b\d{1,2}月\d{1,2}日?(?:\s*${clockPattern})?|\b\d{1,2}[-/.]\d{1,2}\b`, 'gi');

function parseDate(source: string, now: number): Pick<ReminderCandidate, 'date' | 'note' | 'issue'> {
  let year: number, month: number, day: number;
  const relative = source.match(/^(今天|明天|后天|後天|(\d+)\s*天[后後])/);
  const first = source.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  const last = source.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (relative) {
    const count = relative[2] ? Number(relative[2]) : relative[1] === '今天' ? 0 : relative[1] === '明天' ? 1 : 2;
    if (count > 36500) return { date: '', note: '', issue: '相对日期超出范围，请填写日期。' };
    const base = new Date(now); base.setDate(base.getDate() + count);
    year = base.getFullYear(); month = base.getMonth() + 1; day = base.getDate();
  } else if (first) {
    year = Number(first[1]); month = Number(first[2]); day = Number(first[3]);
  } else if (last) {
    year = Number(last[3]);
    const a = Number(last[1]), b = Number(last[2]);
    if (a <= 12 && b <= 12 && a !== b) return { date: '', note: '', issue: '月、日顺序不明确，请选择正确日期。' };
    month = a > 12 ? b : a; day = a > 12 ? a : b;
  } else return { date: '', note: '', issue: '日期缺少年份，请补全日期。' };
  const time = source.match(/(?:(上午|下午|晚上)\s*)?(\d{1,2})[:：](\d{2})(?::(\d{2}))?/) ??
    source.match(/(上午|下午|晚上)?\s*(\d{1,2})[点點](?:(\d{1,2})分?)?/);
  let hour = time ? Number(time[2]) : 9;
  const minute = time ? Number(time[3] ?? 0) : 0;
  const second = time ? Number(time[4] ?? 0) : 0;
  const meridian = source.match(/\b(am|pm)\b/i)?.[1].toLowerCase();
  if (meridian && (hour < 1 || hour > 12)) return { date: '', note: '', issue: '12 小时时间无效，请检查 AM / PM。' };
  if (meridian === 'am' && hour === 12) hour = 0;
  if (meridian === 'pm' && hour < 12) hour += 12;
  if (time?.[1] === '上午' && hour === 12) hour = 0;
  if ((time?.[1] === '下午' || time?.[1] === '晚上') && hour < 12) hour += 12;
  const zone = source.match(/(Z|[+-]\d{2}:?\d{2})$/i);
  const date = zone ? new Date(Date.UTC(year, month - 1, day, hour, minute, second)) : new Date(year, month - 1, day, hour, minute, second);
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 ||
      (zone ? date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
        : date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute)) {
    return { date: '', note: '', issue: '日期或时间无效，请检查月份、天数和时间。' };
  }
  if (zone) {
    const utc = zone[1].toUpperCase() === 'Z';
    const offset = utc ? 0 : (zone[1][0] === '-' ? -1 : 1) * (Number(zone[1].slice(1, 3)) * 60 + Number(zone[1].slice(-2)));
    if (Math.abs(offset) > 14 * 60 || (!utc && Number(zone[1].slice(-2)) > 59)) return { date: '', note: '', issue: '时区格式无效。' };
    return { date: localDateInput(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000), note: '已换算为电脑本地时间' };
  }
  return { date: localDateInput(date.getTime()), note: time ? '电脑本地时间' : '未写时间，暂设为当天 09:00' };
}
export function parseReminderText(text: string, now = Date.now()): ReminderCandidate[] {
  if (text.length > 50000) throw new Error('一次最多识别 5 万字，请分批粘贴。');
  const results: ReminderCandidate[] = [];
  let context = '';
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^[-_=─]{3,}$/.test(line)) { context = ''; continue; }
    if (!line || privateLine.test(line)) continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(line)) { context = line; continue; }
    const ip = line.match(/^(?:IP(?:\s*Address)?|服务器|伺服器)\s*[:：\t ]+(.+)$/i);
    if (ip) { context = ip[1].trim().slice(0, 160); continue; }
    const matches = [...line.matchAll(datePattern)];
    if (!matches.length) { context = line.slice(0, 160); continue; }
    let previousEnd = 0;
    for (const match of matches) {
      const prefix = line.slice(previousEnd, match.index).replace(/^[\s,，;；]+|[\s:：,，;；]+$/g, '');
      const generic = /^(?:到期(?:时间|時間|日期)?|截止(?:时间|時間|日期)?|有效期(?:至)?|expires?(?:\s*(?:at|on))?|expiry(?:\s*date)?|提醒|日期)$/i.test(prefix);
      const title = (generic ? `${context || '到期事项'}${context ? ' · 到期' : ''}` : prefix || context || '待办事项').slice(0, 200);
      results.push({ title, source: match[0], ...parseDate(match[0], now) });
      previousEnd = (match.index ?? 0) + match[0].length;
      if (results.length > 100) throw new Error('一次最多识别 100 条提醒，请分批处理。');
    }
  }
  return results;
}
