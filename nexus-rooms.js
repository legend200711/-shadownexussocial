/**
 * Shadow Nexus Social — Nexus Rooms v2
 * nexus-rooms.js  v2.0.0  (SNS-2026-ROOMS-V2)
 *
 * Architecture:
 *   Firestore: /nexusRooms/{roomId}                         — room metadata
 *   Firestore: /nexusRooms/{roomId}/messages/{id}           — chat messages
 *   Firestore: /nexusRooms/{roomId}/participants/{uid}       — presence
 *   Firestore: /nexusRooms/{roomId}/queue/{trackId}         — music queue
 *   Firestore: /roomInvites/{roomId}/invited/{uid}          — private room invites
 *
 * Chat fix: removed orderBy on subcollection (no composite index needed).
 *   Messages are sorted client-side by createdAt.
 *
 * Privacy: rooms carry privacy:'public'|'private'.
 *   Private rooms enforce Firebase-level access via roomInvites.
 *   Public rooms are readable and joinable by any authenticated user.
 *
 * Music: host can upload audio to R2 via /upload-music endpoint
 *   or add a direct audio URL. Queue state lives in Firestore.
 *   Synchronized playback uses stored timestamp + elapsed calc.
 *
 * Security: senderUid is always taken from auth.currentUser.uid.
 *   No field from the form is trusted for identity.
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════ */
var ROOMS_COLLECTION    = 'nexusRooms';
var INVITES_COLLECTION  = 'roomInvites';
var CHAT_SUBCOLLECTION  = 'messages';
var PARTS_SUBCOLLECTION = 'participants';
var QUEUE_SUBCOLLECTION = 'queue';
var MAX_CHAT_MSGS        = 120;
var SYNC_DEBOUNCE_MS    = 800;
var SEEK_TOLERANCE_S    = 3;
var INACTIVITY_MS       = 6 * 60 * 60 * 1000;
var LOAD_TIMEOUT_MS     = 9000;
var MAX_MSG_LEN         = 500;
var UPLOAD_WORKER_URL   = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Supported audio MIME types and extensions
var AUDIO_MIME_TYPES = [
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
    'audio/aac', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-wav',
    'audio/webm', 'audio/flac', 'audio/x-flac', 'application/octet-stream'
];
var AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'opus', 'webm'];

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _db          = null;
var _fs          = null;
var _user        = null;
var _userData    = null;
var _roomId      = null;
var _roomData    = null;
var _isHost      = false;
var _authState   = 'checking';

// Listeners
var _unsubRoom   = null;
var _unsubChat   = null;
var _unsubParts  = null;
var _unsubList   = null;
var _unsubQueue  = null;

// Loading safeguard
var _loadTimer   = null;

// Video/audio sync
var _player      = null;
var _syncPaused  = false;
var _lastSeekWrite = 0;
var _syncTimer   = null;

// Chat de-dup
var _chatMsgIds  = {};

// Presence cleanup ref
var _myPresenceRef = null;

// Music queue state
var _queueTracks   = [];  // [{id, title, artist, url, addedBy, addedAt}]
var _currentTrack  = null;

// Invite panel
var _inviteSearchTimeout = null;

// Upload state
var _uploading = false;

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */
function _el(id)  { return document.getElementById(id); }

function _esc(s)  {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                          .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _ts(sec) {
    if (!sec && sec !== 0) return '';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function _toast(msg) {
    if (typeof window.toastNotification === 'function') window.toastNotification(msg);
    else console.log('[NXR toast]', msg);
}

function _now() { return Date.now(); }

function _displayName() {
    if (!_user) return 'Anonymous';
    return (_userData && _userData.displayName) || _user.displayName || _user.email || 'Member';
}

function _userHandle() {
    if (!_user) return '';
    return (_userData && _userData.username) ? '@' + _userData.username : '';
}

function _isValidAudioMime(mime) {
    if (!mime) return false;
    var m = mime.toLowerCase().split(';')[0].trim();
    return AUDIO_MIME_TYPES.indexOf(m) !== -1 || m.startsWith('audio/');
}

function _isValidAudioExt(filename) {
    if (!filename) return false;
    var ext = filename.split('.').pop().toLowerCase();
    return AUDIO_EXTENSIONS.indexOf(ext) !== -1;
}

function _isValidAudioUrl(url) {
    if (!url) return false;
    // Must be https or http (no data:, javascript:, etc.)
    if (!/^https?:\/\//i.test(url)) return false;
    // Check extension
    var clean = url.split('?')[0].split('#')[0];
    var ext = clean.split('.').pop().toLowerCase();
    return AUDIO_EXTENSIONS.indexOf(ext) !== -1;
}

/* ══════════════════════════════════════════════════════
   FIREBASE ACCESS — modular SDK via window._snxFirestore
══════════════════════════════════════════════════════ */
function _getFS() {
    if (_fs) return _fs;
    if (window._snxFirestore) { _fs = window._snxFirestore; return _fs; }
    return null;
}

function _getDB() {
    if (_db) return _db;
    var fs = _getFS();
    if (fs && fs.db) { _db = fs.db; return _db; }
    if (window._snxDb) { _db = window._snxDb; return _db; }
    return null;
}

function _serverTS() {
    var fs = _getFS();
    if (fs && fs.serverTimestamp) return fs.serverTimestamp();
    return new Date();
}

function _arrayUnion(val) {
    var fs = _getFS();
    if (fs && fs.arrayUnion) return fs.arrayUnion(val);
    return [val];
}

function _arrayRemove(val) {
    var fs = _getFS();
    if (fs && fs.arrayRemove) return fs.arrayRemove(val);
    return [];
}

/* ══════════════════════════════════════════════════════
   LOADING STATE UI
══════════════════════════════════════════════════════ */
function _showLoading() {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    grid.innerHTML =
        '<div class="nxr-loading-state" id="nxrLoadingState">' +
            '<div class="nxr-portal-loader">' +
                '<div class="nxr-portal-ring"></div>' +
                '<div class="nxr-portal-core"></div>' +
            '</div>' +
            '<div class="nxr-loading-label">LOADING NEXUS ROOMS…</div>' +
        '</div>';
}

function _showEmpty() {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    grid.innerHTML =
        '<div class="nxr-empty">' +
            '<div class="nxr-empty-icon">🌌</div>' +
            '<div class="nxr-empty-title">NO ACTIVE NEXUS ROOMS</div>' +
            '<div class="nxr-empty-text">The Nexus is quiet. Open the first room.</div>' +
        '</div>';
}

function _showAuthChecking() {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    grid.innerHTML =
        '<div class="nxr-loading-state">' +
            '<div class="nxr-portal-loader"><div class="nxr-portal-ring"></div><div class="nxr-portal-core"></div></div>' +
            '<div class="nxr-loading-label">VERIFYING SESSION…</div>' +
        '</div>';
    var btn = _el('nxrCreateBtnWrapper');
    if (btn) btn.style.visibility = 'hidden';
}

function _showSignedOut() {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    grid.innerHTML =
        '<div class="nxr-empty">' +
            '<div class="nxr-empty-icon">🔒</div>' +
            '<div class="nxr-empty-title">SIGN IN TO THE NEXUS</div>' +
            '<div class="nxr-empty-text">Sign in to Shadow Nexus Social to view and create Nexus Rooms.</div>' +
        '</div>';
    var btn = _el('nxrCreateBtnWrapper');
    if (btn) btn.style.visibility = 'hidden';
}

function _showError(errMsg) {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    grid.innerHTML =
        '<div class="nxr-empty">' +
            '<div class="nxr-empty-icon">⚠️</div>' +
            '<div class="nxr-empty-title">UNABLE TO LOAD NEXUS ROOMS</div>' +
            '<div class="nxr-empty-text">' + _esc(errMsg || 'Connection error. Please try again.') + '</div>' +
            '<button class="nxr-retry-btn" onclick="NexusRooms._retryLoad()">↺ RETRY</button>' +
        '</div>';
}

function _showAuthOnPage() {
    var btn = _el('nxrCreateBtnWrapper');
    if (btn) btn.style.visibility = 'visible';
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
function init(user, userData) {
    _user      = user;
    _userData  = userData;
    _authState = 'signed-in';
    _db        = _getDB();
    _showAuthOnPage();
    _subscribeRoomList();
}

function onLogout() {
    _authState = 'signed-out';
    _unsubAll();
    if (_unsubList)  { _unsubList();  _unsubList  = null; }
    if (_unsubQueue) { _unsubQueue(); _unsubQueue = null; }
    _leaveCurrentRoom(true);
    _user = null; _userData = null; _db = null; _fs = null;
    _showSignedOut();
}

function _retryLoad() {
    if (_authState !== 'signed-in') return;
    _subscribeRoomList();
}

/* ══════════════════════════════════════════════════════
   ROOM LIST — subscribes to public active rooms
   Private rooms not shown in list (only host/invited can see them)
══════════════════════════════════════════════════════ */
function _subscribeRoomList() {
    if (_unsubList) { _unsubList(); _unsubList = null; }
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }

    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) { _showError('Could not connect to the Nexus database.'); return; }

    _showLoading();

    _loadTimer = setTimeout(function() {
        _loadTimer = null;
        if (_el('nxrLoadingState')) _showError('Unable to load Nexus Rooms (connection timed out).');
    }, LOAD_TIMEOUT_MS);

    try {
        var colRef = fs.collection(db, ROOMS_COLLECTION);
        // Only public, active, unlocked rooms appear in the discovery list
        var q = fs.query(
            colRef,
            fs.where('status',  '==', 'active'),
            fs.where('privacy', '==', 'public'),
            fs.orderBy('createdAt', 'desc'),
            fs.limit(40)
        );
        _unsubList = fs.onSnapshot(q,
            function(snap) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                _renderRoomList(snap);
            },
            function(err) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                console.error('[NXR] Room list error:', err.code, err.message);
                if (err.code === 'failed-precondition' || err.code === 'unimplemented') {
                    _subscribeRoomListFallback();
                } else {
                    _showError('Could not load rooms: ' + err.message);
                }
            }
        );
    } catch(e) {
        if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
        _showError('Could not connect to the Nexus: ' + (e.message || e));
    }
}

