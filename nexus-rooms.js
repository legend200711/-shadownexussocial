/**
 * Shadow Nexus Social — Nexus Rooms + Watch Together
 * nexus-rooms.js  v1.1.0  (SNS-2026-CINEMATIC-002)
 *
 * Architecture:
 *   Firestore: /nexusRooms/{roomId}                — room metadata
 *   Firestore: /nexusRooms/{roomId}/messages/{id}  — chat messages
 *   Firestore: /nexusRooms/{roomId}/participants/{uid} — presence
 *
 * Security:
 *   Only authenticated users can create/join rooms.
 *   Only the room host (hostUid == auth.uid) can update protected fields.
 *   Participants can only write their own messages + own presence.
 *   Host ends room by setting status:'ended'.
 *   Abandoned-room cleanup: rooms with lastActivityAt > 6h and no active
 *   participants are marked ended on the client of the last person to leave.
 *
 * AUTH FIX (v1.1.0):
 *   Uses window._snxAuth (Firebase modular Auth instance) and
 *   window._snxFirestore (modular Firestore helpers) exposed by the main app
 *   at index.html line ~12000.  No longer relies on legacy compat shims
 *   (window.firebase.auth(), window.firebase.firestore.FieldValue, window.db).
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════ */
var ROOMS_COLLECTION    = 'nexusRooms';
var CHAT_SUBCOLLECTION  = 'messages';
var PARTS_SUBCOLLECTION = 'participants';
var MAX_CHAT_MSGS        = 120;   // max to keep in live view
var SYNC_DEBOUNCE_MS    = 800;   // min ms between seek writes
var SEEK_TOLERANCE_S    = 3;     // seconds of drift before hard-sync
var INACTIVITY_MS       = 6 * 60 * 60 * 1000; // 6h for abandoned cleanup
var LOAD_TIMEOUT_MS     = 9000;  // safeguard: stop spinner after 9 s

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _db         = null;  // Firestore instance
var _fs         = null;  // Firestore modular helpers (from window._snxFirestore)
var _user       = null;
var _userData   = null;
var _roomId     = null;
var _roomData   = null;
var _isHost     = false;

// Auth state: 'checking' | 'signed-in' | 'signed-out'
var _authState  = 'checking';

// Listeners — tracked for clean unsubscription
var _unsubRoom  = null;
var _unsubChat  = null;
var _unsubParts = null;
var _unsubList  = null;  // room list listener

// Loading safeguard timer
var _loadTimer  = null;

// Video sync
var _player     = null;
var _syncPaused = false;
var _lastSeekWrite = 0;
var _syncTimer  = null;

// Chat de-duplication
var _chatMsgIds = {};

