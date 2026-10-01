/**
 * 间隔重复调度。
 *
 * 这个应用有两种复习方式，它们**权重不同**，这是刻意的设计：
 *
 *   1. cloze   填空 —— 看挖空的句子回忆并默写。提交后**不做字符串比对**，
 *              而是直接显示正确答案，由用户自己判定「想起来了 / 模糊 / 没想起来」。
 *              自己判定的依据是：我是不是真的回忆出来了，而不是拼写对不对。
 *              这条路算「已验证」，间隔可以正常增长。
 *
 *   2. reading 阅读标记 —— 填不出来时退回的方式：把词放回原句里直接读，
 *              用户判断认不认识。因为没有主动回忆这一步，**不能认为已完全记住**，
 *              所以间隔封顶、且 verified 保持 0，必须再由填空验证一次才能真正毕业。
 */

const MIN_EASE = 1.3;
const MAX_EASE = 3.2;

/** 填空正确后允许的最大间隔（天）。 */
const MAX_INTERVAL_DAYS = 365;
/** 阅读模式无论答对多少次，间隔都不超过这个天数，直到被填空验证。 */
const READING_INTERVAL_CAP = 4;
/** 失败后的重来间隔（天）。半天，即当天晚些时候还会再见到。 */
const LAPSE_INTERVAL = 0.5;

export const GRADES = {
  cloze_good: { key: 'cloze_good', label: '想起来了', mode: 'cloze', delta: +0.08 },
  cloze_fuzzy: { key: 'cloze_fuzzy', label: '有点模糊', mode: 'cloze', delta: -0.15 },
  cloze_fail: { key: 'cloze_fail', label: '没想起来', mode: 'cloze', delta: -0.25 },
  reading_good: { key: 'reading_good', label: '读的时候认识', mode: 'reading', delta: 0 },
  reading_fail: { key: 'reading_fail', label: '还是不认识', mode: 'reading', delta: -0.2 },
};

/**
 * @typedef {Object} CardState
 * @property {number} ease
 * @property {number} interval_days
 * @property {number} reps
 * @property {number} lapses
 * @property {number} verified
 */

/**
 * 计算下一次复习状态。纯函数，便于单测与回放。
 *
 * @param {CardState} card
 * @param {keyof typeof GRADES} gradeKey
 * @param {Date} now
 * @returns {{ease:number, interval_days:number, reps:number, lapses:number, verified:number, due:Date}}
 */
export function schedule(card, gradeKey, now = new Date()) {
  const grade = GRADES[gradeKey];
  if (!grade) throw new Error(`未知评分：${gradeKey}`);

  let ease = card.ease ?? 2.5;
  let interval = card.interval_days ?? 0;
  let reps = card.reps ?? 0;
  let lapses = card.lapses ?? 0;
  let verified = card.verified ?? 0;

  ease = clamp(ease + grade.delta, MIN_EASE, MAX_EASE);

  switch (gradeKey) {
    case 'cloze_good': {
      // 真正的主动回忆成功：间隔可以放心增长
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 3;
      else interval = interval * ease;
      interval = Math.min(interval, MAX_INTERVAL_DAYS);
      verified = 1;
      reps += 1;
      break;
    }
    case 'cloze_fuzzy': {
      // 回忆出来了但不牢，增长要保守
      interval = reps === 0 ? 1 : Math.max(1, interval * 1.3);
      interval = Math.min(interval, MAX_INTERVAL_DAYS);
      verified = 1;
      reps += 1;
      break;
    }
    case 'cloze_fail': {
      interval = LAPSE_INTERVAL;
      lapses += 1;
      reps = 0;
      verified = 0;
      break;
    }
    case 'reading_good': {
      // 关键：阅读中认出来 ≠ 能主动回忆出来。
      // 间隔封顶，且 verified 保持 0，让它必须再走一次填空才算真记住。
      interval = Math.max(1, Math.min(READING_INTERVAL_CAP, (interval || 1) * 1.4));
      verified = 0;
      reps += 1;
      break;
    }
    case 'reading_fail': {
      interval = LAPSE_INTERVAL;
      lapses += 1;
      reps = 0;
      verified = 0;
      break;
    }
    default:
      break;
  }

  const due = new Date(now.getTime() + interval * 86400000);
  return { ease, interval_days: interval, reps, lapses, verified, due };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 判断一张卡现在是否到期。
 * @param {{due_at:string|null}} row
 * @param {Date} now
 */
export function isDue(row, now = new Date()) {
  if (!row.due_at) return true;
  return new Date(row.due_at).getTime() <= now.getTime();
}

/**
 * 一张卡当前属于哪个学习阶段（用于界面提示）。
 * @param {CardState & {due_at?:string|null}} card
 */
export function stageOf(card) {
  if (!card || card.reps === 0) return 'new';
  if (!card.verified) return 'reading'; // 只在阅读里认出来过，尚未验证
  if (card.interval_days >= 21) return 'mature';
  return 'learning';
}

export const STAGES = {
  new: { key: 'new', name: '新词', desc: '还没复习过' },
  reading: { key: 'reading', name: '待验证', desc: '只在阅读中认出过，需要填空确认' },
  learning: { key: 'learning', name: '学习中', desc: '填空验证过，还在巩固' },
  mature: { key: 'mature', name: '已掌握', desc: '间隔已超过三周' },
};

export { MAX_INTERVAL_DAYS, READING_INTERVAL_CAP, LAPSE_INTERVAL };
