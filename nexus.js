/**
 * SHADOW NEXUS — 24-HOUR NEXUS (nexus.js)
 * ─────────────────────────────────────────
 * Unified system combining Eternal Stream (cloud-stream.js viewer)
 * + 24-Hour Studio (studio.js: Music Library, Playlists, Queue, Upload)
 * into ONE cohesive experience with the Egyptian/Horror/Cosmic theme.
 *
 * This module initialises when the #nexusPage page becomes active.
 * It delegates backend calls to the existing Studio global functions
 * (snxCSMusicCreatePlaylist, snxCSMusicSelectPlaylist, etc.) and
 * the existing Eternal Stream viewer logic where possible, so we
 * do NOT duplicate backend logic — we re-theme and re-unify the UI.
 *
 * Firebase collections (same as studio.js — no new collections):
 *   cloudStreamTracks/{uid}/tracks/{id}
 *   studioPlaylists/{uid}/playlists/{id}
 *   studioCloudStreamMusic/{streamId}
 *   cloudStreams/{streamId}
 *   studioCloudStreamQueue/{streamId}/items/{id}
 */
'use strict';

(function() {

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
var _nx = {
  activeTab:    'watch',
  user:         null,
  userData:     null,
  role:         'member',      // 'member' | 'creator' | 'founder'
  mediaFilter:  'all',         // 'all' | 'music' | 'video' | 'picture'
  uploadType:   'music',       // 'music' | 'video' | 'picture'
  toastTimer:   null,
  // Watch / stream state (bridges to cloud-stream.js player)
  viewerCount:  0,
  likeCount:    0,
  liked:        false,
  streamId:     null,
  streamUnsub:  null,
  npUnsub:      null,
  viewerUnsub:  null,
  // Scenes for TOMB OF SOUND — assigned per-track (stable hash)
  scenes: [
    'ANUBIS CHAMBER','BLOOD PYRAMID','PHARAOH\'S GALAXY',
    'CURSED TOMB','EYE OF THE NEXUS','DESERT AFTER MIDNIGHT',
    'UNDERWORLD','CELESTIAL TEMPLE'
  ]
};

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */
function _el(id)       { return document.getElementById(id); }
function _esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _fmtDur(s)    { if (!s||s<=0) return '0:00'; var m=Math.floor(s/60),ss=Math.floor(s%60); return m+':'+(ss<10?'0':'')+ss; }
function _stableScene(title) {
  var h=0,str=String(title||'');
  for(var i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))|0;
  return _nx.scenes[Math.abs(h)%_nx.scenes.length];
}

function _toast(msg, type) {
  var el = _el('nxToast');
  if (!el) { // fallback to global
    if (typeof toastNotification === 'function') toastNotification(msg);
    return;
  }
  el.textContent = msg;
  el.className = 'nx-toast show' + (type ? ' '+type : '');
  if (_nx.toastTimer) clearTimeout(_nx.toastTimer);
  _nx.toastTimer = setTimeout(function() {
    el.classList.remove('show');
  }, 3500);
}

function _toastError(msg) { _toast(msg, 'error'); }
function _toastOk(msg)    { _toast(msg, 'success'); }

/* ═══════════════════════════════════════════════════════
   INIT — called when nexusPage becomes visible
═══════════════════════════════════════════════════════ */
window.snxNexusInit = function() {
  window._snxOnAuthReady(function() {
    _nx.user     = window._snxCurrentUser || null;
    _nx.userData = window._snxUserData    || null;
    _nx.role     = _resolveRole();

    if (!_nx.user) {
      _showAuthGate();
      return;
    }

    _initHeader();
    _initTabBar();
    _loadActiveTab('watch');

    // Pre-load stream viewer
    _discoverStream();

    // Pre-load music library for instant Vault/Playlist
    if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    if (typeof _csMusicLoadPlaylists === 'function') _csMusicLoadPlaylists();
    if (typeof _sqLoad === 'function') _sqLoad();
    if (typeof _checkActiveCloudStream === 'function') _checkActiveCloudStream();
  });
};

function _resolveRole() {
  var data = _nx.userData || {};
  var r = data.role || 'member';
  if (r === 'founder') return 'founder';
  if (r === 'admin' || r === 'creator') return 'creator';
  return 'member';
}

function _showAuthGate() {
  var body = _el('nxBody');
  if (body) body.innerHTML =
    '<div class="nx-empty" style="padding:60px 20px;">' +
      '<div class="nx-empty-icon">𓂀</div>' +
      '<div class="nx-empty-text">Sign in to enter the 24-Hour Nexus.</div>' +
    '</div>';
}

/* ═══════════════════════════════════════════════════════
   HEADER — viewer count live update
═══════════════════════════════════════════════════════ */
function _initHeader() {
  var nameEl = _el('nxUserBadge');
  if (nameEl) {
    var name = _nx.userData ? (_nx.userData.displayName || _nx.userData.username || '') : '';
    nameEl.textContent = name;
  }
}

function _updateViewerBadge(count) {
  var el = _el('nxViewerCount');
  if (el) el.textContent = count + ' WATCHING';
}

/* ═══════════════════════════════════════════════════════
   TAB BAR
═══════════════════════════════════════════════════════ */
function _initTabBar() {
  // Show/hide management tabs based on role
  var mgmtTabs = ['vault','playlists','queue','upload'];
  mgmtTabs.forEach(function(tab) {
    var btn = _el('nxTab_' + tab);
    if (btn) btn.style.display = (_nx.role === 'member') ? 'none' : '';
  });
  var ctrlTab = _el('nxTab_control');
  if (ctrlTab) ctrlTab.style.display = (_nx.role === 'founder') ? '' : 'none';
}

window.snxNexusSwitchTab = function(tab) {
  _nx.activeTab = tab;
  // Tabs
  document.querySelectorAll('.nx-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.nxtab === tab);
  });
  // Panels
  document.querySelectorAll('.nx-panel').forEach(function(panel) {
    panel.classList.toggle('active', panel.dataset.nxtab === tab);
  });
  _loadActiveTab(tab);
};