function _subscribeRoomListFallback() {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) return;
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
    _loadTimer = setTimeout(function() {
        _loadTimer = null;
        if (_el('nxrLoadingState')) _showError('Unable to load Nexus Rooms (connection timed out).');
    }, LOAD_TIMEOUT_MS);
    try {
        var colRef = fs.collection(db, ROOMS_COLLECTION);
        var q = fs.query(colRef,
            fs.where('status', '==', 'active'),
            fs.where('privacy', '==', 'public'),
            fs.limit(40)
        );
        _unsubList = fs.onSnapshot(q,
            function(snap) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                _renderRoomList(snap);
            },
            function(err) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                // Last fallback: no privacy filter (handles rooms missing privacy field)
                _subscribeRoomListNoFilter();
            }
        );
    } catch(e) {
        if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
        _showError('Could not connect to the Nexus: ' + (e.message || e));
    }
}

function _subscribeRoomListNoFilter() {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) return;
    try {
        var colRef = fs.collection(db, ROOMS_COLLECTION);
        var q = fs.query(colRef, fs.where('status', '==', 'active'), fs.limit(40));
        _unsubList = fs.onSnapshot(q,
            function(snap) { _renderRoomList(snap); },
            function(err)  { _showError('Could not load rooms: ' + err.message); }
        );
    } catch(e) {
        _showError('Could not connect to the Nexus: ' + (e.message || e));
    }
}

function _renderRoomList(snap) {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }

    if (!snap || snap.empty) { _showEmpty(); return; }

    var html = '';
    snap.forEach(function(doc) {
        var d = doc.data();
        if (d.status === 'ended') return;
        // Hide private rooms from discovery list
        if (d.privacy === 'private') return;
        var count  = d.participantCount || 0;
        var locked = d.locked ? ' 🔒' : '';
        var nowPlaying = '';
        if (d.nowPlaying && d.nowPlaying.title) {
            nowPlaying = '<div class="nxr-room-np">🎵 ' + _esc(d.nowPlaying.title.substring(0, 30)) + '</div>';
        }
        var hasWatch = d.mediaUrl ? true : false;
        var statusLabel = hasWatch
            ? '<span class="nxr-room-status-badge nxr-status-watch">📺 Watch</span>'
            : '<span class="nxr-room-status-badge nxr-status-active">💬 Chat</span>';
        html +=
            '<div class="nxr-room-card" onclick="NexusRooms.joinRoom(\'' + doc.id + '\')">' +
            '<div class="nxr-room-name">' + _esc(d.name || 'Unnamed Room') + locked + '</div>' +
            '<div class="nxr-room-desc">' + _esc(d.description || 'Come hang out in the Nexus') + '</div>' +
            nowPlaying +
            '<div class="nxr-room-meta">' +
                '<div class="nxr-room-host"><span class="nxr-host-dot"></span>' + _esc(d.hostName || 'Host') + '</div>' +
                '<div class="nxr-room-count">👥 ' + count + '</div>' +
                statusLabel +
            '</div></div>';
    });

    if (!html) { _showEmpty(); } else { grid.innerHTML = html; }
}

/* ══════════════════════════════════════════════════════
   CREATE ROOM
══════════════════════════════════════════════════════ */
function openCreateModal() {
    if (_authState !== 'signed-in') { _toast('You must be signed in to create a room.'); return; }
    var modal = _el('nxrCreateModal');
    if (!modal) return;
    modal.classList.add('open');
    var inp = _el('nxrRoomNameInput');
    if (inp) setTimeout(function() { inp.focus(); }, 80);
}

function closeCreateModal() {
    var modal = _el('nxrCreateModal');
    if (modal) modal.classList.remove('open');
}

function createRoom() {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) { _toast('You must be signed in to create a room.'); return; }

    var nameEl    = _el('nxrRoomNameInput');
    var descEl    = _el('nxrRoomDescInput');
    var typeEl    = _el('nxrRoomTypeSelect');
    var privacyEl = _el('nxrRoomPrivacySelect');

    var name    = (nameEl    ? nameEl.value    : '').trim().substring(0, 60);
    var desc    = (descEl    ? descEl.value    : '').trim().substring(0, 200);
    var type    = typeEl    ? typeEl.value    : 'chat';
    var privacy = privacyEl ? privacyEl.value : 'private';

    if (!name) { _toast('Please enter a room name.'); return; }

    var btn = _el('nxrCreateSubmitBtn');
    if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Creating…'; }

    var roomData = {
        name:      name,
        description: desc,
        type:      type,
        privacy:   privacy,
        hostUid:   _user.uid,
        hostName:  _displayName(),
        status:    'active',
        locked:    false,
        participantCount: 1,
        participants: [_user.uid],
        authorizedUids: [_user.uid],  // host always authorized
        createdAt: _serverTS(),
        lastActivityAt: _serverTS(),
        mediaUrl:  '',
        mediaType: '',
        playbackState: {
            playing: false, position: 0, updatedAt: _now(), hostUid: _user.uid
        },
        nowPlaying: null
    };

    var colRef = fs.collection(db, ROOMS_COLLECTION);
    fs.addDoc(colRef, roomData)
        .then(function(docRef) {
            closeCreateModal();
            if (nameEl) nameEl.value = '';
            if (descEl) descEl.value = '';
            // Write host's invite record so security rules allow access
            _writeInvite(docRef.id, _user.uid);
            _writePresence(docRef.id);
            _enterRoom(docRef.id, roomData, true);
        })
        .catch(function(err) {
            console.error('[NXR] createRoom error:', err.code, err.message);
            _toast('Could not create room: ' + err.message);
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Create Room'; }
        });
}