// Presence cleanup ref
var _myPresenceRef = null;

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */
function _el(id)  { return document.getElementById(id); }
function _esc(s)  {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                          .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _ts(sec) {
    if (!sec) return '0:00';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}
function _toast(msg) {
    if (typeof window.toastNotification === 'function') toastNotification(msg);
}
function _now() {
    return Date.now();
}
function _displayName() {
    if (!_user) return 'Anonymous';
    return (_userData && _userData.displayName) || _user.displayName || _user.email || 'Member';
}
function _userHandle() {
    if (!_user) return '';
    return (_userData && _userData.username) ? '@' + _userData.username : '';
}

/* ══════════════════════════════════════════════════════
   FIREBASE ACCESS — modular SDK via window._snxFirestore
   Exposed by the main app in index.html (~line 11985).
   Falls back gracefully if called before the module loads.
══════════════════════════════════════════════════════ */
function _getFS() {
    if (_fs) return _fs;
    if (window._snxFirestore) {
        _fs = window._snxFirestore;
        return _fs;
    }
    return null;
}

function _getDB() {
    if (_db) return _db;
    var fs = _getFS();
    if (fs && fs.db) {
        _db = fs.db;
        return _db;
    }
    // Final fallback: legacy compat path (older deployments)
    if (window._snxDb) {
        _db = window._snxDb;
        return _db;
    }
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

// Build a Firestore collection reference (modular-safe)
function _col(path) {
    var fs = _getFS(); var db = _getDB();
    if (!fs || !db) return null;
    return fs.collection(db, path);
}

// Build a Firestore doc reference (modular-safe)
function _docRef(path) {
    var fs = _getFS(); var db = _getDB();
    if (!fs || !db) return null;
    // path is like 'nexusRooms/roomId' or 'nexusRooms/roomId/messages/msgId'
    var parts = path.split('/');
    return fs.doc.apply(null, [db].concat(parts));
}

// Build a Firestore sub-collection reference
function _subCol(roomId, sub) {
    var fs = _getFS(); var db = _getDB();
    if (!fs || !db) return null;
    return fs.collection(db, ROOMS_COLLECTION, roomId, sub);
}

// Build a Firestore sub-doc reference
function _subDocRef(roomId, sub, docId) {
    var fs = _getFS(); var db = _getDB();
    if (!fs || !db) return null;
    return fs.doc(db, ROOMS_COLLECTION, roomId, sub, docId);
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
            '<div class="nxr-portal-loader">' +
                '<div class="nxr-portal-ring"></div>' +
                '<div class="nxr-portal-core"></div>' +
            '</div>' +
            '<div class="nxr-loading-label">VERIFYING SESSION…</div>' +
        '</div>';
    // Hide create button until auth is confirmed
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
    // Once auth is confirmed, make the Create button visible
    var btn = _el('nxrCreateBtnWrapper');
    if (btn) btn.style.visibility = 'visible';
}

/* ══════════════════════════════════════════════════════
   INIT — called once after auth resolves with a user
══════════════════════════════════════════════════════ */
function init(user, userData) {
    _user     = user;
    _userData = userData;
    _authState = 'signed-in';
    _db       = _getDB();
    _showAuthOnPage();
    // Start room list subscription (detaches when user logs out)
    _subscribeRoomList();
}

function onLogout() {
    _authState = 'signed-out';
    _unsubAll();
    if (_unsubList) { _unsubList(); _unsubList = null; }
    _leaveCurrentRoom(true /* silent */);
    _user = null;
    _userData = null;
    _db = null;
    _fs = null;
    _showSignedOut();
}

/* public retry hook */
function _retryLoad() {
    if (_authState !== 'signed-in') return;
    _subscribeRoomList();
}

/* ══════════════════════════════════════════════════════
   ROOM LIST PAGE
══════════════════════════════════════════════════════ */
function _subscribeRoomList() {
    // Cancel existing listener + timeout before re-subscribing
    if (_unsubList) { _unsubList(); _unsubList = null; }
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }

    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs || !_user) {
        _showError('Could not connect to the Nexus database.');
        return;
    }

    _showLoading();

    // Safeguard: stop the spinner after LOAD_TIMEOUT_MS
    _loadTimer = setTimeout(function() {
        _loadTimer = null;
        // Only show timeout error if the grid still shows the loader
        var loader = _el('nxrLoadingState');
        if (loader) {
            console.warn('[NXR] Room list load timed out after ' + (LOAD_TIMEOUT_MS/1000) + 's');
            _showError('Unable to load Nexus Rooms (connection timed out).');
        }
    }, LOAD_TIMEOUT_MS);

    try {
        var colRef = fs.collection(db, ROOMS_COLLECTION);
        var q = fs.query(
            colRef,
            fs.where('status', '==', 'active'),
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
                console.error('[NXR] Room list subscription error:', err.code, err.message);
                // If index not ready, fall back to un-ordered simple query
                if (err.code === 'failed-precondition' || err.code === 'unimplemented') {
                    console.warn('[NXR] Falling back to simple query (index not ready)');
                    _subscribeRoomListFallback();
                } else {
                    _showError('Could not load rooms: ' + err.message);
                }
            }
        );
    } catch(e) {
        if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
        console.error('[NXR] subscribeRoomList exception:', e);
        _showError('Could not connect to the Nexus: ' + (e.message || e));
    }
}

