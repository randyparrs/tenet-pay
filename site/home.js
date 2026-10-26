/*
  paytenet.site home page behavior.
  1. Hero flow animation (canvas)
  2. Product tiles (hover on pointer devices, click or tap to pin)
  3. Scroll reveals and hero intro
  4. Metric placeholders: window.Tenet.setMetrics({...})
  All motion respects prefers-reduced-motion. With reduced motion the diagram is drawn once, static.
*/
(function () {
  "use strict";

  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  function reducedMotion() { return motionQuery.matches; }

  /* Metrics */
  var METRIC_FIELDS = {
    verdictsExpected: "verdicts-expected",
    verdictsTotal: "verdicts-total",
    committeeCorrect: "committee-correct",
    committeeTotal: "committee-total",
    ordersSettled: "orders-settled"
  };

  function setMetrics(values) {
    if (!values) return;
    Object.keys(METRIC_FIELDS).forEach(function (key) {
      if (values[key] === undefined || values[key] === null) return;
      var el = document.querySelector('[data-field="' + METRIC_FIELDS[key] + '"]');
      if (el) el.textContent = String(values[key]);
    });
  }

  /* Product tiles */
  function initTiles() {
    var tiles = Array.prototype.slice.call(document.querySelectorAll("[data-tile]"));
    var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var pinned = null;
    var hovered = null;

    function render() {
      var open = pinned !== null ? pinned : hovered;
      tiles.forEach(function (tile) {
        var isOpen = tile === open;
        tile.setAttribute("data-open", isOpen ? "true" : "false");
        var toggle = tile.querySelector("[data-tile-toggle]");
        if (toggle) toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        tile.querySelectorAll(".tile__link").forEach(function (link) {
          link.tabIndex = isOpen ? 0 : -1;
        });
      });
    }

    tiles.forEach(function (tile) {
      if (canHover) {
        tile.addEventListener("mouseenter", function () { hovered = tile; render(); });
        tile.addEventListener("mouseleave", function () { if (hovered === tile) hovered = null; render(); });
      }
      tile.addEventListener("click", function (event) {
        if (event.target.closest && event.target.closest("a")) return;
        if (pinned === tile) { pinned = null; hovered = null; } else { pinned = tile; }
        render();
      });
      tile.addEventListener("focusin", function (event) {
        if (event.target.classList && event.target.classList.contains("tile__link")) { pinned = tile; render(); }
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && pinned) { pinned = null; render(); }
    });

    render();
  }

  /* Scroll reveal and hero intro */
  function initReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    if (reducedMotion() || !("IntersectionObserver" in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove("reveal-pending");
        io.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });

    els.forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.95) return;
      var delay = parseInt(el.getAttribute("data-reveal-delay") || "0", 10);
      el.classList.add("reveal-pending");
      void el.offsetWidth;
      el.classList.add("reveal-ready");
      el.style.transitionDelay = delay + "ms";
      io.observe(el);
    });
  }

  function initIntro() {
    if (reducedMotion()) return;
    var els = document.querySelectorAll("#hero [data-intro]");
    Array.prototype.forEach.call(els, function (el, i) {
      if (!el.animate) return;
      el.animate(
        [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
        { duration: 1000, delay: 100 + i * 120, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }
      );
    });
  }

  function initAmbient() {
    if (reducedMotion()) return;
    var ring = document.getElementById("flow-escrow-ring");
    if (ring && ring.animate) {
      ring.animate(
        [{ transform: "scale(0.6)", opacity: 0.7 }, { transform: "scale(2.2)", opacity: 0 }],
        { duration: 2800, iterations: Infinity, easing: "ease-out" }
      );
    }
    Array.prototype.forEach.call(document.querySelectorAll(".metric__dot"), function (dot, i) {
      if (!dot.animate) return;
      dot.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }],
        { duration: 2400, delay: i * 500, iterations: Infinity, easing: "ease-in-out" });
    });
  }

  /* Hero flow diagram. Positions are fractions of the canvas and must match the node CSS in styles.css. */
  var NODES = {
    buyers: [0.07, 0.64],
    escrow: [0.5, 0.64],
    judge: [0.5, 0.15],
    lacre: [0.2, 0.15],
    refund: [0.91, 0.34],
    release: [0.91, 0.86]
  };

  var FLOW = {
    cycleSeconds: 6,
    paymentLines: 15,
    bundleLines: 9,
    green: "95,216,150",
    greenLight: "160,240,195",
    white: "235,242,238"
  };

  function initFlow() {
    var canvas = document.getElementById("flow-canvas");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");

    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

    var payments = [];
    for (var i = 0; i < FLOW.paymentLines; i++) {
      payments.push({ k: i - (FLOW.paymentLines - 1) / 2, phase: rnd(), speed: 0.8 + rnd() * 0.5 });
    }
    var bundles = [];
    ["refund", "release"].forEach(function (target) {
      for (var j = 0; j < FLOW.bundleLines; j++) {
        bundles.push({ target: target, k: j - (FLOW.bundleLines - 1) / 2, jitter: rnd() });
      }
    });

    var w = 0, h = 0, raf = 0, visible = true, start = 0;
    var curvesIn = [], curvesOut = [], lacreLine = null, verdictLine = null;

    function pt(name) { return [NODES[name][0] * w, NODES[name][1] * h]; }
    function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    function straight(a, b) { return [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b]; }

    function build() {
      var B = pt("buyers"), E = pt("escrow");
      curvesIn = payments.map(function (p) {
        return [B, [B[0] + w * 0.14, B[1] + p.k * h * 0.04], [E[0] - w * 0.14, E[1] + p.k * h * 0.04], E];
      });
      curvesOut = bundles.map(function (b) {
        var T = pt(b.target);
        return [E, [E[0] + w * 0.1, E[1] + (T[1] - E[1]) * 0.2 + b.k * h * 0.014], [T[0] - w * 0.12, T[1] + b.k * h * 0.03], T];
      });
      lacreLine = straight(pt("lacre"), pt("judge"));
      verdictLine = straight(pt("judge"), E);
    }

    function bezier(q, t) {
      var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      return [
        a * q[0][0] + b * q[1][0] + c * q[2][0] + d * q[3][0],
        a * q[0][1] + b * q[1][1] + c * q[2][1] + d * q[3][1]
      ];
    }

    function stroke(q) {
      ctx.beginPath();
      ctx.moveTo(q[0][0], q[0][1]);
      ctx.bezierCurveTo(q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]);
      ctx.stroke();
    }

    function spark(q, t, len, rgb, amp) {
      var n = 8;
      for (var i = 0; i < n; i++) {
        var a = t - len + (len * i) / n, b = t - len + (len * (i + 1)) / n;
        if (b <= 0 || a >= 1) continue;
        var p = bezier(q, Math.max(0, a)), p2 = bezier(q, Math.min(1, b));
        ctx.strokeStyle = "rgba(" + rgb + "," + amp * ((i + 1) / n) + ")";
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
      }
    }

    function chevron(q, t, color) {
      var p = bezier(q, t);
      var dx = q[3][0] - q[0][0], dy = q[3][1] - q[0][1];
      var m = Math.hypot(dx, dy) || 1, ux = dx / m, uy = dy / m, s = 4;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p[0] - ux * s - uy * s, p[1] - uy * s + ux * s);
      ctx.lineTo(p[0], p[1]);
      ctx.lineTo(p[0] - ux * s + uy * s, p[1] - uy * s - ux * s);
      ctx.stroke();
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }

    function draw(timeMs) {
      if (!w) return;
      var still = reducedMotion();
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      ctx.lineWidth = 0.8;

      ctx.strokeStyle = still ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.11)";
      curvesIn.forEach(stroke);
      ctx.strokeStyle = still ? "rgba(" + FLOW.green + ",0.45)" : "rgba(" + FLOW.green + ",0.28)";
      curvesOut.forEach(stroke);

      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.3)"; stroke(lacreLine);
      ctx.strokeStyle = "rgba(" + FLOW.green + ",0.5)"; stroke(verdictLine);
      ctx.setLineDash([]);
      chevron(lacreLine, 0.72, "rgba(255,255,255,0.5)");
      chevron(verdictLine, 0.72, "rgba(" + FLOW.green + ",0.75)");

      if (still) return;

      var s = timeMs / 1000;
      var cycle = (s % FLOW.cycleSeconds) / FLOW.cycleSeconds;
      var E = pt("escrow");
      ctx.lineWidth = 1.3;

      /* Payments arrive continuously */
      curvesIn.forEach(function (q, i) {
        var p = payments[i];
        spark(q, (((s / FLOW.cycleSeconds) * p.speed + p.phase) % 1) * 1.15, 0.14, FLOW.greenLight, 0.75);
      });

      /* Signed emails reach the judge, then the verdict drops to escrow */
      if (cycle > 0.1 && cycle < 0.34) spark(lacreLine, ((cycle - 0.1) / 0.2) * 1.25, 0.25, FLOW.white, 0.9);
      if (cycle > 0.3 && cycle < 0.54) spark(verdictLine, ((cycle - 0.3) / 0.2) * 1.3, 0.3, FLOW.green, 1);

      /* Escrow glow as the verdict lands */
      if (cycle > 0.48 && cycle < 0.62) {
        var g = 1 - (cycle - 0.48) / 0.14;
        var grad = ctx.createRadialGradient(E[0], E[1], 0, E[0], E[1], 46);
        grad.addColorStop(0, "rgba(" + FLOW.green + "," + 0.35 * g + ")");
        grad.addColorStop(1, "rgba(" + FLOW.green + ",0)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(E[0], E[1], 46, 0, Math.PI * 2); ctx.fill();
      }

      /* Bundles split toward refund and release */
      if (cycle > 0.48) {
        curvesOut.forEach(function (q, i) {
          spark(q, ((cycle - 0.48) / 0.42) * 1.25 - bundles[i].jitter * 0.12, 0.2, FLOW.green, 0.95);
        });
      }
    }

    function loop(t) {
      if (!start) start = t;
      draw(t - start + 1500);
      raf = visible && !reducedMotion() ? requestAnimationFrame(loop) : 0;
    }

    function startLoop() {
      if (!raf && visible && !reducedMotion()) raf = requestAnimationFrame(loop);
    }

    resize();
    draw(4000);

    if ("ResizeObserver" in window) {
      new ResizeObserver(function () { resize(); draw(4000); }).observe(canvas);
    } else {
      window.addEventListener("resize", function () { resize(); draw(4000); });
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) startLoop();
      }).observe(canvas);
    }

    var onMotionChange = function () {
      if (reducedMotion()) { cancelAnimationFrame(raf); raf = 0; draw(4000); }
      else startLoop();
    };
    if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
    else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

    startLoop();
  }

  function init() {
    initTiles();
    initFlow();
    initReveal();
    initIntro();
    initAmbient();
  }

  window.Tenet = { setMetrics: setMetrics };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
