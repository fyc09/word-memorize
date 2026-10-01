/**
 * 极简流式 CSV 解析器。
 * ECDICT 的 translation / definition 字段内含引号、逗号与转义换行，
 * 不能用 split(',') 或按行切分处理，必须走状态机。
 */

/**
 * 从字符串中逐行产出 CSV 记录（已处理引号包裹与 "" 转义）。
 * @param {string} text
 * @returns {Generator<string[]>}
 */
export function* parseCsv(text) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      yield row;
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/**
 * 把 CSV 文本解析为对象数组。
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsvToObjects(text) {
  const out = [];
  let header = null;
  for (const row of parseCsv(text)) {
    if (header === null) {
      header = row;
      continue;
    }
    if (row.length === 1 && row[0] === '') continue;
    /** @type {Record<string, string>} */
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = row[i] ?? '';
    out.push(obj);
  }
  return out;
}
