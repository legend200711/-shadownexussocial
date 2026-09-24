/**
 * Shadow Nexus Social — 24-Hour Cloud Stream
 * cloud-stream.js  (redesigned)
 *
 * Viewer features:
 *   - Cinematic player: Music Visual Mode / Video Mode / Picture Mode
 *   - Audio Visualizer (Web Audio API, falls back gracefully)
 *   - Smooth fade transitions between media types
 *   - Like system (Firebase, one per UID per stream)
 *   - Viewer presence + heartbeat
 *   - Up Next queue (next 3-5 items)
 *   - Fullscreen support
 *   - No gifting in this section
 *
 * Channel owner features (any authenticated user who owns the stream):
 *   - Start / stop / skip broadcast
 *   - Playlist management
 *   - Broadcast history
 *
 * Architecture unchanged:
 *   cloudStreams/{streamId}               — broadcast record
 *   studioCloudStreamMusic/{streamId}     — live Now Playing (worker-owned)
 *   studioPlaylists/{uid}/playlists/{plId}
 *   cloudStreamTracks/{uid}/tracks/{id}
 *   liveRooms/{uid}
 *   cloudStreamLikes/{streamId}/likes/{uid} — per-track like (Firestore)
 */

'use strict';

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, limit, where, onSnapshot,
  serverTimestamp, documentId, increment
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

/* ── Firebase config ─────────────────────────────────────────────────── */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app  = getApps().length ? getApp() : initializeApp(_CFG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

setPersistence(_auth, browserLocalPersistence).catch(() => {});

const WORKER_URL = 'https://snx-cloudstream.nthntjrn.workers.dev';

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let _user     = null;
let _userData = null;

/* Creator/admin state */
let _streamId   = null;
let _streamData = null;
let _artworkDataUrl = null;
let _creator = {
  playlists: [], selectedPl: null, queue: [],
  healthInterval: null, expiryInterval: null,
  adminNpUnsub: null,   // unsubscribe for _subscribeAdminNowPlaying
};

/* Viewer/player state */
let _player = {
  audio:           null,    // single stable HTMLAudioElement
  video:           null,    // reference to #csrVideoEl
  playing:         false,
  mediaType:       'music', // 'music' | 'video' | 'picture'
  trackId:         null,
  trackUrl:        null,
  trackDur:        0,
  artworkUrl:      null,
  trackStartedAt:  0,
  volume:          0.8,
  progressRaf:     null,
  unsub:           null,    // Firestore snapshot unsubscribe
  _streamId:       null,
  _heartbeatTimer: null,
  _watchdogTimer:  null,
  _audioStallAt:   0,
  _userInteracted: false,
  _liked:          false,
  listenerCount:   0,
  // picture-mode timer
  _pictureTimer:   null,
  // queue for Up Next
  _queue:          [],
  _queueIndex:     0,
};

/* Audio Visualizer state */
let _viz = {
  ctx:      null,  // AudioContext
  analyser: null,
  source:   null,
  raf:      null,
  canvas:   null,
  canvasCtx: null,
};

let _confirmCallback = null;

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */
function _el(id)       { return document.getElementById(id); }
function _show(id, v)  { const e = _el(id); if (e) e.style.display = v ? '' : 'none'; }
function _setText(id,t){ const e = _el(id); if (e) e.textContent = t || ''; }
function _sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function _esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _fmtDur(s)    { if (!s||s<=0) return '0:00'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=Math.floor(s%60); return h>0?`${h}:${_p(m)}:${_p(ss)}`:`${m}:${_p(ss)}`; }
function _p(n)         { return n<10?'0'+n:''+n; }
function _fmtTime(ms)  { return new Date(ms).toLocaleString(); }
function _fmtDate(ms)  { return new Date(ms).toLocaleDateString(); }

function _setAuthBadge(name) {
  const e = _el('csrAuthBadge');
  if (e) e.textContent = name;
}

function _toast(msg, type) {
  const el = _el('csrToast');
  if (!el) return;
  el.innerHTML = msg;
  el.className = 'csr-toast csr-toast-show'
    + (type === 'success' ? ' csr-toast-success' : type === 'error' ? ' csr-toast-error' : '');
  el.style.display = '';
  if (el._t) clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('csr-toast-show');
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }, 4000);
}

function _showError(id, msg) {
  const el = _el(id);
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg || '';
}

function _getSessionId() {
  if (_user) return _user.uid;
  const KEY = 'snx_csr_guest_session';
  let id = localStorage.getItem(KEY);
  if (!id) { id = 'g_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36); localStorage.setItem(KEY, id); }
  return id;
}

/* ═══════════════════════════════════════════════════════
   BOOT — Auth state
═══════════════════════════════════════════════════════ */
onAuthStateChanged(_auth, async user => {
  _show('csrLoading', false);

  if (!user) {
    _show('csrAuthGate', true);
    _show('csrApp',      false);
    _setAuthBadge('Sign In');
    return;
  }

  _user = user;
  try {
    const snap = await getDoc(doc(_db, 'users', user.uid));
    if (snap.exists()) _userData = snap.data();
  } catch(_) {}

  _setAuthBadge(_userData ? (_userData.displayName || _userData.username || 'You') : 'You');

  const params  = new URLSearchParams(window.location.search);
  const watchId = params.get('id') || params.get('watch') || params.get('stream');

  _show('csrApp', true);

  if (watchId) {
    // Direct listener link — show viewer section
    _show('csrViewerSection', true);
    await _initListenerMode(watchId);
  } else {
    // Could be creator or general visitor
    await _initCreatorMode();
  }
});

/* ═══════════════════════════════════════════════════════
   CREATOR MODE
═══════════════════════════════════════════════════════ */
async function _initCreatorMode() {
  // Always show the viewer section
  _show('csrViewerSection', true);

  // Show channel management section to the stream owner (any authenticated user)
  // Ownership is verified when they try to start/stop/skip via the worker
  _show('csrAdminSection', true);

  // Check for an active stream belonging to this user
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (snap.docs.length) {
      const d = snap.docs[0];
      _streamId   = d.id;
      _streamData = d.data();
      _showActiveStream();
    } else {
      _showCreateForm();
    }
  } catch (e) {
    console.error('[CSR] initCreatorMode error:', e);
    _showCreateForm();
  }

  _loadPlaylists();
  _loadHistory();

  // Also join as a viewer of the most-recent active stream
  _discoverAndJoinStream();
}

/* Find the most recently active cloud stream for the viewer panel */
async function _discoverAndJoinStream() {
  try {
    // If we already have a stream (creator's own), use it
    if (_streamId) {
      await _initListenerForStream(_streamId, _streamData || {});
      return;
    }
    // Otherwise look for any active stream
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('status', 'in', ['active', 'recovering']),
      orderBy('startedAt', 'desc'),
      limit(1)
    ));
    if (snap.docs.length) {
      const d = snap.docs[0];
      await _initListenerForStream(d.id, d.data());
    } else {
      // No active stream — show offline state
      _setOfflineMsg('No broadcast is currently running.');
    }
  } catch(e) {
    console.warn('[CSR] discoverAndJoinStream:', e.message);
    _setOfflineMsg('Could not connect to stream.');
  }
}

function _setOfflineMsg(msg) {
  _setText('csrOfflineMsg', msg);
  // Make sure offline panel is visible and others are hidden
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.remove('hidden');
}