function _loadActiveTab(tab) {
  if (tab === 'watch')     _loadWatch();
  if (tab === 'vault')     _loadVault();
  if (tab === 'playlists') _loadPlaylists();
  if (tab === 'queue')     _loadQueue();
  if (tab === 'upload')    _loadUpload();
  if (tab === 'control')   _loadControl();
}

/* ═══════════════════════════════════════════════════════
   TAB: WATCH — eternal stream viewer
═══════════════════════════════════════════════════════ */
function _loadWatch() {
  _discoverStream();
}

function _discoverStream() {
  var fs = window._snxFirestore;
  if (!fs) return;
  // Find the most recent active cloudStream
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreams'),
    fs.where('status', 'in', ['active', 'recovering']),
    fs.orderBy('startedAt', 'desc'),
    fs.limit(1)
  )).then(function(snap) {
    if (snap && snap.docs && snap.docs.length) {
      var d = snap.docs[0];
      _nx.streamId = d.id;
      _subscribeStream(d.id, d.data());
    } else {
      _renderWatchOffline();
    }
  }).catch(function() { _renderWatchOffline(); });
}

function _subscribeStream(streamId, streamData) {
  _renderWatchOnline(streamData);
  // Subscribe to Now Playing
  var fs = window._snxFirestore;
  if (!fs) return;
  if (_nx.npUnsub) { try { _nx.npUnsub(); } catch(_){} }
  _nx.npUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'studioCloudStreamMusic', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      _updateNowTransmitting(d);
    },
    function(){}
  );
  // Subscribe viewer count via cloudStreams doc
  if (_nx.streamUnsub) { try { _nx.streamUnsub(); } catch(_){} }
  _nx.streamUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'cloudStreams', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') {
        _renderWatchOffline();
        _cleanupStreamSubs();
        return;
      }
      _nx.viewerCount = d.viewerCount || 0;
      _updateViewerBadge(_nx.viewerCount);
      var vcEl = _el('nxWatchViewers');
      if (vcEl) vcEl.textContent = _nx.viewerCount;
    },
    function(){}
  );
  // Prophecy Queue from studioCloudStreamMusic
  _subscribeQueue(streamId);
  // Viewer presence
  _joinAsViewer(streamId);
  // Check like
  _checkLike(streamId);
}

function _cleanupStreamSubs() {
  if (_nx.npUnsub)     { try { _nx.npUnsub(); }     catch(_){} _nx.npUnsub = null; }
  if (_nx.streamUnsub) { try { _nx.streamUnsub(); } catch(_){} _nx.streamUnsub = null; }
  if (_nx.viewerUnsub) { try { _nx.viewerUnsub(); } catch(_){} _nx.viewerUnsub = null; }
}

function _renderWatchOnline(streamData) {
  var offline = _el('nxWatchOffline');
  var online  = _el('nxWatchOnline');
  if (offline) offline.style.display = 'none';
  if (online)  online.style.display  = '';
}

function _renderWatchOffline() {
  var offline = _el('nxWatchOffline');
  var online  = _el('nxWatchOnline');
  if (offline) offline.style.display = '';
  if (online)  online.style.display  = 'none';
  var el = _el('nxNtTitle');
  if (el) el.textContent = 'THE CHANNEL SLEEPS';
  var sub = _el('nxNtArtist');
  if (sub) sub.textContent = 'The Eternal Stream will return...';
  var qList = _el('nxProphecyQueueList');
  if (qList) qList.innerHTML = '<li class="nx-queue-item"><span class="nx-queue-num">𓂀</span><span class="nx-queue-title">The Prophecy Queue awaits...</span></li>';
}

function _updateNowTransmitting(d) {
  var title  = d.currentTitle  || 'THE ETERNAL SILENCE';
  var artist = d.currentArtist || '';
  var next   = d.nextTitle     || '';
  var el = _el('nxNtTitle');  if (el) el.textContent = title;
  var ae = _el('nxNtArtist'); if (ae) ae.textContent = artist;
  var ne = _el('nxNtNext');   if (ne) ne.textContent = next ? 'UP NEXT: ' + next : '';
  // Update scene name
  var scene = _stableScene(title);
  var se = _el('nxSceneName'); if (se) se.textContent = scene;
  // Update audio viz canvas label
  var cv = _el('nxSceneLabel'); if (cv) cv.textContent = scene;
  // Update prophecy queue
  _renderProphecyQueueFromNP(d);
  // Activate visual scene
  _activateVisualScene(title, d.mediaType || 'music');
}

function _renderProphecyQueueFromNP(d) {
  var el = _el('nxProphecyQueueList');
  if (!el) return;
  var current = d.currentTitle  || 'Untitled';
  var next1   = d.nextTitle     || '';
  var html = '<li class="nx-queue-item nx-queue-current">' +
    '<span class="nx-queue-num">♪</span>' +
    '<span class="nx-queue-title">' + _esc(current) + '</span>' +
    '<span class="nx-queue-type-badge">NOW</span>' +
  '</li>';
  if (next1) {
    html += '<li class="nx-queue-item">' +
      '<span class="nx-queue-num">2</span>' +
      '<span class="nx-queue-title">' + _esc(next1) + '</span>' +
    '</li>';
  }
  el.innerHTML = html;
}

