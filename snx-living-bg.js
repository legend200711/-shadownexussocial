/**
 * Shadow Nexus Social — Living Backgrounds System
 * snx-living-bg.js  v1.0.0  (SNS-2026-CINEMATIC-001)
 *
 * Responsibilities:
 *  1. Insert background DOM layers (fog, nebula, energy, stars)
 *  2. Render lightweight storm-cloud canvas animation
 *  3. Occasional distant lightning flash (rare, subtle)
 *  4. Floating ember/particle system (≤20 DOM nodes max)
 *  5. Page-visibility API — pause when hidden
 *  6. prefers-reduced-motion support
 *  7. User setting: "Living Backgrounds ON/OFF" (localStorage)
 *  8. Export SNXLivingBg for external toggle
 */

(function () {
    'use strict';

    /* ── Constants ── */
    var STORAGE_KEY   = 'snx_living_bg';
    var MAX_EMBERS    = 14; // kept very low for performance
    var LIGHTNING_MIN = 18000; // ms minimum between flashes
    var LIGHTNING_MAX = 60000; // ms maximum between flashes

    /* ── State ── */
    var _enabled       = true;
    var _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var _canvas        = null;
    var _ctx           = null;
    var _clouds        = [];
    var _embers        = [];
    var _raf           = null;
    var _lightningTimer= null;
    var _mounted       = false;
    var _paused        = false;

    /* ── Read saved preference ── */
    try {
        var _saved = localStorage.getItem(STORAGE_KEY);
        if (_saved === 'off') _enabled = false;
    } catch(e) {}

    /* ─────────────────────────────────────────────
       DOM LAYER INJECTION
       ───────────────────────────────────────────── */
    function _injectLayers() {
        if (_mounted) return;
        _mounted = true;

        // Nebula base
        var nebula = document.createElement('div');
        nebula.className = 'snx-bg-nebula snx-bg-layer';
        document.body.insertBefore(nebula, document.body.firstChild);

        // Stars
        var stars = document.createElement('div');
        stars.className = 'snx-bg-stars snx-bg-layer';
        document.body.insertBefore(stars, document.body.firstChild);

        // Fog layers
        var fog2 = document.createElement('div');
        fog2.className = 'snx-bg-fog2 snx-bg-layer';
        document.body.appendChild(fog2);

        var fog = document.createElement('div');
        fog.className = 'snx-bg-fog snx-bg-layer';
        document.body.appendChild(fog);

        // Energy sweep
        var energy = document.createElement('div');
        energy.className = 'snx-bg-energy snx-bg-layer';
        document.body.appendChild(energy);

        // Green accent
        var ga = document.createElement('div');
        ga.className = 'snx-bg-green-accent snx-bg-layer';
        document.body.appendChild(ga);
    }

    /* ─────────────────────────────────────────────
       STORM CLOUD CANVAS
       ───────────────────────────────────────────── */
    function _initCanvas() {
        _canvas = document.getElementById('bg-canvas');
        if (!_canvas) {
            _canvas = document.createElement('canvas');
            _canvas.id = 'bg-canvas';
            _canvas.className = 'snx-storm-canvas';
            document.body.insertBefore(_canvas, document.body.firstChild);
        }
        _ctx = _canvas.getContext('2d');
        _resizeCanvas();
        window.addEventListener('resize', _resizeCanvas);
        _initClouds();
    }

    function _resizeCanvas() {
        if (!_canvas) return;
        _canvas.width  = window.innerWidth;
        _canvas.height = window.innerHeight;
        _initClouds(); // re-scatter clouds after resize
    }

    function _initClouds() {
        if (!_canvas) return;
        _clouds = [];
        var count = _reducedMotion ? 2 : 5;
        for (var i = 0; i < count; i++) {
            _clouds.push({
                x:     Math.random() * _canvas.width,
                y:     Math.random() * (_canvas.height * 0.45),
                rx:    120 + Math.random() * 180,
                ry:    40  + Math.random() * 60,
                alpha: 0.03 + Math.random() * 0.05,
                speed: 0.08 + Math.random() * 0.12,
                dir:   Math.random() > 0.5 ? 1 : -1
            });
        }
    }

    function _drawClouds() {
        if (!_ctx || !_canvas) return;
        _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        for (var i = 0; i < _clouds.length; i++) {
            var c = _clouds[i];
            var grad = _ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.rx);
            grad.addColorStop(0,   'rgba(0,40,120,' + c.alpha + ')');
            grad.addColorStop(0.5, 'rgba(0,20,80,' + (c.alpha * 0.6) + ')');
            grad.addColorStop(1,   'rgba(0,10,40,0)');
            _ctx.beginPath();
            _ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, Math.PI * 2);
            _ctx.fillStyle = grad;
            _ctx.fill();
            // drift
            c.x += c.speed * c.dir;
            if (c.x > _canvas.width  + c.rx) c.x = -c.rx;
            if (c.x < -c.rx)                 c.x = _canvas.width + c.rx;
        }
    }

    /* ─────────────────────────────────────────────
       LIGHTNING — rare, distant, very subtle
       ───────────────────────────────────────────── */
    function _scheduleLightning() {
        if (_lightningTimer) clearTimeout(_lightningTimer);
        var delay = LIGHTNING_MIN + Math.random() * (LIGHTNING_MAX - LIGHTNING_MIN);
        _lightningTimer = setTimeout(_doLightning, delay);
    }

    function _doLightning() {
        if (!_enabled || _reducedMotion || _paused) { _scheduleLightning(); return; }
        // Only flash if page is visible and no media is playing
        if (document.hidden) { _scheduleLightning(); return; }
        // Create a brief full-page flash — very low opacity
        var flash = document.createElement('div');
        flash.style.cssText = [
            'position:fixed',
            'inset:0',
            'pointer-events:none',
            'z-index:9993',
            'background:rgba(100,160,255,0.06)',
            'transition:opacity 0.08s ease-out',
            'opacity:1'
        ].join(';');
        document.body.appendChild(flash);
        setTimeout(function () {
            flash.style.opacity = '0';
            setTimeout(function () {
                if (flash.parentNode) flash.parentNode.removeChild(flash);
            }, 120);
        }, 80);
        _scheduleLightning();
    }

    /* ─────────────────────────────────────────────
       EMBERS / FLOATING PARTICLES
       ───────────────────────────────────────────── */
    function _spawnEmber() {
        if (_embers.length >= MAX_EMBERS) return;
        if (!_enabled || _reducedMotion) return;
        var el = document.createElement('div');
        var isGreen = Math.random() < 0.2;
        el.className = 'ash-particle' + (isGreen ? ' green' : '');
        var duration = 10 + Math.random() * 12;
        var delay    = Math.random() * 4;
        var startX   = Math.random() * 100;
        el.style.cssText = [
            'left:' + startX + 'vw',
            'bottom:' + (-2 + Math.random() * 8) + 'vh',
            '--ash-dur:' + duration + 's',
            '--ash-delay:' + delay + 's'
        ].join(';');
        document.body.appendChild(el);
        _embers.push(el);
        // Remove when animation ends
        var totalMs = (duration + delay) * 1000;
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            var idx = _embers.indexOf(el);
            if (idx !== -1) _embers.splice(idx, 1);
        }, totalMs + 500);
    }

    /* ─────────────────────────────────────────────
       MAIN ANIMATION LOOP
       ───────────────────────────────────────────── */
    function _loop() {
        if (!_paused && _enabled) {
            _drawClouds();
        }
        _raf = requestAnimationFrame(_loop);
    }

    /* ─────────────────────────────────────────────
       PAUSE / RESUME (page visibility)
       ───────────────────────────────────────────── */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            _paused = true;
            document.documentElement.classList.add('snx-page-hidden');
        } else {
            _paused = false;
            document.documentElement.classList.remove('snx-page-hidden');
        }
    });

    /* ─────────────────────────────────────────────
       ENABLE / DISABLE
       ───────────────────────────────────────────── */
    function _applyState() {
        if (_enabled) {
            document.documentElement.classList.remove('snx-bg-off');
        } else {
            document.documentElement.classList.add('snx-bg-off');
            // Clear embers immediately
            _embers.slice().forEach(function (el) {
                if (el.parentNode) el.parentNode.removeChild(el);
            });
            _embers = [];
        }
    }

    function enable() {
        _enabled = true;
        try { localStorage.setItem(STORAGE_KEY, 'on'); } catch(e) {}
        _applyState();
    }

    function disable() {
        _enabled = false;
        try { localStorage.setItem(STORAGE_KEY, 'off'); } catch(e) {}
        _applyState();
    }

    function isEnabled() { return _enabled; }

    /* ─────────────────────────────────────────────
       INIT
       ───────────────────────────────────────────── */
    function init() {
        _applyState();
        if (!_reducedMotion) {
            _injectLayers();
            _initCanvas();
            _loop();
            // Spawn embers on a gentle interval
            if (_enabled) {
                setInterval(function () {
                    if (_enabled && !_paused && !document.hidden) _spawnEmber();
                }, 3500);
            }
            _scheduleLightning();
        } else {
            // Reduced motion: just inject static nebula + stars
            _injectLayers();
        }
    }

    /* Boot after DOM is ready */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ─────────────────────────────────────────────
       PUBLIC API
       ───────────────────────────────────────────── */
    window.SNXLivingBg = {
        enable:    enable,
        disable:   disable,
        isEnabled: isEnabled,
        toggle: function () {
            if (_enabled) disable(); else enable();
            return _enabled;
        }
    };

})();
