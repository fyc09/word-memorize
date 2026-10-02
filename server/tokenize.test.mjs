import test from 'node:test';
import assert from 'node:assert/strict';
import { lemmatize } from './tokenize.mjs';

/**
 * 一个极小的假词典。
 *
 * lemmatize 只用到 lookupWord / lookupLemma 两个方法，所以不需要真的数据库 ——
 * 这个 bug 本来就是纯逻辑问题。真词典反而会让测试依赖 ECDICT 的具体内容。
 */
const WORDS = new Set([
  'overdevelop',
  'overdeveloped',
  'overdevelops',
  'campus',
  'campuses',
  'unexpected',
  'decade',
  'run',
  'child',
  'long-lasting',
  'well-known',
  'app',
  'traffick',
  'trafficking',
  'do',
]);

/** 故意带上 ECDICT 那批截断的词干。它们指向的词从未作为条目存在。 */
const LEMMAS = new Map([
  ['overdeveloped', 'overdevelope'],
  ['overdevelops', 'overdevelope'],
  ['campuses', 'campuse'],
  ['unexpected', 'unexpect'],
  ['trafficking', 'traffick'],
  ['apps', 'app'],
  // 正常的映射，用来确认没被误伤
  ['decades', 'decade'],
  ['running', 'run'],
  ['children', 'child'],
  ['long-lasting', 'long-last'],
]);

const dict = {
  lookupWord: (w) => (WORDS.has(w) ? { level: 6 } : null),
  lookupLemma: (f) => LEMMAS.get(f) ?? null,
};

test('原形查不到释义时，退回文本里的词形，而不是凭空造一个词头', () => {
  // 这是本文件存在的理由：overdevelope / campuse / unexpect 都不是词，
  // 一旦被当成词头，正文里就多出一个查不到释义、还被判成最难一档的生词。
  assert.equal(lemmatize('overdeveloped', dict), 'overdeveloped');
  assert.equal(lemmatize('overdevelops', dict), 'overdevelops');
  assert.equal(lemmatize('campuses', dict), 'campuses');
  assert.equal(lemmatize('unexpected', dict), 'unexpected');
});

test('原形确实是词时照常还原', () => {
  assert.equal(lemmatize('decades', dict), 'decade');
  assert.equal(lemmatize('running', dict), 'run');
  assert.equal(lemmatize('children', dict), 'child');
});

test('原形是字典外的词干、但变形本身是词时，也不会被拆解成残根', () => {
  // 连字符拆解会把 long-lasting 的 lasting 先还原成 last，再拼回 long-last。
  // 所以「词形自身是词」必须排在拆解之前。
  assert.equal(lemmatize('long-lasting', dict), 'long-lasting');
});

test('连字符复合词仍按组成部分还原（整词不在词典时）', () => {
  assert.equal(lemmatize('year-old', dict), 'year-old');
});

test('缩写展开后同样要求落在词典里', () => {
  assert.equal(lemmatize("don't", dict), 'do');
});

test('结果要么是词典里的词，要么就是词形自身', () => {
  const cases = [
    'overdeveloped',
    'campuses',
    'unexpected',
    'trafficking',
    'decades',
    'running',
    'long-lasting',
    'year-old',
    'well-known',
  ];
  for (const c of cases) {
    const out = lemmatize(c, dict);
    assert.ok(
      WORDS.has(out) || out === c.toLowerCase(),
      `${c} → ${out} 既不在词典里，也不是词形自身`,
    );
  }
});
