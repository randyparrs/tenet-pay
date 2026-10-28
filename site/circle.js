/* Copied from site/circle.js by build_site.py for the new paytenet pages; do not edit here. */
/* Tenet: Circle wallet for the Demo Shop. A visitor signs in with Google and Circle creates a wallet for
   them on Arc testnet (an EOA that pays its own gas in testnet USDC). Every transaction is approved in
   Circle's own window; the Demo Shop Worker only forwards the requests to Circle (worker/src/circle.js).
   Circle's Web SDK (circle-sdk.js) loads only when this is used. The session lives in this tab
   (sessionStorage) and is never sent anywhere but the Worker and Circle. */
(function () {
  'use strict';
  var SESSION = 'tenet-circle', PENDING = 'tenet-circle-login';
  var me = document.currentScript && document.currentScript.src || '';
  var version = (/[?&]v=([^&]+)/.exec(me) || [])[1] || '';

  function cfg() {
    var m = document.querySelector('meta[name="tenet-circle"]');
    var p = ((m && m.content) || '').split('|');
    return p[0] && p[1] ? { appId: p[0], clientId: p[1] } : null;
  }
  function api() { var m = document.querySelector('meta[name="tenet-gateway-api"]'); return ((m && m.content) || '').replace(/\/$/, ''); }
  function keep(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }
  function kept(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /* Circle's window in the site's colors (styles.css tokens as hex); its size is Circle's */
  var THEME = {
    backdrop: '#0a0e0c', backdropOpacity: 0.72, bg: '#131916', divider: '#29302c',
    textMain: '#ebf0ec', textMain2: '#ebf0ec', textAuxiliary: '#99a59d', textAuxiliary2: '#99a59d',
    textSummary: '#bfcbc3', textSummaryHighlight: '#ebf0ec', textPlaceholder: '#99a59d', textDetailToggle: '#a1e7be',
    textInteractive: '#a1e7be', interactiveBg: '#0a0e0c', success: '#6fe79f', error: '#fda19a',
    tooltipText: '#0a0e0c', tooltipBg: '#bfcbc3', inputText: '#ebf0ec', inputBg: '#0a0e0c', inputBgDisabled: '#131916',
    inputBorderFocused: '#4dc588', inputBorderFocusedError: '#fda19a', dropdownBg: '#131916', dropdownBorderIsOpen: '#4dc588',
    mainBtnText: '#0a0e0c', mainBtnTextOnHover: '#0a0e0c', mainBtnTextDisabled: '#99a59d', mainBtnBg: '#4dc588',
    mainBtnBgOnHover: '#a1e7be', mainBtnBgDisabled: '#29302c', secondBtnText: '#ebf0ec', secondBtnTextOnHover: '#ebf0ec',
    secondBtnTextDisabled: '#99a59d', secondBtnBorder: '#29302c', secondBtnBorderOnHover: '#4dc588', secondBtnBgOnHover: '#0a0e0c',
    secondBtnBorderDisabled: '#29302c', plainBtnText: '#a1e7be', plainBtnTextOnHover: '#ebf0ec', plainBtnTextDisabled: '#99a59d',
    plainBtnBg: '#131916', plainBtnBgOnHover: '#0a0e0c', titleGradients: ['#a1e7be', '#4dc588']
  };

  /* Requests to the Worker's Circle routes. A rejected session ends it here and in the page. */
  function post(name, body) {
    return fetch(api() + '/api/circle/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401 || r.status === 403) { signOut(); throw new Error('Your Circle session ended. Sign in with Google again.'); }
          if (!r.ok || j.error) throw new Error(j.error || 'Circle did not answer (' + r.status + ').');
          return j;
        });
      });
  }

  var lib = null;
  function sdkLib() {
    if (window.TenetCircleSdk) return Promise.resolve(window.TenetCircleSdk);
    if (!lib) {
      lib = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = new URL('circle-sdk.js', me || location.href).href + (version ? '?v=' + version : '');
        s.onload = function () { if (window.TenetCircleSdk) res(window.TenetCircleSdk); else rej(new Error('Circle sign-in could not load.')); };
        s.onerror = function () { lib = null; rej(new Error('Circle sign-in could not load.')); };
        document.head.appendChild(s);
      });
    }
    return lib;
  }
  function configs(c, d) {
    return { appSettings: { appId: c.appId }, loginConfigs: { deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey,
      google: { clientId: c.clientId, redirectUri: location.origin + location.pathname, selectAccountPrompt: true } } };
  }

  /* Approve one challenge in Circle's window */
  function approve(session, challengeId) {
    var c = cfg();
    return sdkLib().then(function (L) {
      return new Promise(function (res, rej) {
        var sdk = new L.W3SSdk({ appSettings: { appId: c.appId } });
        if (sdk.setThemeColor) sdk.setThemeColor(THEME);
        sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
        sdk.execute(challengeId, function (err, result) {
          if (err) return rej(new Error(/cancel|close/i.test(err.message || '') ? 'Cancelled in the Circle window.' : (err.message || 'Circle did not approve it.')));
          res(result);
        });
      });
    });
  }

  /* After Google: the wallet exists (created on the first sign-in) and the session is kept for this tab */
  function finish(auth, route) {
    var s = { userToken: auth.userToken, encryptionKey: auth.encryptionKey };
    return post('init', { userToken: s.userToken }).then(function (r) {
      return r.challengeId ? approve(s, r.challengeId) : null;
    }).then(function () {
      var tries = 0;
      return (function look() {
        return post('wallet', { userToken: s.userToken }).then(function (w) { return w; }, function (e) {
          if (++tries > 15) throw e;
          return wait(2000).then(look);
        });
      })();
    }).then(function (w) {
      s.walletId = w.walletId; s.address = w.address;
      keep(SESSION, s);
      if (route && location.hash !== route) location.hash = route;
      return s;
    });
  }

  function signOut() { keep(SESSION, null); }

  window.TenetCircle = {
    available: function () { return !!cfg(); },
    session: function () { var s = kept(SESSION); return s && s.address ? s : null; },
    signOut: signOut,
    /* Sign in with Google: the page leaves for Google and comes back to this same page */
    login: function () {
      var c = cfg();
      if (!c) return Promise.reject(new Error('Circle sign-in is not set up.'));
      return sdkLib().then(function (L) {
        var sdk = new L.W3SSdk({ appSettings: { appId: c.appId } });
        return sdk.getDeviceId().then(function (id) { return post('device', { deviceId: id }); }).then(function (d) {
          keep(PENDING, { deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey, route: location.hash || '#/' });
          sdk.updateConfigs(configs(c, d));
          return sdk.performLogin(L.SocialLoginProvider.GOOGLE);
        });
      });
    },
    /* True when the page loads with Google's answer to finish */
    returning: function () { return !!kept(PENDING) && /(^#|&)(id_token|access_token|error|state)=/.test(location.hash || ''); },
    resume: function () {
      var c = cfg(), p = kept(PENDING);
      if (!c || !p) return Promise.reject(new Error('Nothing to finish.'));
      return sdkLib().then(function (L) {
        return new Promise(function (res, rej) {
          /* The SDK reads Google's answer from the address, checks it with Circle and clears it */
          new L.W3SSdk(configs(c, p), function (err, result) {
            keep(PENDING, null);
            if (err || !result) return rej(new Error((err && err.message) || 'Google sign-in did not finish.'));
            res(result);
          });
        });
      }).then(function (result) { return finish(result, p.route); }, function (e) { keep(PENDING, null); throw e; });
    },
    /* One Demo Shop transaction: approved in Circle's window, sent by Circle, then its hash on Arc */
    send: function (to, data, step) {
      var s = window.TenetCircle.session();
      if (!s) return Promise.reject(new Error('Sign in with Google first.'));
      return post('execute', { userToken: s.userToken, walletId: s.walletId, to: to, data: data }).then(function (r) {
        if (step) step('approve');
        return approve(s, r.challengeId).then(function () { return r.challengeId; });
      }).then(function (challengeId) {
        if (step) step('sending');
        var tries = 0;
        return (function txOf() {
          return post('challenge', { userToken: s.userToken, id: challengeId }).then(function (c) {
            if (c.status === 'FAILED' || c.status === 'EXPIRED') throw new Error(c.error || 'Circle could not send it.');
            if (c.transactionId) return c.transactionId;
            if (++tries > 60) throw new Error('Circle has not sent it yet; check My orders in a minute.');
            return wait(2000).then(txOf);
          });
        })();
      }).then(function (txId) {
        var tries = 0;
        return (function hashOf() {
          return post('tx', { userToken: s.userToken, id: txId }).then(function (t) {
            if (/^(FAILED|CANCELLED|DENIED)$/.test(t.state || '')) throw new Error(t.error || 'The transaction failed (' + t.state + ').');
            if (t.txHash) return t.txHash;
            if (++tries > 90) throw new Error('Circle has not sent it yet; check My orders in a minute.');
            return wait(2000).then(hashOf);
          });
        })();
      });
    }
  };
})();