/* Write an invite doc for a uid into a room */
function _writeInvite(roomId, uid) {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var invRef = fs.doc(db, INVITES_COLLECTION, roomId, 'invited', uid);
    fs.setDoc(invRef, {
        uid: uid,
        invitedBy: _user ? _user.uid : uid,
        invitedAt: _serverTS(),
        status: 'accepted'
    }, { merge: true }).catch(function() {});
}

/* ══════════════════════════════════════════════════════
   JOIN ROOM
   Private rooms: only host and invited users can enter.
   Locked rooms: no new participants (existing stay).
══════════════════════════════════════════════════════ */
function joinRoom(roomId) {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) { _toast('You must be signed in to join a room.'); return; }

    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    fs.getDoc(roomDocRef)
        .then(function(snap) {
            if (!snap.exists()) { _toast('Room no longer exists.'); return; }
            var data = snap.data();
            if (data.status === 'ended') { _toast('This room has ended.'); return; }

            var isHost = data.hostUid === _user.uid;

            // ── Lock check (non-host) ──
            if (!isHost && data.locked) {
                _toast('This room is currently locked. No new participants allowed.');
                return;
            }

            // ── Privacy check ──
            if (!isHost && data.privacy === 'private') {
                // Check invite record in Firestore
                var invRef = fs.doc(db, INVITES_COLLECTION, roomId, 'invited', _user.uid);
                return fs.getDoc(invRef).then(function(invSnap) {
                    if (!invSnap.exists() || invSnap.data().status === 'revoked') {
                        _toast('This is a private room. You need an invitation to enter.');
                        return;
                    }
                    _doJoinRoom(roomDocRef, roomId, data, isHost, fs, db);
                });
            }

            _doJoinRoom(roomDocRef, roomId, data, isHost, fs, db);
        })
        .catch(function(err) {
            console.error('[NXR] joinRoom error:', err.code, err.message);
            if (err.code === 'permission-denied') {
                _toast('You do not have permission to enter this room.');
            } else {
                _toast('Could not join room: ' + err.message);
            }
        });
}

function _doJoinRoom(roomDocRef, roomId, data, isHost, fs, db) {
    fs.updateDoc(roomDocRef, {
        participants: _arrayUnion(_user.uid),
        authorizedUids: _arrayUnion(_user.uid),
        participantCount: Math.max((data.participantCount || 0) + 1, (data.participants || []).length + 1),
        lastActivityAt: _serverTS()
    }).then(function() {
        _writePresence(roomId);
        data.id = roomId;
        _enterRoom(roomId, data, isHost);
    }).catch(function(err) {
        console.error('[NXR] doJoinRoom error:', err);
        _toast('Could not join room: ' + err.message);
    });
}

function _writePresence(roomId) {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_user) return;
    _myPresenceRef = fs.doc(db, ROOMS_COLLECTION, roomId, PARTS_SUBCOLLECTION, _user.uid);
    fs.setDoc(_myPresenceRef, {
        uid: _user.uid,
        displayName: _displayName(),
        joinedAt: _serverTS()
    }, { merge: true }).catch(function() {});
}

/* ══════════════════════════════════════════════════════
   ENTER ROOM (UI transition)
══════════════════════════════════════════════════════ */
function _enterRoom(roomId, data, isHost) {
    _roomId     = roomId;
    _roomData   = data;
    _isHost     = isHost;
    _chatMsgIds = {};
    _queueTracks = [];
    _currentTrack = null;

    if (typeof window.firePortalTransition === 'function') {
        window.firePortalTransition(function() { _activateRoomPage(roomId, data, isHost); });
    } else {
        _activateRoomPage(roomId, data, isHost);
    }
}

function _activateRoomPage(roomId, data, isHost) {
    if (typeof window.navTo === 'function') {
        window.navTo('nxrRoomPage');
    } else {
        document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
        var rp = _el('nxrRoomPage');
        if (rp) rp.classList.add('active');
    }
    _renderRoomUI(data, isHost);
    _subscribeRoom(roomId);
    _subscribeChat(roomId);
    _subscribeParticipants(roomId);
    _subscribeQueue(roomId);
    _addSystemMessage('You joined the room.');
}

function _renderRoomUI(data, isHost) {
    var titleEl = _el('nxrRoomTitle');
    if (titleEl) titleEl.textContent = data.name || 'Nexus Room';

    var subEl = _el('nxrRoomSub');
    if (subEl) {
        var privBadge = data.privacy === 'private'
            ? '<span class="nxr-privacy-badge nxr-priv-private">🔒 Private</span>'
            : '<span class="nxr-privacy-badge nxr-priv-public">🌐 Public</span>';
        subEl.innerHTML = 'Host: ' + _esc(data.hostName || 'Unknown') + ' ' + privBadge;
    }

    // Host controls
    var hc = _el('nxrHostControls');
    if (hc) hc.style.display = isHost ? 'flex' : 'none';

    var endBtn = _el('nxrEndRoomBtn');
    if (endBtn) endBtn.style.display = isHost ? 'inline-block' : 'none';

    var hostPanelBtn = _el('nxrHostPanelBtn');
    if (hostPanelBtn) hostPanelBtn.style.display = isHost ? 'inline-block' : 'none';

    // Host panel starts collapsed; opened via button
    var hostPanel = _el('nxrHostPanel');
    if (hostPanel) hostPanel.style.display = 'none';

    // TAP TO JOIN AUDIO starts hidden
    var tapBtn = _el('nxrTapAudioBtn');
    if (tapBtn) tapBtn.style.display = 'none';

    // Reset
    var msgs = _el('nxrChatMessages');
    if (msgs) msgs.innerHTML = '';
    _resetPlayer();
    _renderQueuePanel();
    _renderNowPlaying(null);
}

/* ══════════════════════════════════════════════════════
   ROOM SUBSCRIPTION
══════════════════════════════════════════════════════ */
function _subscribeRoom(roomId) {
    if (_unsubRoom) { _unsubRoom(); _unsubRoom = null; }
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    _unsubRoom = fs.onSnapshot(roomDocRef,
        function(snap) {
            if (!snap.exists()) { _handleRoomEnded(); return; }
            var d = snap.data();
            if (d.status === 'ended') { _handleRoomEnded(); return; }
            _roomData = d;

            // Sync media (Watch Together)
            if (!_isHost && d.mediaUrl) {
                _applySyncState(d.playbackState, d.mediaUrl, d.mediaType);
            }
            // Sync queue playback state for non-host
            if (!_isHost && d.nowPlaying) {
                _renderNowPlaying(d.nowPlaying);
                _syncQueuePlayback(d.nowPlaying);
            }

            // Participant count
            var countEl = _el('nxrChatCount');
            if (countEl) countEl.textContent = d.participantCount || 0;

            // Lock indicator
            var lockBadge = _el('nxrLockBadge');
            if (lockBadge) {
                lockBadge.textContent = d.locked ? '🔒 Locked' : '';
                lockBadge.style.display = d.locked ? 'inline' : 'none';
            }
        },
        function(err) { console.warn('[NXR] room sub error:', err); }
    );
}

function _subscribeParticipants(roomId) {
    if (_unsubParts) { _unsubParts(); _unsubParts = null; }
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var colRef = fs.collection(db, ROOMS_COLLECTION, roomId, PARTS_SUBCOLLECTION);
    _unsubParts = fs.onSnapshot(colRef,
        function(snap) { _renderParticipants(snap); },
        function(err) { console.warn('[NXR] participants sub error:', err); }
    );
}