/* ── ADMIN: show active stream ── */
function _showActiveStream() {
  _show('csrStatusPanel', true);
  _show('csrActiveBanner', true);
  _show('csrCreatePanel', false);
  _renderStatusPanel();
  _startHealthMonitor();
  _startExpiryCountdown();
  _subscribeAdminNowPlaying(_streamId);
}

function _showCreateForm() {
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _show('csrHistoryPanel', true);
}

/* ── Status panel ── */
function _renderStatusPanel() {
  if (!_streamData) return;
  const d = _streamData;
  _setStatusBadge(d.status || 'unknown');
  _el('csrStreamId').textContent      = 'ID: ' + (_streamId || '—');
  _el('csrInfoTitle').textContent     = d.streamName     || '—';
  _el('csrInfoHost').textContent      = d.displayName    || (_userData && (_userData.displayName || _userData.username)) || '—';
  _el('csrInfoCategory').textContent  = d.category       || '—';
  _el('csrInfoStarted').textContent   = d.startedAt ? _fmtTime(d.startedAt.toMillis ? d.startedAt.toMillis() : d.startedAt) : '—';
  _el('csrInfoExpires').textContent   = d.expiresAt ? new Date(d.expiresAt).toLocaleString() : '—';
  _el('csrInfoListeners').textContent = d.viewerCount || '0';
  _el('csrInfoWorker').textContent    = d.workerStatus || 'active';
}

function _setStatusBadge(status) {
  const el = _el('csrStatusBadge');
  if (!el) return;
  const map = {
    active:    ['csr-status-live',    '&#128308; LIVE'],
    starting:  ['csr-status-starting','&#9203; STARTING'],
    recovering:['csr-status-warn',    '&#9888; RECOVERING'],
    stopping:  ['csr-status-warn',    '&#9209; STOPPING'],
    stopped:   ['csr-status-offline', '&#9209; ENDED'],
    ended:     ['csr-status-offline', '&#9209; ENDED'],
    failed:    ['csr-status-error',   '&#10060; ERROR'],
    offline:   ['csr-status-offline', '&#9898; OFFLINE'],
    unknown:   ['csr-status-offline', '&#9898; OFFLINE'],
  };
  const [cls, label] = map[status] || map.unknown;
  el.className = 'csr-status-badge ' + cls;
  el.innerHTML = label;
}

/* Admin Now Playing subscription (updates admin strip only) */
function _subscribeAdminNowPlaying(streamId) {
  // Cancel any existing admin NP listener before subscribing again
  if (_creator.adminNpUnsub) { try { _creator.adminNpUnsub(); } catch(_) {} _creator.adminNpUnsub = null; }
  _creator.adminNpUnsub = onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      _setText('csrAdminNpTitle',  d.currentTitle  || '—');
      _setText('csrAdminNpArtist', d.currentArtist || '');
      _setText('csrAdminNpNext',   d.nextTitle ? 'Next: ' + d.nextTitle : '');
    },
    err => console.warn('[CSR] adminNP error:', err.message)
  );
}

/* ── Health monitor ── */
function _startHealthMonitor() {
  if (_creator.healthInterval) clearInterval(_creator.healthInterval);
  _creator.healthInterval = setInterval(_checkHealth, 30000);
  _checkHealth();
}
function _stopHealthMonitor() {
  if (_creator.healthInterval) { clearInterval(_creator.healthInterval); _creator.healthInterval = null; }
}
async function _checkHealth() {
  if (!_streamId) return;
  try {
    const r    = await fetch(WORKER_URL + '/api/stream/health/' + _streamId);
    const data = await r.json();
    if (data.success) {
      if (_streamData) { _streamData.status = data.status; _streamData.viewerCount = data.viewerCount || 0; }
      _setStatusBadge(data.status);
      _setText('csrInfoWorker',    data.workerActive ? 'active' : 'offline');
      _setText('csrInfoListeners', String(data.viewerCount || 0));
    }
    if (_streamData && _streamData.expiresAt && _streamData.expiresAt - Date.now() <= 0) _streamExpired();
  } catch(_) {}
}

/* ── Expiry countdown ── */
function _startExpiryCountdown() {
  if (_creator.expiryInterval) clearInterval(_creator.expiryInterval);
  _creator.expiryInterval = setInterval(_tickExpiry, 1000);
  _tickExpiry();
}
function _tickExpiry() {
  if (!_streamData || !_streamData.expiresAt) return;
  const remain = _streamData.expiresAt - Date.now();
  const el = _el('csrInfoRemaining');
  if (remain <= 0) { if (el) el.textContent = 'EXPIRED'; _streamExpired(); return; }
  if (el) el.textContent = _fmtDur(Math.floor(remain / 1000));
}
function _streamExpired() {
  if (_creator.expiryInterval) { clearInterval(_creator.expiryInterval); _creator.expiryInterval = null; }
  _setStatusBadge('ended');
  _toast('Your 24-hour cloud broadcast has ended.', 'info');
}

/* ═══════════════════════════════════════════════════════
   LISTENER / VIEWER MODE
═══════════════════════════════════════════════════════ */
async function _initListenerMode(streamId) {
  try {
    const r    = await fetch(WORKER_URL + '/api/stream/sync/' + streamId);
    const data = await r.json();

    if (!r.ok || !data.success) {
      _setOfflineMsg(data.error || 'Broadcast not found or offline.');
      return;
    }
    if (!['active','recovering','starting'].includes(data.status)) {
      _setOfflineMsg('This broadcast has ended.');
      return;
    }

    const streamData = {
      streamName:  data.streamName  || 'Shadow Nexus Cloud Stream',
      displayName: data.displayName || '',
      viewerCount: data.viewerCount || 0,
      startedAt:   data.startedAt   || 0,
      expiresAt:   data.endsAt      || 0,
      status:      data.status,
    };
    _player.trackStartedAt = data.lastAdvancedAt || data.startedAt || Date.now();
    await _initListenerForStream(streamId, streamData);

    if (data.currentMusicUrl) {
      _syncToNowPlaying({
        currentTitle:    data.currentMusicTitle    || '',
        currentArtist:   data.currentMusicArtist   || '',
        currentTrackUrl: data.currentMusicUrl,
        currentTrackId:  data.currentMusicId       || '',
        currentDuration: data.currentMusicDuration || 0,
        artworkUrl:      data.artworkUrl           || '',
        mediaType:       data.mediaType            || 'music',
        nextTitle:       data.nextMusicTitle       || '',
        nextArtist:      data.nextMusicArtist      || '',
        updatedAt:       { toMillis: () => data.lastAdvancedAt || Date.now() },
      });
    }
  } catch (e) {
    console.warn('[CSR] Worker sync failed, using Firestore only:', e.message);
    await _initListenerForStream(streamId, { streamName: 'Shadow Nexus Cloud Stream', displayName: '' });
  }
}

async function _initListenerForStream(streamId, streamData) {
  _player._streamId = streamId;

  // Hide offline panel — we have a stream
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.add('hidden');

  // iOS gate check before subscribing
  _maybeShowTapOverlay();

  // Subscribe to Firestore Now Playing
  if (_player.unsub) { try { _player.unsub(); } catch(_) {} }
  _player.unsub = onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) { _setOfflineMsg('Broadcast ended.'); return; }
      const d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') { _setOfflineMsg('Broadcast ended.'); return; }
      _syncToNowPlaying(d);
    },
    err => console.warn('[CSR] nowPlaying snapshot error:', err.message)
  );

  // Initial fetch
  try {
    const np = await getDoc(doc(_db, 'studioCloudStreamMusic', streamId));
    if (np.exists()) _syncToNowPlaying(np.data());
  } catch(_) {}

  _joinAsListener(streamId);
  _startListenerHeartbeat(streamId);
  _fetchLikes(streamId);
  _startAudioWatchdog(streamId);
}

