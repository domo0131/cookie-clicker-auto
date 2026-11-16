// ==UserScript==
// @name         くらふとRPG オート（そうげん連打）
// @namespace    muse.kurafuto-rpg
// @version      1.0.7
// @description  unityroom「くらふとRPG」の「こうげき」ボタンを自動連打します。座標は実タップで登録。開始・停止は手動です。
// @match        https://80866.play.unityroom.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var SCRIPT_VERSION = '1.0.7';

  // ---------- 設定（GM に保存） ----------
  function load(key, def) {
    try {
      var v = GM_getValue(key, def);
      return (v === undefined || v === null) ? def : v;
    } catch (e) { return def; }
  }
  function save(key, val) { try { GM_setValue(key, val); } catch (e) {} }

  // ---------- 行動ログ（GM に最新200件を保持） ----------
  var LOG_KEY = 'kr_log';
  function logEvent(msg) {
    try {
      var arr = GM_getValue(LOG_KEY, []);
      if (!Array.isArray(arr)) arr = [];
      arr.push({ t: Date.now(), m: String(msg) });
      while (arr.length > 200) arr.shift();
      GM_setValue(LOG_KEY, arr);
    } catch (e) {}
  }

  var cfg = {
    method: load('kr_method', 'mouse'),     // mouse / mouseMove / pointer / click / touch
    intervalMs: load('kr_intervalMs', 200), // クリック間隔(ms)
    pressMs: load('kr_pressMs', 30),        // 押下→解放の間隔(ms)。60fps の約2フレーム分
    fleeEvery: load('kr_fleeEvery', 0),     // 0=逃走しない / N=攻撃N回ごとに1回逃走
    limitMin: load('kr_limitMin', 5),       // 0=無制限
    atk: load('kr_atk', null),              // {u, v} canvas 内の相対座標
    flee: load('kr_flee', null)             // {u, v}
  };

  // v1.0.3 初回のみ: ユーザー指示「タップを早くして」を受け、間隔を 100ms に設定する
  if (!load('kr_fast103', false)) {
    cfg.intervalMs = 100;
    save('kr_intervalMs', 100);
    save('kr_fast103', true);
  }

  // v1.0.4 初回のみ: ユーザー指示「もっと短く」を受け、間隔を 20ms に設定する
  // （押下 30ms + 間隔 20ms = 1タップ 50ms、毎秒約20回）
  if (!load('kr_fast104', false)) {
    cfg.intervalMs = 20;
    save('kr_intervalMs', 20);
    save('kr_fast104', true);
  }

  var METHOD_LABEL = {
    mouse: 'A: マウス',
    mouseMove: 'B: マウス(移動つき)',
    pointer: 'C: ポインター',
    click: 'D: クリックのみ',
    touch: 'E: タッチ'
  };

  // ---------- 状態 ----------
  var canvas = null;
  var running = false;
  var timer = null;
  var elapsedTimer = null;
  var startedAt = 0;
  var attackCount = 0;
  var fleeCount = 0;
  var sinceFlee = 0;
  var warmupLeft = 0;
  var touchSeq = 0;
  var lastHb = 0;
  var stopReason = '';
  var calibTarget = null; // 'atk' | 'flee' | null
  var overlay = null;
  var panel = null, statusEl = null, startBtn = null, stopBtn = null;
  var markerAtk = null, markerFlee = null;

  // ---------- canvas 検出 ----------
  function findCanvas() {
    var list = document.querySelectorAll('canvas');
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var area = c.clientWidth * c.clientHeight;
      if (area > bestArea && c.clientWidth >= 200) { best = c; bestArea = area; }
    }
    return best;
  }

  // ---------- 入力送信 ----------
  function makeMouse(type, x, y, buttons) {
    return new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: Math.round(x), clientY: Math.round(y),
      button: 0, buttons: buttons
    });
  }

  function isBlockingTarget(t) {
    if (!t || t === canvas) return false;
    // canvas の祖先（透明なラッパー等）はブロック扱いしない
    var n = canvas;
    while (n) { if (n === t) return false; n = n.parentElement; }
    return true;
  }

  // 1回分の押下→解放を送る。done(ok) は解放後に呼ばれる。
  function dispatchPress(pos, done) {
    var r = canvas.getBoundingClientRect();
    var x = r.left + pos.u * r.width;
    var y = r.top + pos.v * r.height;
    var target = document.elementFromPoint(x, y);
    if (isBlockingTarget(target)) {
      fail('ボタンの上に別の要素があります（画面変化の可能性）');
      if (done) done(false);
      return;
    }
    var m = cfg.method;
    try {
      if (m === 'click') {
        canvas.dispatchEvent(makeMouse('click', x, y, 0));
        if (done) done(true);
        return;
      }
      if (m === 'pointer') {
        canvas.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y, button: 0, buttons: 1,
          pointerId: 1, isPrimary: true, pointerType: 'mouse'
        }));
        setTimeout(function () {
          canvas.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, cancelable: true,
            clientX: x, clientY: y, button: 0, buttons: 0,
            pointerId: 1, isPrimary: true, pointerType: 'mouse'
          }));
          if (done) done(true);
        }, cfg.pressMs);
        return;
      }
      if (m === 'touch') {
        touchSeq++;
        var touchId = touchSeq;
        var t1 = new Touch({ identifier: touchId, target: canvas, clientX: x, clientY: y });
        canvas.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true,
          touches: [t1], targetTouches: [t1], changedTouches: [t1]
        }));
        setTimeout(function () {
          var t2 = new Touch({ identifier: touchId, target: canvas, clientX: x, clientY: y });
          canvas.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true,
            touches: [], targetTouches: [], changedTouches: [t2]
          }));
          if (done) done(true);
        }, cfg.pressMs);
        return;
      }
      // mouse / mouseMove
      if (m === 'mouseMove') canvas.dispatchEvent(makeMouse('mousemove', x, y, 0));
      canvas.dispatchEvent(makeMouse('mousedown', x, y, 1));
      setTimeout(function () {
        canvas.dispatchEvent(makeMouse('mouseup', x, y, 0));
        if (done) done(true);
      }, cfg.pressMs);
    } catch (e) {
      fail('入力送信でエラー: ' + e.message);
      if (done) done(false);
    }
  }

  function fail(msg) {
    if (running) stopRun(msg);
    else setStatus(msg);
  }

  // ---------- 連打ループ ----------
  function tick() {
    if (!running) return;
    try {
      if (!canvas || !document.contains(canvas)) { stopRun('canvas が見つかりません'); return; }
      if (cfg.limitMin > 0 && Date.now() - startedAt >= cfg.limitMin * 60000) { stopRun('制限時間に到達'); return; }
      if (!cfg.atk) { stopRun('こうげき座標が未設定です'); return; }
      dispatchPress(cfg.atk, function (ok) {
        if (!running || !ok) return;
        attackCount++; sinceFlee++;
        if (attackCount % 1000 === 0) logEvent('攻撃 ' + attackCount + ' 回（経過 ' + fmtTime(Date.now() - startedAt) + '）');
        updateStatus();
        if (cfg.fleeEvery > 0 && cfg.flee && sinceFlee >= cfg.fleeEvery) {
          sinceFlee = 0;
          setTimeout(function () {
            if (!running) return;
            dispatchPress(cfg.flee, function (ok2) {
              if (ok2) fleeCount++;
              updateStatus();
              if (running) timer = setTimeout(tick, 400);
            });
          }, 250);
        } else {
          timer = setTimeout(tick, effInterval());
        }
      });
    } catch (e) {
      stopRun('エラー: ' + e.message);
    }
  }

  // 開始直後はゆっくりした「準備タップ」を挟む（実機の癖への対策: 手で数回押してから
  // 開始すると安定する現象への当て推量。効かなければ将来外す）。
  function effInterval() {
    if (warmupLeft > 0) { warmupLeft--; return Math.max(cfg.intervalMs, 200); }
    return cfg.intervalMs;
  }

  function startRun() {
    if (running) return;
    if (!cfg.atk) { setStatus('先に「こうげき座標」を設定してください'); return; }
    running = true;
    stopReason = '';
    attackCount = 0; fleeCount = 0; sinceFlee = 0;
    warmupLeft = 6;
    startedAt = Date.now();
    elapsedTimer = setInterval(updateStatus, 500);
    logEvent('開始: ' + METHOD_LABEL[cfg.method] + ' 間隔' + cfg.intervalMs + 'ms 押下' + cfg.pressMs + 'ms' +
      ' 逃走' + (cfg.fleeEvery > 0 ? cfg.fleeEvery + '回ごと' : 'なし') +
      ' 制限' + (cfg.limitMin > 0 ? cfg.limitMin + '分' : 'なし'));
    updatePanel();
    updateStatus();
    tick();
  }

  function stopRun(reason) {
    var wasRunning = running;
    if (timer) { clearTimeout(timer); timer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (running && reason) stopReason = reason;
    running = false;
    save('kr_heartbeat', 0);
    if (wasRunning) {
      logEvent('停止: ' + (reason || '手動') + '（経過 ' + fmtTime(Date.now() - startedAt) +
        ' / 攻撃 ' + attackCount + ' / 逃走 ' + fleeCount + '）');
    }
    updatePanel();
    updateStatus();
  }

  // ---------- 座標登録 ----------
  function startCalib(target) {
    if (running) return;
    if (calibTarget) { endCalib(); updatePanel(); return; }
    calibTarget = target;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.25);touch-action:none;';
    overlay.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var r = canvas.getBoundingClientRect();
      var pos = { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
      if (target === 'atk') { cfg.atk = pos; save('kr_atk', pos); }
      else { cfg.flee = pos; save('kr_flee', pos); }
      endCalib();
      drawMarkers();
      updatePanel();
      logEvent((target === 'atk' ? 'こうげき' : 'にげる') + ' の座標を登録');
      setStatus((target === 'atk' ? 'こうげき' : 'にげる') + ' の座標を登録しました');
    }, { once: true });
    document.body.appendChild(overlay);
    setStatus((target === 'atk' ? 'こうげき' : 'にげる') + ' ボタンの中心をタップしてください');
    updatePanel();
  }

  function endCalib() {
    if (overlay) { overlay.remove(); overlay = null; }
    calibTarget = null;
  }

  // ---------- マーカー ----------
  function makeMarker(color) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;width:14px;height:14px;border-radius:50%;border:2px solid #fff;' +
      'background:' + color + ';z-index:2147483640;pointer-events:none;transform:translate(-50%,-50%);display:none;';
    document.body.appendChild(d);
    return d;
  }

  function drawMarkers() {
    if (!canvas) return;
    var r = canvas.getBoundingClientRect();
    placeMarker(markerAtk, cfg.atk, r);
    placeMarker(markerFlee, cfg.flee, r);
  }

  function placeMarker(el, pos, r) {
    if (!el) return;
    if (!pos) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = (r.left + pos.u * r.width) + 'px';
    el.style.top = (r.top + pos.v * r.height) + 'px';
  }

  // ---------- パネル ----------
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var ss = ('0' + (s % 60)).slice(-2);
    return m + ':' + ss;
  }

  function updateStatus() {
    if (!statusEl) return;
    if (running) {
      // ローダーが「実行中は更新を切り替えない」判断に使うハートビート
      var nowHb = Date.now();
      if (nowHb - lastHb > 2000) { lastHb = nowHb; save('kr_heartbeat', nowHb); }
      statusEl.textContent = '実行中 ' + fmtTime(Date.now() - startedAt) +
        ' / 攻撃 ' + attackCount + ' / 逃走 ' + fleeCount +
        ' / ' + METHOD_LABEL[cfg.method] + ' ' + cfg.intervalMs + 'ms' +
        (warmupLeft > 0 ? '（準備タップ中）' : '');
    } else if (stopReason) {
      statusEl.textContent = '停止: ' + stopReason + '（攻撃 ' + attackCount + ' / 逃走 ' + fleeCount + '）';
    } else if (!calibTarget) {
      statusEl.textContent = '停止中（攻撃 ' + attackCount + ' / 逃走 ' + fleeCount + '）';
    }
  }

  function updatePanel() {
    if (!panel) return;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    startBtn.style.opacity = running ? '0.5' : '1';
    stopBtn.style.opacity = running ? '1' : '0.5';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'kr-panel';
    panel.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;background:rgba(20,20,28,0.88);' +
      'color:#fff;font:13px/1.5 sans-serif;padding:8px 10px;border-radius:10px;max-width:78vw;user-select:none;-webkit-user-select:none;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
        '<b>くらふとRPG オート v' + SCRIPT_VERSION + '</b>' +
        '<button id="kr-min" style="min-width:36px;min-height:30px;">－</button>' +
      '</div>' +
      '<div id="kr-body">' +
        '<div id="kr-status" style="margin:4px 0 6px;">停止中</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
          '<button id="kr-start" style="flex:1;min-height:42px;font-size:15px;">▶ 開始</button>' +
          '<button id="kr-stop" style="flex:1;min-height:42px;font-size:15px;">■ 停止</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
          '<button id="kr-cal-atk" style="flex:1;min-height:38px;">◎ こうげき座標</button>' +
          '<button id="kr-cal-flee" style="flex:1;min-height:38px;">◎ にげる座標</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">' +
          '<button id="kr-test" style="min-height:38px;">単発テスト</button>' +
          '<select id="kr-method" style="min-height:38px;flex:1;">' +
            '<option value="mouse">A: マウス</option>' +
            '<option value="mouseMove">B: マウス(移動つき)</option>' +
            '<option value="pointer">C: ポインター</option>' +
            '<option value="click">D: クリックのみ</option>' +
            '<option value="touch">E: タッチ</option>' +
          '</select>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
          '<span>間隔 <button id="kr-int-minus" style="min-width:34px;min-height:34px;">－</button>' +
          '<input id="kr-interval" type="number" min="0" max="1000" step="5" style="width:56px;min-height:34px;">' +
          '<button id="kr-int-plus" style="min-width:34px;min-height:34px;">＋</button>ms</span>' +
          '<span>押下 <button id="kr-press-minus" style="min-width:34px;min-height:34px;">－</button>' +
          '<input id="kr-press" type="number" min="5" max="200" step="5" style="width:56px;min-height:34px;">' +
          '<button id="kr-press-plus" style="min-width:34px;min-height:34px;">＋</button>ms</span>' +
          '<label>逃走 <select id="kr-flee-every" style="min-height:34px;">' +
            '<option value="0">しない</option><option value="25">25回ごと</option>' +
            '<option value="60">60回ごと</option><option value="150">150回ごと</option></select></label>' +
          '<label>制限 <select id="kr-limit" style="min-height:34px;">' +
            '<option value="5">5分</option><option value="30">30分</option>' +
            '<option value="60">60分</option><option value="0">無制限</option></select></label>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button id="kr-log-toggle" style="flex:1;min-height:34px;">ログ表示</button>' +
          '<button id="kr-log-clear" style="min-height:34px;">ログ消去</button>' +
        '</div>' +
        '<div id="kr-log" style="display:none;margin-top:6px;max-height:180px;overflow-y:auto;background:rgba(0,0,0,0.35);border-radius:6px;padding:6px;font-size:11px;white-space:pre-wrap;word-break:break-all;"></div>' +
      '</div>';
    document.body.appendChild(panel);

    statusEl = panel.querySelector('#kr-status');
    startBtn = panel.querySelector('#kr-start');
    stopBtn = panel.querySelector('#kr-stop');

    var body = panel.querySelector('#kr-body');
    panel.querySelector('#kr-min').addEventListener('click', function () {
      body.style.display = (body.style.display === 'none') ? '' : 'none';
      this.textContent = (body.style.display === 'none') ? '＋' : '－';
    });

    startBtn.addEventListener('click', startRun);
    stopBtn.addEventListener('click', function () { stopRun('手動停止'); });
    panel.querySelector('#kr-cal-atk').addEventListener('click', function () { startCalib('atk'); });
    panel.querySelector('#kr-cal-flee').addEventListener('click', function () { startCalib('flee'); });
    panel.querySelector('#kr-test').addEventListener('click', function () {
      if (running) return;
      if (!cfg.atk) { setStatus('先に「こうげき座標」を設定してください'); return; }
      dispatchPress(cfg.atk, function (ok) {
        setStatus(ok ? ('単発テスト送信: ' + METHOD_LABEL[cfg.method] + '（HPバーが減ったか見てください）')
                     : '単発テスト失敗（上の理由を確認）');
      });
    });

    var methodSel = panel.querySelector('#kr-method');
    methodSel.value = cfg.method;
    methodSel.addEventListener('change', function () { cfg.method = this.value; save('kr_method', cfg.method); logEvent('方式を ' + METHOD_LABEL[cfg.method] + ' に変更'); });

    var intervalInput = panel.querySelector('#kr-interval');
    var pressInput = panel.querySelector('#kr-press');

    function applyInterval(v, silent) {
      if (isNaN(v)) return;
      v = Math.max(0, Math.min(1000, v));
      cfg.intervalMs = v;
      intervalInput.value = String(v);
      save('kr_intervalMs', v);
      if (!silent) { logEvent('間隔を ' + v + 'ms に変更'); setStatus('間隔を ' + v + 'ms に設定しました'); }
    }
    function applyPress(v, silent) {
      if (isNaN(v)) return;
      v = Math.max(5, Math.min(200, v));
      cfg.pressMs = v;
      pressInput.value = String(v);
      save('kr_pressMs', v);
      if (!silent) { logEvent('押下を ' + v + 'ms に変更'); setStatus('押下を ' + v + 'ms に設定しました'); }
    }

    // 打った瞬間に保存する（'change' だけだとフォーカスが外れるまで保存されず、
    // 実機で「設定できない」ように見えたため 'input' でも保存する）
    intervalInput.value = String(cfg.intervalMs);
    intervalInput.addEventListener('input', function () { applyInterval(parseInt(this.value, 10), true); });
    intervalInput.addEventListener('change', function () { applyInterval(parseInt(this.value, 10), false); });
    pressInput.value = String(cfg.pressMs);
    pressInput.addEventListener('input', function () { applyPress(parseInt(this.value, 10), true); });
    pressInput.addEventListener('change', function () { applyPress(parseInt(this.value, 10), false); });

    panel.querySelector('#kr-int-minus').addEventListener('click', function () { applyInterval(cfg.intervalMs - 5, false); });
    panel.querySelector('#kr-int-plus').addEventListener('click', function () { applyInterval(cfg.intervalMs + 5, false); });
    panel.querySelector('#kr-press-minus').addEventListener('click', function () { applyPress(cfg.pressMs - 5, false); });
    panel.querySelector('#kr-press-plus').addEventListener('click', function () { applyPress(cfg.pressMs + 5, false); });

    var fleeSel = panel.querySelector('#kr-flee-every');
    fleeSel.value = String(cfg.fleeEvery);
    fleeSel.addEventListener('change', function () { cfg.fleeEvery = parseInt(this.value, 10); save('kr_fleeEvery', cfg.fleeEvery); logEvent('逃走設定を ' + (cfg.fleeEvery > 0 ? cfg.fleeEvery + '回ごと' : 'しない') + ' に変更'); });

    var limitSel = panel.querySelector('#kr-limit');
    limitSel.value = String(cfg.limitMin);
    limitSel.addEventListener('change', function () { cfg.limitMin = parseInt(this.value, 10); save('kr_limitMin', cfg.limitMin); logEvent('制限を ' + (cfg.limitMin > 0 ? cfg.limitMin + '分' : '無制限') + ' に変更'); });

    var logEl = panel.querySelector('#kr-log');
    function renderLog() {
      var arr = [];
      try { arr = GM_getValue(LOG_KEY, []); } catch (e) {}
      if (!Array.isArray(arr) || arr.length === 0) { logEl.textContent = '（ログはまだありません）'; return; }
      var lines = [];
      for (var i = arr.length - 1; i >= 0; i--) {
        var d = new Date(arr[i].t);
        var hh = ('0' + d.getHours()).slice(-2);
        var mm = ('0' + d.getMinutes()).slice(-2);
        var ss = ('0' + d.getSeconds()).slice(-2);
        lines.push(hh + ':' + mm + ':' + ss + ' ' + arr[i].m);
      }
      logEl.textContent = lines.join('\n');
    }
    panel.querySelector('#kr-log-toggle').addEventListener('click', function () {
      var show = logEl.style.display === 'none';
      logEl.style.display = show ? 'block' : 'none';
      this.textContent = show ? 'ログを隠す' : 'ログ表示';
      if (show) renderLog();
    });
    panel.querySelector('#kr-log-clear').addEventListener('click', function () {
      try { GM_setValue(LOG_KEY, []); } catch (e) {}
      renderLog();
      setStatus('ログを消去しました');
    });

    updatePanel();
  }

  // ---------- 異常時の自動停止 ----------
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && running) stopRun('タブが非表示になりました');
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      drawMarkers();
      if (running) stopRun('画面サイズが変わりました');
    }, 300);
  });

  // 実タップ（信頼済みイベント）で即停止。ただしパネル操作は除く。
  // スクリプト自身が出す合成イベントは isTrusted=false なので必ず除外する
  // （v1.0.1 まではこの判定がなく、自分のタッチイベントに反応して即停止していた）。
  function onTrustedInput(e) {
    if (!e.isTrusted) return;
    if (!running) return;
    if (panel && panel.contains(e.target)) return;
    stopRun('手動タップを検知しました');
  }
  document.addEventListener('touchstart', onTrustedInput, true);
  document.addEventListener('mousedown', onTrustedInput, true);

  // ---------- 起動 ----------
  var bootTimer = setInterval(function () {
    var c = findCanvas();
    if (!c) return;
    clearInterval(bootTimer);
    canvas = c;
    canvas.addEventListener('webglcontextlost', function () {
      if (running) stopRun('WebGL コンテキストが失われました');
    });
    markerAtk = makeMarker('rgba(255,60,60,0.85)');
    markerFlee = makeMarker('rgba(60,120,255,0.85)');
    buildPanel();
    logEvent('起動 v' + SCRIPT_VERSION);
    drawMarkers();
    // canvas の差し替え監視とマーカー追随
    setInterval(function () {
      var now = findCanvas();
      if (now && now !== canvas) {
        if (running) { stopRun('canvas が差し替わりました'); }
        canvas = now;
        canvas.addEventListener('webglcontextlost', function () {
          if (running) stopRun('WebGL コンテキストが失われました');
        });
      }
      drawMarkers();
    }, 1000);
  }, 500);
})();