function _subscribeQueue(streamId) {
  // The queue is shown from studioCloudStreamMusic — already subscribed in npUnsub
  // We also show from the studio queue (studioCloudStreamQueue) when available
  var fs = window._snxFirestore;
  if (!fs) return;
}

/* ═══════════════════════════════════════════════════════
   VISUAL SCENE ENGINE — TOMB OF SOUND
═══════════════════════════════════════════════════════ */
function _activateVisualScene(title, mediaType) {
  var canvas = _el('nxSceneCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Resize canvas
  canvas.width  = canvas.offsetWidth  || 360;
  canvas.height = canvas.offsetHeight || 200;
  var W = canvas.width, H = canvas.height;

  // Colour palette per scene
  var scene = _stableScene(title);
  var palettes = {
    'ANUBIS CHAMBER':     ['#c5a41d','#1a2a1a','#8a6f0d'],
    'BLOOD PYRAMID':      ['#8a0a14','#c5a41d','#2a0a0a'],
    'PHARAOH\'S GALAXY':  ['#1a0a3a','#c5a41d','#7c3acf'],
    'CURSED TOMB':        ['#1a1a0a','#8a6f0d','#3a0a0a'],
    'EYE OF THE NEXUS':   ['#1ad3d3','#c5a41d','#0a1a2a'],
    'DESERT AFTER MIDNIGHT':['#c5a41d','#0a0a1a','#3a2a0a'],
    'UNDERWORLD':         ['#3a0a0a','#c5a41d','#0a0a0a'],
    'CELESTIAL TEMPLE':   ['#7c3acf','#c5a41d','#1a0a3a']
  };

  var pal = palettes[scene] || palettes['ANUBIS CHAMBER'];

  // Draw gradient background
  var grd = ctx.createLinearGradient(0,0,W,H);
  grd.addColorStop(0, pal[1]);
  grd.addColorStop(0.5, pal[2] + '66');
  grd.addColorStop(1, '#000');
  ctx.fillStyle = grd;
  ctx.fillRect(0,0,W,H);

  // Draw hieroglyphic bars (simulated visualizer)
  var bars = 24;
  var bw   = (W - 20) / bars;
  for (var i = 0; i < bars; i++) {
    var h  = 8 + Math.random() * (H * 0.55);
    var x  = 10 + i * bw;
    var alpha = 0.3 + Math.random() * 0.5;
    ctx.fillStyle = pal[0] + Math.floor(alpha * 255).toString(16).padStart(2,'0');
    ctx.fillRect(x, H - h, bw * 0.65, h);
  }

  // Draw Eye of Horus (𓂀) text
  ctx.font = 'bold ' + Math.floor(H * 0.28) + 'px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = pal[0];
  ctx.fillText('𓂀', W/2, H/2);
  ctx.globalAlpha = 1;

  // Scene name text
  ctx.font = '700 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = pal[0] + 'cc';
  ctx.fillText(scene, W - 10, H - 6);
}

/* ═══════════════════════════════════════════════════════
   LIKES & VIEWER PRESENCE
═══════════════════════════════════════════════════════ */
function _checkLike(streamId) {
  var fs = window._snxFirestore;
  if (!fs || !_nx.user) return;
  fs.getDoc(fs.doc(fs.db, 'cloudStreamLikes', streamId, 'likes', _nx.user.uid))
    .then(function(snap) {
      _nx.liked = !!(snap && snap.exists());
      _updateLikeBtn();
    }).catch(function(){});
}

function _updateLikeBtn() {
  var btn = _el('nxLikeBtn');
  if (!btn) return;
  if (_nx.liked) btn.classList.add('liked');
  else           btn.classList.remove('liked');
}

window.snxNexusToggleLike = function() {
  if (!_nx.user || !_nx.streamId) {
    _toastError('Sign in to like the stream.');
    return;
  }
  var fs = window._snxFirestore;
  if (!fs) return;
  var likeRef = fs.doc(fs.db, 'cloudStreamLikes', _nx.streamId, 'likes', _nx.user.uid);
  if (_nx.liked) {
    // Unlike
    fs.deleteDoc(likeRef).then(function() {
      _nx.liked = false;
      _nx.likeCount = Math.max(0, _nx.likeCount - 1);
      _updateLikeBtn();
      _updateLikeCount();
      // Decrement stream doc
      fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _nx.streamId), { likes: fs.increment(-1) }).catch(function(){});
    }).catch(function(){});
  } else {
    // Like
    fs.setDoc(likeRef, { uid: _nx.user.uid, ts: fs.serverTimestamp() })
      .then(function() {
        _nx.liked = true;
        _nx.likeCount += 1;
        _updateLikeBtn();
        _updateLikeCount();
        // Increment stream doc
        fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _nx.streamId), { likes: fs.increment(1) }).catch(function(){});
      }).catch(function(){});
  }
};

function _updateLikeCount() {
  var el = _el('nxLikeCount');
  if (el) el.textContent = _nx.likeCount;
}

function _joinAsViewer(streamId) {
  // Use RTDB presence (same pattern as cloud-stream.js)
  var rtdbApi = window._snxRtdbApi;
  if (!rtdbApi || !_nx.user) return;
  var sessionKey = sessionStorage.getItem('snx_nx_session') || (function(){
    var id = Math.random().toString(36).slice(2,12);
    sessionStorage.setItem('snx_nx_session', id);
    return id;
  })();
  var presRef = rtdbApi.ref(rtdbApi.getDatabase(), 'nexusViewers/' + streamId + '/' + sessionKey);
  rtdbApi.set(presRef, {
    uid:       _nx.user.uid,
    ts:        rtdbApi.serverTimestamp ? { '.sv': 'timestamp' } : Date.now(),
    sessionId: sessionKey
  });
  rtdbApi.onDisconnect && rtdbApi.onDisconnect(presRef).remove();
}