/* ── Sync viewer UI to a Now Playing document ── */
function _syncToNowPlaying(d) {
  if (!d) return;

  const url       = d.currentTrackUrl || '';
  const title     = d.currentTitle    || '—';
  const artist    = d.currentArtist   || '';
  const dur       = d.currentDuration || 0;
  const artwork   = d.artworkUrl      || d.coverArtUrl || '';
  const mediaType = d.mediaType       || 'music';
  const nextTitle = d.nextTitle       || '';

  // Update Now Playing panel
  _setText('csrNpTitle',  title);
  _setText('csrNpArtist', artist);
  _setText('csrTotalTime', _fmtDur(dur));

  // Type badge
  const typeBadge = _el('csrNpTypeBadge');
  if (typeBadge) {
    typeBadge.textContent =
      mediaType === 'video'   ? '🎬 Video'   :
      mediaType === 'picture' ? '🖼 Picture'  :
                                '🎵 Music';
  }

  // Thumbnail in Now Playing panel
  _setNpThumb(artwork);

  // Up Next
  if (d.upNext && Array.isArray(d.upNext)) {
    _player._queue = d.upNext;
    _renderUpNext(d.upNext);
  } else if (nextTitle) {
    _renderUpNext([{ title: nextTitle, artist: d.nextArtist || '', mediaType: d.nextMediaType || 'music', artworkUrl: d.nextArtworkUrl || '' }]);
  } else {
    _renderUpNext([]);
  }

  // Load new media if URL changed
  if (url && url !== _player.trackUrl) {
    _player.trackUrl      = url;
    _player.trackId       = d.currentTrackId || '';
    _player.trackDur      = dur;
    _player.artworkUrl    = artwork;
    _player.mediaType     = mediaType;
    _player.trackStartedAt = d.updatedAt?.toMillis ? d.updatedAt.toMillis() : Date.now();
    _loadMedia(url, dur, mediaType, artwork, title, artist);
  }
}

/* ── Set Now Playing thumbnail ── */
function _setNpThumb(artworkUrl) {
  const img  = _el('csrNpThumb');
  const def  = _el('csrNpThumbDefault');
  if (!img) return;
  if (artworkUrl) {
    img.onload  = () => { img.classList.add('loaded'); if (def) def.style.display = 'none'; };
    img.onerror = () => { img.classList.remove('loaded'); if (def) def.style.display = ''; };
    img.src = artworkUrl;
  } else {
    img.classList.remove('loaded');
    img.src = '';
    if (def) def.style.display = '';
  }
}

/* ── Render Up Next ── */
function _renderUpNext(items) {
  const list = _el('csrUpNextList');
  if (!list) return;
  if (!items || !items.length) {
    list.innerHTML = '<div class="csr-up-next-empty">Nothing queued yet</div>';
    return;
  }
  const shown = items.slice(0, 5);
  list.innerHTML = shown.map(item => {
    const icon = item.mediaType === 'video' ? '🎬' : item.mediaType === 'picture' ? '🖼' : '🎵';
    const typeLabel = item.mediaType === 'video' ? 'Video' : item.mediaType === 'picture' ? 'Picture' : 'Music';
    const thumbHtml = item.artworkUrl
      ? `<img src="${_esc(item.artworkUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : icon;
    return `<div class="csr-up-next-item" role="listitem">
      <div class="csr-up-next-thumb" aria-hidden="true">${thumbHtml}</div>
      <div class="csr-up-next-info">
        <div class="csr-up-next-title">${_esc(item.title || 'Untitled')}</div>
        <div class="csr-up-next-type">${icon} ${_esc(typeLabel)}</div>
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════
   MEDIA LOADING — stable single controller
   Never recreates the <audio> element for track changes;
   swaps src instead. Keeps Web Audio connections alive.
═══════════════════════════════════════════════════════ */
function _loadMedia(url, dur, mediaType, artworkUrl, title, artist) {
  if (!url) { _player._audioStallAt = _player._audioStallAt || Date.now(); return; }

  // Fade transition between modes
  _fadeTransition(() => {
    if (mediaType === 'video') {
      _activateVideoMode(url, dur);
    } else if (mediaType === 'picture') {
      _activatePictureMode(url, dur, title);
    } else {
      _activateMusicMode(url, dur, artworkUrl);
    }
  });
}

/* ── Fade transition helper ── */
function _fadeTransition(cb) {
  const overlay = _el('csrFadeOverlay');
  if (!overlay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cb();
    return;
  }
  overlay.classList.add('fading');
  setTimeout(() => {
    cb();
    overlay.classList.remove('fading');
  }, 420);
}

/* ── Show/hide stage modes ── */
function _setStageMode(mode) {
  // mode: 'music' | 'video' | 'picture'
  const modes = ['csrModeMusic', 'csrModeVideo', 'csrModePicture'];
  const map   = { music: 'csrModeMusic', video: 'csrModeVideo', picture: 'csrModePicture' };
  modes.forEach(id => {
    const el = _el(id);
    if (el) {
      el.classList.toggle('active', id === map[mode]);
      el.setAttribute('aria-hidden', id !== map[mode] ? 'true' : 'false');
    }
  });
  // Hide offline panel whenever we have real content
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.add('hidden');
  _player.mediaType = mode;
}

/* ── MUSIC MODE ── */
function _activateMusicMode(url, dur, artworkUrl) {
  _setStageMode('music');
  _stopPictureTimer();

  // Update blurred background
  const bg = _el('csrStageBg');
  if (bg) bg.style.backgroundImage = artworkUrl ? `url('${_esc(artworkUrl)}')` : 'none';

  // Update artwork image
  const img = _el('csrMusicArtwork');
  const def = _el('csrMusicArtworkDefault');
  if (img) {
    img.classList.remove('loaded');
    if (artworkUrl) {
      img.alt = 'Album artwork';
      img.onload  = () => { img.classList.add('loaded'); if (def) def.style.display = 'none'; };
      img.onerror = () => { img.classList.remove('loaded'); img.src = ''; if (def) def.style.display = ''; };
      img.src = artworkUrl;
    } else {
      img.src = '';
      if (def) def.style.display = '';
    }
  }

  _loadAndPlayAudio(url, dur);
}

/* ── VIDEO MODE ── */
function _activateVideoMode(url, dur) {
  _setStageMode('video');
  _stopPictureTimer();
  _stopAudio();

  // Clear any blurred bg
  const bg = _el('csrStageBg');
  if (bg) bg.style.backgroundImage = 'none';

  const video = _el('csrVideoEl');
  if (!video) return;
  _player.video = video;

  // Remove old handlers before setting new src
  video.onended  = null;
  video.onerror  = null;

  video.volume = _player.volume;
  video.src    = url;
  video.load();

  video.onended = () => {
    _stopProgressRaf();
    _player._audioStallAt = Date.now(); // triggers watchdog to advance
    _setPlayBtn(false);
  };
  video.onerror = () => {
    console.warn('[CSR] video error for url:', url);
    _player._audioStallAt = _player._audioStallAt || Date.now();
  };
  video.addEventListener('timeupdate', _updateProgress, { passive: true });

  const tapOverlay = _el('csrTapOverlay');
  const tapVisible = tapOverlay && tapOverlay.style.display !== 'none';
  if (_player.playing && !tapVisible) {
    video.play().catch(err => {
      if (err.name === 'NotAllowedError') { _player.playing = false; _showTapOverlay(); }
    });
    _startProgressRaf();
  }
  _setPlayBtn(_player.playing && !tapVisible);
  _show('csrProgressFill', true);
}

/* ── PICTURE MODE ── */
function _activatePictureMode(url, duration, title) {
  _setStageMode('picture');
  _stopPictureTimer();
  _stopAudio();

  const img = _el('csrPictureImg');
  const bg  = _el('csrPictureBg');
  if (img) { img.alt = _esc(title || 'Stream picture'); img.src = url; }
  if (bg)  { bg.style.backgroundImage = `url('${_esc(url)}')`; }

  const bgStage = _el('csrStageBg');
  if (bgStage) bgStage.style.backgroundImage = `url('${_esc(url)}')`;

  // Auto-advance after duration (default 30s if not specified)
  const displayMs = ((duration || 30)) * 1000;
  _player._pictureTimer = setTimeout(() => {
    _player._audioStallAt = Date.now(); // watchdog will re-sync
  }, displayMs);

  _setPlayBtn(false); // no play/pause for pictures
  _setText('csrCurrentTime', '');
  _setText('csrTotalTime', _fmtDur(duration || 30) + ' display');
}

function _stopPictureTimer() {
  if (_player._pictureTimer) { clearTimeout(_player._pictureTimer); _player._pictureTimer = null; }
}

/* ── AUDIO playback (stable element, swap src) ── */
function _loadAndPlayAudio(url, dur) {
  if (!url) return;

  // Create audio element once; reuse thereafter
  if (!_player.audio) {
    const audio = new Audio();
    audio.volume  = _player.volume;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.setAttribute('x-webkit-airplay', 'allow');
    audio.addEventListener('timeupdate', _updateProgress, { passive: true });
    audio.addEventListener('ended',      _onAudioEnded);
    audio.addEventListener('stalled',    () => { if (!_player._audioStallAt) _player._audioStallAt = Date.now(); });
    audio.addEventListener('waiting',    () => { if (!_player._audioStallAt) _player._audioStallAt = Date.now(); });
    audio.addEventListener('canplay',    () => { _player._audioStallAt = 0; });
    audio.addEventListener('playing',    () => { _player._audioStallAt = 0; });
    audio.addEventListener('error',      () => { _player._audioStallAt = _player._audioStallAt || Date.now(); });
    _player.audio = audio;
  }

  const audio = _player.audio;
  audio.pause();
  audio.src  = url;
  audio.load();
  _player.trackDur      = dur;
  _player._audioStallAt = 0;

  // Synchronized seek (skip ahead to match server clock)
  const elapsed = Math.max(0, (Date.now() - _player.trackStartedAt) / 1000);
  if (elapsed > 2 && dur > 0 && elapsed < dur - 2) {
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        try { audio.currentTime = Math.min(elapsed, audio.duration - 1); } catch(_) {}
      }
    }, { once: true });
  }

  // Connect to Web Audio for visualizer (only on music mode)
  _connectVisualizer(audio);

  const tapOverlay = _el('csrTapOverlay');
  const tapVisible = tapOverlay && tapOverlay.style.display !== 'none';

  if (_player.playing && !tapVisible) {
    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
          _player.playing = false;
          _setPlayBtn(false);
          _showTapOverlay();
        } else {
          _player._audioStallAt = _player._audioStallAt || Date.now();
        }
      });
    }
    _startProgressRaf();
  }
  _setPlayBtn(_player.playing && !tapVisible);
}