function _subscribeRoomListFallback() {
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs || !_user) return;

    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
    _loadTimer = setTimeout(function() {
        _loadTimer = null;
        var loader = _el('nxrLoadingState');
        if (loader) _showError('Unable to load Nexus Rooms (connection timed out).');
    }, LOAD_TIMEOUT_MS);

    try {
        var colRef = fs.collection(db, ROOMS_COLLECTION);
        var q = fs.query(colRef, fs.where('status', '==', 'active'), fs.limit(40));
        _unsubList = fs.onSnapshot(q,
            function(snap) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                _renderRoomList(snap);
            },
            function(err) {
                if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
                console.error('[NXR] Fallback room list error:', err.code, err.message);
                _showError('Could not load rooms: ' + err.message);
            }
        );
    } catch(e) {
        if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
        _showError('Could not connect to the Nexus: ' + (e.message || e));
    }
}

function _renderRoomList(snap) {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;

    // Snapshot returned — always stop the loading timeout
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }

    if (!snap || snap.empty) {
        _showEmpty();
        return;
    }

    var html = '';
    snap.forEach(function(doc) {
        var d = doc.data();
        if (d.status === 'ended') return;
        var count = d.participantCount || 0;
        var hasWatch = d.mediaUrl ? true : false;
        var statusLabel = hasWatch
            ? '<span class="nxr-room-status-badge nxr-status-watch">📺 Watch</span>'
            : '<span class="nxr-room-status-badge nxr-status-active">💬 Chat</span>';
        html +=
            '<div class="nxr-room-card" onclick="NexusRooms.joinRoom(\'' + doc.id + '\')">' +
            '<div class="nxr-room-name">' + _esc(d.name || 'Unnamed Room') + '</div>' +
            '<div class="nxr-room-desc">' + _esc(d.description || 'Come hang out in the Nexus') + '</div>' +
            '<div class="nxr-room-meta">' +
                '<div class="nxr-room-host"><span class="nxr-host-dot"></span>' + _esc(d.hostName || 'Host') + '</div>' +
                '<div class="nxr-room-count">👥 ' + count + '</div>' +
                statusLabel +
            '</div></div>';
    });

    if (!html) {
        _showEmpty();
    } else {
        grid.innerHTML = html;
    }
}

/* ══════════════════════════════════════════════════════
   CREATE ROOM
══════════════════════════════════════════════════════ */
function openCreateModal() {
    var modal = _el('nxrCreateModal');
    if (!modal) return;
    if (_authState !== 'signed-in') {
        _toast('You must be signed in to create a room.');
        return;
    }
    modal.classList.add('open');
    var inp = _el('nxrRoomNameInput');
    if (inp) setTimeout(function() { inp.focus(); }, 80);
}

function closeCreateModal() {
    var modal = _el('nxrCreateModal');
    if (modal) modal.classList.remove('open');
}

function createRoom() {
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs || !_user) { _toast('You must be signed in to create a room.'); return; }

    var nameEl = _el('nxrRoomNameInput');
    var descEl = _el('nxrRoomDescInput');
    var typeEl = _el('nxrRoomTypeSelect');

    var name = (nameEl ? nameEl.value : '').trim();
    var desc = (descEl ? descEl.value : '').trim();
    var type = typeEl ? typeEl.value : 'chat';

    if (!name) { _toast('Please enter a room name.'); return; }

    // Sanitize
    name = name.substring(0, 60);
    desc = desc.substring(0, 200);

    var btn = _el('nxrCreateSubmitBtn');
    if (btn) {
        if (btn.disabled) return; // prevent double-submit
        btn.disabled = true;
        btn.textContent = 'Creating…';
    }

    var roomData = {
        name: name,
        description: desc,
        type: type,
        hostUid: _user.uid,      // always use authenticated UID — never trust client form
        hostName: _displayName(),
        status: 'active',
        participantCount: 1,
        participants: [_user.uid],
        createdAt: _serverTS(),
        lastActivityAt: _serverTS(),
        mediaUrl: '',
        mediaType: '',
        playbackState: {
            playing: false,
            position: 0,
            updatedAt: _now(),
            hostUid: _user.uid
        }
    };

    var colRef = fs.collection(db, ROOMS_COLLECTION);
    fs.addDoc(colRef, roomData)
        .then(function(docRef) {
            closeCreateModal();
            if (nameEl) nameEl.value = '';
            if (descEl) descEl.value = '';
            // Write my presence doc
            _writePresence(docRef.id);
            // Enter the room
            _enterRoom(docRef.id, roomData, true /* isHost */);
        })
        .catch(function(err) {
            console.error('[NXR] createRoom error:', err.code, err.message);
            _toast('Could not create room: ' + err.message);
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Create Room'; }
        });
}

