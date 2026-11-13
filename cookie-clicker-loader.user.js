// ==UserScript==
// @name         Cookie Clicker 自動購入（Galaxy Tab専用機用）
// @namespace    muse.cookieclicker
// @version      1.1.0
// @downloadURL  https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-loader.user.js
// @updateURL    https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-loader.user.js
// @description  ローダー: 本体スクリプトを GitHub から直接取得して実行する薄い入れ物。本体の更新は Tampermonkey の更新確認を待たず、push から数分で届く。取得できないときは前回取得した本体で起動する。
// @match        https://orteil.dashnet.org/cookieclicker/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      raw.githubusercontent.com
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 本体の配信URL（ローダーはここだけを見る）
  var BODY_URL = 'https://raw.githubusercontent.com/domo0131/cookie-clicker-auto/main/cookie-clicker-auto.user.js';
  var CHECK_MS = 5 * 60 * 1000;   // 新版チェック間隔: 5分
  var TIMEOUT_MS = 20000;
  var WATCHDOG_MS = 10000;        // 起動時の取得が長引いたらキャッシュで先に起動

  var K_CODE = 'ccauto_loader_code';        // 前回取得できた本体
  var K_VER = 'ccauto_loader_version';      // その版
  var K_PCODE = 'ccauto_loader_prevCode';   // 1つ前の本体（戻し先）
  var K_PVER = 'ccauto_loader_prevVersion';

  function gGet(k, d) { try { var v = GM_getValue(k); return (v === undefined || v === null) ? d : v; } catch (e) { return d; } }
  function gSet(k, v) { try { GM_setValue(k, v); } catch (e) {} }

  var executed = false;
  var runningVer = '';

  function parseVer(text) {
    var m = ('' + text).slice(0, 4000).match(/\/\/\s*@version\s+([0-9]+(?:\.[0-9]+)*)/);
    return m ? m[1] : '';
  }
  function isNewer(a, b) {
    if (!a) return false;
    if (!b) return true;
    var pa = a.split('.'), pb = b.split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i] || '0', 10), nb = parseInt(pb[i] || '0', 10);
      if (na !== nb) return na > nb;
    }
    return false;
  }

  // 本体は GM_getValue / GM_setValue / GM_xmlhttpRequest / unsafeWindow の4つだけを使う
  function runBody(code, ver) {
    try {
      var fn = new Function('GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'unsafeWindow', code);
      fn(GM_getValue, GM_setValue, GM_xmlhttpRequest, (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window);
      executed = true;
      runningVer = ver || '';
      return true;
    } catch (e) { return false; }
  }
  function runCached() {
    var code = gGet(K_CODE, ''), ver = gGet(K_VER, '');
    if (code && runBody(code, ver)) return true;
    var pc = gGet(K_PCODE, ''), pv = gGet(K_PVER, '');
    if (pc && runBody(pc, pv)) return true;
    return false;
  }

  function fetchBody(isBoot) {
    if (typeof GM_xmlhttpRequest !== 'function') { if (isBoot && !executed) runCached(); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: BODY_URL + '?t=' + Date.now(),
      timeout: TIMEOUT_MS,
      onload: function (res) {
        if (!res || res.status !== 200 || !res.responseText) { if (isBoot && !executed) runCached(); return; }
        var code = '' + res.responseText;
        var ver = parseVer(code);
        if (!ver || code.length < 10000) { if (isBoot && !executed) runCached(); return; } // 本体らしくない応答は取り込まない
        if (ver !== gGet(K_VER, '')) {
          var old = gGet(K_CODE, '');
          if (old) { gSet(K_PCODE, old); gSet(K_PVER, gGet(K_VER, '')); }
          gSet(K_CODE, code); gSet(K_VER, ver);
        }
        if (!executed) { if (!runBody(code, ver)) runCached(); }
        else if (isNewer(ver, runningVer)) {
          // 本体が自動昇天などの重要な処理の最中なら、切り替え（再読み込み）を次回確認まで延期する
          var busy = false;
          try {
            var fl = GM_getValue('ccauto_ascendFlow', null);
            if (fl && fl.phase && fl.phase !== 'done' && fl.phase !== 'stuck') busy = true;
          } catch (e) { busy = false; }
          if (!busy) { setTimeout(function () { try { location.reload(); } catch (e) {} }, 3000); }
        }
      },
      onerror: function () { if (isBoot && !executed) runCached(); },
      ontimeout: function () { if (isBoot && !executed) runCached(); }
    });
  }

  fetchBody(true);
  setTimeout(function () { if (!executed) runCached(); }, WATCHDOG_MS);
  setInterval(function () { fetchBody(false); }, CHECK_MS);
})();