function _onAudioEnded() {
  _stopProgressRaf();
  _player._audioStallAt = Date.now();
  _setPlayBtn(false);
  _vizStop();
}

function _stopAudio() {
  const audio = _player.audio;
  if (!audio) return;
  try { audio.pause(); } catch(_) {}
  _stopProgressRaf();
  _vizStop();
}

/* ═══════════════════════════════════════════════════════
   AUDIO VISUALIZER — Web Audio API
═══════════════════════════════════════════════════════ */
function _connectVisualizer(audioEl) {
  if (!audioEl) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  try {
    if (!_viz.ctx) {
      _viz.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Disconnect previous source
    if (_viz.source) { try { _viz.source.disconnect(); } catch(_) {} }

    const analyser = _viz.ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;

    const source = _viz.ctx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(_viz.ctx.destination);

    _viz.analyser = analyser;
    _viz.source   = source;

    if (!_viz.canvas) {
      _viz.canvas    = _el('csrVisualizerCanvas');
      _viz.canvasCtx = _viz.canvas ? _viz.canvas.getContext('2d') : null;
    }
    _vizStart();
  } catch(e) {
    // Web Audio not available — visualizer simply won't show
    console.warn('[CSR] Visualizer setup failed:', e.message);
  }
}

function _vizStart() {
  _vizStop();
  if (!_viz.analyser || !_viz.canvasCtx) return;

  function draw() {
    _viz.raf = requestAnimationFrame(draw);
    const analyser  = _viz.analyser;
    const canvas    = _viz.canvas;
    const ctx       = _viz.canvasCtx;
    if (!analyser || !canvas || !ctx) return;

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);

    const barCount = Math.min(bufLen, 32);
    const barW     = (W / barCount) * 0.7;
    const gap      = (W / barCount) * 0.3;

    for (let i = 0; i < barCount; i++) {
      const val    = data[i] / 255;
      const barH   = val * H * 0.95;
      const x      = i * (barW + gap) + gap / 2;
      const y      = H - barH;

      // Colour: neon-blue to neon-green gradient based on height
      const r = Math.round(0 + val * 57);
      const g = Math.round(174 + val * 81);
      const b = Math.round(239 - val * 100);
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 2) : ctx.rect(x, y, barW, barH);
      ctx.fill();
    }
  }
  draw();
}

function _vizStop() {
  if (_viz.raf) { cancelAnimationFrame(_viz.raf); _viz.raf = null; }
  // Clear canvas to flat bars (settled look)
  if (_viz.canvasCtx && _viz.canvas) {
    _viz.canvasCtx.clearRect(0, 0, _viz.canvas.width, _viz.canvas.height);
    // Draw flat minimal bars to indicate paused/stopped state
    _drawFlatBars();
  }
}

function _drawFlatBars() {
  const ctx    = _viz.canvasCtx;
  const canvas = _viz.canvas;
  if (!ctx || !canvas) return;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 40;
  canvas.width  = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  const barCount = 32;
  const barW     = (W / barCount) * 0.7;
  const gap      = (W / barCount) * 0.3;
  for (let i = 0; i < barCount; i++) {
    const x = i * (barW + gap) + gap / 2;
    ctx.fillStyle = 'rgba(0,174,239,0.18)';
    ctx.fillRect(x, H - 3, barW, 3);
  }
}

/* ═══════════════════════════════════════════════════════
   PROGRESS
═══════════════════════════════════════════════════════ */
function _updateProgress() {
  const media = _player.mediaType === 'video' ? _player.video : _player.audio;
  if (!media) return;
  const pos = media.currentTime || 0;
  const dur = (isFinite(media.duration) && media.duration > 0)
    ? media.duration
    : _player.trackDur;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const fill = _el('csrProgressFill');
  if (fill) {
    fill.style.width = pct.toFixed(2) + '%';
    const bar = _el('csrProgressBar');
    if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
  }
  _setText('csrCurrentTime', _fmtDur(Math.floor(pos)));
}