/* ══════════════════════════════════════════════════════
   JOIN ROOM
══════════════════════════════════════════════════════ */
function joinRoom(roomId) {
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs || !_user) { _toast('You must be signed in to join a room.'); return; }

    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    fs.getDoc(roomDocRef)
        .then(function(snap) {
            if (!snap.exists()) { _toast('Room no longer exists.'); return; }
            var data = snap.data();
            if (data.status === 'ended') { _toast('This room has ended.'); return; }
            var isHost = data.hostUid === _user.uid;
            // Add self to participants list
            return fs.updateDoc(roomDocRef, {
                participants: _arrayUnion(_user.uid),
                participantCount: Math.max((data.participantCount || 0) + 1, (data.participants || []).length + 1),
                lastActivityAt: _serverTS()
            }).then(function() {
                _writePresence(roomId);
                data.id = roomId;
                _enterRoom(roomId, data, isHost);
            });
        })
        .catch(function(err) {
            console.error('[NXR] joinRoom error:', err.code, err.message);
            _toast('Could not join room: ' + err.message);
        });
}

function _writePresence(roomId) {
    var db = _getDB();
    var fs = _getFS();
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
    _roomId   = roomId;
    _roomData = data;
    _isHost   = isHost;
    _chatMsgIds = {};

    // Navigate to room page with cinematic transition
    if (typeof window.firePortalTransition === 'function') {
        window.firePortalTransition(function() {
            _activateRoomPage(roomId, data, isHost);
        });
    } else {
        _activateRoomPage(roomId, data, isHost);
    }
}

function _activateRoomPage(roomId, data, isHost) {
    // Show room page, hide rooms list
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
    _addSystemMessage('You joined the room.');
}

function _renderRoomUI(data, isHost) {
    // Header
    var titleEl = _el('nxrRoomTitle');
    if (titleEl) titleEl.textContent = data.name || 'Nexus Room';
    var subEl = _el('nxrRoomSub');
    if (subEl) subEl.textContent = 'Host: ' + (data.hostName || 'Unknown');
    // Show/hide host controls
    var hc = _el('nxrHostControls');
    if (hc) hc.style.display = isHost ? 'flex' : 'none';
    var endBtn = _el('nxrEndRoomBtn');
    if (endBtn) endBtn.style.display = isHost ? 'inline-block' : 'none';
    // Reset chat
    var msgs = _el('nxrChatMessages');
    if (msgs) msgs.innerHTML = '';
    // Reset video
    _resetPlayer();
}

/* ══════════════════════════════════════════════════════
   ROOM SUBSCRIPTION
══════════════════════════════════════════════════════ */
function _subscribeRoom(roomId) {
    if (_unsubRoom) { _unsubRoom(); _unsubRoom = null; }
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    _unsubRoom = fs.onSnapshot(roomDocRef,
        function(snap) {
            if (!snap.exists()) { _handleRoomEnded(); return; }
            var d = snap.data();
            if (d.status === 'ended') { _handleRoomEnded(); return; }
            _roomData = d;
            // Sync media for non-host participants
            if (!_isHost) {
                _applySyncState(d.playbackState, d.mediaUrl, d.mediaType);
            }
            // Update count
            var countEl = _el('nxrChatCount');
            if (countEl) countEl.textContent = d.participantCount || 0;
        },
        function(err) { console.warn('[NXR] room sub error:', err); }
    );
}

function _subscribeParticipants(roomId) {
    if (_unsubParts) { _unsubParts(); _unsubParts = null; }
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;
    var colRef = fs.collection(db, ROOMS_COLLECTION, roomId, PARTS_SUBCOLLECTION);
    _unsubParts = fs.onSnapshot(colRef,
        function(snap) { _renderParticipants(snap); },
        function() {}
    );
}