/* ═══════════════════════════════════════════════════════
   TAB: VAULT — NEXUS MEDIA VAULT
═══════════════════════════════════════════════════════ */
function _loadVault() {
  _renderVault();
}

function _renderVault() {
  // Delegate to the existing studio.js music library, re-rendered in nexus theme
  var el = _el('nxVaultList');
  if (!el) return;

  // Get tracks from global _music.tracks (populated by studio.js _mlLoadTracks)
  var tracks = (window._snxNexusTracks) ? window._snxNexusTracks
             : (window._music && window._music.tracks) ? window._music.tracks
             : [];

  if (!tracks || !tracks.length) {
    el.innerHTML =
      '<div class="nx-empty">' +
        '<div class="nx-empty-icon">𓂀</div>' +
        '<div class="nx-empty-text">The Vault is empty.<br>Upload music, video, or pictures.</div>' +
      '</div>';
    // Try to load
    if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    return;
  }

  var filter = _nx.mediaFilter;
  var q = (_el('nxVaultSearch') || {}).value || '';

  var filtered = tracks.filter(function(t) {
    var typeMatch = filter === 'all' || (t.mediaType || 'music') === filter;
    if (!typeMatch) return false;
    if (!q) return true;
    var ql = q.toLowerCase();
    return (t.title||'').toLowerCase().includes(ql) ||
           (t.artist||'').toLowerCase().includes(ql);
  });

  var count = _el('nxVaultCount');
  if (count) count.textContent = filtered.length + ' ITEMS';

  if (!filtered.length) {
    el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">🔍</div><div class="nx-empty-text">No items found.</div></div>';
    return;
  }

  el.innerHTML = filtered.map(function(t) {
    var type    = t.mediaType || 'music';
    var typeIcon = type === 'video' ? '🎬' : type === 'picture' ? '🖼️' : '🎵';
    var dur     = t.duration ? _fmtDur(t.duration) : '—';
    var art     = t.artworkUrl || t.thumbnailUrl || '';
    var inSQ    = (typeof window._sq !== 'undefined' && window._sq && window._sq.queue && window._sq.queue.some(function(q) { return q.id === t.id; }));

    return '<div class="nx-track-item" data-tid="' + _esc(t.id) + '">' +
      '<div class="nx-track-artwork">' +
        (art ? '<img src="' + _esc(art) + '" alt="" loading="lazy">' : typeIcon) +
      '</div>' +
      '<div class="nx-track-info">' +
        '<div class="nx-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="nx-track-artist">' + _esc(t.artist || t.creator || '') + '</div>' +
      '</div>' +
      '<span class="nx-track-dur">' + _esc(dur) + '</span>' +
      '<div class="nx-track-actions">' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusPreviewTrack(\'' + _esc(t.id) + '\')" title="Play / Preview">▶</button>' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusAddToQueue(\'' + _esc(t.id) + '\')" ' +
          'title="Add to Queue" style="color:' + (inSQ ? 'var(--nx-gold)' : '') + ';">' +
          (inSQ ? '✓' : '+Q') +
        '</button>' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusAddToPlaylistModal(\'' + _esc(t.id) + '\')" title="Add to Playlist">+PL</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusVaultFilter = function(filter) {
  _nx.mediaFilter = filter;
  document.querySelectorAll('.nx-media-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  _renderVault();
};

window.snxNexusVaultSearch = function() { _renderVault(); };

window.snxNexusPreviewTrack = function(trackId) {
  var tracks = (window._music && window._music.tracks) ? window._music.tracks : [];
  var t = tracks.find(function(x){ return x.id === trackId; });
  if (!t || !t.url) { _toastError('Track not ready yet.'); return; }
  if (typeof snxCSMusicPlayTrack === 'function') {
    snxCSMusicPlayTrack(trackId);
    _toast('Playing: ' + (t.title || 'Untitled'));
  }
};

window.snxNexusAddToQueue = function(trackId) {
  if (typeof snxSQAddToQueue === 'function') {
    snxSQAddToQueue(trackId);
    _toastOk('Added to queue.');
    _renderVault();
    if (_nx.activeTab === 'queue') _loadQueue();
  }
};

window.snxNexusAddToPlaylistModal = function(trackId) {
  // Re-use existing cs music playlist add
  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];
  if (!playlists.length) {
    _toast('Create a playlist first in the PLAYLISTS tab.');
    return;
  }
  var names = playlists.map(function(p,i){ return (i+1)+'. '+p.name; }).join('\n');
  var choice = prompt('Add to which playlist? (enter number)\n\n' + names + '\n\nor press Cancel');
  if (!choice) return;
  var idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= playlists.length) { _toastError('Invalid selection.'); return; }
  var pl = playlists[idx];
  if (typeof snxCSMusicAddSingleTrack === 'function') {
    snxCSMusicAddSingleTrack(pl.id, trackId);
  }
};

/* Called by studio.js after library loads, to re-render vault */
window.snxNexusOnTracksLoaded = function() {
  if (_nx.activeTab === 'vault') _renderVault();
};

/* ═══════════════════════════════════════════════════════
   TAB: PLAYLISTS — PROPHECY PLAYLISTS
═══════════════════════════════════════════════════════ */
function _loadPlaylists() {
  if (typeof _csMusicLoadPlaylists === 'function') _csMusicLoadPlaylists();
  _renderPlaylists();
}

function _renderPlaylists() {
  var el = _el('nxPlaylistsList');
  if (!el) return;

  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];

  if (!playlists.length) {
    el.innerHTML =
      '<div class="nx-empty">' +
        '<div class="nx-empty-icon">𓂀</div>' +
        '<div class="nx-empty-text">No Prophecy Playlists yet.<br>Create one to begin.</div>' +
      '</div>';
    return;
  }

  el.innerHTML = playlists.map(function(pl) {
    var count = (pl.trackIds && pl.trackIds.length) || 0;
    var isSel = window._csMusic && window._csMusic.selectedId === pl.id;
    return '<div class="nx-playlist-card' + (isSel ? ' selected' : '') + '" onclick="snxNexusOpenPlaylist(\'' + _esc(pl.id) + '\')">' +
      '<div class="nx-playlist-art">𓂀</div>' +
      '<div class="nx-playlist-info">' +
        '<div class="nx-playlist-name">' + _esc(pl.name) + '</div>' +
        '<div class="nx-playlist-count">' + count + ' ITEM' + (count !== 1 ? 'S' : '') + '</div>' +
      '</div>' +
      '<div class="nx-playlist-actions" onclick="event.stopPropagation();">' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusSendToStream(\'' + _esc(pl.id) + '\')" title="Send to Eternal Stream">▶ STREAM</button>' +
        '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxNexusDeletePlaylist(\'' + _esc(pl.id) + '\')" title="Delete">🗑</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusCreatePlaylist = function() {
  var name = prompt('𓂀 Name your Prophecy Playlist:');
  if (!name || !name.trim()) return;
  if (typeof snxCSMusicCreatePlaylist !== 'function') { _toastError('Not ready.'); return; }
  // Patch create to re-render after
  var orig = window._renderCSPlaylistPanel;
  snxCSMusicCreatePlaylist._nxHooked = true;
  // We call the existing function directly; it uses prompt internally.
  // Since snxCSMusicCreatePlaylist uses its own prompt, we need to patch.
  // Instead, call our own version:
  _nxCreatePlaylist(name.trim());
};

function _nxCreatePlaylist(name) {
  if (!window._snxFirestore || !_nx.user) { _toastError('Not signed in.'); return; }
  var fs  = window._snxFirestore;
  var uid = _nx.user.uid;
  var id  = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  var pl  = { id: id, name: name, trackIds: [], shuffle: false, repeat: true,
              crossfade: 3, volume: 80, createdAt: fs.serverTimestamp() };
  fs.setDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', id), pl)
    .then(function() {
      if (window._csMusic) {
        window._csMusic.playlists.unshift(Object.assign({}, pl, { id: id, createdAt: Date.now() }));
      }
      _toastOk('Playlist created: ' + name);
      _renderPlaylists();
    })
    .catch(function(e) { _toastError('Could not create: ' + e.message); });
}

window.snxNexusOpenPlaylist = function(plId) {
  if (typeof snxCSMusicSelectPlaylist === 'function') snxCSMusicSelectPlaylist(plId);
  _showPlaylistEditor(plId);
};

window.snxNexusDeletePlaylist = function(plId) {
  if (!confirm('Delete this Prophecy Playlist?')) return;
  if (typeof snxCSMusicDeletePlaylist === 'function') {
    snxCSMusicDeletePlaylist(plId);
    setTimeout(_renderPlaylists, 400);
  }
};

window.snxNexusSendToStream = function(plId) {
  // Show send-to-stream modal
  var modal = _el('nxStreamModal');
  if (!modal) return;
  modal.dataset.plid = plId;
  modal.classList.add('open');
};

window.snxNexusStreamModalClose = function() {
  var modal = _el('nxStreamModal');
  if (modal) modal.classList.remove('open');
};

window.snxNexusStreamPlayNow = function() {
  var modal = _el('nxStreamModal');
  if (!modal) return;
  var plId = modal.dataset.plid;
  modal.classList.remove('open');
  if (!plId) return;
  if (typeof snxCSMusicSelectPlaylist === 'function') snxCSMusicSelectPlaylist(plId);
  if (typeof snxCSMusicPlayPause === 'function') {
    setTimeout(function() {
      if (!window._csMusic || !window._csMusic.playing) snxCSMusicPlayPause();
    }, 500);
  }
  _toastOk('Playlist sent to Eternal Stream — Playing Now.');
  snxNexusSwitchTab('watch');
};

window.snxNexusStreamAddToQueue = function() {
  var modal = _el('nxStreamModal');
  if (!modal) return;
  var plId = modal.dataset.plid;
  modal.classList.remove('open');
  if (!plId) return;
  // Select playlist so its tracks resolve, then add to SQ
  if (typeof snxCSMusicSelectPlaylist === 'function') {
    snxCSMusicSelectPlaylist(plId);
    setTimeout(function() {
      if (window._csMusic && window._csMusic.queue && typeof snxSQAddToQueue === 'function') {
        window._csMusic.queue.forEach(function(t) { snxSQAddToQueue(t.id); });
      }
      _toastOk('Playlist added to Prophecy Queue.');
    }, 800);
  }
};

window.snxNexusStreamAddNext = function() {
  // Same as addToQueue but inserts at position 1
  snxNexusStreamAddToQueue();
  _toastOk('Added next in queue.');
};

/* Playlist editor (inline) */
function _showPlaylistEditor(plId) {
  var editorEl = _el('nxPlaylistEditor');
  if (!editorEl) return;
  editorEl.style.display = '';
  _renderPlaylistEditor(plId);
  // Scroll to editor
  editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

window.snxNexusCloseEditor = function() {
  var el = _el('nxPlaylistEditor');
  if (el) el.style.display = 'none';
};

function _renderPlaylistEditor(plId) {
  var el = _el('nxPlaylistEditorInner');
  if (!el) return;
  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];
  var pl = playlists.find(function(p){ return p.id === plId; });
  if (!pl) return;

  var queue = (window._csMusic && window._csMusic.selectedId === plId) ? window._csMusic.queue : [];
  var count = pl.trackIds ? pl.trackIds.length : 0;

  var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
    '<div>' +
      '<div class="nx-section-title" style="margin-bottom:2px;">𓂀 ' + _esc(pl.name) + '</div>' +
      '<div style="font-size:11px;color:var(--nx-text2);">' + count + ' ITEMS</div>' +
    '</div>' +
    '<div style="display:flex;gap:6px;">' +
      '<button class="nx-btn nx-btn-primary" onclick="snxNexusSendToStream(\'' + _esc(plId) + '\')">▶ SEND TO STREAM</button>' +
      '<button class="nx-btn nx-btn-sm" onclick="snxNexusCloseEditor()">✕</button>' +
    '</div>' +
  '</div>';

  // Track list
  if (queue.length) {
    html += '<div id="nxPlEditorTracks">' +
      queue.map(function(t, i) {
        return '<div class="nx-pl-edit-item">' +
          '<span class="nx-pl-num">' + (i+1) + '</span>' +
          '<div class="nx-pl-move-btns">' +
            '<button class="nx-pl-move-btn" onclick="snxCSMusicMoveTrack(\'' + _esc(plId) + '\',' + i + ',-1)" ' + (i===0?'disabled':'') + '>▲</button>' +
            '<button class="nx-pl-move-btn" onclick="snxCSMusicMoveTrack(\'' + _esc(plId) + '\',' + i + ',1)" ' + (i===queue.length-1?'disabled':'') + '>▼</button>' +
          '</div>' +
          '<div class="nx-track-info" style="flex:1;min-width:0;">' +
            '<div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div>' +
            '<div class="nx-track-artist">' + _esc(t.artist||'') + '</div>' +
          '</div>' +
          (t.duration ? '<span class="nx-track-dur">' + _fmtDur(t.duration) + '</span>' : '') +
          '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxCSMusicRemoveTrackFromPlaylist(\'' + _esc(plId) + '\',\'' + _esc(t.id) + '\');snxNexusOpenPlaylist(\'' + _esc(plId) + '\')">×</button>' +
        '</div>';
      }).join('') +
    '</div>';
  } else if (count > 0) {
    html += '<div style="color:var(--nx-text2);font-size:12px;padding:12px 0;">Loading ' + count + ' tracks…</div>';
  } else {
    html += '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">No tracks yet. Add from the Vault.</div></div>';
  }

  // Add Media from Vault
  html += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--nx-border);">' +
    '<div class="nx-section-title">+ ADD MEDIA FROM VAULT</div>' +
    '<input class="nx-input" type="search" placeholder="Search Vault…" id="nxPlEditorSearch" oninput="snxNexusPlEditorSearch(\'' + _esc(plId) + '\')" style="margin-bottom:8px;">' +
    '<div id="nxPlEditorVault" style="max-height:260px;overflow-y:auto;"></div>' +
  '</div>';

  el.innerHTML = html;
  _renderPlEditorVault(plId, '');
}

window.snxNexusPlEditorSearch = function(plId) {
  var q = (_el('nxPlEditorSearch')||{}).value || '';
  _renderPlEditorVault(plId, q);
};

function _renderPlEditorVault(plId, q) {
  var el = _el('nxPlEditorVault');
  if (!el) return;
  var tracks = (window._music && window._music.tracks) ? window._music.tracks : [];
  if (!tracks.length) {
    el.innerHTML = '<div style="color:var(--nx-text3);font-size:12px;padding:8px 0;">No tracks in library yet.</div>';
    return;
  }
  var pl = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists.find(function(p){ return p.id===plId; }) : null;
  var inPl = pl && pl.trackIds ? pl.trackIds : [];
  var ql = q.toLowerCase();
  var filtered = tracks.filter(function(t) {
    if (!ql) return true;
    return (t.title||'').toLowerCase().includes(ql)||(t.artist||'').toLowerCase().includes(ql);
  });
  if (!filtered.length) {
    el.innerHTML = '<div style="color:var(--nx-text3);font-size:12px;padding:8px 0;">No results.</div>';
    return;
  }
  el.innerHTML = filtered.map(function(t) {
    var added = inPl.indexOf(t.id) !== -1;
    return '<div class="nx-track-item">' +
      '<div class="nx-track-info" style="flex:1;min-width:0;">' +
        '<div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div>' +
        '<div class="nx-track-artist">' + _esc(t.artist||'') + '</div>' +
      '</div>' +
      '<button class="nx-btn nx-btn-sm' + (added ? ' nx-btn-danger' : '') + '" ' +
        'onclick="snxNexusPlEditorToggle(\'' + _esc(plId) + '\',\'' + _esc(t.id) + '\',this)">' +
        (added ? '✓ ADDED' : '+ ADD') +
      '</button>' +
    '</div>';
  }).join('');
}

window.snxNexusPlEditorToggle = function(plId, trackId, btn) {
  var pl = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists.find(function(p){ return p.id===plId; }) : null;
  if (!pl) return;
  var inPl = pl.trackIds && pl.trackIds.indexOf(trackId) !== -1;
  if (inPl) {
    if (typeof snxCSMusicRemoveTrackFromPlaylist === 'function') snxCSMusicRemoveTrackFromPlaylist(plId, trackId);
    if (btn) { btn.textContent = '+ ADD'; btn.classList.remove('nx-btn-danger'); }
  } else {
    if (typeof snxCSMusicAddSingleTrack === 'function') snxCSMusicAddSingleTrack(plId, trackId);
    if (btn) { btn.textContent = '✓ ADDED'; btn.classList.add('nx-btn-danger'); }
  }
};

/* Re-render playlists after studio.js updates */
window.snxNexusOnPlaylistsLoaded = function() {
  if (_nx.activeTab === 'playlists') _renderPlaylists();
};

/* ═══════════════════════════════════════════════════════
   TAB: QUEUE — THE PROPHECY QUEUE
═══════════════════════════════════════════════════════ */
function _loadQueue() {
  _renderQueue();
}

function _renderQueue() {
  var el = _el('nxQueueList');
  if (!el) return;

  // Now Playing
  var npTitle  = (window._csMusic && window._csMusic.nowPlayingTitle)  || '—';
  var npArtist = (window._csMusic && window._csMusic.nowPlayingArtist) || '';
  var npEl = _el('nxNPTitle');  if (npEl) npEl.textContent  = npTitle;
  var naEl = _el('nxNPArtist'); if (naEl) naEl.textContent = npArtist;
  var ntEl = _el('nxNPNext');   if (ntEl) ntEl.textContent = (window._csMusic && window._csMusic.nextTitle) ? 'NEXT: ' + window._csMusic.nextTitle : '';

  // SQ queue
  var sq = (window._sq && window._sq.queue) ? window._sq.queue : [];
  var sqIdx = (window._sq && window._sq.queueIndex) || 0;

  if (!sq.length) {
    el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">The Prophecy Queue is empty.<br>Add tracks from the Vault or Playlists.</div></div>';
    return;
  }

  el.innerHTML = sq.map(function(t, i) {
    var isCur = i === sqIdx;
    return '<div class="nx-sq-item' + (isCur ? ' nx-sq-current' : '') + '">' +
      '<span style="width:20px;text-align:center;font-size:12px;color:var(--nx-text3);flex-shrink:0;">' +
        (isCur ? '♪' : (i+1)) +
      '</span>' +
      '<div class="nx-track-info" style="flex:1;min-width:0;">' +
        '<div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div>' +
        '<div class="nx-track-artist">' + _esc(t.artist||'') + '</div>' +
      '</div>' +
      (t.duration ? '<span class="nx-track-dur">' + _fmtDur(t.duration) + '</span>' : '') +
      '<div style="display:flex;gap:4px;">' +
        (i > 0 ? '<button class="nx-btn nx-btn-sm" onclick="snxNexusQueueMoveNext(' + i + ')" title="Move to Next">⬆</button>' : '') +
        '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxNexusQueueRemove(' + i + ')" title="Remove">×</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusQueuePlayPause = function() {
  if (typeof snxSQPlayPause === 'function') snxSQPlayPause();
  _renderQueue();
};

window.snxNexusQueueSkip = function() {
  if (typeof snxSQSkip === 'function') snxSQSkip();
  setTimeout(_renderQueue, 300);
};

window.snxNexusQueueClear = function() {
  if (!confirm('Clear the Prophecy Queue?')) return;
  if (typeof snxSQClear === 'function') snxSQClear();
  setTimeout(_renderQueue, 300);
};

window.snxNexusQueueRemove = function(idx) {
  // Remove item from _sq.queue
  if (window._sq && window._sq.queue) {
    window._sq.queue.splice(idx, 1);
    if (typeof snxSQRenderQueue === 'function') snxSQRenderQueue();
    _renderQueue();
  }
};

window.snxNexusQueueMoveNext = function(idx) {
  if (!window._sq || !window._sq.queue) return;
  var q   = window._sq.queue;
  var cur = window._sq.queueIndex || 0;
  var insertAt = cur + 1;
  if (insertAt >= q.length) insertAt = q.length - 1;
  if (idx === insertAt) return;
  var item = q.splice(idx, 1)[0];
  q.splice(insertAt, 0, item);
  if (typeof snxSQRenderQueue === 'function') snxSQRenderQueue();
  _renderQueue();
};

window.snxNexusOnQueueUpdate = function() {
  if (_nx.activeTab === 'queue') _renderQueue();
};

/* ═══════════════════════════════════════════════════════
   TAB: UPLOAD — OFFERING CHAMBER
═══════════════════════════════════════════════════════ */
function _loadUpload() {
  _renderUploadTypeBar();
}

function _renderUploadTypeBar() {
  document.querySelectorAll('.nx-upload-type-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.type === _nx.uploadType);
  });
  // Update accept attribute on hidden file input
  var fileInput = _el('nxUploadFileInput');
  if (!fileInput) return;
  var accepts = {
    music:   'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac,.opus',
    video:   'video/*,.mp4,.mov,.webm,.mkv',
    picture: 'image/*,.jpg,.jpeg,.png,.gif,.webp'
  };
  fileInput.accept = accepts[_nx.uploadType] || accepts.music;
}

window.snxNexusSetUploadType = function(type) {
  _nx.uploadType = type;
  _renderUploadTypeBar();
};

window.snxNexusOpenFilePicker = function() {
  var inp = _el('nxUploadFileInput');
  if (inp) inp.click();
};

window.snxNexusFilesSelected = function(event) {
  var files = event && event.target && event.target.files;
  if (!files || !files.length) return;
  if (_nx.uploadType === 'music' && typeof snxMusicFilesSelected === 'function') {
    snxMusicFilesSelected(event);
  } else {
    _nxUploadFiles(files);
  }
};

function _nxUploadFiles(files) {
  // For video/picture — use r2-upload worker
  var arr = Array.from(files);
  if (!arr.length) return;
  _toast('Uploading ' + arr.length + ' file(s)…');
  // Queue each file upload using the existing upload-worker endpoint
  arr.forEach(function(file) {
    _nxUploadSingleFile(file);
  });
}

function _nxUploadSingleFile(file) {
  var progressEl = _el('nxUploadProgress');
  var barEl      = _el('nxUploadProgressBar');
  if (progressEl) progressEl.style.display = '';

  var ext     = file.name.split('.').pop().toLowerCase();
  var type    = _nx.uploadType;
  var uid     = _nx.user ? _nx.user.uid : 'anon';
  var fname   = uid + '/' + type + '/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  var UPLOAD_URL = 'https://yellow-term-11e6.nthntjrn.workers.dev';

  var form = new FormData();
  form.append('file', file, fname);
  form.append('path', fname);
  form.append('uid',  uid);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', UPLOAD_URL + '/upload', true);

  var token = _nx.user ? _nx.user.accessToken : null;
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable && barEl) {
      barEl.style.width = Math.round((e.loaded/e.total)*100) + '%';
    }
  };

  xhr.onload = function() {
    if (progressEl) progressEl.style.display = 'none';
    if (barEl) barEl.style.width = '0%';
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var res = JSON.parse(xhr.responseText);
        var url = res.url || res.publicUrl || '';
        _nxSaveMediaToFirestore(file, url, type);
        _toastOk('Upload complete: ' + file.name);
      } catch(e) {
        _toastError('Upload failed: bad response');
      }
    } else {
      _toastError('Upload failed: ' + xhr.status);
    }
  };
  xhr.onerror = function() {
    if (progressEl) progressEl.style.display = 'none';
    _toastError('Upload error. Check your connection.');
  };
  xhr.send(form);
}

function _nxSaveMediaToFirestore(file, url, type) {
  var fs  = window._snxFirestore;
  var uid = _nx.user ? _nx.user.uid : null;
  if (!fs || !uid) return;
  var id   = 'nx_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  var data = {
    id:          id,
    title:       file.name.replace(/\.[^.]+$/, '').replace(/_/g,' '),
    artist:      (_nx.userData && (_nx.userData.displayName || _nx.userData.username)) || '',
    mediaType:   type,
    url:         url,
    status:      'ready',
    size:        file.size,
    uploadedAt:  fs.serverTimestamp(),
    uid:         uid
  };
  // Save to cloudStreamTracks (same path as studio.js)
  fs.setDoc(fs.doc(fs.db, 'cloudStreamTracks', uid, 'tracks', id), data)
    .then(function() {
      // Reload library
      if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    })
    .catch(function(e) { console.warn('[NX Upload]', e.message); });
}

/* ═══════════════════════════════════════════════════════
   TAB: CONTROL — FOUNDER CONTROLS
═══════════════════════════════════════════════════════ */
function _loadControl() {
  if (_nx.role !== 'founder') {
    var el = _el('nxControlPanel');
    if (el) el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">🔒</div><div class="nx-empty-text">Founder access required.</div></div>';
    return;
  }
  _renderControlNP();
}

function _renderControlNP() {
  var npTitle  = (window._csMusic && window._csMusic.nowPlayingTitle)  || '—';
  var npArtist = (window._csMusic && window._csMusic.nowPlayingArtist) || '';
  var t = _el('nxControlNPTitle');  if (t) t.textContent = npTitle;
  var a = _el('nxControlNPArtist');if (a) a.textContent = npArtist;
  var v = _el('nxControlViewers'); if (v) v.textContent = _nx.viewerCount;
}

window.snxNexusControlSkip = function() {
  if (typeof snxCSMusicNext === 'function') snxCSMusicNext();
  setTimeout(_renderControlNP, 300);
  _toast('Skipped to next track.');
};

window.snxNexusControlPlayPause = function() {
  if (typeof snxCSMusicPlayPause === 'function') snxCSMusicPlayPause();
  setTimeout(_renderControlNP, 300);
};

window.snxNexusControlStop = function() {
  if (!confirm('Stop the Cloud Stream?\nThis will end the broadcast for all viewers.')) return;
  if (typeof snxCSStop === 'function') snxCSStop();
  _toast('Stream stopped.');
};

window.snxNexusStartStream = function() {
  // Delegate to studio.js start cloud stream
  var name = prompt('Stream Name:', 'Shadow Nexus — Eternal Transmission');
  if (!name) return;
  // Fill in the studio form values and call start
  var nameEl = _el('snxCSStreamName');
  if (nameEl) nameEl.value = name;
  if (typeof snxStartCloudStream === 'function') snxStartCloudStream();
  _toastOk('Starting Eternal Stream…');
};

/* ═══════════════════════════════════════════════════════
   PUBLIC API — called by HTML onclick and studio.js hooks
═══════════════════════════════════════════════════════ */

// Re-render current tab when studio.js notifies of data changes
window.snxNexusRefreshTab = function() {
  if (_nx.activeTab) _loadActiveTab(_nx.activeTab);
};

/* ═══════════════════════════════════════════════════════
   STUB TAB SWITCHING from studio.js
   studio.js calls _renderCSPlaylistPanel() — we hook this
   so playlist tab stays fresh.
═══════════════════════════════════════════════════════ */
var _origRenderCSPlaylistPanel = null;
function _hookStudioFunctions() {
  if (typeof window._renderCSPlaylistPanel === 'function' && !_origRenderCSPlaylistPanel) {
    _origRenderCSPlaylistPanel = window._renderCSPlaylistPanel;
    window._renderCSPlaylistPanel = function() {
      _origRenderCSPlaylistPanel.apply(this, arguments);
      if (_nx.activeTab === 'playlists') _renderPlaylists();
    };
  }
}
// Hook when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _hookStudioFunctions);
} else {
  _hookStudioFunctions();
}

})(); // end IIFE