function _startProgressRaf() {
  _stopProgressRaf();
  function tick() { _updateProgress(); _player.progressRaf = requestAnimationFrame(tick); }
  _player.progressRaf = requestAnimationFrame(tick);
}
function _stopProgressRaf() {
  if (_player.progressRaf) { cancelAnimationFrame(_player.progressRaf); _player.progressRaf = null; }
}

/* ═══════════════════════════════════════════════════════
   IOS / AUTOPLAY GATE
═══════════════════════════════════════════════════════ */
function _isAutoplayBlocked() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream
    || (/Safari/.test(ua) && !/Chrome/.test(ua))
    || window.navigator.standalone === true;
}
function _maybeShowTapOverlay() {
  if (_isAutoplayBlocked()) { _showTapOverlay(); _player.playing = false; }
}
function _showTapOverlay() {
  _show('csrTapOverlay', true);
  _player.playing = false;
  _setPlayBtn(false);
}

window.csrStartListening = function() {
  _show('csrTapOverlay', false);
  _player._userInteracted = true;
  _player.playing = true;

  // Resume AudioContext if suspended (required by browser autoplay policy)
  if (_viz.ctx && _viz.ctx.state === 'suspended') {
    _viz.ctx.resume().catch(() => {});
  }

  const media = _player.mediaType === 'video' ? _player.video : _player.audio;
  if (media) {
    const p = media.play();
    if (p) p.catch(err => {
      console.warn('[CSR] csrStartListening play() failed:', err.message);
      if (_player.trackUrl) _loadAndPlayAudio(_player.trackUrl, _player.trackDur);
    });
    _setPlayBtn(true);
    _startProgressRaf();
    if (_player.mediaType === 'music') _vizStart();
  } else if (_player.trackUrl) {
    _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
  }
};

/* ── Play/Pause toggle ── */
window.csrTogglePlay = function() {
  const tapOverlay = _el('csrTapOverlay');
  if (tapOverlay && tapOverlay.style.display !== 'none') {
    window.csrStartListening();
    return;
  }

  const media = _player.mediaType === 'video' ? _player.video : _player.audio;

  if (_player.mediaType === 'picture') return; // pictures aren't pause-able

  if (!media) {
    if (_player.trackUrl) {
      _player.playing = true;
      _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
    }
    return;
  }

  if (_player.playing) {
    try { media.pause(); } catch(_) {}
    _player.playing = false;
    _stopProgressRaf();
    _vizStop();
  } else {
    // Resume AudioContext on user gesture
    if (_viz.ctx && _viz.ctx.state === 'suspended') _viz.ctx.resume().catch(() => {});
    const p = media.play();
    if (p) p.catch(err => { if (err.name === 'NotAllowedError') _showTapOverlay(); });
    _player.playing = true;
    _startProgressRaf();
    if (_player.mediaType === 'music') _vizStart();
  }
  _setPlayBtn(_player.playing);
};

function _setPlayBtn(playing) {
  const btn  = _el('csrPlayerPlayBtn');
  const icon = _el('csrPlayBtnIcon');
  if (btn)  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (icon) icon.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

window.csrSetVolume = function(val) {
  _player.volume = parseInt(val, 10) / 100;
  if (_player.audio) _player.audio.volume = _player.volume;
  const vid = _el('csrVideoEl');
  if (vid) vid.volume = _player.volume;
};

/* ── Retry connect ── */
window.csrRetryConnect = function() {
  _discoverAndJoinStream();
};

/* ═══════════════════════════════════════════════════════
   VIEWER PRESENCE — heartbeat
═══════════════════════════════════════════════════════ */
async function _joinAsListener(streamId) {
  if (!streamId) return;
  const sessionId = _getSessionId();
  try {
    await fetch(WORKER_URL + '/api/stream/listener/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId, sessionId,
        uid:         _user ? _user.uid : null,
        displayName: _user ? (_userData?.displayName || _userData?.username || '') : 'Guest',
      }),
    });
  } catch(e) { console.warn('[CSR] join failed:', e.message); }
}

function _startListenerHeartbeat(streamId) {
  if (!streamId) return;
  if (_player._heartbeatTimer) { clearInterval(_player._heartbeatTimer); _player._heartbeatTimer = null; }
  const sessionId = _getSessionId();

  const _beat = async () => {
    try {
      const r = await fetch(WORKER_URL + '/api/stream/listener/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId, sessionId }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.rejoin) { await _joinAsListener(streamId); return; }
      if (typeof d.viewerCount === 'number') {
        _player.listenerCount = d.viewerCount;
        _setText('csrViewerCount', String(d.viewerCount));
        _setText('csrInfoListeners', String(d.viewerCount));
      }
    } catch(_) {}
  };

  _beat();
  _player._heartbeatTimer = setInterval(_beat, 25000);

  window.addEventListener('beforeunload', () => _leaveAsListener(streamId), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { _joinAsListener(streamId); _beat(); }
  });
}

async function _leaveAsListener(streamId) {
  if (!streamId) return;
  const sessionId = _getSessionId();
  try {
    navigator.sendBeacon
      ? navigator.sendBeacon(WORKER_URL + '/api/stream/listener/leave', JSON.stringify({ streamId, sessionId }))
      : await fetch(WORKER_URL + '/api/stream/listener/leave', {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId, sessionId }),
        });
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   LIKES — one per authenticated user per stream track.
   Stored in Firestore: cloudStreamLikes/{streamId}/likes/{uid}
   Falls back to worker API if Firestore rules block it.
═══════════════════════════════════════════════════════ */
async function _fetchLikes(streamId) {
  if (!streamId) return;
  try {
    // Try worker endpoint first (same as before)
    const uid = _user ? _user.uid : null;
    const url = uid
      ? WORKER_URL + '/api/stream/likes/' + streamId + '/' + uid
      : WORKER_URL + '/api/stream/likes/' + streamId;
    const r = await fetch(url);
    if (!r.ok) throw new Error('worker likes unavailable');
    const d = await r.json();
    _setText('csrLikeCount', _fmtLikeCount(d.likeCount || 0));
    _player._liked = !!d.liked;
    _updateLikeBtn();
    return;
  } catch(_) {}

  // Fallback: Firestore cloudStreamLikes
  try {
    const likeSnap = await getDoc(doc(_db, 'cloudStreamLikes', streamId));
    const total = likeSnap.exists() ? (likeSnap.data().count || 0) : 0;
    _setText('csrLikeCount', _fmtLikeCount(total));
    if (_user) {
      const myLike = await getDoc(doc(_db, 'cloudStreamLikes', streamId, 'likes', _user.uid));
      _player._liked = myLike.exists();
    }
    _updateLikeBtn();
  } catch(e) {
    console.warn('[CSR] fetchLikes fallback failed:', e.message);
  }
}

function _fmtLikeCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function _updateLikeBtn() {
  const btn  = _el('csrLikeBtn');
  const heart = _el('csrLikeHeart');
  if (!btn) return;
  if (_player._liked) {
    btn.classList.add('liked');
    btn.setAttribute('aria-pressed', 'true');
    if (heart) heart.textContent = '♥';
  } else {
    btn.classList.remove('liked');
    btn.setAttribute('aria-pressed', 'false');
    if (heart) heart.textContent = '♡';
  }
}