function _renderParticipants(snap) {
    var list = _el('nxrParticipantsList');
    if (!list) return;
    if (!snap || snap.empty) { list.innerHTML = ''; return; }
    var html = '';
    snap.forEach(function(doc) {
        var d = doc.data();
        var isHostChip = _roomData && _roomData.hostUid === doc.id;
        html += '<div class="nxr-participant-chip' + (isHostChip ? ' is-host' : '') + '">' +
            (isHostChip ? '<span class="nxr-chip-dot"></span>' : '') +
            _esc((d.displayName || 'Member').substring(0, 16)) +
            (isHostChip ? ' 👑' : '') +
            (_isHost && !isHostChip ? ' <span class="nxr-kick-btn" onclick="NexusRooms.kickParticipant(\'' + doc.id + '\')">✕</span>' : '') +
            '</div>';
    });
    list.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   CHAT SUBSCRIPTION — FIX
   Root cause: orderBy('timestamp') on a subcollection requires a composite
   index that was not deployed. This version fetches WITHOUT orderBy and
   sorts client-side using the createdAt numeric field, which is always
   written and never depends on a server index.
══════════════════════════════════════════════════════ */
function _subscribeChat(roomId) {
    if (_unsubChat) { _unsubChat(); _unsubChat = null; }
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;

    var chatColRef = fs.collection(db, ROOMS_COLLECTION, roomId, CHAT_SUBCOLLECTION);
    // Use limitToLast without orderBy — avoids composite index requirement.
    // We sort incoming messages client-side by createdAt (ms timestamp).
    var q = fs.query(chatColRef, fs.limit(MAX_CHAT_MSGS));

    _unsubChat = fs.onSnapshot(q,
        function(snap) {
            snap.docChanges().forEach(function(change) {
                if (change.type === 'added') {
                    var msgId = change.doc.id;
                    if (_chatMsgIds[msgId]) return;
                    _chatMsgIds[msgId] = true;
                    _appendChatMessage(change.doc.data(), msgId);
                }
            });
        },
        function(err) {
            console.error('[NXR] chat sub error:', err.code, err.message);
            // If permission denied — user may have been removed or room is private
            if (err.code === 'permission-denied') {
                _addSystemMessage('Chat access denied.');
            }
        }
    );
}

function sendChatMessage() {
    var input = _el('nxrChatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !_roomId || !_user) return;
    if (text.length > MAX_MSG_LEN) text = text.substring(0, MAX_MSG_LEN);
    input.value = '';
    input.focus();

    var db = _getDB(), fs = _getFS();
    if (!db || !fs) { _toast('Not connected.'); return; }

    var isHostMsg = !!(_roomData && _roomData.hostUid === _user.uid);
    var chatColRef = fs.collection(db, ROOMS_COLLECTION, _roomId, CHAT_SUBCOLLECTION);

    // createdAt is a JS timestamp (ms) — never relies on an index
    fs.addDoc(chatColRef, {
        uid:         _user.uid,         // always from auth, never from form
        displayName: _displayName(),
        text:        text,
        isHost:      isHostMsg,
        createdAt:   _now(),            // client ms — used for client-side sort
        serverTs:    _serverTS()        // server timestamp for ordering fallback
    })
    .then(function() {
        var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
        fs.updateDoc(roomDocRef, { lastActivityAt: _serverTS() }).catch(function() {});
    })
    .catch(function(err) {
        console.error('[NXR] sendChatMessage error:', err.code, err.message);
        if (err.code === 'permission-denied') {
            _toast('Message blocked. Permission denied.');
        } else {
            _toast('Could not send message.');
        }
    });
}

function _appendChatMessage(data, msgId) {
    var msgs = _el('nxrChatMessages');
    if (!msgs) return;
    var isHost = data.isHost;
    var ts = '';
    // Prefer server timestamp; fallback to createdAt ms
    if (data.serverTs && data.serverTs.toDate) {
        var d = data.serverTs.toDate();
        ts = d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
    } else if (data.createdAt) {
        var d2 = new Date(data.createdAt);
        ts = d2.getHours() + ':' + String(d2.getMinutes()).padStart(2,'0');
    }
    var div = document.createElement('div');
    div.dataset.msgId = msgId;
    div.className = 'nxr-chat-msg' + (isHost ? ' nxr-msg-host' : '');
    div.innerHTML =
        '<span class="nxr-msg-author">' + _esc(data.displayName || 'Member') + (isHost ? ' 👑' : '') + '</span>' +
        '<span class="nxr-msg-text">' + _esc(data.text || '') + '</span>' +
        (ts ? '<span class="nxr-msg-ts">' + ts + '</span>' : '');
    // Insert in chronological order using createdAt
    var inserted = false;
    var msgAt = data.createdAt || 0;
    var children = msgs.children;
    for (var i = children.length - 1; i >= 0; i--) {
        var child = children[i];
        if (child.dataset && child.dataset.msgAt && parseInt(child.dataset.msgAt) <= msgAt) {
            if (child.nextSibling) {
                msgs.insertBefore(div, child.nextSibling);
            } else {
                msgs.appendChild(div);
            }
            inserted = true;
            break;
        }
    }
    if (!inserted) {
        if (msgs.firstChild) msgs.insertBefore(div, msgs.firstChild);
        else msgs.appendChild(div);
    }
    div.dataset.msgAt = msgAt;
    msgs.scrollTop = msgs.scrollHeight;
}

function _addSystemMessage(text) {
    var msgs = _el('nxrChatMessages');
    if (!msgs) return;
    var div = document.createElement('div');
    div.className = 'nxr-chat-msg nxr-msg-system';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

/* ══════════════════════════════════════════════════════
   WATCH TOGETHER — VIDEO PLAYER
══════════════════════════════════════════════════════ */
function _resetPlayer() {
    _player = _el('nxrVideoPlayer');
    if (!_player) return;
    _player.pause();
    _player.src = '';
    var holder = _el('nxrVideoPlaceholder');
    if (holder) holder.style.display = 'flex';
    _player.style.display = 'none';
    _syncPaused = false;
    var status = _el('nxrSyncStatus');
    if (status) status.classList.remove('visible');
}

function hostSetMedia() {
    if (!_isHost) return;
    var inp = _el('nxrMediaUrlInput');
    if (!inp) return;
    var url = inp.value.trim();
    if (!url) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_roomId) return;
    var mediaType = url.match(/\.(mp4|webm|ogv|mov)(\?|$)/i) ? 'video' : 'audio';
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
    fs.updateDoc(roomDocRef, {
        mediaUrl:  url,
        mediaType: mediaType,
        playbackState: { playing: false, position: 0, updatedAt: _now(), hostUid: _user.uid },
        lastActivityAt: _serverTS()
    }).catch(function(err) { _toast('Could not set media: ' + err.message); });
}

function _loadMedia(url, mediaType) {
    _player = _el('nxrVideoPlayer');
    if (!_player || !url) return;
    var holder = _el('nxrVideoPlaceholder');
    if (holder) holder.style.display = 'none';
    _player.style.display = 'block';
    if (_player.src !== url) { _player.src = url; _player.load(); }
    if (!_isHost) {
        _player.controls = true;
    } else {
        _player.controls = false;
        _attachHostPlayerEvents();
    }
}

function _attachHostPlayerEvents() {
    if (!_player || _player._nxrHostBound) return;
    _player._nxrHostBound = true;
    _player.addEventListener('play',   _onHostPlay);
    _player.addEventListener('pause',  _onHostPause);
    _player.addEventListener('seeked', _onHostSeeked);
}

function _onHostPlay()   { _pushPlaybackState(true,  _player.currentTime); }
function _onHostPause()  { _pushPlaybackState(false, _player.currentTime); }
function _onHostSeeked() {
    var n = _now();
    if (n - _lastSeekWrite < SYNC_DEBOUNCE_MS) return;
    _lastSeekWrite = n;
    _pushPlaybackState(_player && !_player.paused, _player.currentTime);
}

function _pushPlaybackState(playing, position) {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        'playbackState.playing':   playing,
        'playbackState.position':  position,
        'playbackState.updatedAt': _now(),
        'playbackState.hostUid':   _user.uid
    }).catch(function() {});
}

