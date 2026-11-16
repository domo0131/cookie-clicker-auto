// ==UserScript==
// @name         くらふとRPG オート（そうげん連打）
// @namespace    muse.kurafuto-rpg
// @version      1.0.9
// @description  unityroom「くらふとRPG」の「こうげき」ボタンを自動連打します。座標は実タップで登録。開始・停止は手動です。
// @match        https://80866.play.unityroom.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var SCRIPT_VERSION = '1.0.9';

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
  var logRenderFn = null; // パネル構築時に renderLog を登録（開いている間は自動で再描画）
  function logEvent(msg) {
    try {
      var arr = GM_getValue(LOG_KEY, []);
      if (!Array.isArray(arr)) arr = [];
      arr.push({ t: Date.now(), m: String(msg) });
      while (arr.length > 200) arr.shift();
      GM_setValue(LOG_KEY, arr);
    } catch (e) {}
    if (logRenderFn) { try { logRenderFn(); } catch (e) {} }
  }

  var cfg = {
    method: load('kr_method', 'touch'),     // mouse / mouseMove / pointer / click / touch（新規は実績のある E を既定に）
    intervalMs: load('kr_intervalMs', 200), // クリック間隔(ms)
    pressMs: load('kr_pressMs', 30),        // 押下→解放の間隔(ms)。60fps の約2フレーム分
    fleeEvery: load('kr_fleeEvery', 0),     // 0=逃走しない / N=攻撃N回ごとに1回逃走
    limitMin: load('kr_limitMin', 5),       // 0=無制限
    fingers: load('kr_fingers', 1),         // 同時タップ本数（方式Eのみ）: 1 or 2
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
  var runGen = 0;              // 実行の世代。開始・停止のたびに増やし、古い予約コールバックを無効化する
  var timer = null;            // 単指ループの次回 tick
  var fleeTimer = null;        // 逃走までの待ちタイマー
  var elapsedTimer = null;
  var hbTimer = null;          // ハートビート用タイマー
  var startedAt = 0;
  var attackCount = 0;
  var fleeCount = 0;
  var sinceFlee = 0;
  var warmupLeft = 0;
  var touchSeq = 0;
  var stopReason = '';
  var calibTarget = null; // 'atk' | 'flee' | null
  var overlay = null;
  var panel = null, statusEl = null, startBtn = null, stopBtn = null;
  var markerAtk = null, markerFlee = null;
  var sessionId = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  // 押下中（解放待ち）の記録。停止時に後始末（解放イベント）を送るために保持する
  var inFlight = null; // {canvas, timer, release}
  // 2本同時タップ用: identifier -> {x, y, kind, canvas, timer}
  var parActive = {};
  var parTimer = null;

  function useParallel() { return cfg.fingers >= 2 && cfg.method === 'touch'; }

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

  function isBlockingTarget(t, c) {
    if (!t || t === c) return false;
    // canvas の祖先（透明なラッパー等）はブロック扱いしない
    var n = c;
    while (n) { if (n === t) return false; n = n.parentElement; }
    return true;
  }

  // 押下位置を画面座標に直し、塞がれていないか確認する。問題があれば fail して null を返す
  function pressPoint(pos, c) {
    var r = c.getBoundingClientRect();
    if (!r.width || !r.height) { fail('canvas のサイズが取得できません'); return null; }
    var x = r.left + pos.u * r.width;
    var y = r.top + pos.v * r.height;
    var target = document.elementFromPoint(x, y);
    if (!target) { fail('ボタンの位置が画面外です'); return null; }
    if (isBlockingTarget(target, c)) { fail('ボタンの上に別の要素があります（画面変化の可能性）'); return null; }
    return { x: x, y: y };
  }

  // 1回分の押下→解放を送る。done(ok) は解放後に呼ばれる。
  // 押下開始時の canvas を固定し、解放も同じ canvas に送る。解放タイマーは inFlight に
  // 登録され、停止時は stopRun が即座に解放して後始末する（旧世代のコールバックは gen で無効化）。
  function dispatchPress(pos, gen, done) {
    var c = canvas;
    if (!c) { fail('canvas が見つかりません'); if (done) done(false); return; }
    var pt = pressPoint(pos, c);
    if (!pt) { if (done) done(false); return; }
    var x = pt.x, y = pt.y;
    var m = cfg.method;
    try {
      if (m === 'click') {
        c.dispatchEvent(makeMouse('click', x, y, 0));
        if (done) done(true);
        return;
      }
      var releaseFn = null;
      if (m === 'pointer') {
        c.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y, button: 0, buttons: 1,
          pointerId: 1, isPrimary: true, pointerType: 'mouse'
        }));
        releaseFn = function () {
          c.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, cancelable: true,
            clientX: x, clientY: y, button: 0, buttons: 0,
            pointerId: 1, isPrimary: true, pointerType: 'mouse'
          }));
        };
      } else if (m === 'touch') {
        touchSeq++;
        var touchId = touchSeq;
        var t1 = new Touch({ identifier: touchId, target: c, clientX: x, clientY: y });
        c.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true,
          touches: [t1], targetTouches: [t1], changedTouches: [t1]
        }));
        releaseFn = function () {
          var t2 = new Touch({ identifier: touchId, target: c, clientX: x, clientY: y });
          c.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true,
            touches: [], targetTouches: [], changedTouches: [t2]
          }));
        };
      } else {
        // mouse / mouseMove
        if (m === 'mouseMove') c.dispatchEvent(makeMouse('mousemove', x, y, 0));
        c.dispatchEvent(makeMouse('mousedown', x, y, 1));
        releaseFn = function () { c.dispatchEvent(makeMouse('mouseup', x, y, 0)); };
      }
      var rec = { canvas: c, timer: null, release: releaseFn };
      inFlight = rec;
      rec.timer = setTimeout(function () {
        if (inFlight === rec) inFlight = null;
        try {
          releaseFn();
        } catch (e) {
          fail('解放でエラー: ' + e.message);
          if (done) done(false);
          return;
        }
        if (done) done(true);
      }, cfg.pressMs);
    } catch (e) {
      fail('入力送信でエラー: ' + e.message);
      if (done) done(false);
    }
  }

  // 停止時: 解放待ちの押下があれば、その場で解放して後始末する
  function releaseInFlight() {
    if (!inFlight) return;
    var rec = inFlight;
    inFlight = null;
    if (rec.timer) clearTimeout(rec.timer);
    try { rec.release(); } catch (e) {}
  }

  function fail(msg) {
    if (running) stopRun(msg);
    else setStatus(msg);
  }

  // ---------- 連打ループ（単指） ----------
  function runStopped(gen) { return !running || gen !== runGen; }

  function tick(gen) {
    if (runStopped(gen)) return;
    try {
      if (!canvas || !document.contains(canvas)) { stopRun('canvas が見つかりません'); return; }
      if (document.hidden) { stopRun('タブが非表示になりました'); return; }
      if (cfg.limitMin > 0 && Date.now() - startedAt >= cfg.limitMin * 60000) { stopRun('制限時間に到達'); return; }
      if (!cfg.atk) { stopRun('こうげき座標が未設定です'); return; }
      dispatchPress(cfg.atk, gen, function (ok) {
        if (runStopped(gen) || !ok) return;
        attackCount++; sinceFlee++;
        if (attackCount % 1000 === 0) logEvent('攻撃 ' + attackCount + ' 回（経過 ' + fmtTime(Date.now() - startedAt) + '）');
        updateStatus();
        if (cfg.fleeEvery > 0 && cfg.flee && sinceFlee >= cfg.fleeEvery) {
          sinceFlee = 0;
          fleeTimer = setTimeout(function () { fleeStep(gen); }, 250);
        } else {
          timer = setTimeout(function () { tick(gen); }, effInterval());
        }
      });
    } catch (e) {
      stopRun('エラー: ' + e.message);
    }
  }

  // 逃走は発火直前に設定・制限・状態を再確認する（予約後に設定が変わっても誤発火しない）
  function fleeStep(gen) {
    fleeTimer = null;
    if (runStopped(gen)) return;
    if (cfg.fleeEvery <= 0 || !cfg.flee) { timer = setTimeout(function () { tick(gen); }, effInterval()); return; }
    if (document.hidden) { stopRun('タブが非表示になりました'); return; }
    if (cfg.limitMin > 0 && Date.now() - startedAt >= cfg.limitMin * 60000) { stopRun('制限時間に到達'); return; }
    dispatchPress(cfg.flee, gen, function (ok) {
      if (runStopped(gen)) return;
      if (ok) fleeCount++;
      updateStatus();
      timer = setTimeout(function () { tick(gen); }, 400);
    });
  }

  // ---------- 連打ループ（2本同時タップ、方式Eのみ） ----------
  // 各指は 押下 pressMs のあいだ画面に残り、開始は (押下+間隔)/本数 ずつずらす。
  // touches には押下中の全指を正しく入れる（他の指を消すイベント列にしない）。
  function parStagger() {
    var base = Math.round((cfg.pressMs + cfg.intervalMs) / Math.max(1, cfg.fingers));
    if (warmupLeft > 0) return Math.max(base, 200);
    return Math.max(5, base);
  }

  function parCadence(gen) {
    if (runStopped(gen)) return;
    if (!canvas || !document.contains(canvas)) { stopRun('canvas が見つかりません'); return; }
    if (document.hidden) { stopRun('タブが非表示になりました'); return; }
    if (cfg.limitMin > 0 && Date.now() - startedAt >= cfg.limitMin * 60000) { stopRun('制限時間に到達'); return; }
    if (Object.keys(parActive).length < cfg.fingers) parPress(gen);
    parTimer = setTimeout(function () { parCadence(gen); }, parStagger());
  }

  function parPress(gen) {
    var c = canvas;
    var kind = 'atk';
    if (cfg.fleeEvery > 0 && cfg.flee && sinceFlee >= cfg.fleeEvery && !parHasFlee()) kind = 'flee';
    var pos = (kind === 'flee') ? cfg.flee : cfg.atk;
    if (!pos) return;
    var pt = pressPoint(pos, c);
    if (!pt) return; // fail() が停止まで面倒を見る
    if (kind === 'flee') sinceFlee = 0;
    if (warmupLeft > 0) warmupLeft--;
    touchSeq++;
    var id = touchSeq;
    var rec = { x: pt.x, y: pt.y, kind: kind, canvas: c, timer: null };
    parActive[id] = rec;
    try {
      c.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, cancelable: true,
        touches: parTouchList(c, null), targetTouches: parTouchList(c, null),
        changedTouches: [new Touch({ identifier: id, target: c, clientX: pt.x, clientY: pt.y })]
      }));
    } catch (e) {
      delete parActive[id];
      fail('入力送信でエラー: ' + e.message);
      return;
    }
    rec.timer = setTimeout(function () { parEnd(id, gen); }, cfg.pressMs);
  }

  function parHasFlee() {
    for (var k in parActive) { if (parActive[k].kind === 'flee') return true; }
    return false;
  }

  function parTouchList(c, excludeId) {
    var list = [];
    for (var k in parActive) {
      if (excludeId !== null && String(excludeId) === k) continue;
      var r = parActive[k];
      list.push(new Touch({ identifier: parseInt(k, 10), target: c, clientX: r.x, clientY: r.y }));
    }
    return list;
  }

  function parEnd(id, gen) {
    var rec = parActive[id];
    if (!rec) return;
    delete parActive[id];
    try {
      var rest = parTouchList(rec.canvas, null);
      rec.canvas.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true,
        touches: rest, targetTouches: rest,
        changedTouches: [new Touch({ identifier: id, target: rec.canvas, clientX: rec.x, clientY: rec.y })]
      }));
    } catch (e) {}
    if (runStopped(gen)) return;
    if (rec.kind === 'flee') {
      fleeCount++;
    } else {
      attackCount++; sinceFlee++;
      if (attackCount % 1000 === 0) logEvent('攻撃 ' + attackCount + ' 回（経過 ' + fmtTime(Date.now() - startedAt) + '）');
    }
    updateStatus();
  }

  // 停止時: 押下中の全指をまとめて解放する
  function parCleanup() {
    if (parTimer) { clearTimeout(parTimer); parTimer = null; }
    var ids = Object.keys(parActive);
    if (!ids.length) return;
    var c = parActive[ids[0]].canvas;
    var changed = [];
    for (var i = 0; i < ids.length; i++) {
      var rec = parActive[ids[i]];
      if (rec.timer) clearTimeout(rec.timer);
      changed.push(new Touch({ identifier: parseInt(ids[i], 10), target: c, clientX: rec.x, clientY: rec.y }));
    }
    parActive = {};
    try {
      c.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true,
        touches: [], targetTouches: [], changedTouches: changed
      }));
    } catch (e) {}
  }

  // 開始直後はゆっくりした「準備タップ」を挟む（実機の癖への対策: 手で数回押してから
  // 開始すると安定する現象への当て推量。効かなければ将来外す）。
  function effInterval() {
    if (warmupLeft > 0) { warmupLeft--; return Math.max(cfg.intervalMs, 200); }
    return cfg.intervalMs;
  }

  function startRun() {
    if (running) return;
    if (calibTarget) { setStatus('座標の登録中は開始できません'); return; }
    if (!cfg.atk) { setStatus('先に「こうげき座標」を設定してください'); return; }
    runGen++;
    var gen = runGen;
    running = true;
    stopReason = '';
    attackCount = 0; fleeCount = 0; sinceFlee = 0;
    warmupLeft = 6;
    startedAt = Date.now();
    elapsedTimer = setInterval(function () { updateStatus(true); }, 500);
    // ハートビート（ローダーが「実行中は更新を切り替えない」判断に使う。所有者つき）
    save('kr_heartbeat', Date.now());
    save('kr_heartbeat_owner', sessionId);
    hbTimer = setInterval(function () {
      save('kr_heartbeat', Date.now());
      save('kr_heartbeat_owner', sessionId);
    }, 2000);
    logEvent('開始: ' + METHOD_LABEL[cfg.method] + ' 間隔' + cfg.intervalMs + 'ms 押下' + cfg.pressMs + 'ms' +
      (useParallel() ? ' 同時' + cfg.fingers + '本' : '') +
      ' 逃走' + (cfg.fleeEvery > 0 ? cfg.fleeEvery + '回ごと' : 'なし') +
      ' 制限' + (cfg.limitMin > 0 ? cfg.limitMin + '分' : 'なし'));
    updatePanel();
    updateStatus(true);
    if (useParallel()) parCadence(gen);
    else tick(gen);
  }

  function stopRun(reason) {
    var wasRunning = running;
    runGen++; // 予約済みの全コールバックを無効化する
    if (timer) { clearTimeout(timer); timer = null; }
    if (fleeTimer) { clearTimeout(fleeTimer); fleeTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    releaseInFlight();
    parCleanup();
    if (running && reason) stopReason = reason;
    running = false;
    // ハートビートは所有者（このタブ）が書いたものだけ消す（別タブの実行を邪魔しない）
    if (load('kr_heartbeat_owner', '') === sessionId) save('kr_heartbeat', 0);
    if (wasRunning) {
      logEvent('停止: ' + (reason || '手動') + '（経過 ' + fmtTime(Date.now() - startedAt) +
        ' / 攻撃 ' + attackCount + ' / 逃走 ' + fleeCount + '）');
    }
    updatePanel();
    updateStatus(true);
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
      if (!r.width || !r.height) {
        endCalib();
        updatePanel();
        setStatus('画面サイズが取得できませんでした');
        return;
      }
      var pos = { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
      if (!isFinite(pos.u) || !isFinite(pos.v) || pos.u < 0 || pos.u >= 1 || pos.v < 0 || pos.v >= 1) {
        endCalib();
        updatePanel();
        setStatus('ボタンの範囲内をタップしてください');
        return;
      }
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

  var lastStatusAt = 0;
  function updateStatus(force) {
    if (!statusEl) return;
    var now = Date.now();
    // 実行中の表示更新は 250ms に1回まで（攻撃ごとの書き換えは端末負荷になるため）
    if (running && !force && now - lastStatusAt < 250) return;
    lastStatusAt = now;
    if (running) {
      statusEl.textContent = '実行中 ' + fmtTime(now - startedAt) +
        ' / 攻撃 ' + attackCount + ' / 逃走 ' + fleeCount +
        ' / ' + METHOD_LABEL[cfg.method] + ' ' + cfg.intervalMs + 'ms' +
        (useParallel() ? ' ' + cfg.fingers + '本同時' : '') +
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
          '<label>同時 <select id="kr-fingers" style="min-height:34px;">' +
            '<option value="1">1本</option><option value="2">2本</option></select></label>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button id="kr-log-toggle" style="flex:1;min-height:34px;">ログ表示</button>' +
          '<button id="kr-probe" style="flex:1;min-height:34px;">データ確認</button>' +
          '<button id="kr-log-clear" style="min-height:34px;">ログ消去</button>' +
        '</div>' +
        '<div id="kr-log" style="display:none;margin-top:6px;max-height:180px;overflow-y:auto;background:rgba(0,0,0,0.35);border-radius:6px;padding:6px;font-size:11px;white-space:pre-wrap;word-break:break-all;"></div>' +
      '</div>';
    document.body.appendChild(panel);

    statusEl = panel.querySelector('#kr-status');
    startBtn = panel.querySelector('#kr-start');
    stopBtn = panel.querySelector('#kr-stop');

    startBtn.addEventListener('click', startRun);
    stopBtn.addEventListener('click', function () { stopRun('手動で停止'); });
    panel.querySelector('#kr-cal-atk').addEventListener('click', function () { startCalib('atk'); });
    panel.querySelector('#kr-cal-flee').addEventListener('click', function () { startCalib('flee'); });
    panel.querySelector('#kr-min').addEventListener('click', function () {
      var body = panel.querySelector('#kr-body');
      var hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      this.textContent = hide ? '＋' : '－';
    });

    panel.querySelector('#kr-test').addEventListener('click', function () {
      if (running) { setStatus('実行中はテストできません'); return; }
      if (calibTarget) { setStatus('座標の登録中はテストできません'); return; }
      if (inFlight || Object.keys(parActive).length) { setStatus('押下中です。少し待ってください'); return; }
      if (!cfg.atk) { setStatus('先に「こうげき座標」を設定してください'); return; }
      dispatchPress(cfg.atk, runGen, function (ok) {
        setStatus(ok ? '単発テストを送信しました' : '単発テストに失敗しました');
      });
    });

    var methodSel = panel.querySelector('#kr-method');
    methodSel.value = cfg.method;
    methodSel.addEventListener('change', function () {
      cfg.method = this.value;
      save('kr_method', cfg.method);
      logEvent('方式を ' + METHOD_LABEL[cfg.method] + ' に変更');
    });

    var intervalInput = panel.querySelector('#kr-interval');
    var pressInput = panel.querySelector('#kr-press');

    // 数値入力の扱い: 入力中（'input'）は範囲内の値だけを即反映し、欄の文字は書き戻さない
    // （書き戻すと「30」と打つ途中の「3」が下限で「5」に化けて設定できなくなる）。
    // 確定時（'change' と －/＋）にだけ整形して書き戻し、変わったときだけログに残す。
    function applyInterval(v, mode) {
      if (isNaN(v)) return;
      if (mode === 'input') {
        if (v < 0 || v > 1000) return;
        cfg.intervalMs = v;
        save('kr_intervalMs', v);
        return;
      }
      v = Math.max(0, Math.min(1000, v));
      var changed = v !== cfg.intervalMs;
      cfg.intervalMs = v;
      intervalInput.value = String(v);
      save('kr_intervalMs', v);
      if (changed) { logEvent('間隔を ' + v + 'ms に変更'); setStatus('間隔を ' + v + 'ms に設定しました'); }
    }
    function applyPress(v, mode) {
      if (isNaN(v)) return;
      if (mode === 'input') {
        if (v < 5 || v > 200) return;
        cfg.pressMs = v;
        save('kr_pressMs', v);
        return;
      }
      v = Math.max(5, Math.min(200, v));
      var changed = v !== cfg.pressMs;
      cfg.pressMs = v;
      pressInput.value = String(v);
      save('kr_pressMs', v);
      if (changed) { logEvent('押下を ' + v + 'ms に変更'); setStatus('押下を ' + v + 'ms に設定しました'); }
    }

    intervalInput.value = String(cfg.intervalMs);
    intervalInput.addEventListener('input', function () { applyInterval(parseInt(this.value, 10), 'input'); });
    intervalInput.addEventListener('change', function () { applyInterval(parseInt(this.value, 10), 'set'); });
    pressInput.value = String(cfg.pressMs);
    pressInput.addEventListener('input', function () { applyPress(parseInt(this.value, 10), 'input'); });
    pressInput.addEventListener('change', function () { applyPress(parseInt(this.value, 10), 'set'); });

    panel.querySelector('#kr-int-minus').addEventListener('click', function () { applyInterval(cfg.intervalMs - 5, 'set'); });
    panel.querySelector('#kr-int-plus').addEventListener('click', function () { applyInterval(cfg.intervalMs + 5, 'set'); });
    panel.querySelector('#kr-press-minus').addEventListener('click', function () { applyPress(cfg.pressMs - 5, 'set'); });
    panel.querySelector('#kr-press-plus').addEventListener('click', function () { applyPress(cfg.pressMs + 5, 'set'); });

    var fleeSel = panel.querySelector('#kr-flee-every');
    fleeSel.value = String(cfg.fleeEvery);
    fleeSel.addEventListener('change', function () { cfg.fleeEvery = parseInt(this.value, 10); save('kr_fleeEvery', cfg.fleeEvery); logEvent('逃走設定を ' + (cfg.fleeEvery > 0 ? cfg.fleeEvery + '回ごと' : 'しない') + ' に変更'); });

    var limitSel = panel.querySelector('#kr-limit');
    limitSel.value = String(cfg.limitMin);
    limitSel.addEventListener('change', function () { cfg.limitMin = parseInt(this.value, 10); save('kr_limitMin', cfg.limitMin); logEvent('制限を ' + (cfg.limitMin > 0 ? cfg.limitMin + '分' : '無制限') + ' に変更'); });

    var fingersSel = panel.querySelector('#kr-fingers');
    fingersSel.value = String(cfg.fingers);
    fingersSel.addEventListener('change', function () {
      cfg.fingers = parseInt(this.value, 10);
      save('kr_fingers', cfg.fingers);
      logEvent('同時タップを ' + cfg.fingers + '本に変更');
      if (cfg.fingers >= 2 && cfg.method !== 'touch') setStatus('同時タップは方式E（タッチ）のときだけ効きます');
    });

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
    logRenderFn = function () { if (logEl.style.display !== 'none') renderLog(); };
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

    // ---------- データ確認（ゲーム内部データが読めるかの調査） ----------
    function probeData() {
      logEvent('データ確認を開始します');
      try {
        logEvent('localStorage: ' + localStorage.length + ' 件');
        for (var i = 0; i < localStorage.length && i < 25; i++) {
          var k = localStorage.key(i);
          var v = localStorage.getItem(k) || '';
          logEvent('LS [' + k + '] = ' + String(v).slice(0, 120));
        }
      } catch (e) { logEvent('localStorage 読めません: ' + e.message); }
      try { logEvent('sessionStorage: ' + sessionStorage.length + ' 件'); } catch (e) {}
      try { logEvent('cookie: ' + (document.cookie ? document.cookie.slice(0, 160) : '(なし)')); } catch (e) {}
      try {
        var pw = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        var names = ['unityInstance', 'gameInstance', 'Module', 'UnityLoader', 'createUnityInstance'];
        for (var j = 0; j < names.length; j++) {
          var nm = names[j];
          var val = pw[nm];
          logEvent('global ' + nm + ': ' + (val === undefined ? 'なし' : typeof val));
          if (val && typeof val === 'object') {
            try { logEvent('  キー: ' + Object.keys(val).slice(0, 25).join(',')); } catch (e) {}
          }
        }
        var mod = pw.Module || (pw.unityInstance && pw.unityInstance.Module);
        if (mod) {
          try { if (mod.HEAPU8) logEvent('Module.HEAPU8: ' + mod.HEAPU8.length + ' バイト'); } catch (e) {}
        }
        logEvent('canvas 数: ' + document.querySelectorAll('canvas').length);
      } catch (e) { logEvent('グローバル確認でエラー: ' + e.message); }
      try {
        if (window.indexedDB && indexedDB.databases) {
          indexedDB.databases().then(function (dbs) {
            logEvent('IndexedDB: ' + (dbs ? dbs.length : 0) + ' 件');
            (dbs || []).forEach(function (info) { probeDb(info.name); });
          }, function (e) { logEvent('IndexedDB 一覧が取れません: ' + e.message); });
        } else {
          logEvent('IndexedDB の一覧APIがありません');
        }
      } catch (e) { logEvent('IndexedDB 確認でエラー: ' + e.message); }
      renderLog();
      setStatus('データ確認の結果をログに出しました');
    }

    function probeDb(name) {
      try {
        var req = indexedDB.open(name);
        req.onerror = function () { logEvent('DB [' + name + '] 開けません'); renderLog(); };
        req.onsuccess = function () {
          var db = req.result;
          var stores = [];
          for (var i = 0; i < db.objectStoreNames.length; i++) stores.push(db.objectStoreNames[i]);
          logEvent('DB [' + name + '] v' + db.version + ' ストア: ' + (stores.join(', ') || '(なし)'));
          stores.forEach(function (sn) {
            try {
              var tx = db.transaction(sn, 'readonly');
              var st = tx.objectStore(sn);
              var creq = st.count();
              creq.onsuccess = function () { logEvent('  [' + sn + '] ' + creq.result + ' 件'); renderLog(); };
              var kreq = st.getAllKeys(null, 5);
              kreq.onsuccess = function () {
                var keys = (kreq.result || []).map(function (x) { return String(x).slice(0, 60); });
                logEvent('  [' + sn + '] キー例: ' + keys.join(' | '));
                renderLog();
              };
            } catch (e) { logEvent('  [' + sn + '] 読めません: ' + e.message); }
          });
          renderLog();
        };
      } catch (e) { logEvent('DB [' + name + '] でエラー: ' + e.message); }
    }

    panel.querySelector('#kr-probe').addEventListener('click', function () { probeData(); });

    updatePanel();
  }

  // ---------- 異常時の自動停止 ----------
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && running) stopRun('タブが非表示になりました');
  });
  window.addEventListener('pagehide', function () {
    if (running) stopRun('ページが閉じられました');
  });

  // サイズが変わった瞬間に止める（遅らせると座標がずれたまま押し続けるため）。
  // マーカーの追随だけを 300ms デバウンスする。
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (running) stopRun('画面サイズが変わりました');
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawMarkers, 300);
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

  // webglcontextlost は、その canvas が現役のときだけ停止理由にする
  function attachContextLost(c) {
    c.addEventListener('webglcontextlost', function () {
      if (c === canvas && running) stopRun('WebGL コンテキストが失われました');
    });
  }

  // ---------- 起動 ----------
  var bootTimer = setInterval(function () {
    var c = findCanvas();
    if (!c) return;
    clearInterval(bootTimer);
    canvas = c;
    attachContextLost(canvas);
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
        attachContextLost(canvas);
      }
      drawMarkers();
    }, 1000);
  }, 500);
})();