window.csrToggleLike = async function() {
  if (!_user) { _toast('Sign in to like.', 'info'); return; }
  const streamId = _player._streamId;
  if (!streamId) return;

  const wasLiked = _player._liked;
  // Optimistic UI
  _player._liked = !wasLiked;
  _updateLikeBtn();
  const countEl = _el('csrLikeCount');
  const cur = _parseLikeCount(countEl?.textContent || '0');
  if (countEl) countEl.textContent = _fmtLikeCount(Math.max(0, cur + (_player._liked ? 1 : -1)));

  try {
    const idToken = await _user.getIdToken(true);
    const r = await fetch(WORKER_URL + '/api/stream/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId, uid: _user.uid, action: _player._liked ? 'like' : 'unlike' }),
    });
    const d = await r.json();
    if (r.ok && typeof d.likeCount === 'number') {
      _setText('csrLikeCount', _fmtLikeCount(d.likeCount));
      _player._liked = !!d.liked;
      _updateLikeBtn();
    } else {
      throw new Error(d.error || 'rejected');
    }
  } catch(_workerErr) {
    // Fallback: Firestore cloudStreamLikes
    try {
      const likeRef  = doc(_db, 'cloudStreamLikes', streamId, 'likes', _user.uid);
      const countRef = doc(_db, 'cloudStreamLikes', streamId);
      if (_player._liked) {
        await setDoc(likeRef, { uid: _user.uid, likedAt: serverTimestamp() });
        await setDoc(countRef, { count: increment(1) }, { merge: true });
      } else {
        await deleteDoc(likeRef);
        await setDoc(countRef, { count: increment(-1) }, { merge: true });
      }
    } catch(e) {
      // Roll back on full failure
      _player._liked = wasLiked;
      _updateLikeBtn();
      if (countEl) countEl.textContent = _fmtLikeCount(cur);
      _toast('Could not update like.', 'error');
    }
  }
};

function _parseLikeCount(s) {
  if (!s) return 0;
  const clean = String(s).trim();
  if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1000);
  return parseInt(clean, 10) || 0;
}

/* ═══════════════════════════════════════════════════════
   AUDIO WATCHDOG
═══════════════════════════════════════════════════════ */
const WATCHDOG_MS    = 15000;
const STALL_RELOAD_MS = 20000;

function _startAudioWatchdog(streamId) {
  if (_player._watchdogTimer) { clearInterval(_player._watchdogTimer); _player._watchdogTimer = null; }

  _player._watchdogTimer = setInterval(async () => {
    // Don't interfere with tap-to-listen gate
    const tapOverlay = _el('csrTapOverlay');
    if (tapOverlay && tapOverlay.style.display !== 'none') return;

    if (!_player.playing || !_player.trackUrl) return;
    if (_player.mediaType === 'picture') return; // pictures advance by timer

    const stallAge = _player._audioStallAt ? Date.now() - _player._audioStallAt : 0;
    const media    = _player.mediaType === 'video' ? _player.video : _player.audio;

    if (!media || stallAge > STALL_RELOAD_MS) {
      // Re-sync from Firestore
      if (streamId) {
        try {
          const np = await getDoc(doc(_db, 'studioCloudStreamMusic', streamId));
          if (np.exists()) {
            const d = np.data();
            if (d.currentTrackUrl && d.currentTrackUrl !== _player.trackUrl) {
              _syncToNowPlaying(d);
              return;
            }
          }
        } catch(_) {}
      }
      // Same track — reload
      if (_player.trackUrl) {
        console.warn('[CSR] watchdog: reloading stalled media');
        _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
      }
    } else if (media && !media.paused && media.readyState >= 3) {
      _player._audioStallAt = 0;
    }
  }, WATCHDOG_MS);
}

/* ═══════════════════════════════════════════════════════
   FULLSCREEN
═══════════════════════════════════════════════════════ */
window.csrToggleFullscreen = function() {
  const stage = _el('csrStage');
  if (!stage) return;
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  } else {
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req) req.call(stage).catch(() => {});
  }
};

document.addEventListener('fullscreenchange',       _onFsChange);
document.addEventListener('webkitfullscreenchange', _onFsChange);
function _onFsChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const icon = _el('csrFullscreenIcon');
  if (icon) icon.innerHTML = isFs ? '&#x2715;' : '&#x26F6;';
}

/* ═══════════════════════════════════════════════════════
   ADMIN — CREATE BROADCAST FORM
═══════════════════════════════════════════════════════ */
function _renderCreateForm() {
  // Show test mode option for all users
  const dur = _el('csrFormDuration');
  if (dur) {
    const testOpt = dur.querySelector('option[value="5"]');
    if (testOpt) testOpt.style.display = '';
  }
  const hint = _el('csrTestModeHint');
  if (hint && dur) {
    dur.addEventListener('change', () => {
      hint.style.display = dur.value === '5' ? '' : 'none';
    });
  }
}

async function _loadPlaylists() {
  const el = _el('csrPlaylistSelector');
  if (!el || !_user) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'studioPlaylists', _user.uid, 'playlists'),
      orderBy('createdAt', 'desc'), limit(50)
    ));
    _creator.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderPlaylistSelector();
  } catch(e) {
    el.innerHTML = '<div class="csr-hint">Could not load playlists.</div>';
  }
}

function _renderPlaylistSelector() {
  const el = _el('csrPlaylistSelector');
  if (!el) return;
  if (!_creator.playlists.length) {
    el.innerHTML = '<div class="csr-hint">No playlists found. <a class="csr-link" href="/?snxPage=studioPage">Go to 24-Hour Studio</a> to create a playlist.</div>';
    return;
  }
  el.innerHTML = _creator.playlists.map(pl => {
    const sel = _creator.selectedPl && _creator.selectedPl.id === pl.id;
    return `<button class="csr-pl-btn${sel ? ' selected' : ''}" onclick="csrSelectPlaylist('${_esc(pl.id)}')">
      <span class="csr-pl-name">${_esc(pl.name)}</span>
      <span class="csr-pl-count">${(pl.trackIds || []).length} tracks</span>
    </button>`;
  }).join('');
}

window.csrSelectPlaylist = async function(plId) {
  const pl = _creator.playlists.find(p => p.id === plId);
  if (!pl) return;
  _creator.selectedPl = pl;
  _renderPlaylistSelector();
  _creator.queue = [];
  const el = _el('csrQueuePreview');
  if (el) { el.style.display = ''; el.innerHTML = '<div class="csr-hint">Loading tracks…</div>'; }
  try {
    const ids = pl.trackIds || [];
    if (!ids.length) { if (el) el.innerHTML = '<div class="csr-hint">This playlist has no tracks.</div>'; return; }
    const chunks = [];
    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
    const results = [];
    for (const chunk of chunks) {
      const snap = await getDocs(query(
        collection(_db, 'cloudStreamTracks', _user.uid, 'tracks'),
        where(documentId(), 'in', chunk)
      ));
      snap.docs.forEach(d => results.push({ id: d.id, ...d.data() }));
    }
    _creator.queue = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
    _renderQueuePreview();
  } catch(e) {
    if (el) el.innerHTML = '<div class="csr-hint">Could not load tracks: ' + _esc(e.message) + '</div>';
  }
};