function _applySyncState(state, mediaUrl, mediaType) {
    if (!state) return;
    if (mediaUrl && (!_player || _player.src !== mediaUrl)) { _loadMedia(mediaUrl, mediaType); }
    if (!_player || !_player.src) return;
    var elapsed = (_now() - (state.updatedAt || _now())) / 1000;
    var expectedPos = state.position + (state.playing ? elapsed : 0);
    if (Math.abs(_player.currentTime - expectedPos) > SEEK_TOLERANCE_S) {
        _player.currentTime = Math.max(0, expectedPos);
    }
    if (state.playing && _player.paused) {
        _syncPaused = false;
        _player.play().catch(function() {
            // Autoplay blocked — show tap button
            var tapBtn = _el('nxrTapAudioBtn');
            if (tapBtn) tapBtn.style.display = 'flex';
        });
    } else if (!state.playing && !_player.paused) {
        _player.pause(); _syncPaused = true;
    }
    var status = _el('nxrSyncStatus');
    if (status) status.classList.add('visible');
}

/* User taps to start audio (browser autoplay policy) */
function tapToJoinAudio() {
    var tapBtn = _el('nxrTapAudioBtn');
    if (tapBtn) tapBtn.style.display = 'none';
    if (_player && _player.src) {
        _player.play().catch(function() {});
    }
    // Also for queue player
    var qp = _el('nxrQueueAudio');
    if (qp && qp.src) { qp.play().catch(function() {}); }
}

function hostPlay()      { if (!_isHost || !_player) return; _player.play().catch(function() {}); }
function hostPause()     { if (!_isHost || !_player) return; _player.pause(); }
function hostSeekBack()  { if (!_isHost || !_player) return; _player.currentTime = Math.max(0, _player.currentTime - 10); }
function hostSeekFwd()   { if (!_isHost || !_player) return; _player.currentTime = _player.currentTime + 10; }

/* ══════════════════════════════════════════════════════
   MUSIC QUEUE
══════════════════════════════════════════════════════ */
function _subscribeQueue(roomId) {
    if (_unsubQueue) { _unsubQueue(); _unsubQueue = null; }
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var qColRef = fs.collection(db, ROOMS_COLLECTION, roomId, QUEUE_SUBCOLLECTION);
    var q = fs.query(qColRef, fs.orderBy('addedAt', 'asc'));
    _unsubQueue = fs.onSnapshot(q,
        function(snap) {
            _queueTracks = [];
            snap.forEach(function(doc) {
                var t = doc.data();
                t.id = doc.id;
                _queueTracks.push(t);
            });
            _renderQueuePanel();
        },
        function(err) {
            // Fallback without orderBy if index missing
            console.warn('[NXR] queue sub error (retrying without orderBy):', err.code);
            var qColRef2 = fs.collection(db, ROOMS_COLLECTION, roomId, QUEUE_SUBCOLLECTION);
            _unsubQueue = fs.onSnapshot(qColRef2,
                function(snap2) {
                    _queueTracks = [];
                    snap2.forEach(function(doc) {
                        var t = doc.data(); t.id = doc.id; _queueTracks.push(t);
                    });
                    _queueTracks.sort(function(a,b) { return (a.addedAt||0) - (b.addedAt||0); });
                    _renderQueuePanel();
                },
                function() {}
            );
        }
    );
}

function _renderQueuePanel() {
    var list = _el('nxrQueueList');
    if (!list) return;
    if (!_queueTracks || !_queueTracks.length) {
        list.innerHTML = '<div class="nxr-queue-empty">No tracks in queue</div>';
        return;
    }
    var html = '';
    _queueTracks.forEach(function(t, i) {
        var isCurrent = _roomData && _roomData.nowPlaying && _roomData.nowPlaying.trackId === t.id;
        html += '<div class="nxr-queue-item' + (isCurrent ? ' nxr-queue-current' : '') + '">' +
            '<div class="nxr-queue-info">' +
                '<div class="nxr-queue-title">' + _esc(t.title || 'Unknown') + '</div>' +
                '<div class="nxr-queue-artist">' + _esc(t.artist || '') + '</div>' +
            '</div>' +
            (_isHost ?
                '<div class="nxr-queue-actions">' +
                    '<button class="nxr-q-btn" onclick="NexusRooms.queuePlay(\'' + t.id + '\')" title="Play">▶</button>' +
                    '<button class="nxr-q-btn nxr-q-remove" onclick="NexusRooms.queueRemove(\'' + t.id + '\')" title="Remove">✕</button>' +
                '</div>'
            : '') +
            '</div>';
    });
    list.innerHTML = html;
}

function _renderNowPlaying(np) {
    var npEl = _el('nxrNowPlaying');
    if (!npEl) return;
    if (!np || !np.title) {
        npEl.style.display = 'none';
        return;
    }
    npEl.style.display = 'flex';
    var titleEl = _el('nxrNpTitle');
    if (titleEl) titleEl.textContent = np.title || 'Unknown';
    var artistEl = _el('nxrNpArtist');
    if (artistEl) artistEl.textContent = np.artist || '';
    var statusEl = _el('nxrNpStatus');
    if (statusEl) statusEl.textContent = np.playing ? '▶ Playing' : '⏸ Paused';
}

/* Play a track from the queue */
function queuePlay(trackId) {
    if (!_isHost || !_roomId) return;
    var track = null;
    for (var i = 0; i < _queueTracks.length; i++) {
        if (_queueTracks[i].id === trackId) { track = _queueTracks[i]; break; }
    }
    if (!track) return;

    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;

    var nowPlaying = {
        trackId:   track.id,
        url:       track.url,
        title:     track.title || 'Unknown',
        artist:    track.artist || '',
        playing:   true,
        position:  0,
        updatedAt: _now(),
        hostUid:   _user.uid
    };
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        nowPlaying: nowPlaying,
        lastActivityAt: _serverTS()
    }).then(function() {
        _playQueueTrack(track.url, nowPlaying);
    }).catch(function(err) { _toast('Could not play track: ' + err.message); });
}

function _playQueueTrack(url, np) {
    var qp = _el('nxrQueueAudio');
    if (!qp) return;
    qp.src = url;
    qp.currentTime = 0;
    qp.play().catch(function() {});
    _attachQueuePlayerEvents(qp);
    _renderNowPlaying(np);
}

function _syncQueuePlayback(np) {
    if (!np || !np.url) return;
    var qp = _el('nxrQueueAudio');
    if (!qp) return;
    if (qp.src !== np.url) {
        qp.src = np.url;
        qp.load();
    }
    var elapsed = (_now() - (np.updatedAt || _now())) / 1000;
    var expectedPos = (np.position || 0) + (np.playing ? elapsed : 0);
    if (Math.abs(qp.currentTime - expectedPos) > SEEK_TOLERANCE_S) {
        qp.currentTime = Math.max(0, expectedPos);
    }
    if (np.playing && qp.paused) {
        qp.play().catch(function() {
            var tapBtn = _el('nxrTapAudioBtn');
            if (tapBtn) tapBtn.style.display = 'flex';
        });
    } else if (!np.playing && !qp.paused) {
        qp.pause();
    }
}

