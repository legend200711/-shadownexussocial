/**
 * Shadow Nexus Social — Nexus Rooms + Watch Together
 * nexus-rooms.js  v1.0.0  (SNS-2026-CINEMATIC-001)
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
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════ */
var ROOMS_COLLECTION   = 'nexusRooms';
var CHAT_SUBCOLLECTION = 'messages';
var PARTS_SUBCOLLECTION= 'participants';
var MAX_CHAT_MSGS       = 120;   // max to keep in live view
var SYNC_DEBOUNCE_MS    = 800;   // min ms between seek writes
var SEEK_TOLERANCE_S    = 3;     // seconds of drift before hard-sync
var INACTIVITY_MS       = 6 * 60 * 60 * 1000; // 6h for abandoned cleanup

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _db         = null;
var _user       = null;
var _userData   = null;
var _roomId     = null;
var _roomData   = null;
var _isHost     = false;

// Listeners — tracked for clean unsubscription
var _unsubRoom  = null;
var _unsubChat  = null;
var _unsubParts = null;
var _unsubList  = null;  // room list listener

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
   FIREBASE ACCESS
══════════════════════════════════════════════════════ */
function _getDB() {
    if (_db) return _db;
    // Borrow from main app firebase instance
    if (window.db) { _db = window.db; return _db; }
    if (window.firebase && window.firebase.firestore) {
        _db = window.firebase.firestore();
        return _db;
    }
    return null;
}

function _getField() {
    if (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue)
        return window.firebase.firestore.FieldValue;
    if (window.FieldValue) return window.FieldValue;
    return null;
}

function _serverTS() {
    var FV = _getField();
    if (FV) return FV.serverTimestamp();
    return new Date();
}

function _arrayUnion(val) {
    var FV = _getField();
    if (FV) return FV.arrayUnion(val);
    return [val];
}

function _arrayRemove(val) {
    var FV = _getField();
    if (FV) return FV.arrayRemove(val);
    return [];
}

/* ══════════════════════════════════════════════════════
   INIT — called once after auth resolves
══════════════════════════════════════════════════════ */
function init(user, userData) {
    _user     = user;
    _userData = userData;
    _db       = _getDB();
    // Start room list subscription once (detaches when user logs out)
    _subscribeRoomList();
}

function onLogout() {
    _unsubscribeAll();
    _leaveCurrentRoom(true /* silent */);
    _user = null;
    _userData = null;
    _db = null;
}

/* ══════════════════════════════════════════════════════
   ROOM LIST PAGE
══════════════════════════════════════════════════════ */
function _subscribeRoomList() {
    if (_unsubList) { _unsubList(); _unsubList = null; }
    var db = _getDB();
    if (!db || !_user) return;
    try {
        _unsubList = db.collection(ROOMS_COLLECTION)
            .where('status', '==', 'active')
            .orderBy('createdAt', 'desc')
            .limit(40)
            .onSnapshot(function(snap) {
                _renderRoomList(snap);
            }, function(err) {
                console.warn('[NXR] Room list subscription error:', err);
            });
    } catch(e) { console.warn('[NXR] subscribeRoomList:', e); }
}

function _renderRoomList(snap) {
    var grid = _el('nxrRoomsGrid');
    if (!grid) return;
    if (!snap || snap.empty) {
        grid.innerHTML = '<div class="nxr-empty"><div class="nxr-empty-icon">🌌</div><div class="nxr-empty-text">No Nexus Rooms are open right now.<br>Be the first to create one!</div></div>';
        return;
    }
    var html = '';
    snap.forEach(function(doc) {
        var d = doc.data();
        if (d.status === 'ended') return;
        var count = d.participantCount || 0;
        var hasWatch = d.mediaUrl ? true : false;
        var statusLabel = hasWatch ? '<span class="nxr-room-status-badge nxr-status-watch">📺 Watch</span>' : '<span class="nxr-room-status-badge nxr-status-active">💬 Chat</span>';
        html += '<div class="nxr-room-card" onclick="NexusRooms.joinRoom(\'' + doc.id + '\')">' +
            '<div class="nxr-room-name">' + _esc(d.name || 'Unnamed Room') + '</div>' +
            '<div class="nxr-room-desc">' + _esc(d.description || 'Come hang out in the Nexus') + '</div>' +
            '<div class="nxr-room-meta">' +
                '<div class="nxr-room-host"><span class="nxr-host-dot"></span>' + _esc(d.hostName || 'Host') + '</div>' +
                '<div class="nxr-room-count">👥 ' + count + '</div>' +
                statusLabel +
            '</div></div>';
    });
    if (!html) {
        html = '<div class="nxr-empty"><div class="nxr-empty-icon">🌌</div><div class="nxr-empty-text">No Nexus Rooms are open right now.<br>Be the first to create one!</div></div>';
    }
    grid.innerHTML = html;
}

