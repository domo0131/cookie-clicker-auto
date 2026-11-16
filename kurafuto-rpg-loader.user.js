// ==UserScript==
// @name         くらふとRPG オート（そうげん連打）
// @namespace    muse.kurafuto-rpg
// @version      1.0.0
// @description  本体スクリプトを GitHub から自動で取りに行くローダーです。更新は自動で反映されます（連打の実行中は切り替えません）。
// @match        https://80866.play.unityroom.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var MAIN_URL = 'https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/kurafuto-rpg-auto.user.js';
  var CHECK_MS = 5 * 60 * 1000; // 5分ごとに更新チェック

  function gmGet(k, d) {
    try {
      var v = GM_getValue(k, d);
      return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
  }
  function gmSet(k, v) { try { GM_setValue(k, v); } catch (e) {} }

  function parseVersion(text) {
    var m = /\/\/\s*@version\s+([0-9]+(?:\.[0-9]+)*)/.exec(text || '');
    return m ? m[1] : null;
  }
  function cmpVer(a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  var ran = false;
  var executedVer = null;

  function runBody(body, ver) {
    if (ran) return;
    ran = true;
    executedVer = ver;
    try { eval(body); } catch (e) { /* 本体のエラーでローダーまで落とさない */ }
  }

  // 本体が実行中かどうかは、本体が書くハートビート（kr_heartbeat）で判断する
  function isRunning() {
    var hb = gmGet('kr_heartbeat', 0);
    return !!hb && (Date.now() - hb < 4000);
  }

  function tryApplyPending() {
    var pending = gmGet('kr_loader_pending', null);
    if (!pending) return;
    if (executedVer && cmpVer(pending, executedVer) <= 0) { gmSet('kr_loader_pending', null); return; }
    if (isRunning()) return; // 連打中は切り替えない（止まってから）
    gmSet('kr_loader_pending', null);
    location.reload();
  }

  function fetchMain(isFirst) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: MAIN_URL + '?t=' + Date.now(),
      onload: function (res) {
        if (res.status !== 200 || !res.responseText) return;
        var v = parseVersion(res.responseText);
        if (!v) return;
        var cachedVer = gmGet('kr_loader_version', null);
        if (!cachedVer || cmpVer(v, cachedVer) > 0) {
          gmSet('kr_loader_body', res.responseText);
          gmSet('kr_loader_version', v);
          cachedVer = v;
        }
        if (isFirst && !ran) {
          // 初回（キャッシュなし）: 取得した本体をそのまま実行する
          runBody(gmGet('kr_loader_body', res.responseText), gmGet('kr_loader_version', v));
          return;
        }
        if (executedVer && cachedVer && cmpVer(cachedVer, executedVer) > 0) {
          gmSet('kr_loader_pending', cachedVer);
          tryApplyPending();
        }
      },
      onerror: function () { /* 通信失敗時はキャッシュ済み本体で続行 */ }
    });
  }

  // 起動: キャッシュ済みの本体があれば即実行し、裏で更新をチェックする
  var cachedBody = gmGet('kr_loader_body', null);
  var cachedVersion = gmGet('kr_loader_version', null);
  if (cachedBody && cachedVersion) {
    runBody(cachedBody, cachedVersion);
    fetchMain(false);
  } else {
    fetchMain(true);
  }
  setInterval(function () { fetchMain(false); }, CHECK_MS);
  setInterval(tryApplyPending, 30000);
})();