function _renderParticipants(snap) {
    var list = _el('nxrParticipantsList');
    if (!list) return;
    if (!snap || snap.empty) { list.innerHTML = ''; return; }
    var html = '';
    snap.forEach(function(doc) {
        var d = doc.data();
        var isHost = _roomData && _roomData.hostUid === doc.id;
        html += '<div class="nxr-participant-chip' + (isHost ? ' is-host' : '') + '">' +
            (isHost ? '<span class="nxr-chip-dot"></span>' : '') +
            _esc((d.displayName || 'Member').substring(0, 16)) +
            (isHost ? ' 👑' : '') +
            '</div>';
    });
    list.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   CHAT SUBSCRIPTION
══════════════════════════════════════════════════════ */
function _subscribeChat(roomId) {
    if (_unsubChat) { _unsubChat(); _unsubChat = null; }
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;
    var chatColRef = fs.collection(db, ROOMS_COLLECTION, roomId, CHAT_SUBCOLLECTION);
    var q = fs.query(
        chatColRef,
        fs.orderBy('timestamp', 'asc'),
        fs.limitToLast(MAX_CHAT_MSGS)
    );
    _unsubChat = fs.onSnapshot(q,
        function(snap) {
            snap.docChanges().forEach(function(change) {
                if (change.type === 'added') {
                    var msgId = change.doc.id;
                    if (_chatMsgIds[msgId]) return; // de-duplicate
                    _chatMsgIds[msgId] = true;
                    _appendChatMessage(change.doc.data(), change.doc.id);
                }
            });
        },
        function(err) { console.warn('[NXR] chat sub error:', err); }
    );
}

function sendChatMessage() {
    var input = _el('nxrChatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !_roomId || !_user) return;
    input.value = '';
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;

    var isHost = _roomData && _roomData.hostUid === _user.uid;
    var chatColRef = fs.collection(db, ROOMS_COLLECTION, _roomId, CHAT_SUBCOLLECTION);
    fs.addDoc(chatColRef, {
            uid: _user.uid,
            displayName: _displayName(),
            text: text.substring(0, 500),
            isHost: isHost,
            timestamp: _serverTS()
        })
        .then(function() {
            // bump lastActivityAt
            var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
            fs.updateDoc(roomDocRef, { lastActivityAt: _serverTS() }).catch(function() {});
        })
        .catch(function() { _toast('Could not send message.'); });
}

function _appendChatMessage(data, msgId) {
    var msgs = _el('nxrChatMessages');
    if (!msgs) return;
    var isHost = data.isHost;
    var ts = '';
    if (data.timestamp && data.timestamp.toDate) {
        var d = data.timestamp.toDate();
        ts = d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
    }
    var div = document.createElement('div');
    div.className = 'nxr-chat-msg' + (isHost ? ' nxr-msg-host' : '');
    div.innerHTML = '<span class="nxr-msg-author">' + _esc(data.displayName || 'Member') + (isHost ? ' 👑' : '') + '</span>' +
        '<span class="nxr-msg-text">' + _esc(data.text || '') + '</span>' +
        (ts ? '<span class="nxr-msg-ts">' + ts + '</span>' : '');
    msgs.appendChild(div);
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
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs || !_roomId) return;
    var mediaType = url.match(/\.(mp4|webm|ogg|mov)(\?|$)/i) ? 'video' : 'audio';
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
    fs.updateDoc(roomDocRef, {
        mediaUrl: url,
        mediaType: mediaType,
        playbackState: {
            playing: false,
            position: 0,
            updatedAt: _now(),
            hostUid: _user.uid
        },
        lastActivityAt: _serverTS()
    }).catch(function(err) { _toast('Could not set media.'); });
}

function _loadMedia(url, mediaType) {
    _player = _el('nxrVideoPlayer');
    if (!_player || !url) return;
    var holder = _el('nxrVideoPlaceholder');
    if (holder) holder.style.display = 'none';
    _player.style.display = 'block';
    if (_player.src !== url) {
        _player.src = url;
        _player.load();
    }
    if (!_isHost) {
        _player.controls = true; // show native controls for participants
    } else {
        _player.controls = false; // host uses custom controls
        _attachHostPlayerEvents();
    }
}

function _attachHostPlayerEvents() {
    if (!_player || _player._nxrHostBound) return;
    _player._nxrHostBound = true;
    _player.addEventListener('play',  _onHostPlay);
    _player.addEventListener('pause', _onHostPause);
    _player.addEventListener('seeked', _onHostSeeked);
}

function _onHostPlay()  { _pushPlaybackState(true,  _player.currentTime); }
function _onHostPause() { _pushPlaybackState(false, _player.currentTime); }
function _onHostSeeked() {
    var now = _now();
    if (now - _lastSeekWrite < SYNC_DEBOUNCE_MS) return;
    _lastSeekWrite = now;
    _pushPlaybackState(_player && !_player.paused, _player.currentTime);
}

function _pushPlaybackState(playing, position) {
    if (!_isHost || !_roomId) return;
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
    fs.updateDoc(roomDocRef, {
        'playbackState.playing':   playing,
        'playbackState.position':  position,
        'playbackState.updatedAt': _now(),
        'playbackState.hostUid':   _user.uid
    }).catch(function() {});
}

function _applySyncState(state, mediaUrl, mediaType) {
    if (!state) return;
    // Load media if URL changed
    if (mediaUrl && (!_player || _player.src !== mediaUrl)) {
        _loadMedia(mediaUrl, mediaType);
    }
    if (!_player || !_player.src) return;
    // Compute expected position
    var elapsed = ((_now() - (state.updatedAt || _now())) / 1000);
    var expectedPos = state.position + (state.playing ? elapsed : 0);
    // Correct drift
    var drift = Math.abs(_player.currentTime - expectedPos);
    if (drift > SEEK_TOLERANCE_S) {
        _player.currentTime = Math.max(0, expectedPos);
    }
    if (state.playing && _player.paused) {
        _syncPaused = false;
        _player.play().catch(function() {});
    } else if (!state.playing && !_player.paused) {
        _player.pause();
        _syncPaused = true;
    }
    var status = _el('nxrSyncStatus');
    if (status) status.classList.add('visible');
}

/* Host control buttons (called from HTML onclick) */
function hostPlay()  { if (!_isHost || !_player) return; _player.play().catch(function() {}); }
function hostPause() { if (!_isHost || !_player) return; _player.pause(); }
function hostSeekBack() {
    if (!_isHost || !_player) return;
    _player.currentTime = Math.max(0, _player.currentTime - 10);
}
function hostSeekFwd() {
    if (!_isHost || !_player) return;
    _player.currentTime = _player.currentTime + 10;
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
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) { _cleanupRoomState(); return; }
    var roomId = _roomId;
    // Remove presence doc
    if (_myPresenceRef) {
        fs.deleteDoc(_myPresenceRef).catch(function() {});
        _myPresenceRef = null;
    }
    // Remove from participants array, decrement count
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, roomId);
    fs.getDoc(roomDocRef)
        .then(function(snap) {
            if (!snap.exists()) return;
            var d = snap.data();
            if (d.status === 'ended') return;
            var newCount = Math.max(0, (d.participantCount || 1) - 1);
            var newParts = (d.participants || []).filter(function(uid) { return uid !== _user.uid; });
            // Abandoned room cleanup
            var lastActivity = d.lastActivityAt && d.lastActivityAt.toMillis ? d.lastActivityAt.toMillis() : 0;
            var isAbandoned  = newCount <= 0 && (_now() - lastActivity) > INACTIVITY_MS;
            var update = {
                participants: newParts,
                participantCount: newCount,
                lastActivityAt: _serverTS()
            };
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
    var db = _getDB();
    var fs = _getFS();
    if (!db || !fs) return;
    var roomDocRef = fs.doc(db, ROOMS_COLLECTION, _roomId);
    fs.updateDoc(roomDocRef, {
        status: 'ended',
        endedAt: _serverTS(),
        'playbackState.playing': false
    }).then(function() {
        _addSystemMessage('Room has ended.');
        setTimeout(function() {
            _cleanupRoomState();
            _goBackToRoomList();
        }, 1200);
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
    _roomId   = null;
    _roomData = null;
    _isHost   = false;
    _chatMsgIds = {};
    _syncPaused = false;
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    if (_player) {
        _player.pause();
        _player.src = '';
        _player._nxrHostBound = false;
        _player.removeEventListener('play',  _onHostPlay);
        _player.removeEventListener('pause', _onHostPause);
        _player.removeEventListener('seeked', _onHostSeeked);
        _player = null;
    }
}

function _unsubAll() {
    if (_unsubRoom)  { _unsubRoom();  _unsubRoom  = null; }
    if (_unsubChat)  { _unsubChat();  _unsubChat  = null; }
    if (_unsubParts) { _unsubParts(); _unsubParts = null; }
}

function _goBackToRoomList() {
    if (typeof window.realmNavTo === 'function') {
        window.realmNavTo('nexusRoomsPage');
    } else if (typeof window.navTo === 'function') {
        window.navTo('nexusRoomsPage');
    }
}

/* ══════════════════════════════════════════════════════
   PUBLIC API — window.NexusRooms
══════════════════════════════════════════════════════ */
window.NexusRooms = {
    init:             init,
    onLogout:         onLogout,
    openCreateModal:  openCreateModal,
    closeCreateModal: closeCreateModal,
    createRoom:       createRoom,
    joinRoom:         joinRoom,
    leaveRoom:        leaveRoom,
    endRoom:          endRoom,
    sendMessage:      sendChatMessage,
    hostSetMedia:     hostSetMedia,
    hostPlay:         hostPlay,
    hostPause:        hostPause,
    hostSeekBack:     hostSeekBack,
    hostSeekFwd:      hostSeekFwd,
    _retryLoad:       _retryLoad  // exposed for retry button
};

/* ══════════════════════════════════════════════════════
   AUTO-INIT: Hook into the main app's Firebase Auth
   ───────────────────────────────────────────────────
   The main app (index.html) exposes:
     window._snxAuth          — Firebase Auth instance (modular SDK)
     window._snxCurrentUser   — most-recent auth user (or null)
     window._snxUserData      — Firestore user doc data (may lag auth)
     window._snxFirestore     — modular Firestore helpers
     window._snxAuthResolved  — true once onAuthStateChanged has fired once
     window._snxAuthReadyQueue — callbacks run once auth resolves

   THREE AUTH STATES handled correctly:
     'checking'   — Firebase is restoring the session; show "Verifying..."
                    NEVER show "You must be signed in" during this state.
     'signed-in'  — user is authenticated; enable Create Room, load rooms.
     'signed-out' — user is not authenticated; disable protected actions.
══════════════════════════════════════════════════════ */
(function _autoInit() {

    // Show "verifying session…" while we wait for auth
    _showAuthChecking();

    function _hookAuth(snxAuth) {
        // Import onAuthStateChanged from the modular SDK (already loaded by main app)
        // We use the same auth instance so we share the exact same session.
        snxAuth.onAuthStateChanged(function(user) {
            if (user) {
                // ── SIGNED IN ──
                // Retrieve userData from the main app's global if available
                var ud = window._snxUserData || window.currentUserData || window._snxCurrentUserData || null;
                NexusRooms.init(user, ud);

                // If userData hasn't loaded yet, poll briefly and re-init
                if (!ud) {
                    var attempts = 0;
                    var poll = setInterval(function() {
                        attempts++;
                        var latestUd = window._snxUserData || window.currentUserData || null;
                        if (latestUd || attempts > 30) {
                            clearInterval(poll);
                            if (latestUd && _user) {
                                _userData = latestUd;
                            }
                        }
                    }, 200);
                }
            } else {
                // ── SIGNED OUT ──
                NexusRooms.onLogout();
            }
        });
    }

    function _tryHook() {
        // window._snxAuth is set by the main module script at line ~12000
        if (window._snxAuth) {
            _hookAuth(window._snxAuth);
            return;
        }

        // Auth module not yet ready — queue a callback if the mechanism exists
        if (Array.isArray(window._snxAuthReadyQueue)) {
            window._snxAuthReadyQueue.push(function() {
                if (window._snxAuth) _hookAuth(window._snxAuth);
            });
            return;
        }

        // Fallback: poll until the auth instance appears (max ~10 s)
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

    // If auth already resolved before this script executed (fast page reload)
    // call _tryHook immediately so we don't wait for the poll
    if (window._snxAuth) {
        _tryHook();
    } else {
        // Slight defer so the main module's type="module" script runs first
        setTimeout(_tryHook, 0);
    }

})();

})();