/* ══════════════════════════════════════════════════════
   CREATE ROOM
══════════════════════════════════════════════════════ */
function openCreateModal() {
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
    var db = _getDB();
    if (!db || !_user) { _toast('You must be signed in to create a room.'); return; }
    var name = (_el('nxrRoomNameInput') || {}).value.trim();
    var desc = (_el('nxrRoomDescInput') || {}).value.trim();
    var type = (_el('nxrRoomTypeSelect') || { value: 'chat' }).value;
    if (!name) { _toast('Please enter a room name.'); return; }

    var roomData = {
        name: name.substring(0, 60),
        description: desc.substring(0, 200),
        type: type,
        hostUid: _user.uid,
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

    var btn = _el('nxrCreateSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    db.collection(ROOMS_COLLECTION).add(roomData)
        .then(function(docRef) {
            closeCreateModal();
            if (_el('nxrRoomNameInput')) _el('nxrRoomNameInput').value = '';
            if (_el('nxrRoomDescInput')) _el('nxrRoomDescInput').value = '';
            // Write my presence doc
            _writePresence(docRef.id);
            // Enter the room
            _enterRoom(docRef.id, roomData, true /* isHost */);
        })
        .catch(function(err) {
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
    if (!db || !_user) { _toast('You must be signed in to join a room.'); return; }
    var roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
    roomRef.get()
        .then(function(snap) {
            if (!snap.exists) { _toast('Room no longer exists.'); return; }
            var data = snap.data();
            if (data.status === 'ended') { _toast('This room has ended.'); return; }
            var isHost = data.hostUid === _user.uid;
            // Add self to participants list
            return roomRef.update({
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
            _toast('Could not join room: ' + err.message);
        });
}

function _writePresence(roomId) {
    var db = _getDB();
    if (!db || !_user) return;
    _myPresenceRef = db.collection(ROOMS_COLLECTION).doc(roomId)
                       .collection(PARTS_SUBCOLLECTION).doc(_user.uid);
    _myPresenceRef.set({
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
    if (!db) return;
    _unsubRoom = db.collection(ROOMS_COLLECTION).doc(roomId)
        .onSnapshot(function(snap) {
            if (!snap.exists) { _handleRoomEnded(); return; }
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
        }, function(err) { console.warn('[NXR] room sub error:', err); });
}

function _subscribeParticipants(roomId) {
    if (_unsubParts) { _unsubParts(); _unsubParts = null; }
    var db = _getDB();
    if (!db) return;
    _unsubParts = db.collection(ROOMS_COLLECTION).doc(roomId)
        .collection(PARTS_SUBCOLLECTION)
        .onSnapshot(function(snap) {
            _renderParticipants(snap);
        }, function() {});
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
    if (!db) return;
    _unsubChat = db.collection(ROOMS_COLLECTION).doc(roomId)
        .collection(CHAT_SUBCOLLECTION)
        .orderBy('timestamp', 'asc')
        .limitToLast(MAX_CHAT_MSGS)
        .onSnapshot(function(snap) {
            snap.docChanges().forEach(function(change) {
                if (change.type === 'added') {
                    var msgId = change.doc.id;
                    if (_chatMsgIds[msgId]) return; // de-duplicate
                    _chatMsgIds[msgId] = true;
                    _appendChatMessage(change.doc.data(), change.doc.id);
                }
            });
        }, function(err) { console.warn('[NXR] chat sub error:', err); });
}

function sendChatMessage() {
    var input = _el('nxrChatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !_roomId || !_user) return;
    input.value = '';
    var db = _getDB();
    if (!db) return;

    var isHost = _roomData && _roomData.hostUid === _user.uid;
    db.collection(ROOMS_COLLECTION).doc(_roomId)
        .collection(CHAT_SUBCOLLECTION)
        .add({
            uid: _user.uid,
            displayName: _displayName(),
            text: text.substring(0, 500),
            isHost: isHost,
            timestamp: _serverTS()
        })
        .then(function() {
            // bump lastActivityAt
            db.collection(ROOMS_COLLECTION).doc(_roomId)
                .update({ lastActivityAt: _serverTS() })
                .catch(function() {});
        })
        .catch(function(err) { _toast('Could not send message.'); });
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
    if (!db || !_roomId) return;
    var mediaType = url.match(/\.(mp4|webm|ogg|mov)(\?|$)/i) ? 'video' : 'audio';
    db.collection(ROOMS_COLLECTION).doc(_roomId).update({
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
        // Remove host controls from player for participants
        _player.controls = true; // show native controls for UX but we'll sync
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

function _onHostPlay() {
    _pushPlaybackState(true, _player.currentTime);
}
function _onHostPause() {
    _pushPlaybackState(false, _player.currentTime);
}
function _onHostSeeked() {
    var now = _now();
    if (now - _lastSeekWrite < SYNC_DEBOUNCE_MS) return;
    _lastSeekWrite = now;
    _pushPlaybackState(_player && !_player.paused, _player.currentTime);
}

function _pushPlaybackState(playing, position) {
    if (!_isHost || !_roomId) return;
    var db = _getDB();
    if (!db) return;
    db.collection(ROOMS_COLLECTION).doc(_roomId).update({
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
function hostPlay()  {
    if (!_isHost || !_player) return;
    _player.play().catch(function() {});
}
function hostPause() {
    if (!_isHost || !_player) return;
    _player.pause();
}
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
    if (!db) { _cleanupRoomState(); return; }
    var roomId = _roomId;
    // Remove presence doc
    if (_myPresenceRef) {
        _myPresenceRef.delete().catch(function() {});
        _myPresenceRef = null;
    }
    // Remove from participants array, decrement count
    db.collection(ROOMS_COLLECTION).doc(roomId).get()
        .then(function(snap) {
            if (!snap.exists) return;
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
            return db.collection(ROOMS_COLLECTION).doc(roomId).update(update);
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
    if (!db) return;
    db.collection(ROOMS_COLLECTION).doc(_roomId).update({
        status: 'ended',
        endedAt: _serverTS(),
        'playbackState.playing': false
    }).then(function() {
        _addSystemMessage('Room has ended.');
        setTimeout(function() {
            _cleanupRoomState();
            _goBackToRoomList();
        }, 1200);
    }).catch(function(err) { _toast('Could not end room.'); });
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
    _unsubscribeAll();
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

function _unsubscribeAll() {
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
    hostSeekFwd:      hostSeekFwd
};

/* ══════════════════════════════════════════════════════
   AUTO-INIT: Hook into existing auth flow
══════════════════════════════════════════════════════ */
(function _autoInit() {
    // Wait for the main app's auth to broadcast its user state
    function _tryHook() {
        if (window.firebase && window.firebase.auth) {
            window.firebase.auth().onAuthStateChanged(function(user) {
                if (!user) {
                    NexusRooms.onLogout();
                    return;
                }
                // Retrieve userData from the main app's global if available
                function _doInit() {
                    var ud = window.currentUserData || window._currentUserData || null;
                    NexusRooms.init(user, ud);
                }
                if (window.currentUserData) {
                    _doInit();
                } else {
                    // Fallback — poll briefly
                    var attempts = 0;
                    var poll = setInterval(function() {
                        attempts++;
                        if (window.currentUserData || attempts > 20) {
                            clearInterval(poll);
                            _doInit();
                        }
                    }, 300);
                }
            });
        } else {
            setTimeout(_tryHook, 600);
        }
    }
    _tryHook();
})();

})();
