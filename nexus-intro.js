/**
 * nexus-intro.js
 * Shadow Nexus Social — Cinematic Welcome Experience
 *
 * Self-contained module. Does NOT touch Firebase, auth, or any existing
 * Shadow Nexus logic. Communicates only by:
 *   - Reading sessionStorage key 'snxIntroDone' to decide if intro should show
 *   - Listening for DOMContentLoaded to inject its overlay
 *   - Calling window.snxIntroCompleted() when the user dismisses the intro
 *     (which the main app wires to its own post-auth flow)
 */

(function () {
    'use strict';

    // ── Session key ──────────────────────────────────────────────────────────
    var SESSION_KEY = 'snxIntroDone';

    // ── Determine whether to show the intro ─────────────────────────────────
    // Show only once per browsing session UNLESS the user explicitly replays.
    // sessionStorage is cleared when the tab/browser is closed so PWA cold
    // starts and new sessions always see the full cinematic.
    function shouldShow() {
        // Replay flag written by replayNexusIntro()
        if (sessionStorage.getItem('snxIntroReplay') === '1') {
            sessionStorage.removeItem('snxIntroReplay');
            return true;
        }
        return !sessionStorage.getItem(SESSION_KEY);
    }

    // ── Expose replay trigger (called from Settings) ─────────────────────────
    window.replayNexusIntro = function () {
        sessionStorage.setItem('snxIntroReplay', '1');
        sessionStorage.removeItem(SESSION_KEY);
        // Rebuild and re-run the overlay
        var old = document.getElementById('snxIntroOverlay');
        if (old) old.remove();
        _buildAndRun();
    };

    // ── SVG helpers (inline, no external files) ─────────────────────────────
    function _wolfSVG() {
        // Simple stylised wolf silhouette (path)
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="#000" ' +
            'aria-hidden="true" focusable="false" role="img">' +
            '<path d="M10,105 C10,105 0,85 8,70 C14,58 28,55 28,55 L18,38 C18,38 28,44 36,42 ' +
            'C44,40 46,30 52,26 C58,22 68,28 68,28 L62,10 C62,10 72,20 78,20 ' +
            'C84,20 90,12 90,12 L88,30 C88,30 98,22 110,24 ' +
            'C122,26 130,36 134,44 C138,52 136,60 140,64 ' +
            'C144,68 158,68 166,72 C174,76 180,88 180,88 ' +
            'L188,76 C188,76 194,90 190,100 C186,110 170,110 170,110 ' +
            'L140,110 C140,110 136,96 130,92 C124,88 114,90 108,90 ' +
            'C102,90 96,96 92,100 C88,104 82,110 82,110 ' +
            'L52,110 C52,110 44,104 38,100 C32,96 26,98 22,102 C18,106 10,105 10,105 Z" />' +
            // Tail arc
            '<path d="M170,110 C178,90 200,82 198,70 C196,58 188,62 182,68" stroke="#000" stroke-width="4" fill="none"/>' +
            '</svg>';
    }

    function _catSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 70" fill="#000" ' +
            'aria-hidden="true" focusable="false" role="img">' +
            // Body
            '<ellipse cx="60" cy="45" rx="38" ry="18"/>' +
            // Head
            '<circle cx="28" cy="30" r="15"/>' +
            // Ears
            '<polygon points="18,18 14,4 26,16"/>' +
            '<polygon points="32,18 38,4 26,16"/>' +
            // Tail (up)
            '<path d="M98,45 Q118,30 112,14" stroke="#000" stroke-width="5" fill="none" stroke-linecap="round"/>' +
            // Legs
            '<rect x="22" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="34" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="64" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="76" y="56" width="8" height="12" rx="3"/>' +
            '</svg>';
    }

    function _crowSVG() {
        // Simplified crow in-flight silhouette
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 28" fill="#000" ' +
            'aria-hidden="true" focusable="false" role="img">' +
            // Body
            '<ellipse cx="32" cy="18" rx="14" ry="6"/>' +
            // Left wing up
            '<path d="M18,18 Q4,4 0,8 Q8,12 18,18 Z"/>' +
            // Right wing up
            '<path d="M46,18 Q60,4 64,8 Q56,12 46,18 Z"/>' +
            // Head + beak
            '<circle cx="20" cy="15" r="5"/>' +
            '<path d="M16,14 L8,12 L16,16 Z"/>' +
            '</svg>';
    }

    // ── Build the overlay HTML ───────────────────────────────────────────────
    function _buildOverlay() {
        var el = document.createElement('div');
        el.id = 'snxIntroOverlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Shadow Nexus Social cinematic welcome');

        el.innerHTML =
            // Stars
            '<div id="snxIntroStars" aria-hidden="true"></div>' +

            // Atmospheric lightning bolts (slow, not strobe)
            '<div id="snxIntroLightning" aria-hidden="true">' +
            '<div class="snxi-bolt"></div>' +
            '<div class="snxi-bolt"></div>' +
            '<div class="snxi-bolt"></div>' +
            '<div class="snxi-bolt"></div>' +
            '</div>' +

            // Fog
            '<div id="snxIntroFog" aria-hidden="true">' +
            '<div class="snxi-fog-band"></div>' +
            '<div class="snxi-fog-band"></div>' +
            '<div class="snxi-fog-band"></div>' +
            '</div>' +

            // Portal ring
            '<div id="snxIntroPortal" aria-hidden="true">' +
            '<div class="snxi-portal-ring"></div>' +
            '<div class="snxi-portal-ring"></div>' +
            '<div class="snxi-portal-ring"></div>' +
            '<div class="snxi-portal-ring"></div>' +
            '<div class="snxi-portal-core"></div>' +
            '</div>' +

            // Forest silhouette
            '<div id="snxIntroForest" aria-hidden="true">' +
            '<div class="snxi-tree"></div><div class="snxi-tree"></div>' +
            '<div class="snxi-tree"></div><div class="snxi-tree"></div>' +
            '<div class="snxi-tree"></div><div class="snxi-tree"></div>' +
            '<div class="snxi-tree"></div><div class="snxi-tree"></div>' +
            '<div class="snxi-tree"></div><div class="snxi-tree"></div>' +
            '<div class="snxi-tree"></div>' +
            '</div>' +

            // Wolf
            '<div id="snxIntroWolf" aria-hidden="true">' + _wolfSVG() + '</div>' +

            // Crows
            '<div id="snxIntroCrows" aria-hidden="true"></div>' +

            // Cat
            '<div id="snxIntroCat" aria-hidden="true">' + _catSVG() + '</div>' +

            // Blue flames
            '<div id="snxIntroFlames" aria-hidden="true">' +
            '<div class="snxi-flame"></div><div class="snxi-flame"></div>' +
            '<div class="snxi-flame"></div><div class="snxi-flame"></div>' +
            '<div class="snxi-flame"></div><div class="snxi-flame"></div>' +
            '<div class="snxi-flame"></div><div class="snxi-flame"></div>' +
            '<div class="snxi-flame"></div><div class="snxi-flame"></div>' +
            '</div>' +

            // Title
            '<div id="snxIntroTitle">' +
            '<div class="snxi-welcome-to">Welcome to</div>' +
            '<div class="snxi-main-title">SHADOW <span>NEXUS</span> SOCIAL</div>' +
            '<div class="snxi-tagline">Stay Legendary</div>' +
            '</div>' +

            // Enter button
            '<button id="snxIntroEnterBtn" type="button" ' +
            'aria-label="Enter the Nexus and open Shadow Nexus Social">ENTER THE NEXUS</button>' +

            // Sound toggle (default muted — no autoplay)
            '<button id="snxIntroSoundBtn" type="button" aria-pressed="false" ' +
            'aria-label="Toggle intro sound">🔇 Sound</button>' +

            // Skip
            '<button id="snxIntroSkipBtn" type="button" aria-label="Skip intro">Skip Intro ›</button>';

        return el;
    }

    // ── Inject crows ────────────────────────────────────────────────────────
    function _injectCrows() {
        var container = document.getElementById('snxIntroCrows');
        if (!container) return;
        var crows = [
            { top: '12%', dur: '16s', delay: '1.5s' },
            { top: '18%', dur: '20s', delay: '4s' },
            { top: '9%',  dur: '14s', delay: '7s' },
            { top: '22%', dur: '18s', delay: '11s' },
            { top: '15%', dur: '22s', delay: '2s' },
            { top: '8%',  dur: '17s', delay: '15s' },
        ];
        crows.forEach(function (c) {
            var d = document.createElement('div');
            d.className = 'snxi-crow';
            d.style.setProperty('--cy', c.top);
            d.style.setProperty('--cdur', c.dur);
            d.style.setProperty('--cdelay', c.delay);
            d.innerHTML = _crowSVG();
            container.appendChild(d);
        });
    }

    // ── Exit sequence ────────────────────────────────────────────────────────
    function _runExit(overlay) {
        // 1. Expand portal
        var portal = document.getElementById('snxIntroPortal');
        if (portal) portal.classList.add('snxi-portal-expand');

        // 2. Expand fog
        var fogs = overlay.querySelectorAll('.snxi-fog-band');
        fogs.forEach(function (f) { f.classList.add('snxi-fog-expand'); });

        // 3. Fade title
        var title = document.getElementById('snxIntroTitle');
        if (title) title.classList.add('snxi-title-exit');

        // 4. Fade entire overlay
        setTimeout(function () {
            overlay.classList.add('snxi-exit');
        }, 600);

        // 5. Remove from DOM after transition
        setTimeout(function () {
            overlay.classList.add('snxi-gone');
            // Fire any hooked callback
            if (typeof window.snxIntroCompleted === 'function') {
                window.snxIntroCompleted();
            }
        }, 2500);
    }

    // ── Audio (optional, muted by default) ──────────────────────────────────
    var _audioCtx = null;
    var _audioMuted = true;

    function _toggleSound() {
        var btn = document.getElementById('snxIntroSoundBtn');
        _audioMuted = !_audioMuted;
        if (btn) {
            btn.textContent = _audioMuted ? '🔇 Sound' : '🔊 Sound';
            btn.setAttribute('aria-pressed', String(!_audioMuted));
        }
        if (!_audioMuted) _startAmbient();
        else if (_audioCtx) _audioCtx.suspend().catch(function(){});
    }

    function _startAmbient() {
        // Synthesize a very gentle ambient hum with the Web Audio API.
        // No external audio files required — zero network requests.
        try {
            if (!_audioCtx) {
                _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (_audioCtx.state === 'suspended') _audioCtx.resume();

            // Low drone
            var osc1 = _audioCtx.createOscillator();
            var gain1 = _audioCtx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(55, _audioCtx.currentTime);
            gain1.gain.setValueAtTime(0, _audioCtx.currentTime);
            gain1.gain.linearRampToValueAtTime(0.06, _audioCtx.currentTime + 3);
            osc1.connect(gain1);
            gain1.connect(_audioCtx.destination);
            osc1.start();

            // Higher harmonic
            var osc2 = _audioCtx.createOscillator();
            var gain2 = _audioCtx.createGain();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(110, _audioCtx.currentTime);
            gain2.gain.setValueAtTime(0, _audioCtx.currentTime);
            gain2.gain.linearRampToValueAtTime(0.03, _audioCtx.currentTime + 4);
            osc2.connect(gain2);
            gain2.connect(_audioCtx.destination);
            osc2.start();

            // Fade them both when overlay exits
            window.addEventListener('snxIntroExit', function () {
                var t = _audioCtx.currentTime;
                gain1.gain.linearRampToValueAtTime(0, t + 2);
                gain2.gain.linearRampToValueAtTime(0, t + 2);
                setTimeout(function () {
                    try { osc1.stop(); osc2.stop(); } catch (_) {}
                }, 2200);
            }, { once: true });

        } catch (e) { /* Web Audio not available — silent fallback */ }
    }

    // ── Main build + run ─────────────────────────────────────────────────────
    function _buildAndRun() {
        var overlay = _buildOverlay();
        document.body.insertBefore(overlay, document.body.firstChild);
        _injectCrows();

        // ── Wire buttons ────────────────────────────────────────────────────
        var enterBtn = document.getElementById('snxIntroEnterBtn');
        var skipBtn  = document.getElementById('snxIntroSkipBtn');
        var soundBtn = document.getElementById('snxIntroSoundBtn');

        function _doEnter() {
            sessionStorage.setItem(SESSION_KEY, '1');
            // Dispatch event so ambient audio can fade
            window.dispatchEvent(new CustomEvent('snxIntroExit'));
            _runExit(overlay);
        }

        if (enterBtn) {
            enterBtn.addEventListener('click', _doEnter);
            enterBtn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _doEnter(); }
            });
        }
        if (skipBtn)  {
            skipBtn.addEventListener('click', _doEnter);
            skipBtn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _doEnter(); }
            });
        }
        if (soundBtn) {
            soundBtn.addEventListener('click', _toggleSound);
        }

        // ── Escape key exits ─────────────────────────────────────────────────
        document.addEventListener('keydown', function _escListener(e) {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', _escListener);
                _doEnter();
            }
        });

        // ── Focus management: trap focus inside overlay while visible ────────
        overlay.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') return;
            var focusable = Array.from(overlay.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
            if (!focusable.length) return;
            var first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey) { if (document.activeElement === first) { last.focus(); e.preventDefault(); } }
            else            { if (document.activeElement === last)  { first.focus(); e.preventDefault(); } }
        });

        // Auto-focus the Skip button so keyboard users can dismiss immediately
        setTimeout(function () {
            var sb = document.getElementById('snxIntroSkipBtn');
            if (sb) sb.focus();
        }, 50);
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function _init() {
        if (!shouldShow()) return;
        _buildAndRun();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }

})();