function _renderQueuePreview() {
  const el = _el('csrQueuePreview');
  if (!el) return;
  const q = _creator.queue;
  if (!q.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const totalSecs = q.reduce((a, t) => a + (t.duration || 0), 0);
  el.innerHTML =
    `<div class="csr-queue-header">${q.length} tracks · ${_fmtDur(totalSecs)} total</div>` +
    `<div class="csr-queue-list">` +
    q.slice(0, 10).map((t, i) =>
      `<div class="csr-queue-item">
        <span class="csr-queue-num">${i + 1}</span>
        <div class="csr-queue-info">
          <div class="csr-queue-title">${_esc(t.title || 'Untitled')}</div>
          <div class="csr-queue-artist">${_esc(t.artist || '')}</div>
        </div>
        <span class="csr-queue-dur">${_fmtDur(t.duration || 0)}</span>
      </div>`
    ).join('') +
    (q.length > 10 ? `<div class="csr-queue-more">+ ${q.length - 10} more</div>` : '') +
    `</div>`;
}

/* ── Start Broadcast ── */
window.csrStartBroadcast = async function() {
  const btn = _el('csrStartBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting…'; }
  try {
    if (!_user) throw new Error('Authentication required.');
    if (!_creator.selectedPl) throw new Error('Please select a playlist first.');
    const validTracks = _creator.queue.filter(t => t.url || t.downloadURL || t.musicUrl);
    if (!validTracks.length) throw new Error('No playable audio tracks found.');

    const durEl = _el('csrFormDuration');
    let durationMinutes = parseInt(durEl ? durEl.value : '1440', 10);
    // All authenticated users may use all duration options
    if (durationMinutes > 1440) durationMinutes = 1440;

    const dupSnap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (dupSnap.docs.length) {
      _show('csrDuplicateWarn', true);
      _streamId   = dupSnap.docs[0].id;
      _streamData = dupSnap.docs[0].data();
      throw new Error('Broadcast already active.');
    }

    const streamId = _user.uid + '_' + Date.now();
    _streamId = streamId;
    const title   = (_el('csrFormTitle')    || {}).value?.trim() || 'CloudStream by ' + (_userData?.displayName || _user.uid);
    const desc    = (_el('csrFormDesc')     || {}).value?.trim() || '';
    const cat     = (_el('csrFormCategory') || {}).value || 'Music';
    const shuffle = (_el('csrFormShuffle')  || {}).checked || false;
    const repeat  = (_el('csrFormRepeat')   || {}).checked !== false;

    _show('csrStartingProgress', true);
    _show('csrValidationError', false);
    _renderHandoffStep(0, 'Preparing broadcast…');

    await setDoc(doc(_db, 'cloudStreams', streamId), {
      uid: _user.uid,
      displayName: _userData?.displayName || _userData?.username || '',
      streamName: title, description: desc, category: cat,
      theme: 'shadow-nexus', durationMinutes,
      status: 'starting', viewerCount: 0,
      coverArt: _artworkDataUrl || '',
      createdAt: serverTimestamp(), startedAt: null, expiresAt: null,
      workerStatus: 'pending', lastHeartbeat: null,
      musicPlaylistId: _creator.selectedPl.id,
    });
    _streamData = { uid: _user.uid, streamName: title, status: 'starting', durationMinutes };
    _renderHandoffStep(1, 'Saving configuration…');
    await _sleep(400);

    _renderHandoffStep(2, 'Starting cloud worker…');
    const musicQueue = validTracks.map(t => ({
      id: t.id,
      title:    t.title    || t.name   || 'Untitled',
      artist:   t.artist   || '',
      url:      t.url      || t.downloadURL || t.musicUrl || '',
      duration: t.duration || t.durationSecs || 0,
      artworkUrl: t.artworkUrl || t.artwork || '',
      mediaType:  t.mediaType  || 'music',
    }));

    const idToken  = await _user.getIdToken(true);
    const startRes = await fetch(WORKER_URL + '/api/stream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({
        streamId, uid: _user.uid,
        displayName:  _userData?.displayName || '',
        streamName:   title, theme: 'shadow-nexus',
        scenePlaylist: [],
        durationMinutes, musicQueue,
        musicShuffle: shuffle, musicRepeat: repeat,
        musicCrossfade: 3, musicVolume: 80,
        musicPlaylistId: _creator.selectedPl.id,
      }),
    });
    if (!startRes.ok) {
      const errData = await startRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Cloud worker failed to start (HTTP ' + startRes.status + ').');
    }
    await startRes.json();
    _renderHandoffStep(3, 'Verifying worker…');
    await _sleep(600);

    const expiresAt = Date.now() + durationMinutes * 60 * 1000;
    await updateDoc(doc(_db, 'cloudStreams', streamId), {
      status: 'active', startedAt: serverTimestamp(), expiresAt,
    });
    await setDoc(doc(_db, 'liveRooms', _user.uid), {
      creatorId: _user.uid, creatorSource: 'shadow_nexus_social',
      roomId: _user.uid, hostId: _user.uid,
      hostName: _userData?.displayName || _userData?.username || '',
      hostUsername: _userData?.username || '',
      hostAvatar: _userData?.avatar || _userData?.profilePicture || _user.photoURL || '',
      title, description: desc, category: cat,
      coverArt: _artworkDataUrl || '',
      status: 'live', isLive: true, type: '24hour_cloudstream',
      cloudStreamId: streamId, startedAt: serverTimestamp(),
      expiresAt: new Date(expiresAt).toISOString(),
      viewers: 0, likes: 0,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });

    _streamData = { uid: _user.uid, streamName: title, status: 'active', durationMinutes, expiresAt, category: cat, displayName: _userData?.displayName || '' };

    if (musicQueue.length) {
      const first = musicQueue[0];
      await setDoc(doc(_db, 'studioCloudStreamMusic', streamId), {
        cloudStreamId: streamId, uid: _user.uid,
        playlistId: _creator.selectedPl.id,
        currentTrackId: first.id, currentTitle: first.title,
        currentArtist: first.artist,
        currentTrackUrl: first.url, currentDuration: first.duration || 0,
        artworkUrl: first.artworkUrl || '',
        mediaType: first.mediaType || 'music',
        nextTrackId: musicQueue[1]?.id    || '',
        nextTitle:   musicQueue[1]?.title || '',
        nextArtist:  musicQueue[1]?.artist || '',
        upNext: musicQueue.slice(1, 6).map(t => ({
          title: t.title, artist: t.artist,
          mediaType: t.mediaType || 'music', artworkUrl: t.artworkUrl || '',
        })),
        queueIndex: 0, status: 'playing', updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    _renderHandoffStep(4, 'Broadcast is LIVE!');
    await _sleep(800);
    _show('csrStartingProgress', false);
    _show('csrCreatePanel', false);
    _showActiveStream();
    _toast('&#9925; Cloud Stream is now LIVE!', 'success');
  } catch(e) {
    console.error('[CSR] startBroadcast error:', e);
    _show('csrStartingProgress', false);
    if (btn) { btn.disabled = false; btn.innerHTML = '&#128308; GO LIVE FOR 24 HOURS'; }
    if (_streamId && e.message && e.message.includes('already active')) {
      _showActiveStream();
    } else {
      _showError('csrValidationError', e.message || 'Could not start broadcast.');
      if (_streamId) updateDoc(doc(_db, 'cloudStreams', _streamId), { status: 'failed' }).catch(() => {});
    }
    _streamId = null;
  }
};

function _renderHandoffStep(step, label) {
  const el = _el('csrHandoffSteps');
  if (!el) return;
  const steps = ['Preparing broadcast…','Saving configuration…','Starting cloud worker…','Verifying worker…','Broadcast is LIVE!'];
  el.innerHTML = steps.map((s, i) => {
    const done = i < step, active = i === step;
    const icon = done ? '&#10003;' : active ? '&#9203;' : '&#9675;';
    return `<div class="csr-handoff-step${done?' done':active?' active':''}">
      <span class="csr-handoff-icon">${icon}</span>
      <span>${_esc(i === step ? label : s)}</span>
    </div>`;
  }).join('');
}

/* ── Stop Broadcast ── */
window.csrConfirmStop = function() {
  _showConfirm('End Cloud Stream?', 'This will stop the broadcast for all viewers. Cannot be undone.', _stopBroadcast);
};

async function _stopBroadcast() {
  const btn = _el('csrStopBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Stopping…'; }
  _stopHealthMonitor();
  try {
    const idToken = await _user.getIdToken(true);
    await fetch(WORKER_URL + '/api/stream/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId: _streamId, uid: _user.uid }),
    });
  } catch(_) {}
  try {
    if (_streamId) {
      await updateDoc(doc(_db, 'cloudStreams', _streamId), { status: 'stopped', stoppedAt: serverTimestamp() });
      await updateDoc(doc(_db, 'studioCloudStreamMusic', _streamId), { status: 'stopped', stoppedAt: serverTimestamp() }).catch(() => {});
    }
    await updateDoc(doc(_db, 'liveRooms', _user.uid), { isLive: false, status: 'ended', updatedAt: serverTimestamp() }).catch(() => {});
  } catch(_) {}

  if (_player.unsub) { try { _player.unsub(); } catch(_) {} _player.unsub = null; }
  if (_creator.adminNpUnsub) { try { _creator.adminNpUnsub(); } catch(_) {} _creator.adminNpUnsub = null; }
  _stopAudio();
  _streamId = _streamData = null;
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _toast('Broadcast ended.', 'info');
}

