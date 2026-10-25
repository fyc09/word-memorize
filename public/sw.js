/*
 * Service Worker：只负责接收推送并弹出通知，不做离线缓存。
 *
 * 不放缓存是有意的 —— 这是个随时在变的本地应用，
 * 缓存一份旧的 dist 只会让「改了代码但页面没变」这种问题更难查。
 *
 * 注册见 src/main.tsx；服务端发送见 server/push.mjs。
 */

self.addEventListener('push', (event) => {
  // 服务端发的就是我们自己的 JSON；解析失败也要弹一条，
  // 否则用户在系统层面看不到任何反应，更难判断是哪儿断了。
  let data = { title: '语境背单词', body: '该复习了', url: '/review', tag: 'remind' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* 用默认文案 */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // tag 相同会覆盖上一条，避免堆一串同样的提醒
      tag: data.tag,
      renotify: false,
      data: { url: data.url },
    }),
  );
});

/** 取 URL 的 pathname；解析不了就返回 null，不让一次点击整个失败。 */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // 已经开着这个页面就聚焦过去，别再开一个新标签
      for (const client of list) {
        if (pathOf(client.url) === target) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
