/* claude-manager.com — private first-party visitor beacon.
 * Static-site port of the VisitorTracker (visitor-stats skill, 2026-07-14),
 * cloned from the imperabusinessservices.com build.
 *
 * Records: pageviews, real time-on-page (visible time only), the acquisition
 * source of the visit (paid ad vs organic vs social vs direct), and the site's
 * three key actions:
 *    book -> a download actually STARTED   (label says which button + which route)
 *    call -> an email was given at the download popup (a real lead)
 *    dirs -> clicked out to the GitHub repo or the Impera site
 *
 * navigator.sendBeacon, no cookies, nothing render-blocking, no external lib.
 * Nothing here ever throws into the page.
 *
 * NOTE ON THE DOWNLOAD BUTTONS: nav/hero/main all start life as "#download"
 * jump links and are rewritten to a REAL release URL once the GitHub API call
 * in index.html resolves. All three also open the email popup (unless the
 * visitor already gave an email, or capture is off). So "a download started"
 * is only true when the popup did NOT open AND the href is a real URL --
 * which is exactly what the click handler below tests.
 */
(function () {
  "use strict";
  var SITE = "manager";
  var ENDPOINT = "https://web-analytics.imperabusinessservices.com/scollect-manager";
  var DWELL_CAP = 45 * 60 * 1000;

  function rid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function ids() {
    var vid = "", sid = "";
    try {
      vid = localStorage.getItem("_svid") || "";
      if (!vid) { vid = rid(); localStorage.setItem("_svid", vid); }
      sid = sessionStorage.getItem("_ssid") || "";
      if (!sid) { sid = rid(); sessionStorage.setItem("_ssid", sid); }
    } catch (e) { /* private mode: ids stay blank, still counts as a visit */ }
    return { vid: vid, sid: sid };
  }

  function classifyChannel() {
    try {
      var q = new URLSearchParams(location.search);
      var val = function (k) { return (q.get(k) || "").trim(); };
      if (val("gclid") || val("gbraid") || val("wbraid") || val("gad_source")) return "google-cpc";
      if (val("fbclid")) return "meta-cpc";
      var src = val("utm_source").toLowerCase();
      var med = val("utm_medium").toLowerCase();
      if (med) {
        if (/cp[cv]|ppc|paid/.test(med)) {
          if (/goog|adwords/.test(src)) return "google-cpc";
          if (/face|fb|meta|insta|\big\b/.test(src)) return "meta-cpc";
          return "paid";
        }
        if (med === "email") return "email";
        if (med.indexOf("social") > -1) return "social";
        return "referral";
      }
      var ref = document.referrer || "";
      if (!ref) return "direct";
      var host = "";
      try { host = new URL(ref).hostname.toLowerCase(); } catch (e) { host = ""; }
      var strip = function (h) { return h.replace(/^www\./, ""); };
      if (host && strip(host) === strip(location.hostname.toLowerCase())) return "direct";
      if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\.|search\.brave/.test(host)) return "organic";
      if (/(^|\.)(facebook|instagram|twitter|linkedin|reddit|pinterest|tiktok)\.|(^|\.)(t\.co|x\.com|fb\.com|lnkd\.in)$/.test(host)) return "social";
      return "referral";
    } catch (e) { return "direct"; }
  }

  function sessionChannel() {
    try {
      var c = sessionStorage.getItem("_schan");
      if (!c) { c = classifyChannel(); sessionStorage.setItem("_schan", c); }
      return c;
    } catch (e) { return classifyChannel(); }
  }

  function beacon(ev) {
    try {
      var who = ids();
      var base = {
        site: SITE, vid: who.vid, sid: who.sid, ets: Date.now(),
        path: location.pathname, ref: document.referrer || ""
      };
      for (var k in ev) base[k] = ev[k];
      var body = JSON.stringify(base);
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, body);
      else fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, mode: "no-cors" }).catch(function () {});
    } catch (e) { /* never let tracking throw into the page */ }
  }

  // ---- pageview + dwell (multi-page static site: one page per document) ----
  var visibleMs = 0;
  var shownAt = document.visibilityState === "visible" ? Date.now() : 0;
  beacon({ typ: "pageview", title: document.title, label: "chan:" + sessionChannel() });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (shownAt) { visibleMs += Date.now() - shownAt; shownAt = 0; }
    } else {
      shownAt = Date.now();
    }
  });
  window.addEventListener("pagehide", function () {
    if (shownAt) { visibleMs += Date.now() - shownAt; shownAt = 0; }
    var d = Math.min(visibleMs, DWELL_CAP);
    if (d > 0) beacon({ typ: "dwell", dwell: d, title: document.title });
    visibleMs = 0;
  });

  // ---- key actions ----
  // These strings land in the dashboard verbatim, after "Download started · ",
  // so each one has to read as a finished phrase on its own.
  var DL_BTNS = {
    navDownload: "from the nav button",
    heroDownload: "from the hero button",
    mainDownload: "from the big download button"
  };

  function gateOpen() {
    var g = document.getElementById("emailGate");
    return !!(g && g.classList.contains("open"));
  }
  function dl(label) { beacon({ typ: "book", label: "Download started | " + label, title: document.title }); }

  // BUBBLE phase (not capture): the page's own button handlers must run first so
  // that gateOpen() below reports whether the popup just intercepted this click.
  document.addEventListener("click", function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a") : null;
    if (!a) return;
    var id = a.id || "";

    // "No thanks, just download" -> the popup hands off to the real download
    if (id === "egateSkip") { dl("skipped the email popup"); return; }

    // the three Download buttons
    if (DL_BTNS[id]) {
      if (gateOpen()) return;                 // popup opened; no download yet
      var href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#") return;  // pre-hydration: just a jump to the download section
      dl(DL_BTNS[id]);
      return;
    }

    // the "On Mac? Get the Mac version" cross-platform link (hidden until hydrated)
    if (id === "otherPlatform") {
      var h2 = a.getAttribute("href") || "";
      if (h2 && h2.charAt(0) !== "#") dl("from the other-platform link");
      return;
    }

    // outbound clicks (the download buttons above already returned)
    var hl = (a.getAttribute("href") || "").toLowerCase();
    if (hl.indexOf("github.com/imperabusinessservices") > -1) {
      beacon({ typ: "dirs", label: "Opened the GitHub repo", title: document.title });
    } else if (hl.indexOf("imperabusinessservices.com") > -1) {
      beacon({ typ: "dirs", label: "Clicked through to the Impera site", title: document.title });
    }
  }, false);

  // Email given at the download popup = a real lead. The page's own submit
  // handler runs first and always preventDefaults, so mirror its validity +
  // honeypot checks here or we'd count typo'd/bot submissions as leads.
  var form = document.getElementById("egateForm");
  if (form) {
    form.addEventListener("submit", function () {
      try {
        var input = document.getElementById("egateEmail");
        var email = ((input && input.value) || "").trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;   // same test index.html makes
        var bot = document.getElementById("egateBot");
        if (bot && bot.checked) return;                          // honeypot tripped: not a person
        beacon({ typ: "call", label: "Gave their email at the download popup", title: document.title });
        dl("gave their email first");
      } catch (e2) { /* ignore */ }
    }, false);
  }

  // ---- wrap gtag & fbq (log tag fires; always call the original through) ----
  function hook() {
    var w = window;
    if (typeof w.gtag === "function" && !w.gtag.__st) {
      var g = w.gtag;
      var ng = function () {
        var args = Array.prototype.slice.call(arguments);
        try {
          if (args[0] === "event") {
            var p = args[2] || {};
            beacon({ typ: "gtag", label: "GA/Ads: " + String(args[1]) + (p.send_to ? " → " + p.send_to : ""), title: document.title });
          }
        } catch (e) { /* ignore */ }
        return g.apply(this, args);
      };
      ng.__st = true; w.gtag = ng;
    }
    if (typeof w.fbq === "function" && !w.fbq.__st) {
      var f = w.fbq;
      var nf = function () {
        var args = Array.prototype.slice.call(arguments);
        try {
          if (args[0] === "track") {
            var p2 = args[2] || {};
            beacon({ typ: "fbq", label: "Meta Pixel: " + String(args[1]) + (p2.content_name ? " (" + p2.content_name + ")" : ""), title: document.title });
          }
        } catch (e) { /* ignore */ }
        return f.apply(this, args);
      };
      for (var k in f) { try { nf[k] = f[k]; } catch (e) { /* ignore */ } }
      nf.__st = true; w.fbq = nf;
    }
  }
  hook();
  var iv = setInterval(hook, 600);
  setTimeout(function () { clearInterval(iv); }, 30000);
})();