var _qpBound = false;
function _attachQueuePlayerEvents(qp) {
    if (_qpBound) return;
    _qpBound = true;
    qp.addEventListener('play', function() {
        if (!_isHost || !_roomId) return;
        var db = _getDB(), fs = _getFS();
        if (!db || !fs) return;
        var np = (_roomData && _roomData.nowPlaying) ? Object.assign({}, _roomData.nowPlaying) : {};
        np.playing   = true;
        np.position  = qp.currentTime;
        np.updatedAt = _now();
        fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), { nowPlaying: np }).catch(function() {});
    });
    qp.addEventListener('pause', function() {
        if (!_isHost || !_roomId) return;
        var db = _getDB(), fs = _getFS();
        if (!db || !fs) return;
        var np = (_roomData && _roomData.nowPlaying) ? Object.assign({}, _roomData.nowPlaying) : {};
        np.playing   = false;
        np.position  = qp.currentTime;
        np.updatedAt = _now();
        fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), { nowPlaying: np }).catch(function() {});
    });
    qp.addEventListener('ended', function() {
        if (!_isHost || !_roomId) return;
        // Auto-advance to next track
        var db = _getDB(), fs = _getFS();
        if (!db || !fs) return;
        var np = _roomData && _roomData.nowPlaying;
        if (!np) return;
        var idx = -1;
        for (var i = 0; i < _queueTracks.length; i++) {
            if (_queueTracks[i].id === np.trackId) { idx = i; break; }
        }
        if (idx >= 0 && idx + 1 < _queueTracks.length) {
            queuePlay(_queueTracks[idx + 1].id);
        } else {
            fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
                nowPlaying: null, lastActivityAt: _serverTS()
            }).catch(function() {});
        }
    });
}

function queueNext() {
    if (!_isHost || !_roomId) return;
    var np = _roomData && _roomData.nowPlaying;
    var idx = -1;
    if (np && np.trackId) {
        for (var i = 0; i < _queueTracks.length; i++) {
            if (_queueTracks[i].id === np.trackId) { idx = i; break; }
        }
    }
    var nextIdx = (idx >= 0 && idx + 1 < _queueTracks.length) ? idx + 1 : 0;
    if (_queueTracks.length > 0) queuePlay(_queueTracks[nextIdx].id);
}

function queuePlayPause() {
    if (!_isHost || !_roomId) return;
    var qp = _el('nxrQueueAudio');
    if (!qp) return;
    if (qp.paused) { qp.play().catch(function() {}); }
    else { qp.pause(); }
}

function queueRemove(trackId) {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    fs.deleteDoc(fs.doc(db, ROOMS_COLLECTION, _roomId, QUEUE_SUBCOLLECTION, trackId))
        .catch(function(err) { _toast('Could not remove track: ' + err.message); });
}

function queueClear() {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var qColRef = fs.collection(db, ROOMS_COLLECTION, _roomId, QUEUE_SUBCOLLECTION);
    fs.getDocs(qColRef).then(function(snap) {
        snap.forEach(function(doc) {
            fs.deleteDoc(doc.ref).catch(function() {});
        });
    });
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        nowPlaying: null, lastActivityAt: _serverTS()
    }).catch(function() {});
    var qp = _el('nxrQueueAudio');
    if (qp) { qp.pause(); qp.src = ''; }
    _renderNowPlaying(null);
}

