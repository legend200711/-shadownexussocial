/**
 * Shadow Nexus Social — ShadowNexusEnvironmentController
 * snx-living-bg.js  v4.0.0  (SNS-2026-WORLD-ENV-001)
 *
 * Single authority for the entire animated world environment.
 * The canvas engine (ECLIPSE STORM ENGINE) lives in index.html and
 * communicates via window globals. This controller manages:
 *
 *   1. Enable / disable the entire environment (localStorage preference)
 *   2. Section mood — updates CSS class + canvas engine mood
 *   3. Page visibility — pause CSS animations when tab is hidden
 *   4. Environmental UI reactions (nav open, music, live, notifications)
 *   5. Music reaction — gentle glow breathing when music plays
 *   6. Parallax layer shift on mouse movement (desktop)
 *   7. CSS DOM layer injection (clouds, fog, energy, stars, green accent)
 *   8. Public API: window.SNXLivingBg and window.ShadowNexusEnvironmentController
 *
 * DOES NOT: create a second canvas, second RAF loop, second rain engine,
 * second resize listener, or second particle spawner. The canvas engine
 * is the sole renderer; this file only manages CSS layers and state.
 */

(function () {
    'use strict';

    /* ──────────────────────────────────────────────────────
       CONSTANTS
    ────────────────────────────────────────────────────── */
    var STORAGE_KEY = 'snx_living_bg';

    /* Section → mood map */
    var MOOD_MAP = {
        'feed':              'feed',
        'studioPage':        'music',
        'nexusPage':         'music',
        'liveHubPage':       'live',
        'inboxPage':         'messages',
        'profile':           'profile',
        'profilePage':       'profile',
        'settingsPage':      'profile',
        'notificationsPage': 'feed',
        'searchPage':        'feed',
        'communityPage':     'feed',
        'friendsPage':       'feed',
        'stormRoomsPage':    'live',
        'supportRoomsPage':  'feed',
        'adminPage':         'profile',
        'moderatorPage':     'profile',
        'administratorPage': 'profile'
    };

    var MOOD_CLASSES = [
        'snx-mood-feed', 'snx-mood-music', 'snx-mood-live',
        'snx-mood-messages', 'snx-mood-profile'
    ];

    /* ──────────────────────────────────────────────────────
       STATE
    ────────────────────────────────────────────────────── */
    var _enabled       = true;
    var _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var _mounted       = false;
    var _currentMood   = 'feed';
    var _musicPlaying  = false;
    var _musicPulseRaf = null;
    var _parallaxRaf   = null;
    var _mouseX        = 0.5;
    var _mouseY        = 0.5;
    var _parallaxTX    = 0;
    var _parallaxTY    = 0;

    /* Read saved preference */
    try {
        var _saved = localStorage.getItem(STORAGE_KEY);
        if (_saved === 'off') _enabled = false;
    } catch (e) {}

    /* ──────────────────────────────────────────────────────
       DOM LAYER INJECTION
    ────────────────────────────────────────────────────── */
    function _injectLayers() {
        if (_mounted) return;
        _mounted = true;

        /* Safety check: ensure the Nexus Realm artwork element exists.
           It is placed statically in the HTML but inject it here as a
           fallback in case the HTML version is somehow absent. */
        if (!document.getElementById('snx-realm-artwork')) {
            var artwork = _el('div', 'snx-realm-artwork', '');
            document.body.insertBefore(artwork, document.body.firstChild);
        }
        if (!document.getElementById('snx-readability-overlay')) {
            var readability = _el('div', 'snx-readability-overlay', '');
            document.body.insertBefore(readability, document.body.firstChild);
        }

        /* Nebula base — atmospheric tint above artwork (z: -2) */
        var nebula = _el('div', 'snx-nebula-layer', 'snx-bg-nebula snx-bg-layer');
        document.body.insertBefore(nebula, document.body.firstChild);

        /* Deep stars (z: -1 area, behind canvas) */
        var stars = _el('div', 'snx-stars-layer', 'snx-bg-stars snx-bg-layer');
        document.body.insertBefore(stars, document.body.firstChild);

        /* Storm clouds layer 1 */
        var clouds = _el('div', 'snx-clouds-layer', 'snx-bg-clouds snx-bg-layer');
        document.body.appendChild(clouds);

        /* Storm clouds layer 2 — counter-drift */
        var clouds2 = _el('div', 'snx-clouds2-layer', 'snx-bg-clouds2 snx-bg-layer');
        document.body.appendChild(clouds2);

        /* Storm clouds layer 3 — slower upper bank */
        var clouds3 = _el('div', 'snx-clouds3-layer', 'snx-bg-clouds3 snx-bg-layer');
        document.body.appendChild(clouds3);

        /* Fog layer upper (z: 3) */
        var fog2 = _el('div', 'snx-fog2-layer', 'snx-bg-fog2 snx-bg-layer');
        document.body.appendChild(fog2);

        /* Fog layer lower (z: 4) */
        var fog = _el('div', 'snx-fog-layer', 'snx-bg-fog snx-bg-layer');
        document.body.appendChild(fog);

        /* Foreground mist (z: 5) */
        var mist = _el('div', 'snx-mist-layer', 'snx-bg-mist snx-bg-layer');
        document.body.appendChild(mist);

        /* Energy sweep — blue glow at bottom */
        var energy = _el('div', 'snx-energy-layer', 'snx-bg-energy snx-bg-layer');
        document.body.appendChild(energy);

        /* Neon green horizon accent */
        var ga = _el('div', 'snx-green-accent-layer', 'snx-bg-green-accent snx-bg-layer');
        document.body.appendChild(ga);

        /* Lightning flash overlay (triggered by JS) */
        var lf = _el('div', 'snx-lightning-flash', 'snx-bg-layer');
        document.body.appendChild(lf);

        /* Foreground rain veil */
        var rv = _el('div', 'snx-rain-veil', 'snx-bg-layer');
        document.body.appendChild(rv);
    }

    function _el(tag, id, cls) {
        var e = document.createElement(tag);
        e.id = id;
        if (cls) e.className = cls;
        return e;
    }

    /* ──────────────────────────────────────────────────────
       PARALLAX — subtle depth on mouse move (desktop only)
    ────────────────────────────────────────────────────── */
    function _initParallax() {
        if (_reducedMotion) return;
        if (window.innerWidth < 768) return; /* mobile: skip */

        document.addEventListener('mousemove', function (e) {
            _mouseX = e.clientX / window.innerWidth;
            _mouseY = e.clientY / window.innerHeight;
        }, { passive: true });

        function _applyParallax() {
            /* Gentle lerp toward target */
            var targetX = (_mouseX - 0.5) * -18;
            var targetY = (_mouseY - 0.5) * -10;
            _parallaxTX += (targetX - _parallaxTX) * 0.045;
            _parallaxTY += (targetY - _parallaxTY) * 0.045;

            var clouds = document.getElementById('snx-clouds-layer');
            var clouds2 = document.getElementById('snx-clouds2-layer');
            var clouds3 = document.getElementById('snx-clouds3-layer');
            var fog = document.getElementById('snx-fog-layer');
            var fog2 = document.getElementById('snx-fog2-layer');

            /* FIX: use transform: translateX() instead of marginLeft.
               marginLeft triggers layout (reflow) every frame on all affected elements.
               translateX is GPU-composited and does NOT cause layout recalculation. */
            if (clouds)  clouds.style.transform  = 'translateX(' + (_parallaxTX * 0.6).toFixed(2) + 'px)';
            if (clouds2) clouds2.style.transform = 'translateX(' + (_parallaxTX * 0.4).toFixed(2) + 'px)';
            if (clouds3) clouds3.style.transform = 'translateX(' + (_parallaxTX * 0.25).toFixed(2) + 'px)';
            if (fog)     fog.style.transform     = 'translateX(' + (_parallaxTX * 0.3).toFixed(2) + 'px)';
            if (fog2)    fog2.style.transform    = 'translateX(' + (_parallaxTX * 0.2).toFixed(2) + 'px)';

            /* Tell the canvas engine about parallax offset */
            window._snxParallaxX = _parallaxTX;
            window._snxParallaxY = _parallaxTY;

            _parallaxRaf = requestAnimationFrame(_applyParallax);
        }

        _parallaxRaf = requestAnimationFrame(_applyParallax);
    }

    /* ──────────────────────────────────────────────────────
       ENABLE / DISABLE
    ────────────────────────────────────────────────────── */
    function _applyState() {
        if (_enabled) {
            document.documentElement.classList.remove('snx-bg-off');
        } else {
            document.documentElement.classList.add('snx-bg-off');
        }
    }

    function enable() {
        _enabled = true;
        try { localStorage.setItem(STORAGE_KEY, 'on'); } catch (e) {}
        _applyState();
        window._snxBgPauseOverride = false;
        if (typeof window._snxBgRender === 'function') window._snxBgRender();
    }

    function disable() {
        _enabled = false;
        try { localStorage.setItem(STORAGE_KEY, 'off'); } catch (e) {}
        _applyState();
        window._snxBgPauseOverride = true;
    }

    function isEnabled() { return _enabled; }

    /* ──────────────────────────────────────────────────────
       SECTION MOOD API
    ────────────────────────────────────────────────────── */
    function setMood(mood) {
        mood = mood || 'feed';
        if (mood === _currentMood) return;
        _currentMood = mood;
        var html = document.documentElement;
        MOOD_CLASSES.forEach(function (c) { html.classList.remove(c); });
        if (mood !== 'feed') {
            html.classList.add('snx-mood-' + mood);
        }
        window._snxCurrentMood = mood;
    }

    function getMoodForPage(pageId) {
        return MOOD_MAP[pageId] || 'feed';
    }

    /* ──────────────────────────────────────────────────────
       ENVIRONMENTAL UI REACTIONS
       Called by external code: SNXLivingBg.react(type)
    ────────────────────────────────────────────────────── */
    function react(type) {
        if (!_enabled || _reducedMotion) return;
        var html = document.documentElement;

        switch (type) {
            case 'nav-open':
                _flashReact('snx-react-nav', 600);
                break;
            case 'music-open':
                _flashReact('snx-react-music', 900);
                break;
            case 'music-start':
                setMusicReaction(true);
                break;
            case 'music-stop':
                setMusicReaction(false);
                break;
            case 'live-open':
                _flashReact('snx-react-live', 1200);
                break;
            case 'notification':
                _flashReact('snx-react-notif', 500);
                break;
            case 'messages-open':
                /* calmer atmosphere — handled by mood class */
                break;
        }
    }

    function _flashReact(cls, duration) {
        var html = document.documentElement;
        html.classList.add(cls);
        setTimeout(function () { html.classList.remove(cls); }, duration);
    }

    /* ──────────────────────────────────────────────────────
       MUSIC REACTION
    ────────────────────────────────────────────────────── */
    function setMusicReaction(playing) {
        if (_musicPlaying === playing) return;
        _musicPlaying = playing;
        if (playing) {
            document.documentElement.classList.add('snx-music-active');
            window._snxMusicActive = true;
        } else {
            document.documentElement.classList.remove('snx-music-active');
            window._snxMusicActive = false;
        }
    }

    /* ──────────────────────────────────────────────────────
       PAGE VISIBILITY — pause CSS animations
    ────────────────────────────────────────────────────── */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            document.documentElement.classList.add('snx-page-hidden');
        } else {
            document.documentElement.classList.remove('snx-page-hidden');
        }
    });

    /* ──────────────────────────────────────────────────────
       INIT
    ────────────────────────────────────────────────────── */
    function init() {
        _applyState();
        _injectLayers();
        if (!_enabled) {
            window._snxBgPauseOverride = true;
        }
        if (!_reducedMotion) {
            _initParallax();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ──────────────────────────────────────────────────────
       PUBLIC API
    ────────────────────────────────────────────────────── */
    var api = {
        enable:           enable,
        disable:          disable,
        isEnabled:        isEnabled,
        setMood:          setMood,
        getMoodForPage:   getMoodForPage,
        react:            react,
        setMusicReaction: setMusicReaction,
        toggle: function () {
            if (_enabled) disable(); else enable();
            return _enabled;
        }
    };

    window.SNXLivingBg = api;
    window.ShadowNexusEnvironmentController = api; /* alias */

})();
