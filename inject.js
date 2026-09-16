// inject.js —— 运行在页面 MAIN world，尽早劫持 fetch / XMLHttpRequest，
// 捕获「包含到期时间」或「来自套餐/资源类接口」的响应，转发给 ISOLATED world 的 content.js。
// 同时把捕获结果写入共享 DOM 节点 + localStorage，防止 content.js 加载晚于请求。
(function () {
  'use strict';
  var MSG = 'WB_POINTS';
  var READY = 'WB_POINTS_READY';
  var BRIDGE_ID = '__wbPointsBridge';
  var STORE_KEY = '__wbPointsCapture';

  // 强到期信号：只认真正的到期/有效期字段或中文「到期/有效期/过期」
  var EXPIRE_RE = /expireAt|expireAtRaw|ExpiredTime|CycleEndTime|DeductionEndTime|expiresOn|expiryTime|expireDate|validUntil|validityEnd|到期|有效期|过期/i;
  // 套餐 / 资源 / 余额类接口的 URL 特征（用于在没有到期字段时也尽量捕获目标接口）
  var BALANCE_URL_RE = /plan|resource|quota|subscription|package|commodity|get-user-resource|getCurrentPlan|fetchInUsageResource|userResource|billing\/meter/i;

  function installBridge() {
    if (document.getElementById(BRIDGE_ID)) return;
    var bridge = document.createElement('div');
    bridge.id = BRIDGE_ID;
    bridge.style.display = 'none';
    bridge.setAttribute('aria-hidden', 'true');
    if (document.head) document.head.appendChild(bridge);
    else if (document.documentElement) document.documentElement.appendChild(bridge);
  }
  installBridge();

  function saveQueue(queue) {
    try {
      var json = JSON.stringify(queue);
      var bridge = document.getElementById(BRIDGE_ID);
      if (bridge) bridge.textContent = json;
      try { localStorage.setItem(STORE_KEY, json); } catch (e) {}
    } catch (e) {}
  }

  function emit(url, data) {
    try {
      var serialized;
      try { serialized = JSON.stringify(data); } catch (e) { serialized = ''; }
      var hasExpiry = EXPIRE_RE.test(serialized);
      var payload = { __wbType: MSG, url: url || '(unknown)', data: data, hasExpiry: hasExpiry };
      window.postMessage(payload, '*');
      var queue = window.__wbPointsQueue || (window.__wbPointsQueue = []);
      // 同 url 只保留最近一份，避免队列无限增长
      for (var i = queue.length - 1; i >= 0; i--) {
        if (queue[i].url === payload.url) { queue.splice(i, 1); break; }
      }
      queue.push(payload);
      if (queue.length > 12) queue.shift();
      saveQueue(queue);
    } catch (e) { /* ignore */ }
  }

  function shouldCapture(url, serialized) {
    if (!serialized || serialized.length > 2000000) return false; // 跳过超大/非 JSON
    if (BALANCE_URL_RE.test(url || '')) return true;
    if (EXPIRE_RE.test(serialized)) return true;
    return false;
  }

  function tryCapture(url, text) {
    try {
      var obj = JSON.parse(text);
      if (shouldCapture(url, text)) emit(url || '(unknown)', obj);
    } catch (e) { /* not json */ }
  }

  // 响应 content.js 的 ready ping：把已缓存的响应重新 post 出去
  window.addEventListener('message', function (e) {
    if (e.data && e.data.__wbType === READY) {
      var queue = window.__wbPointsQueue || [];
      queue.forEach(function (p) { window.postMessage(p, '*'); });
    }
  });

  // ---- 劫持 fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input
        : (input && (input.url || input.uri)) || '';
      return origFetch.apply(this, arguments).then(
        function (resp) {
          try {
            var ct = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : '';
            if ((ct && /json/i.test(ct)) || /plan|resource|quota|meter|usage|billing|credit|point/i.test(url)) {
              resp.clone().text().then(function (t) { tryCapture(url, t); }).catch(function () {});
            }
          } catch (e) { /* ignore */ }
          return resp;
        },
        function (err) { return Promise.reject(err); }
      );
    };
  }

  // ---- 劫持 XMLHttpRequest ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  if (origOpen && origSend) {
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__wbUrl = (typeof u === 'string') ? u : '';
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener('load', function () {
        try {
          var ct = self.getResponseHeader ? self.getResponseHeader('content-type') : '';
          if ((ct && /json/i.test(ct)) || /plan|resource|quota|meter|usage|billing|credit|point/i.test(self.__wbUrl || '')) {
            tryCapture(self.__wbUrl, self.responseText);
          }
        } catch (e) { /* ignore */ }
      });
      return origSend.apply(this, arguments);
    };
  }
})();