/* ── Skip Track ── */
window.csrSkipTrack = async function() {
  if (!_streamId || !_user) return;
  try {
    const idToken = await _user.getIdToken(true);
    await fetch(WORKER_URL + '/api/stream/music/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId: _streamId, uid: _user.uid, action: 'next' }),
    });
    _toast('Skipping…', 'info');
    setTimeout(_checkHealth, 1500);
  } catch(e) {
    _toast('Could not skip: ' + e.message, 'error');
  }
};

/* ── Broadcast History ── */
async function _loadHistory() {
  const el = _el('csrHistoryList');
  if (!el || !_user) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      orderBy('createdAt', 'desc'), limit(10)
    ));
    if (!snap.docs.length) { _show('csrHistoryPanel', false); return; }
    _show('csrHistoryPanel', true);
    el.innerHTML = snap.docs.map(d => {
      const data = d.data();
      const started = data.startedAt?.toMillis ? data.startedAt.toMillis() : null;
      const stopped = data.stoppedAt?.toMillis ? data.stoppedAt.toMillis() : null;
      const duration = (started && stopped) ? _fmtDur(Math.floor((stopped - started) / 1000)) : '—';
      const colors = { active: '#39ff14', stopped: '#5a80a8', failed: '#ff3355', ended: '#5a80a8' };
      const color = colors[data.status] || '#5a80a8';
      return `<div class="csr-history-item">
        <div class="csr-history-name">${_esc(data.streamName || 'Untitled')}</div>
        <div class="csr-history-meta">
          <span style="color:${color}">${_esc((data.status || '').toUpperCase())}</span>
          <span>·</span><span>${started ? _fmtDate(started) : '—'}</span>
          <span>·</span><span>${duration}</span>
        </div>
      </div>`;
    }).join('');
  } catch(_) { el.innerHTML = '<div class="csr-hint">Could not load history.</div>'; }
}

/* ── Artwork (broadcast cover) ── */
// Uploads chosen image to Cloudflare R2 and stores permanent URL.
const _R2_UPLOAD_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
window.csrLoadArtwork = function(evt) {
  const file = evt.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;

  // Local preview while uploading
  const blobUrl = URL.createObjectURL(file);
  const img = _el('csrArtworkImg');
  if (img) img.src = blobUrl;
  _show('csrArtworkPreview', true);
  const btn = _el('csrArtworkBtn');
  if (btn) btn.textContent = '🖼 Uploading…';

  if (!_user || typeof _user.getIdToken !== 'function') {
    _artworkDataUrl = blobUrl;
    if (btn) btn.textContent = '🖼 Change Image';
    return;
  }

  _user.getIdToken(true).then(function(idToken) {
    const uid = _user.uid;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const r2Key = 'cloud-stream/' + uid + '/artwork/' + Date.now() + '_' + safeName;

    const form = new FormData();
    form.append('file', file, file.name);
    form.append('path', r2Key);

    const xhr = new XMLHttpRequest();
    xhr.timeout = 3 * 60 * 1000;

    xhr.onload = function() {
      URL.revokeObjectURL(blobUrl);
      if (xhr.status === 200) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.url) {
            _artworkDataUrl = res.url;
            if (img) img.src = res.url;
            if (btn) btn.textContent = '🖼 Change Image';
            return;
          }
        } catch(_) {}
      }
      console.warn('[CloudStream] Artwork R2 upload failed. HTTP', xhr.status);
      _artworkDataUrl = '';
      if (btn) btn.textContent = '🖼 Retry Image';
    };
    xhr.onerror = xhr.ontimeout = function() {
      URL.revokeObjectURL(blobUrl);
      _artworkDataUrl = '';
      if (btn) btn.textContent = '🖼 Retry Image';
    };

    xhr.open('POST', _R2_UPLOAD_WORKER + '/');
    xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
    xhr.send(form);
  }).catch(function(e) {
    console.warn('[CloudStream] Artwork upload auth error:', e.message);
    _artworkDataUrl = '';
    if (btn) btn.textContent = '🖼 Change Image';
  });
};
window.csrRemoveArtwork = function() {
  _artworkDataUrl = null;
  _show('csrArtworkPreview', false);
  const btn = _el('csrArtworkBtn');
  if (btn) btn.textContent = '🖼 Choose Image';
};

/* ── Scroll helpers ── */
window.csrScrollToAdmin  = function() {
  const el = _el('csrAdminSection');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
};
window.csrScrollToPlaylist = function() { window.location.href = '/?snxPage=studioPage'; };
window.csrOpenExistingStream = function() { _show('csrDuplicateWarn', false); _showActiveStream(); };

/* ── Confirmation dialog ── */
function _showConfirm(title, body, cb) {
  _confirmCallback = cb;
  _setText('csrConfirmTitle', title);
  _setText('csrConfirmBody', body);
  _show('csrConfirmOverlay', true);
}
window.csrConfirmCancel  = function() { _show('csrConfirmOverlay', false); _confirmCallback = null; };
window.csrConfirmProceed = function() { _show('csrConfirmOverlay', false); if (_confirmCallback) _confirmCallback(); _confirmCallback = null; };

/* ── SPA re-init ── */
window.csrSpaInit = async function() {
  if (!_user) return;
  _show('csrLoading', false);
  _show('csrAuthGate', false);
  _show('csrApp', true);
  _show('csrViewerSection', false);
  await _initCreatorMode();
};

window.csrRefreshPlaylists = function() {
  if (_user) _loadPlaylists();
};