/* ══════════════════════════════════════════════════════
   MUSIC UPLOAD FROM DEVICE
══════════════════════════════════════════════════════ */
function openAddMusicPanel() {
    if (!_isHost) return;
    var panel = _el('nxrAddMusicPanel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function triggerAudioUpload() {
    if (!_isHost) return;
    var inp = _el('nxrAudioFileInput');
    if (inp) inp.click();
}

function handleAudioFileSelect(inputEl) {
    var file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;

    // Validate extension
    if (!_isValidAudioExt(file.name)) {
        _toast('Unsupported file type. Supported: ' + AUDIO_EXTENSIONS.join(', ').toUpperCase());
        inputEl.value = '';
        return;
    }

    // Validate MIME (allow application/octet-stream as some mobile browsers send this)
    var mime = file.type || '';
    if (!_isValidAudioMime(mime) && mime !== '' && mime !== 'application/octet-stream') {
        _toast('Unsupported file type: ' + mime);
        inputEl.value = '';
        return;
    }

    // Size limit: 200 MB
    var MAX_AUDIO = 200 * 1024 * 1024;
    if (file.size > MAX_AUDIO) {
        _toast('File too large. Maximum 200 MB for audio files.');
        inputEl.value = '';
        return;
    }

    _uploadAudioToR2(file);
    inputEl.value = '';
}

function _uploadAudioToR2(file) {
    if (_uploading) { _toast('Upload already in progress.'); return; }
    if (!_user) { _toast('You must be signed in to upload.'); return; }

    _uploading = true;
    _setUploadProgress(0, 'Preparing upload…');

    // Get Firebase ID token
    var auth = window._snxAuth;
    if (!auth || !auth.currentUser) {
        _toast('Authentication error. Please sign in again.');
        _uploading = false;
        _setUploadProgress(-1, '');
        return;
    }

    auth.currentUser.getIdToken(false).then(function(token) {
        var ext = file.name.split('.').pop().toLowerCase();
        var safeName = 'room-' + _roomId + '-' + _now() + '.' + ext;
        var path = 'rooms/' + _user.uid + '/' + safeName;

        var fd = new FormData();
        fd.append('file', file, file.name);
        fd.append('path', path);

        // Use XHR for progress tracking
        var xhr = new XMLHttpRequest();
        xhr.open('POST', UPLOAD_WORKER_URL + '/upload-music', true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);

        xhr.upload.addEventListener('progress', function(e) {
            if (e.lengthComputable) {
                var pct = Math.round((e.loaded / e.total) * 100);
                _setUploadProgress(pct, 'Uploading… ' + pct + '%');
            }
        });

        xhr.addEventListener('load', function() {
            _uploading = false;
            _setUploadProgress(-1, '');
            if (xhr.status === 200) {
                var resp;
                try { resp = JSON.parse(xhr.responseText); } catch(e) { resp = {}; }
                if (resp.url) {
                    var titleGuess = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
                    _addToQueue({ url: resp.url, title: titleGuess, artist: _displayName() });
                    _toast('Uploaded: ' + titleGuess);
                } else {
                    _toast('Upload failed: ' + (resp.error || 'Unknown error'));
                }
            } else {
                var errBody;
                try { errBody = JSON.parse(xhr.responseText); } catch(e) { errBody = {}; }
                _toast('Upload failed (' + xhr.status + '): ' + (errBody.error || xhr.statusText));
            }
        });

        xhr.addEventListener('error', function() {
            _uploading = false;
            _setUploadProgress(-1, '');
            _toast('Upload failed: network error. Check your connection.');
        });

        xhr.addEventListener('timeout', function() {
            _uploading = false;
            _setUploadProgress(-1, '');
            _toast('Upload timed out. Try again on a better connection.');
        });

        xhr.timeout = 120000; // 2 min timeout
        xhr.send(fd);

    }).catch(function(err) {
        _uploading = false;
        _setUploadProgress(-1, '');
        _toast('Authentication error: ' + err.message);
    });
}

function _setUploadProgress(pct, label) {
    var bar  = _el('nxrUploadBar');
    var fill = _el('nxrUploadFill');
    var lbl  = _el('nxrUploadLabel');
    if (pct < 0) {
        // Hide
        if (bar) bar.style.display = 'none';
        if (lbl) lbl.textContent = '';
    } else {
        if (bar) bar.style.display = 'block';
        if (fill) fill.style.width = pct + '%';
        if (lbl) lbl.textContent = label || '';
    }
}

/* ══════════════════════════════════════════════════════
   ADD MUSIC BY LINK
══════════════════════════════════════════════════════ */
function addMusicByLink() {
    if (!_isHost) return;
    var inp = _el('nxrMusicLinkInput');
    if (!inp) return;
    var url = inp.value.trim();
    if (!url) return;

    if (!_isValidAudioUrl(url)) {
        var errEl = _el('nxrMusicLinkError');
        if (errEl) {
            errEl.textContent = 'THIS MUSIC LINK IS NOT SUPPORTED';
            errEl.style.display = 'block';
            setTimeout(function() { errEl.style.display = 'none'; }, 3000);
        } else {
            _toast('This music link is not supported. Use a direct audio file URL (MP3, M4A, OGG, WAV, etc.)');
        }
        return;
    }

    var titleGuess = url.split('/').pop().split('?')[0].replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Track';
    _addToQueue({ url: url, title: titleGuess, artist: '' });
    inp.value = '';

    var errEl = _el('nxrMusicLinkError');
    if (errEl) errEl.style.display = 'none';
}

function _addToQueue(track) {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var qColRef = fs.collection(db, ROOMS_COLLECTION, _roomId, QUEUE_SUBCOLLECTION);
    fs.addDoc(qColRef, {
        url:       track.url,
        title:     (track.title || 'Unknown').substring(0, 100),
        artist:    (track.artist || '').substring(0, 60),
        addedBy:   _user.uid,
        addedByName: _displayName(),
        addedAt:   _now()
    }).catch(function(err) { _toast('Could not add track: ' + err.message); });
}

/* ══════════════════════════════════════════════════════
   HOST CONTROLS — INVITE / LOCK / KICK
══════════════════════════════════════════════════════ */
function openInvitePanel() {
    if (!_isHost) return;
    var panel = _el('nxrInvitePanel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function searchUsersToInvite() {
    var inp = _el('nxrInviteSearchInput');
    if (!inp) return;
    var q = inp.value.trim();
    if (!q) return;

    if (_inviteSearchTimeout) clearTimeout(_inviteSearchTimeout);
    _inviteSearchTimeout = setTimeout(function() {
        var db = _getDB(), fs = _getFS();
        if (!db || !fs) return;
        // Search by username or displayName prefix
        var usersRef = fs.collection(db, 'users');
        var qRef = fs.query(usersRef,
            fs.where('username', '>=', q.toLowerCase()),
            fs.where('username', '<=', q.toLowerCase() + '\uf8ff'),
            fs.limit(8)
        );
        fs.getDocs(qRef).then(function(snap) {
            var results = [];
            snap.forEach(function(doc) {
                var d = doc.data();
                if (doc.id !== _user.uid) {
                    results.push({ uid: doc.id, displayName: d.displayName || 'Member', username: d.username || '' });
                }
            });
            _renderInviteResults(results);
        }).catch(function() {
            // Fallback: search by displayName
            var qRef2 = fs.query(usersRef,
                fs.where('displayName', '>=', q),
                fs.where('displayName', '<=', q + '\uf8ff'),
                fs.limit(8)
            );
            fs.getDocs(qRef2).then(function(snap2) {
                var results = [];
                snap2.forEach(function(doc) {
                    var d = doc.data();
                    if (doc.id !== _user.uid) {
                        results.push({ uid: doc.id, displayName: d.displayName || 'Member', username: d.username || '' });
                    }
                });
                _renderInviteResults(results);
            }).catch(function() {});
        });
    }, 400);
}

function _renderInviteResults(results) {
    var list = _el('nxrInviteResults');
    if (!list) return;
    if (!results.length) { list.innerHTML = '<div class="nxr-invite-no-results">No users found</div>'; return; }
    var html = '';
    results.forEach(function(u) {
        html += '<div class="nxr-invite-result-item">' +
            '<div class="nxr-invite-user-info">' +
                '<div class="nxr-invite-user-name">' + _esc(u.displayName) + '</div>' +
                (u.username ? '<div class="nxr-invite-user-handle">@' + _esc(u.username) + '</div>' : '') +
            '</div>' +
            '<button class="nxr-invite-send-btn" onclick="NexusRooms.sendInvite(\'' + u.uid + '\',\'' + _esc(u.displayName) + '\')">INVITE</button>' +
            '</div>';
    });
    list.innerHTML = html;
}

function sendInvite(toUid, displayName) {
    if (!_isHost || !_roomId || !_user) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;

    // Write invite record in roomInvites (security-enforced access)
    var invRef = fs.doc(db, INVITES_COLLECTION, _roomId, 'invited', toUid);
    fs.setDoc(invRef, {
        uid:       toUid,
        invitedBy: _user.uid,
        invitedAt: _serverTS(),
        status:    'pending',
        roomId:    _roomId,
        roomName:  _roomData ? _roomData.name : ''
    }, { merge: true })
    .then(function() {
        // Also add to authorizedUids on the room doc for Firestore rule enforcement
        return fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
            authorizedUids: _arrayUnion(toUid)
        });
    })
    .then(function() {
        // Send notification to invited user
        _sendRoomInviteNotification(toUid, displayName);
        _toast('Invitation sent to ' + displayName);
        // Update UI
        var btn = document.querySelector('.nxr-invite-send-btn[onclick*="' + toUid + '"]');
        if (btn) { btn.textContent = '✓ SENT'; btn.disabled = true; }
    })
    .catch(function(err) { _toast('Could not send invite: ' + err.message); });
}

function _sendRoomInviteNotification(toUid, displayName) {
    var db = _getDB(), fs = _getFS();
    if (!db || !fs || !_roomData) return;
    // Write to /notifications/{uid}/items/{id}
    var notifColRef = fs.collection(db, 'notifications', toUid, 'items');
    fs.addDoc(notifColRef, {
        type:         'roomInvite',
        fromUid:      _user.uid,
        fromName:     _displayName(),
        roomId:       _roomId,
        roomName:     _roomData.name || 'Nexus Room',
        privacy:      _roomData.privacy || 'private',
        text:         _displayName() + ' invited you to join their Nexus Room: ' + (_roomData.name || 'Nexus Room'),
        timestamp:    _serverTS(),
        read:         false
    }).catch(function() {});
}

function revokeInvite(uid) {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var invRef = fs.doc(db, INVITES_COLLECTION, _roomId, 'invited', uid);
    fs.updateDoc(invRef, { status: 'revoked' })
    .then(function() {
        return fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
            authorizedUids: _arrayRemove(uid),
            participants:   _arrayRemove(uid)
        });
    })
    .catch(function(err) { _toast('Could not revoke invite: ' + err.message); });
}

function kickParticipant(uid) {
    if (!_isHost || !_roomId || uid === _user.uid) return;
    if (!confirm('Remove this participant from the room?')) return;
    revokeInvite(uid);
    // Remove their presence doc
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    fs.deleteDoc(fs.doc(db, ROOMS_COLLECTION, _roomId, PARTS_SUBCOLLECTION, uid)).catch(function() {});
}

function toggleLockRoom() {
    if (!_isHost || !_roomId) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var newLocked = !(_roomData && _roomData.locked);
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        locked: newLocked, lastActivityAt: _serverTS()
    }).then(function() {
        _toast(newLocked ? 'Room locked. No new participants can enter.' : 'Room unlocked.');
        _renderLockBtn(newLocked);
    }).catch(function(err) { _toast('Could not change lock state: ' + err.message); });
}

function _renderLockBtn(locked) {
    var btn = _el('nxrLockBtn');
    if (btn) {
        btn.textContent = locked ? '🔓 Unlock Room' : '🔒 Lock Room';
    }
}

