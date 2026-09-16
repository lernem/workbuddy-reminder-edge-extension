// content.js —— 运行在 ISOLATED world。
// 负责：①接收 inject.js 捕获的接口数据（多响应累积）；②从所有响应中挑选解析出
// 「带到期时间的积分/套餐」最多的那份进行渲染；③在页面右侧注入固定侧边栏，
// 显示「已用/总量」与到期时间并高亮提醒；④提供兜底解析与调试能力。
(function () {
  'use strict';

  var MSG = 'WB_POINTS';
  var READY = 'WB_POINTS_READY';
  var BRIDGE_ID = '__wbPointsBridge';
  var STORE_KEY = '__wbPointsCapture';

  var EXPIRY_KEYS = [
    'CycleEndTime', 'ExpiredTime',
    'expireAt', 'expireAtRaw', 'expiresOn', 'expiresAt',
    'DeductionEndTime', 'expireAtText', 'endTime',
    'validUntil', 'validityEnd', 'expireDate', 'expiryTime'
  ];
  // 名称候选（广度优先，覆盖中英文常见命名）
  var NAME_KEYS = [
    'PackageName', 'ProductName', 'SubProductName', 'name', 'title', 'planName', 'planTitle',
    'packageName', 'packageCode', 'commodityName', 'productName', 'resourceName', 'itemName',
    'goodsName', 'skuName', 'displayName', 'tier', 'type', 'planTier', 'label', 'plan',
    'alias', 'desc', 'description', 'remark', '备注', '名称', '套餐名称', '资源名', '商品名'
  ];
  // 总量候选（月度周期额度优先于终身额度）
  var TOTAL_KEYS = [
    'CycleCapacitySize', 'CapacitySize',
    'total', 'totalQuota', 'totalCredits', 'quota', 'amount', 'creditTotal',
    'allCount', 'totalCount', 'grantTotal', 'faceValue', 'initQuota', '额度', '总量', '总数'
  ];
  // 已用候选（月度周期已用优先于终身已用）
  var USED_KEYS = [
    'CycleCapacityUsed', 'CapacityUsed',
    'used', 'usedQuota', 'usedCredits', 'consume', 'consumeQuota', 'consumed',
    'cost', 'spent', 'deduct', 'deducted', 'usedCount', '已用', '已消耗', '消耗'
  ];

  // 页面分组规则（依据真实接口 + 页面「平台奖励积分」区块反推）：
  //  - 订阅计划：套餐基础积分(TCACA_code_026) + 版本赠送包(SubProductCode 含 subscribe_bonus，TCACA_code_028)
  //  - 平台奖励积分：其余免费包，但排除「体验版」基础包（页面不计入奖励）
  var SUBSCRIPTION_BASE_CODE = 'TCACA_code_026_BaESVICNoi';
  var EXPERIENCE_CODE = 'TCACA_code_008_cfWoLwvjU4';
  function classifyPackage(pkg) {
    var code = pkg.PackageCode || '';
    var name = pkg.PackageName || '';
    var sub = pkg.SubProductCode || '';
    if (code === SUBSCRIPTION_BASE_CODE || /subscribe_bonus/.test(sub)) {
      return { group: 'sub', subType: code === SUBSCRIPTION_BASE_CODE ? 'base' : 'gift' };
    }
    if (/体验版/.test(name) || code === EXPERIENCE_CODE) {
      return { group: 'base', exclude: true };
    }
    return { group: 'reward' };
  }

  var usedStructured = false;     // 是否已用结构化数据成功渲染
  var capturedList = [];          // 累积所有捕获的接口 payload（去重后）
  var domTicks = 0;

  console.log('[WB Points] content.js 已加载');

  // ---------- 日期解析 ----------
  function toDate(v) {
    if (v == null) return null;
    if (typeof v === 'number') {
      var ms = v > 1e12 ? v : (v * 1000);
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    var s = String(v).trim();
    var m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:\s*[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3],
        m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    }
    var d2 = new Date(s);
    return isNaN(d2.getTime()) ? null : d2;
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v != null && !isNaN(Number(v))) return Number(v);
    }
    return null;
  }
  function pickName(obj) {
    for (var i = 0; i < NAME_KEYS.length; i++) {
      var v = obj[NAME_KEYS[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  }

  // 取顶层原始字段快照（仅基础类型），用于调试时反推真实字段名
  function snapshotFields(obj) {
    var snap = {};
    var cnt = 0;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      var t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        snap[k] = v;
        if (++cnt >= 40) break;
      }
    }
    return snap;
  }

  // ---------- 递归提取带到期时间的条目 ----------
  function extractItems(obj, path, out, sourceUrl) {
    if (obj == null || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) extractItems(obj[i], path + '[' + i + ']', out, sourceUrl);
      return out;
    }
    var exp = null;
    for (var k = 0; k < EXPIRY_KEYS.length; k++) {
      if (obj[EXPIRY_KEYS[k]] != null && String(obj[EXPIRY_KEYS[k]]).length > 0) { exp = obj[EXPIRY_KEYS[k]]; break; }
    }
    if (exp != null) {
      var date = toDate(exp);
      if (date) {
        var cls = classifyPackage(obj);
        var remain = obj.CycleCapacityRemain != null ? Number(obj.CycleCapacityRemain) : null;
        var status = obj.Status != null ? Number(obj.Status) : null;
        var expiredAt = toDate(obj.ExpiredTime);
        out.push({
          name: pickName(obj) || '(未命名套餐/资源)',
          amount: pick(obj, TOTAL_KEYS),
          used: pick(obj, USED_KEYS),
          total: pick(obj, TOTAL_KEYS),
          remain: remain,
          status: status,
          expiredAt: expiredAt,
          expireAt: date,
          raw: String(exp),
          source: path,
          sourceUrl: sourceUrl || '',
          group: cls.group,
          subType: cls.subType || '',
          exclude: !!cls.exclude,
          fields: snapshotFields(obj)
        });
      }
    }
    for (var key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      var val = obj[key];
      if (val && typeof val === 'object') extractItems(val, path + '.' + key, out, sourceUrl);
    }
    return out;
  }

  function dedupe(items) {
    var seen = {}, res = [];
    items.forEach(function (it) {
      var key = it.name + '|' + it.expireAt.getTime();
      if (seen[key]) return;
      seen[key] = true;
      res.push(it);
    });
    res.sort(function (x, y) { return x.expireAt - y.expireAt; });
    return res;
  }

  // ---------- 读取 MAIN world 留下的桥接数据（返回数组） ----------
  function readBridge() {
    var out = [];
    try {
      var el = document.getElementById(BRIDGE_ID);
      if (el && el.textContent) {
        var arr = JSON.parse(el.textContent);
        if (Array.isArray(arr)) out = out.concat(arr);
      }
    } catch (e) {}
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (s) {
        var arr2 = JSON.parse(s);
        if (Array.isArray(arr2)) out = out.concat(arr2);
      }
    } catch (e) {}
    return out;
  }

  function safeCount(p) {
    try { return extractItems(p.data, '', [], p.url).length; } catch (e) { return 0; }
  }

  function mergeCaptured(list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (p) {
      if (!p || !p.data) return;
      var idx = -1;
      for (var i = 0; i < capturedList.length; i++) {
        if (capturedList[i].url === p.url) { idx = i; break; }
      }
      if (idx >= 0) {
        // 保留解析出条目更多的版本，避免空响应覆盖真实数据
        var oldN = safeCount(capturedList[idx]);
        var newN = safeCount(p);
        if (newN >= oldN) capturedList[idx] = p;
      } else {
        capturedList.push(p);
      }
    });
  }

  // 合并所有已捕获接口中解析出的条目（免费包 + 付费包一并展示）
  function collectAllItems() {
    var all = [];
    capturedList.forEach(function (p) {
      extractItems(p.data, '', all, p.url);
    });
    return dedupe(all);
  }

  // 是否“当前可用”：活跃状态 + 未过期 + 周期额度尚有剩余
  function isAvailable(it) {
    if (it.status != null && it.status !== 0) return false;      // 非活跃（如已失效=3）
    if (it.expiredAt && it.expiredAt.getTime() < Date.now()) return false; // 整体已过期
    if (it.remain != null && it.remain <= 0) return false;       // 本周期已用尽
    return true;
  }

  function renderBest() {
    var items = collectAllItems();
    if (items.length) {
      usedStructured = true;
      console.log('[WB Points] 合并 ' + capturedList.length + ' 个接口，共解析出 ' + items.length + ' 项');
      render(items, '已合并 ' + capturedList.length + ' 个接口');
      return true;
    }
    return false;
  }

  // ---------- 页面文本解析兜底 ----------
  function tryDom() {
    if (usedStructured) return;
    domTicks++;
    var found = [];
    var dateRe = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/;
    var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walk.nextNode())) {
      var txt = node.textContent || '';
      if (dateRe.test(txt)) {
        var dm = txt.match(dateRe);
        var date = new Date(+dm[1], +dm[2] - 1, +dm[3]);
        if (isNaN(date)) continue;
        var ctx = collectContext(node);
        if (!/到期|有效期|过期|expire|valid|积分|权益|套餐|额度|剩余|quota|credit|point/i.test(ctx)) continue;
        var name = findName(node.parentElement);
        found.push({ name: name || '(未命名)', amount: null, used: null, total: null, expireAt: date, raw: txt.trim(), source: 'DOM' });
      }
    }
    if (found.length) {
      var items = dedupe(found);
      usedStructured = true;
      render(items, '页面文本解析');
    } else if (domTicks >= 5 && !usedStructured) {
      renderDebug('未能自动识别积分数据，请点击下方按钮复制调试信息');
    }
  }

  function collectContext(textNode) {
    var parts = [];
    var el = textNode.parentElement;
    for (var i = 0; i < 3 && el; i++) {
      parts.push(el.textContent || '');
      el = el.parentElement;
    }
    return parts.join(' ');
  }

  function findName(el) {
    for (var i = 0; i < 6 && el; i++) {
      var head = el.querySelector && el.querySelector('h1,h2,h3,h4,.title,.name,[class*="title"],[class*="name"],[class*="card-title"],[class*="plan"],[class*="package"]');
      if (head && head.textContent.trim()) return head.textContent.trim().slice(0, 40);
      el = el.parentElement;
    }
    return null;
  }

  // ---------- 渲染侧边栏 ----------
  function ensureStyles() {
    if (document.getElementById('wb-points-style')) return;
    if (!document.head && !document.documentElement) return;
    var css = [
      '#wb-points-sidebar{position:fixed!important;top:0!important;right:0!important;left:auto!important;bottom:auto!important;',
      'width:320px!important;height:100vh!important;z-index:2147483647!important;',
      'background:#fff!important;border-left:1px solid #e5e7eb!important;box-shadow:-4px 0 16px rgba(0,0,0,.08)!important;',
      'font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif!important;color:#1f2937!important;',
      'display:flex!important;flex-direction:column!important;overflow:hidden!important;margin:0!important;padding:0!important;}',
      '#wb-points-sidebar *{box-sizing:border-box;}',
      '#wb-points-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;',
      'background:#0b66ff;color:#fff;font-weight:600;}',
      '#wb-points-head .cnt{font-weight:400;opacity:.9;font-size:12px;margin-left:6px;}',
      '#wb-points-body{flex:1;overflow:auto;padding:8px 10px;}',
      '.wb-row{padding:8px 10px;margin-bottom:8px;border-radius:8px;border:1px solid #eef0f3;background:#fafbfc;}',
      '.wb-row .nm{font-weight:600;color:#111827;word-break:break-all;}',
      '.wb-row .amt{color:#2563eb;font-size:12px;margin-top:2px;}',
      '.wb-row .dt{margin-top:3px;font-size:12px;color:#374151;}',
      '.wb-row .left{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;}',
      '.wb-crit{background:#fee2e2;color:#b91c1c;}',
      '.wb-warn{background:#ffedd5;color:#c2410c;}',
      '.wb-ok{background:#dcfce7;color:#15803d;}',
      '.wb-exp{background:#f3f4f6;color:#6b7280;}',
      '.wb-group-h{padding:12px 10px 4px;font-weight:600;color:#111827;font-size:13px;}',
      '.wb-group-h .wb-group-cnt{font-weight:400;font-size:11px;color:#6b7280;margin-left:4px;}',
      '.wb-expired-wrap{margin:4px 10px 10px;border:1px dashed #e5e7eb;border-radius:8px;padding:4px 8px;}',
      '.wb-expired-sum{cursor:pointer;color:#9ca3af;font-size:12px;outline:none;}',
      '.wb-row-x{opacity:.6;}',
      '#wb-points-foot{padding:8px 10px;border-top:1px solid #eef0f3;font-size:11px;color:#6b7280;}',
      '#wb-points-foot button{margin-top:6px;width:100%;padding:6px;border:1px solid #d1d5db;border-radius:6px;',
      'background:#fff;cursor:pointer;color:#374151;}',
      '#wb-points-foot button:hover{background:#f3f4f6;}',
      '#wb-points-close{cursor:pointer;background:transparent;border:0;color:#fff;font-size:16px;line-height:1;}',
      '#wb-points-toggle{position:fixed!important;top:50%!important;right:0!important;left:auto!important;bottom:auto!important;',
      'transform:translateY(-50%)!important;z-index:2147483647!important;background:#0b66ff!important;color:#fff!important;',
      'border:0!important;border-radius:8px 0 0 8px!important;padding:10px 6px!important;cursor:pointer!important;',
      'writing-mode:vertical-rl!important;font-size:12px!important;letter-spacing:2px!important;',
      'box-shadow:-2px 0 8px rgba(0,0,0,.12)!important;margin:0!important;}',
      '.wb-debug{color:#b45309;white-space:pre-wrap;font-family:monospace;font-size:11px;}',
      '#wb-points-refresh{position:absolute;right:28px;top:8px;background:transparent;border:0;color:#fff;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px;}',
      '#wb-points-refresh:hover{background:rgba(255,255,255,.2);}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'wb-points-style';
    st.textContent = css;
    if (document.head) document.head.appendChild(st);
    else if (document.documentElement) document.documentElement.appendChild(st);
  }

  function render(items, source) {
    ensureStyles();
    removeExisting();
    var sb = document.createElement('div');
    sb.id = 'wb-points-sidebar';

    var head = document.createElement('div');
    head.id = 'wb-points-head';
    head.style.position = 'relative';
    var title = document.createElement('div');
    title.innerHTML = '积分到期提醒';
    var refresh = document.createElement('button');
    refresh.id = 'wb-points-refresh';
    refresh.textContent = '刷新';
    refresh.title = '重新解析所有已捕获接口';
    refresh.onclick = function () { rerun(); };
    var close = document.createElement('button');
    close.id = 'wb-points-close';
    close.textContent = '×';
    close.title = '关闭侧边栏';
    close.onclick = function () { sb.remove(); var t = document.getElementById('wb-points-toggle'); if (t) t.style.display = 'block'; };
    head.appendChild(title); head.appendChild(refresh); head.appendChild(close);
    sb.appendChild(head);

    var body = document.createElement('div');
    body.id = 'wb-points-body';
    var now = new Date();

    // 按页面分组：订阅计划 / 平台奖励积分（排除体验版基础包）
    var subItems = [];
    var rewardItems = [];
    items.forEach(function (it) {
      if (it.exclude) return;                       // 体验版等基础包不计入
      if (it.group === 'sub') subItems.push(it);
      else rewardItems.push(it);                    // 其余均为平台奖励积分
    });

    // ---- 订阅计划（高级版）----
    if (subItems.length) {
      subItems.sort(function (a, b) {
        if (a.subType === b.subType) return a.expireAt - b.expireAt;
        return a.subType === 'base' ? -1 : 1;
      });
      var gh = document.createElement('div');
      gh.className = 'wb-group-h';
      gh.innerHTML = '订阅计划（高级版） <span class="wb-group-cnt">套餐到期：' + fmtDate(subItems[0].expireAt) + '</span>';
      body.appendChild(gh);
      subItems.forEach(function (it) {
        var saved = it.name;
        it.name = it.subType === 'gift' ? '套餐赠送积分' : '套餐基础积分';
        body.appendChild(buildRow(it, now, false));
        it.name = saved;
      });
    }

    // ---- 平台奖励积分 ----
    if (rewardItems.length) {
      var rAvail = rewardItems.filter(isAvailable);
      var rExpired = rewardItems.filter(function (it) { return !isAvailable(it); });
      var rRemain = rewardItems.reduce(function (s, it) { return s + (it.remain != null ? it.remain : 0); }, 0);
      var gh2 = document.createElement('div');
      gh2.className = 'wb-group-h';
      gh2.innerHTML = '平台奖励积分 <span class="wb-group-cnt">可用 ' + rewardItems.length +
        ' 个 · 剩余 ' + fmtNum(rRemain) + ' 积分</span>';
      body.appendChild(gh2);
      rAvail.sort(function (a, b) { return a.expireAt - b.expireAt; });
      rAvail.forEach(function (it) { body.appendChild(buildRow(it, now, false)); });
      if (rExpired.length) {
        var ed = document.createElement('details');
        ed.className = 'wb-expired-wrap';
        var sum = document.createElement('summary');
        sum.className = 'wb-expired-sum';
        sum.textContent = '已失效 / 已用尽（' + rExpired.length + '）';
        ed.appendChild(sum);
        rExpired.forEach(function (it) { ed.appendChild(buildRow(it, now, true)); });
        body.appendChild(ed);
      }
    }

    if (!subItems.length && !rewardItems.length) {
      var empty = document.createElement('div');
      empty.className = 'wb-row wb-debug';
      empty.textContent = '未识别到可用的积分套餐（全部已过期或已用尽）。';
      body.appendChild(empty);
    }

    sb.appendChild(body);

    var foot = document.createElement('div');
    foot.id = 'wb-points-foot';
    foot.innerHTML = '数据来源：' + escapeHtml(source || '') + '（自动捕获页面接口）';
    var btn = document.createElement('button');
    btn.textContent = '复制全部原始接口数据（供调试）';
    btn.onclick = function () { copyRaw(); };
    foot.appendChild(btn);
    sb.appendChild(foot);

    document.body.appendChild(sb);
    var t = document.getElementById('wb-points-toggle');
    if (t) t.style.display = 'none';
  }

  // 构造单行（可用 / 已失效）
  function buildRow(it, now, expired) {
    var days = Math.ceil((it.expireAt - now) / 86400000);
    var row = document.createElement('div');
    row.className = 'wb-row' + (expired ? ' wb-row-x' : '');
    var cls = (expired || days < 0) ? 'wb-exp' : (days < 7 ? 'wb-crit' : (days < 30 ? 'wb-warn' : 'wb-ok'));
    var leftTxt = days < 0 ? '已过期' : ('剩余 ' + days + ' 天');
    if (expired) {
      if (it.status != null && it.status !== 0) leftTxt = '已失效';
      else if (it.remain != null && it.remain <= 0) leftTxt = '已用尽';
      else if (it.expiredAt) leftTxt = '已过期';
    }
    var html = '<div class="nm">' + escapeHtml(it.name) + '</div>';
    if (it.used != null && it.total != null) {
      var left = it.total - it.used;
      html += '<div class="amt">已用 ' + fmtNum(it.used) + ' / 总量 ' + fmtNum(it.total) +
        (left >= 0 ? '（剩 ' + fmtNum(left) + '）' : '') + '</div>';
    } else if (it.amount != null) {
      html += '<div class="amt">积分：' + fmtNum(it.amount) + '</div>';
    }
    html += '<div class="dt">到期：' + fmtDate(it.expireAt) + '</div>';
    html += '<span class="left ' + cls + '">' + leftTxt + '</span>';
    row.innerHTML = html;
    return row;
  }

  function renderDebug(msg) {
    ensureStyles();
    removeExisting();
    var sb = document.createElement('div');
    sb.id = 'wb-points-sidebar';
    sb.innerHTML = '<div id="wb-points-head"><div>积分到期提醒<span class="cnt">未识别</span></div>' +
      '<button id="wb-points-close" style="cursor:pointer;background:transparent;border:0;color:#fff;font-size:16px;">×</button></div>' +
      '<div id="wb-points-body"><div class="wb-row wb-debug">' + escapeHtml(msg || '已捕获接口数据，但均未解析出带到期时间的条目。可能是接口字段变化，请点击下方按钮复制原始接口数据，粘贴给开发者以便适配。') + '</div></div>' +
      '<div id="wb-points-foot">数据来源：自动识别失败' +
      '<button id="wb-debug-copy">复制全部原始接口数据（供调试）</button></div>';
    document.body.appendChild(sb);
    var c = sb.querySelector('#wb-points-close');
    if (c) c.onclick = function () { sb.remove(); };
    var b = sb.querySelector('#wb-debug-copy');
    if (b) b.onclick = copyRaw;
  }

  // 在响应里定位“包数组”（兼容 data / data.data 两种结构）
  function findPackageArray(obj) {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj.data)) return obj.data;
      if (obj.data && Array.isArray(obj.data.data)) return obj.data.data;
      for (var k in obj) {
        if (obj[k] && typeof obj[k] === 'object' && Array.isArray(obj[k].data)) return obj[k].data;
      }
    }
    return null;
  }

  // 尽力抓取页面上“平台奖励积分”区块的可见文本（作为页面真实口径的基准）
  function grabPageSection(keyword) {
    try {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length === 0 && el.textContent && el.textContent.indexOf(keyword) >= 0) {
          var box = el.parentElement;
          for (var j = 0; j < 6 && box; j++) {
            if (box.textContent && box.textContent.indexOf(keyword) >= 0 && box.textContent.length < 5000) box = box.parentElement;
            else break;
          }
          return box ? box.innerText : (el.parentElement ? el.parentElement.innerText : null);
        }
      }
    } catch (e) {}
    return null;
  }

  function copyRaw() {
    var text;
    if (capturedList.length) {
      var out = capturedList.map(function (p) {
        var entry = { url: p.url, hasExpiry: !!p.hasExpiry };
        if (/free-packages|paid-packages/.test(p.url)) {
          var arr = findPackageArray(p.data) || [];
          entry.packageCount = arr.length;
          entry.packages = arr.map(function (o) {
            return {
              PackageName: o.PackageName,
              CapacityType: o.CapacityType,
              FeeType: o.FeeType,
              Status: o.Status,
              PkgSourceType: o.PkgSourceType,
              CycleCapacityRemain: o.CycleCapacityRemain,
              CycleCapacityUsed: o.CycleCapacityUsed,
              CycleCapacitySize: o.CycleCapacitySize,
              SubProductCode: o.SubProductCode,
              PackageCode: o.PackageCode,
              CycleEndTime: o.CycleEndTime,
              ExpiredTime: o.ExpiredTime
            };
          });
        } else {
          entry.body = p.data;
        }
        return entry;
      });
      var sec = grabPageSection('平台奖励积分');
      if (sec) out.push({ _pageSection_平台奖励积分: sec.slice(0, 3000) });
      text = JSON.stringify(out, null, 2);
    } else {
      text = '(未捕获到任何接口数据)';
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { alert('已复制全部原始数据到剪贴板'); }, function () { alert('复制失败，请手动复制'); });
    } else {
      alert('当前环境不支持自动复制');
    }
  }

  function removeExisting() {
    var e = document.getElementById('wb-points-sidebar');
    if (e) e.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) { return n.toLocaleString('zh-CN'); }
  function fmtDate(d) {
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 消息与触发 ----------
  function handle(payload) {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', function () { handle(payload); }, { once: true });
      return;
    }
    mergeCaptured([payload]);
    console.log('[WB Points] 收到接口 ' + (payload.url || '') + '（当前共捕获 ' + capturedList.length + ' 个接口）');
    if (!usedStructured) {
      if (!renderBest()) { /* 尚未找到带到期字段的数据，等更多接口到达 */ }
    } else {
      if (collectAllItems().length) renderBest();
    }
  }

  function rerun() {
    usedStructured = false;
    if (renderBest()) return;
    window.postMessage({ __wbType: READY }, '*');
    setTimeout(function () { if (!usedStructured) tryDom(); }, 800);
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.__wbType === MSG) handle(e.data);
  });

  setTimeout(function () {
    mergeCaptured(readBridge());
    console.log('[WB Points] 桥接已缓存接口数：' + capturedList.length);
    if (!renderBest()) {
      window.postMessage({ __wbType: READY }, '*');
    }
  }, 0);

  var iv = setInterval(function () {
    if (usedStructured) { clearInterval(iv); return; }
    tryDom();
  }, 1500);
  setTimeout(function () { clearInterval(iv); }, 12000);

  function ensureToggle() {
    if (!document.body) return;
    if (document.getElementById('wb-points-toggle')) return;
    var t = document.createElement('div');
    t.id = 'wb-points-toggle';
    t.setAttribute('role', 'button');
    t.textContent = '积分到期';
    t.style.setProperty('position', 'fixed', 'important');
    t.style.setProperty('top', '50%', 'important');
    t.style.setProperty('right', '0', 'important');
    t.style.setProperty('left', 'auto', 'important');
    t.style.setProperty('bottom', 'auto', 'important');
    t.style.setProperty('transform', 'translateY(-50%)', 'important');
    t.style.setProperty('z-index', '2147483647', 'important');
    t.onclick = function () {
      if (renderBest()) return;
      window.postMessage({ __wbType: READY }, '*');
      setTimeout(function () { if (!usedStructured) tryDom(); }, 600);
      setTimeout(function () { if (!usedStructured) renderDebug(); }, 1800);
    };
    document.body.appendChild(t);
    console.log('[WB Points] 浮动按钮已注入');
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') ensureToggle();
  else window.addEventListener('DOMContentLoaded', ensureToggle);
})();
