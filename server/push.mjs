/**
 * Web Push（VAPID + RFC 8291）的最小实现。
 *
 * 不用 web-push 之类的库：整个项目运行时只依赖 cheerio，
 * 而这里需要的全部能力 node:crypto 都有 ——
 *   VAPID      = ES256 签的 JWT（把 ECDSA 的 DER 签名换成裸 r||s）
 *   加密       = ECDH(P-256) → HKDF-SHA256 → AES-128-GCM
 *   报文格式   = aes128gcm 单条记录：salt | rs | idlen | as_public | ciphertext
 *
 * 协议参考 RFC 8291（消息加密）与 RFC 8292（VAPID）。
 * 浏览器侧见 public/sw.js。
 */

import crypto from 'node:crypto';

/** base64url，去掉 padding。 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** base64url → Buffer（浏览器给的值没有 padding）。 */
const unb64u = (str) => Buffer.from(str, 'base64url');

/**
 * VAPID 密钥对存在 settings 里，首次用到时生成。
 *
 * 公钥给浏览器 subscribe 用；私钥只在服务端签 JWT。
 * 换密钥会让所有旧的订阅失效 —— 所以生成一次就存下来。
 */
export function ensureVapid(getSetting, setSetting) {
  const existing = getSetting('vapidPrivate', '') && getSetting('vapidPublic', '');
  if (existing) {
    return {
      privateKey: getSetting('vapidPrivate', ''),
      publicKey: getSetting('vapidPublic', ''),
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  // SPKI 的末尾 65 字节就是未压缩点 0x04||X||Y，浏览器要的正是这个
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });

  setSetting('vapidPrivate', privDer.toString('base64'));
  setSetting('vapidPublic', b64u(pubRaw));
  return { privateKey: privDer.toString('base64'), publicKey: b64u(pubRaw) };
}

/**
 * VAPID 的 Authorization 头。
 *
 * JWT 的 aud 必须是推送服务的源（从 endpoint 里取），不是我们自己的地址 ——
 * 写错会被 401，且提示很含糊。
 *
 * sub 必须是**带真实 TLD 的 mailto:** 或 https URL。Apple 的推送服务
 * （web.push.apple.com）会因此直接报 403 BadJwtToken，而它的错误列表里
 * 只说了「isn't a URL or mailto:」—— `mailto:noreply@localhost` 形式上
 * 合格、但 localhost 没有 TLD，照样被拒。所以默认值用 example.com。
 *
 * 结果按 aud 缓存 ~50 分钟：Apple 明确要求「不要比每小时更频繁地刷新 JWT」。
 */
const jwtCache = new Map();

function vapidHeader(endpoint, vapid, subject) {
  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    // 订阅里的 endpoint 是浏览器给的，不能假定它一定合法
    return null;
  }

  const cacheKey = `${origin}|${vapid.publicKey}|${subject}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.header;

  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(
    JSON.stringify({
      aud: origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 上限 24h
      sub: subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const key = crypto.createPrivateKey({
    key: Buffer.from(vapid.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  // ieee-p1363 = 裸 r||s，JWT 要的就是这个；默认的 DER 浏览器不认
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  const value = `vapid t=${signingInput}.${b64u(sig)}, k=${vapid.publicKey}`;
  // exp 是 12h 后，这里保守一点提前一小时重签
  jwtCache.set(cacheKey, { header: value, until: Date.now() + 11 * 3600 * 1000 });
  return value;
}

/** 默认的联系地址。Apple 会校验 TLD，所以不能用 localhost。 */
export const DEFAULT_SUBJECT = 'mailto:noreply@example.com';

/** HKDF-SHA256，返回指定长度。 */
function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

/**
 * 把明文加密成 aes128gcm 的单条记录。
 *
 * 结构：salt(16) | rs(4, 大端) | idlen(1) | as_public(65) | ciphertext
 * 明文末尾要补一个 0x02 作为「最后一条记录」的填充分隔符。
 */
function encryptPayload(payloadBuf, p256dh, authSecret) {
  const uaPublic = unb64u(p256dh); // 65 字节，0x04||X||Y
  const auth = unb64u(authSecret);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 也是 65 字节未压缩点

  const shared = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3–3.4 的两级 HKDF
  const prkInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(auth, shared, prkInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const plaintext = Buffer.concat([payloadBuf, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/**
 * 发一条推送。
 *
 * 返回 { ok, status, gone }：
 *   gone = 404/410 表示订阅已失效，调用方应当把它从库里删掉。
 */
export async function sendPush(sub, payload, vapid, subject) {
  const authorization = vapidHeader(sub.endpoint, vapid, subject);
  if (!authorization) return { ok: false, status: 0, gone: false, error: 'endpoint 不是合法 URL' };

  let body;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub.p256dh, sub.auth);
  } catch (e) {
    /*
     * 存的 p256dh / auth 不是合法的 P-256 点（浏览器换过密钥、数据被改过）。
     * 这条订阅已经没救，标成 gone 让调用方删掉 —— 不抛异常是因为
     * 一条坏订阅不能把整批发送中断。
     */
    return { ok: false, status: 0, gone: true, error: `订阅密钥无效：${e.message}` };
  }

  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // 通知的时效交给 TTL，不必再给 Urgency
        TTL: '3600',
      },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e.message };
  }

  const gone = res.status === 404 || res.status === 410;
  let detail = '';
  if (!res.ok) {
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      detail = '';
    }
  }

  return { ok: res.ok, status: res.status, gone, error: res.ok ? null : detail };
}

/** 给所有订阅发；顺手清掉已失效的。 */
export async function sendToAll(subs, payload, vapid, subject, dropSub) {
  const results = [];
  for (const sub of subs) {
    const r = await sendPush(sub, payload, vapid, subject);
    results.push({ endpoint: sub.endpoint, ...r });
    if (r.gone) dropSub(sub.endpoint);
  }
  return results;
}