function toggleRoomPrivacy() {
    if (!_isHost || !_roomId || !_roomData) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    var newPrivacy = _roomData.privacy === 'public' ? 'private' : 'public';
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        privacy: newPrivacy, lastActivityAt: _serverTS()
    }).then(function() {
        _toast('Room is now ' + (newPrivacy === 'public' ? 'Public' : 'Private'));
    }).catch(function(err) { _toast('Could not change privacy: ' + err.message); });
}

/* ══════════════════════════════════════════════════════
   LEAVE / END ROOM
══════════════════════════════════════════════════════ */
function leaveRoom() {
    if (!_roomId || !_user) { _goBackToRoomList(); return; }
    _leaveCurrentRoom(false);
}

function _leaveCurrentRoom(silent) {
    if (!_roomId || !_user) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) { _cleanupRoomState(); return; }
    var roomId = _roomId;
    if (_myPresenceRef) { fs.deleteDoc(_myPresenceRef).catch(function() {}); _myPresenceRef = null; }

    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    fs.getDoc(roomDocRef)
        .then(function(snap) {
            if (!snap.exists()) return;
            var d = snap.data();
            if (d.status === 'ended') return;
            var newCount = Math.max(0, (d.participantCount || 1) - 1);
            var newParts = (d.participants || []).filter(function(u) { return u !== _user.uid; });
            var lastActivity = d.lastActivityAt && d.lastActivityAt.toMillis ? d.lastActivityAt.toMillis() : 0;
            var isAbandoned = newCount <= 0 && (_now() - lastActivity) > INACTIVITY_MS;
            var update = { participants: newParts, participantCount: newCount, lastActivityAt: _serverTS() };
            if (isAbandoned) update.status = 'ended';
            return fs.updateDoc(roomDocRef, update);
        })
        .catch(function() {})
        .finally(function() {
            _cleanupRoomState();
            if (!silent) _goBackToRoomList();
        });
}

function endRoom() {
    if (!_isHost || !_roomId) return;
    if (!confirm('End this Nexus Room for everyone?')) return;
    var db = _getDB(), fs = _getFS();
    if (!db || !fs) return;
    fs.updateDoc(fs.doc(db, ROOMS_COLLECTION, _roomId), {
        status: 'ended', endedAt: _serverTS(), 'playbackState.playing': false, nowPlaying: null
    }).then(function() {
        _addSystemMessage('Room has ended.');
        setTimeout(function() { _cleanupRoomState(); _goBackToRoomList(); }, 1200);
    }).catch(function() { _toast('Could not end room.'); });
}

function _handleRoomEnded() {
    _addSystemMessage('⚠️ This room has ended.');
    setTimeout(function() {
        _cleanupRoomState();
        _goBackToRoomList();
        _toast('The room has ended.');
    }, 1500);
}

function _cleanupRoomState() {
    _unsubAll();
    if (_unsubQueue) { _unsubQueue(); _unsubQueue = null; }
    _roomId = null; _roomData = null; _isHost = false;
    _chatMsgIds = {}; _syncPaused = false;
    _queueTracks = []; _currentTrack = null;
    _qpBound = false;
    if (_syncTimer)   { clearInterval(_syncTimer);   _syncTimer = null; }
    if (_player) {
        _player.pause(); _player.src = '';
        _player._nxrHostBound = false;
        _player.removeEventListener('play',   _onHostPlay);
        _player.removeEventListener('pause',  _onHostPause);
        _player.removeEventListener('seeked', _onHostSeeked);
        _player = null;
    }
    var qp = _el('nxrQueueAudio');
    if (qp) { qp.pause(); qp.src = ''; }
    _uploading = false;
    _setUploadProgress(-1, '');
}

function _unsubAll() {
    if (_unsubRoom)  { _unsubRoom();  _unsubRoom  = null; }
    if (_unsubChat)  { _unsubChat();  _unsubChat  = null; }
    if (_unsubParts) { _unsubParts(); _unsubParts = null; }
}

function _goBackToRoomList() {
    if (typeof window.realmNavTo === 'function') window.realmNavTo('nexusRoomsPage');
    else if (typeof window.navTo === 'function')   window.navTo('nexusRoomsPage');
}

/* ══════════════════════════════════════════════════════
   HOST PANEL TOGGLE (secondary controls menu)
══════════════════════════════════════════════════════ */
function toggleHostPanel() {
    if (!_isHost) return;
    var panel = _el('nxrHostPanel');
    if (!panel) return;
    var hidden = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = hidden ? 'block' : 'none';
}

/* ══════════════════════════════════════════════════════
   PUBLIC API — window.NexusRooms
══════════════════════════════════════════════════════ */
window.NexusRooms = {
    init:               init,
    onLogout:           onLogout,
    openCreateModal:    openCreateModal,
    closeCreateModal:   closeCreateModal,
    createRoom:         createRoom,
    joinRoom:           joinRoom,
    leaveRoom:          leaveRoom,
    endRoom:            endRoom,
    sendMessage:        sendChatMessage,
    // Watch Together
    hostSetMedia:       hostSetMedia,
    hostPlay:           hostPlay,
    hostPause:          hostPause,
    hostSeekBack:       hostSeekBack,
    hostSeekFwd:        hostSeekFwd,
    tapToJoinAudio:     tapToJoinAudio,
    // Music Queue
    openAddMusicPanel:  openAddMusicPanel,
    triggerAudioUpload: triggerAudioUpload,
    handleAudioFileSelect: handleAudioFileSelect,
    addMusicByLink:     addMusicByLink,
    queuePlay:          queuePlay,
    queuePlayPause:     queuePlayPause,
    queueNext:          queueNext,
    queueRemove:        queueRemove,
    queueClear:         queueClear,
    // Host controls
    openInvitePanel:    openInvitePanel,
    searchUsersToInvite: searchUsersToInvite,
    sendInvite:         sendInvite,
    revokeInvite:       revokeInvite,
    kickParticipant:    kickParticipant,
    toggleLockRoom:     toggleLockRoom,
    toggleRoomPrivacy:  toggleRoomPrivacy,
    toggleHostPanel:    toggleHostPanel,
    // Retry
    _retryLoad:         _retryLoad
};

/* ══════════════════════════════════════════════════════
   AUTO-INIT
══════════════════════════════════════════════════════ */
(function _autoInit() {
    _showAuthChecking();

    function _hookAuth(snxAuth) {
        snxAuth.onAuthStateChanged(function(user) {
            if (user) {
                var ud = window._snxUserData || window.currentUserData || window._snxCurrentUserData || null;
                NexusRooms.init(user, ud);
                if (!ud) {
                    var attempts = 0;
                    var poll = setInterval(function() {
                        attempts++;
                        var latestUd = window._snxUserData || window.currentUserData || null;
                        if (latestUd || attempts > 30) {
                            clearInterval(poll);
                            if (latestUd && _user) _userData = latestUd;
                        }
                    }, 200);
                }
            } else {
                NexusRooms.onLogout();
            }
        });
    }

    function _tryHook() {
        if (window._snxAuth) { _hookAuth(window._snxAuth); return; }
        if (Array.isArray(window._snxAuthReadyQueue)) {
            window._snxAuthReadyQueue.push(function() {
                if (window._snxAuth) _hookAuth(window._snxAuth);
            });
            return;
        }
        var waited = 0;
        var poll = setInterval(function() {
            waited += 300;
            if (window._snxAuth) {
                clearInterval(poll);
                _hookAuth(window._snxAuth);
            } else if (waited >= 10000) {
                clearInterval(poll);
                console.error('[NXR] Firebase Auth never became available.');
                _showError('Could not connect to Shadow Nexus authentication.');
            }
        }, 300);
    }

    if (window._snxAuth) { _tryHook(); } else { setTimeout(_tryHook, 0); }
})();

})();
