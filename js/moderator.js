/**
 * Shadow Nexus Social — Moderator & Administrator Panel
 * Extracted from index.html (SNS-2026-GLOBAL-REPAIR-002)
 *
 * Uses window._snxFirestore, window._snxRole, window._snxCurrentUser,
 * window._snxUserData for all Firebase access.
 * All functions exposed on window for inline onclick compatibility.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   MODERATOR PANEL
   ═══════════════════════════════════════════════════════════════════════ */
(function() {

  function modOnly() {
      const r = window._snxRole || 'member';
      return r === 'moderator' || r === 'administrator' || r === 'founder';
  }
  function fmtDate(ts) {
      if (!ts) return '';
      return new Date(typeof ts === 'number' ? ts : ts.toMillis?.() || Date.now()).toLocaleString();
  }
  function esc(s) {
      return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  let _modReportType = 'post';

  window.modSwitchReportTab = function(type, btn) {
      _modReportType = type;
      if (btn && btn.parentElement) btn.parentElement.querySelectorAll('.adm-tab').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      modLoadReports(type);
  };

  async function modLoadReports(type) {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, where, orderBy, limit } = fs;
      const listEl = document.getElementById('modReportList');
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const q = query(collection(db,'reports'), where('type','==',type), where('status','==','open'), orderBy('createdAt','desc'), limit(30));
          const snap = await getDocs(q);
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No open reports.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const r = d.data(); const rid = d.id;
              listEl.insertAdjacentHTML('beforeend', `
              <div class="mod-report-card">
                  <div class="mod-report-header">
                      <span>Reported by: <strong>${esc(r.reporterName||'Unknown')}</strong> · ${fmtDate(r.createdAt)}</span>
                      <span class="mod-report-reason">${esc(r.reason||'No reason')}</span>
                  </div>
                  <div class="mod-report-body">${esc(r.content||r.targetId||'')}</div>
                  <div class="mod-report-actions">
                      <button class="btn-mod-dismiss" onclick="modResolveReport('${rid}','dismiss')">✓ Dismiss</button>
                      <button class="btn-mod-hide"    onclick="modResolveReport('${rid}','hide')">🙈 Hide Content</button>
                      <button class="btn-mod-remove"  onclick="modResolveReport('${rid}','remove')">🗑 Remove Content</button>
                      ${type !== 'user' ? '' : `<button class="btn-mod-mute" onclick="modMuteUser('${esc(r.targetId||'')}','${esc(r.targetName||'')}')">🔇 Mute 24h</button>`}
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error loading reports.</div>'; }
  }

  window.modResolveReport = async function(reportId, action) {
      if (!modOnly()) { toastNotification('⛔ Moderator access required.'); return; }
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc, getDoc } = fs;
      try {
          const rSnap = await getDoc(doc(db,'reports',reportId));
          if (!rSnap.exists()) { toastNotification('Report not found.'); return; }
          const r = rSnap.data();
          if (action === 'hide' || action === 'remove') {
              if (r.type === 'post' && r.targetId) {
                  try { await updateDoc(doc(db,'posts',r.targetId), { hidden: true }); } catch(_) {}
              }
          }
          await updateDoc(doc(db,'reports',reportId), {
              status: 'resolved', resolvedBy: window._snxCurrentUser?.uid || '',
              resolvedAt: Date.now(), resolution: action
          });
          await modAuditLog(`Report resolved (${action})`, `Report ID: ${reportId}`);
          toastNotification(`✅ Report ${action === 'dismiss' ? 'dismissed' : 'resolved'}.`);
          modLoadReports(_modReportType);
      } catch(e) { toastNotification('Action failed: ' + e.message); }
  };

  window.modMuteUser = async function(targetUid, targetName) {
      if (!modOnly()) { toastNotification('⛔ Moderator access required.'); return; }
      if (!targetUid) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc } = fs;
      const muteUntil = Date.now() + 24 * 60 * 60 * 1000;
      try {
          await updateDoc(doc(db,'users',targetUid), { mutedUntil: muteUntil });
          await modAuditLog('User muted 24h', `Target: ${targetName||targetUid}`);
          toastNotification(`🔇 ${targetName||targetUid} muted for 24 hours.`);
          modLoadMuted();
      } catch(e) { toastNotification('Mute failed: ' + e.message); }
  };

  window.modUnmuteUser = async function(targetUid, targetName) {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc } = fs;
      try {
          await updateDoc(doc(db,'users',targetUid), { mutedUntil: null });
          await modAuditLog('User unmuted', `Target: ${targetName||targetUid}`);
          toastNotification(`✅ ${targetName||targetUid} unmuted.`);
          modLoadMuted();
      } catch(e) { toastNotification('Unmute failed: ' + e.message); }
  };

  async function modLoadMuted() {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, where } = fs;
      const listEl = document.getElementById('modMutedList');
      if (!listEl) return;
      const now = Date.now();
      try {
          const q = query(collection(db,'users'), where('mutedUntil','>',now));
          const snap = await getDocs(q);
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No muted users.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const u = d.data();
              const until = new Date(u.mutedUntil).toLocaleString();
              listEl.insertAdjacentHTML('beforeend', `
              <div class="mod-muted-row">
                  <div class="mod-muted-avatar">${esc((u.displayName||'?')[0])}</div>
                  <div class="mod-muted-name">${esc(u.displayName||u.username||u.uid)}</div>
                  <span class="mod-muted-until">Until ${until}</span>
                  <button class="btn-mod-unmute" onclick="modUnmuteUser('${esc(u.uid||d.id)}','${esc(u.displayName||'')}')">Unmute</button>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Could not load.</div>'; }
  }

  let _modPostTimer = null;
  window.modSearchPosts = function() {
      clearTimeout(_modPostTimer);
      _modPostTimer = setTimeout(modLoadPosts, 300);
  };

  async function modLoadPosts() {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, orderBy, limit } = fs;
      const listEl = document.getElementById('modPostList');
      const q_str = (document.getElementById('modPostSearch')?.value||'').trim().toLowerCase();
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const snap = await getDocs(query(collection(db,'posts'), orderBy('createdAt','desc'), limit(40)));
          let posts = snap.docs.map(d=>({id:d.id,...d.data()}));
          if (q_str) posts = posts.filter(p=>(p.text||'').toLowerCase().includes(q_str)||(p.authorName||'').toLowerCase().includes(q_str));
          if (!posts.length) { listEl.innerHTML = '<div class="empty-state">No posts found.</div>'; return; }
          listEl.innerHTML = '';
          posts.forEach(p => {
              const hidden = p.hidden ? '🙈 Hidden' : '';
              listEl.insertAdjacentHTML('beforeend', `
              <div class="admin-post-card">
                  <div style="font-size:12px;color:#6a90b8;margin-bottom:4px;">${esc(p.authorName||'Unknown')} · ${fmtDate(p.createdAt)} ${hidden ? `<span style="color:#ffcc44;font-size:10px;">${hidden}</span>` : ''}</div>
                  <div style="font-size:13px;color:#d8eeff;">${esc((p.text||'').slice(0,120))}</div>
                  <div class="admin-post-actions">
                      ${p.hidden
                          ? `<button class="btn-mod-dismiss" onclick="modTogglePostHide('${p.id}',false)">👁 Unhide</button>`
                          : `<button class="btn-mod-hide" onclick="modTogglePostHide('${p.id}',true)">🙈 Hide</button>`
                      }
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  window.modTogglePostHide = async function(postId, hide) {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc } = fs;
      try {
          await updateDoc(doc(db,'posts',postId), { hidden: hide });
          await modAuditLog(hide ? 'Post hidden' : 'Post unhidden', `Post ID: ${postId}`);
          toastNotification(hide ? '🙈 Post hidden.' : '👁 Post visible again.');
          modLoadPosts();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  async function modAuditLog(action, details) {
      const fs = window._snxFirestore;
      if (!fs || !window._snxCurrentUser) return;
      try {
          const { db, collection, addDoc } = fs;
          await addDoc(collection(db,'auditLog'), {
              action, details,
              adminUid:  window._snxCurrentUser.uid,
              adminName: window._snxUserData?.displayName || '',
              role: window._snxRole || 'moderator',
              ts: Date.now()
          });
      } catch(_) {}
  }

  async function modLoadActionLog() {
      const fs = window._snxFirestore;
      if (!fs || !window._snxCurrentUser) return;
      const { db, collection, getDocs, query, where, orderBy, limit } = fs;
      const listEl = document.getElementById('modActionLog');
      if (!listEl) return;
      try {
          const snap = await getDocs(query(collection(db,'auditLog'),
              where('adminUid','==',window._snxCurrentUser.uid),
              orderBy('ts','desc'), limit(30)));
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No actions yet.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const e = d.data();
              listEl.insertAdjacentHTML('beforeend', `
              <div class="audit-entry">
                  <span class="audit-ts">${fmtDate(e.ts)}</span>
                  <span class="audit-action">${esc(e.action)} — ${esc(e.details||'')}</span>
              </div>`);
          });
      } catch(_) {}
  }

  window.modSwitchChatTab = function(type, btn) {
      document.querySelectorAll('#moderatorPage [id^="modChatTab"]').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const listEl = document.getElementById('modChatLog');
      if (!listEl) return;
      listEl.innerHTML = `<div class="empty-state" style="padding:20px 0;color:#6a90b8;font-size:13px;">Reviewing <strong style="color:#cc88ff;">${type === 'storm' ? 'Storm Rooms' : 'Support Rooms'}</strong> chat logs. Actions taken in chats are recorded in the Moderation Activity Log.</div>`;
  };

  let _modCommentTimer = null;
  window.modSearchComments = function() {
      clearTimeout(_modCommentTimer);
      _modCommentTimer = setTimeout(_modLoadComments, 350);
  };
  async function _modLoadComments() {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, orderBy, limit } = fs;
      const listEl = document.getElementById('modCommentList');
      const q_str  = (document.getElementById('modCommentSearch')?.value||'').trim().toLowerCase();
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const snap = await getDocs(query(collection(db,'posts'), orderBy('createdAt','desc'), limit(30)));
          let rows = [];
          snap.forEach(d => {
              const p = d.data();
              (p.comments||[]).forEach(c => {
                  rows.push({ postId:d.id, ...c, postText:(p.text||'').slice(0,60) });
              });
          });
          if (q_str) rows = rows.filter(c=>(c.text||'').toLowerCase().includes(q_str)||(c.authorName||'').toLowerCase().includes(q_str));
          if (!rows.length) { listEl.innerHTML = '<div class="empty-state">No comments found.</div>'; return; }
          listEl.innerHTML = '';
          rows.slice(0,60).forEach(c => {
              listEl.insertAdjacentHTML('beforeend', `
              <div class="mod-muted-row" style="flex-direction:column;gap:2px;padding:8px 0;">
                  <div style="font-size:11px;color:#6a90b8;">${esc(c.authorName||'?')} on post: "${esc(c.postText)}"</div>
                  <div style="font-size:13px;color:#d8eeff;">${esc((c.text||'').slice(0,160))}</div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  let _modWarnTimer = null;
  window.modSearchWarnUsers = function() {
      clearTimeout(_modWarnTimer);
      _modWarnTimer = setTimeout(_modLoadWarnUsers, 300);
  };
  async function _modLoadWarnUsers() {
      if (!modOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs } = fs;
      const listEl = document.getElementById('modWarnUserList');
      const q_str  = (document.getElementById('modWarnUserSearch')?.value||'').trim().toLowerCase();
      if (!listEl) return;
      if (!q_str) { listEl.innerHTML = '<div class="empty-state" style="padding:14px 0;color:#6a90b8;font-size:13px;">Search for a user to issue or review warnings.</div>'; return; }
      listEl.innerHTML = '<div class="empty-state">Searching…</div>';
      try {
          const snap = await getDocs(collection(db,'users'));
          let users = snap.docs.map(d=>d.data()).filter(u => u.uid && u.displayName && u.role !== 'founder' && u.role !== 'administrator');
          users = users.filter(u => (u.displayName||'').toLowerCase().includes(q_str)||(u.username||'').toLowerCase().includes(q_str));
          if (!users.length) { listEl.innerHTML = '<div class="empty-state">No users found.</div>'; return; }
          listEl.innerHTML = '';
          users.slice(0,15).forEach(u => {
              const warnCount = (u.warnings||[]).length;
              listEl.insertAdjacentHTML('beforeend', `
              <div class="mod-muted-row">
                  <div class="mod-muted-avatar">${esc((u.displayName||'?')[0])}</div>
                  <span class="mod-muted-name">${esc(u.displayName||u.username||u.uid)} <span style="font-size:10px;color:#6a90b8;">@${esc(u.username||u.uid)}</span></span>
                  ${warnCount ? `<span class="mod-muted-until">⚠️ ${warnCount} warning${warnCount>1?'s':''}</span>` : ''}
                  <button class="btn-mod-mute" onclick="modIssueWarning('${esc(u.uid)}','${esc(u.displayName||'')}')">⚠️ Warn</button>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  window.modIssueWarning = async function(uid, name) {
      if (!modOnly()) { toastNotification('⛔ Moderator access required.'); return; }
      const reason = window.prompt(`Reason for warning ${name || uid}:`);
      if (reason === null) return;
      const { db, doc, updateDoc, arrayUnion } = window._snxFirestore;
      try {
          const warn = { reason: reason||'Community guidelines violation', issuedBy: window._snxCurrentUser?.uid||'', ts: Date.now() };
          await updateDoc(doc(db,'users',uid), { warnings: arrayUnion(warn) });
          await modAuditLog('Warning issued', `${name||uid}: ${reason||''}`);
          toastNotification(`⚠️ Warning issued to ${name||uid}.`);
          modSearchWarnUsers();
          modLoadWarnLog();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  async function modLoadWarnLog() {
      const fs = window._snxFirestore;
      if (!fs || !window._snxCurrentUser) return;
      const { db, collection, getDocs, query, where, orderBy, limit } = fs;
      const listEl = document.getElementById('modWarningLog');
      if (!listEl) return;
      try {
          const snap = await getDocs(query(collection(db,'auditLog'),
              where('adminUid','==',window._snxCurrentUser.uid),
              where('action','==','Warning issued'),
              orderBy('ts','desc'), limit(20)));
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No warnings recorded yet.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const e = d.data();
              listEl.insertAdjacentHTML('beforeend', `
              <div class="audit-entry">
                  <span class="audit-ts">${fmtDate(e.ts)}</span>
                  <span class="audit-action">${esc(e.details||'')}</span>
              </div>`);
          });
      } catch(_) {}
  }

  window.renderModeratorPanel = function() {
      if (!modOnly()) { toastNotification('⛔ Moderator access required.'); navTo('feed'); return; }
      modLoadReports('post');
      modLoadMuted();
      modLoadPosts();
      modLoadActionLog();
      modLoadWarnLog();
  };

})();

/* ═══════════════════════════════════════════════════════════════════════
   ADMINISTRATOR PANEL
   ═══════════════════════════════════════════════════════════════════════ */
(function() {

  function admOnly() {
      const r = window._snxRole || 'member';
      return r === 'administrator' || r === 'founder';
  }
  function fmtDate(ts) {
      if (!ts) return '';
      return new Date(typeof ts === 'number' ? ts : ts.toMillis?.() || Date.now()).toLocaleString();
  }
  function esc(s) {
      return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.admSwitchTab = function(tab, btn) {
      document.querySelectorAll('#administratorPage .adm-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#administratorPage .adm-tab-content').forEach(c => c.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const c = document.getElementById('admTab-' + tab);
      if (c) c.classList.add('active');
      if (tab === 'dashboard')  admLoadStats();
      if (tab === 'users')      admSearchUsers();
      if (tab === 'reports')    admLoadReports('user');
      if (tab === 'moderation') admLoadPostsMod('recent');
      if (tab === 'badges')     admSearchBadgeUsers();
      if (tab === 'announce')   admLoadAnnounceHistory();
      if (tab === 'audit')      admLoadAuditLog();
  };

  window.admLoadPostsMod = async function(filter, btn) {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      document.querySelectorAll('#admTab-moderation .adm-tab[id^="admPost"]').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const { db, collection, getDocs, query, orderBy, limit, where } = fs;
      const listEl = document.getElementById('admPostModList');
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          let posts;
          if (filter === 'reported') {
              const rSnap = await getDocs(query(collection(db,'reports'), where('type','==','post'), where('status','==','open'), orderBy('createdAt','desc'), limit(40)));
              const ids = [...new Set(rSnap.docs.map(d=>d.data().targetId).filter(Boolean))];
              posts = await Promise.all(ids.map(id => fs.getDoc(fs.doc(db,'posts',id)).then(s=>s.exists()?{id:s.id,...s.data()}:null)));
              posts = posts.filter(Boolean);
          } else {
              const snap = await getDocs(query(collection(db,'posts'), orderBy('createdAt','desc'), limit(40)));
              posts = snap.docs.map(d=>({id:d.id,...d.data()}));
          }
          if (!posts.length) { listEl.innerHTML = '<div class="empty-state">No posts found.</div>'; return; }
          listEl.innerHTML = '';
          posts.forEach(p => {
              listEl.insertAdjacentHTML('beforeend', `
              <div class="admin-post-card">
                  <div style="font-size:12px;color:#6a90b8;margin-bottom:4px;">${esc(p.authorName||'Unknown')} · ${fmtDate(p.createdAt)} ${p.hidden?'<span style="color:#ffcc44;font-size:10px;">🙈 Hidden</span>':''}</div>
                  <div style="font-size:13px;color:#d8eeff;">${esc((p.text||'').slice(0,120))}</div>
                  <div class="admin-post-actions">
                      ${p.hidden
                          ? `<button class="btn-mod-dismiss" onclick="admTogglePostHide('${p.id}',false)">👁 Unhide</button>`
                          : `<button class="btn-mod-hide" onclick="admTogglePostHide('${p.id}',true)">🙈 Hide</button>`
                      }
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  };

  window.admTogglePostHide = async function(postId, hide) {
      if (!admOnly()) return;
      const { db, doc, updateDoc } = window._snxFirestore;
      try {
          await updateDoc(doc(db,'posts',postId), { hidden: hide });
          await admAuditLog(hide ? 'Post hidden' : 'Post unhidden', `Post ID: ${postId}`);
          toastNotification(hide ? '🙈 Post hidden.' : '👁 Post visible again.');
          admLoadPostsMod(document.getElementById('admPostTabReported')?.classList.contains('active') ? 'reported' : 'recent');
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  let _admCommentTimer = null;
  window.admSearchComments = function() {
      clearTimeout(_admCommentTimer);
      _admCommentTimer = setTimeout(_admLoadComments, 350);
  };
  async function _admLoadComments() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, orderBy, limit } = fs;
      const listEl = document.getElementById('admCommentModList');
      const q_str  = (document.getElementById('admCommentSearch')?.value||'').trim().toLowerCase();
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const snap = await getDocs(query(collection(db,'posts'), orderBy('createdAt','desc'), limit(30)));
          let rows = [];
          snap.forEach(d => {
              const p = d.data();
              (p.comments||[]).forEach(c => {
                  rows.push({ postId:d.id, ...c, postText:(p.text||'').slice(0,60) });
              });
          });
          if (q_str) rows = rows.filter(c=>(c.text||'').toLowerCase().includes(q_str)||(c.authorName||'').toLowerCase().includes(q_str));
          if (!rows.length) { listEl.innerHTML = '<div class="empty-state">No comments found.</div>'; return; }
          listEl.innerHTML = '';
          rows.slice(0,60).forEach(c => {
              listEl.insertAdjacentHTML('beforeend', `
              <div class="adm-user-row" style="flex-direction:column;gap:4px;">
                  <div style="font-size:11px;color:#6a90b8;">${esc(c.authorName||'?')} on post: "${esc(c.postText)}"</div>
                  <div style="font-size:13px;color:#d8eeff;">${esc((c.text||'').slice(0,160))}</div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  window.admSwitchChatTab = function(type, btn) {
      document.querySelectorAll('#admTab-moderation [id^="admChatTab"]').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const listEl = document.getElementById('admChatModLog');
      if (!listEl) return;
      listEl.innerHTML = `<div class="empty-state" style="padding:20px 0;color:#6a90b8;font-size:13px;">Chat moderation logs for <strong>${type === 'storm' ? 'Storm Rooms' : type === 'support' ? 'Support Rooms' : 'Direct Messages'}</strong> are enforced by Firestore Security Rules.<br>Use the Audit Log tab to review moderation actions taken in chats.</div>`;
  };

  let _admBadgeTimer = null;
  window.admSearchBadgeUsers = function() {
      clearTimeout(_admBadgeTimer);
      _admBadgeTimer = setTimeout(_admLoadBadgeUsers, 300);
  };
  async function _admLoadBadgeUsers() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs } = fs;
      const listEl = document.getElementById('admBadgeUserList');
      const q_str  = (document.getElementById('admBadgeUserSearch')?.value||'').trim().toLowerCase();
      if (!listEl) return;
      if (!q_str) { listEl.innerHTML = '<div class="empty-state" style="padding:14px 0;color:#6a90b8;font-size:13px;">Search for a user above to manage their badges.</div>'; return; }
      listEl.innerHTML = '<div class="empty-state">Searching…</div>';
      try {
          const snap = await getDocs(collection(db,'users'));
          let users = snap.docs.map(d=>d.data()).filter(u => u.uid && u.displayName && u.role !== 'founder');
          users = users.filter(u => (u.displayName||'').toLowerCase().includes(q_str)||(u.username||'').toLowerCase().includes(q_str));
          if (!users.length) { listEl.innerHTML = '<div class="empty-state">No users found.</div>'; return; }
          const BADGES = ['Verified','Moderator','Artist','OG','Early','Supporter','Top','Legend','Admin','Beta','Helper','Event','Holiday','Achievement'];
          listEl.innerHTML = '';
          users.slice(0,20).forEach(u => {
              const cur = new Set(u.badges||[]);
              const btns = BADGES.map(b => {
                  const has = cur.has(b);
                  return `<button class="admin-badge-btn ${has?'has-badge':''}" onclick="admToggleBadge('${esc(u.uid)}','${esc(b)}',${!has})" title="${has?'Remove':'Add'} ${b}">${b}</button>`;
              }).join('');
              listEl.insertAdjacentHTML('beforeend', `
              <div class="adm-user-row">
                  <div class="adm-user-avatar">${esc((u.displayName||'?')[0])}</div>
                  <div class="adm-user-info">
                      <div class="adm-user-name">${esc(u.displayName||u.username||u.uid)}</div>
                      <div class="adm-user-handle">@${esc(u.username||u.uid)} · ${u.role||'member'}</div>
                      <div class="admin-badge-controls">${btns}</div>
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  window.admToggleBadge = async function(uid, badge, add) {
      if (!admOnly()) { toastNotification('⛔ Administrator access required.'); return; }
      const { db, doc, getDoc, updateDoc } = window._snxFirestore;
      try {
          const snap = await getDoc(doc(db,'users',uid));
          if (!snap.exists()) return;
          let badges = snap.data().badges || [];
          if (add) { if (!badges.includes(badge)) badges.push(badge); }
          else { badges = badges.filter(b => b !== badge); }
          await updateDoc(doc(db,'users',uid), { badges });
          await admAuditLog(`Badge ${add?'added':'removed'}: ${badge}`, `User UID: ${uid}`);
          toastNotification(`${add?'✅ Added':'❌ Removed'} badge: ${badge}`);
          admSearchBadgeUsers();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  async function admLoadStats() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, where } = fs;
      try {
          const usersSnap = await getDocs(collection(db,'users'));
          const users = usersSnap.docs.map(d=>d.data()).filter(u=>u.uid&&u.displayName);
          const _s = (id,v) => { const el=document.getElementById(id); if(el)el.textContent=v; };
          _s('admStatTotal',    users.length);
          _s('admStatOnline',   users.filter(u=>u.status==='online').length);
          _s('admStatSuspended',users.filter(u=>u.suspended).length);
          try {
              const rSnap = await getDocs(query(collection(db,'reports'),where('status','==','open')));
              _s('admStatReports', rSnap.size);
          } catch(_) {}
      } catch(_) {}
  }

  let _admUserTimer = null;
  window.admSearchUsers = function() {
      clearTimeout(_admUserTimer);
      _admUserTimer = setTimeout(_admRenderUsers, 300);
  };

  async function _admRenderUsers() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs } = fs;
      const listEl = document.getElementById('admUserList');
      const q_str  = (document.getElementById('admUserSearch')?.value||'').trim().toLowerCase();
      const filt   = document.getElementById('admUserFilter')?.value || 'all';
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const snap = await getDocs(collection(db,'users'));
          let users = snap.docs.map(d=>d.data()).filter(u=>u.uid&&u.displayName&&u.uid!==window._snxCurrentUser?.uid);
          users = users.filter(u=>u.role !== 'founder');
          if (filt === 'online')    users = users.filter(u=>u.status==='online');
          if (filt === 'suspended') users = users.filter(u=>u.suspended);
          if (q_str) users = users.filter(u=>(u.displayName||'').toLowerCase().includes(q_str)||(u.username||'').toLowerCase().includes(q_str));
          users.sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||''));
          if (!users.length) { listEl.innerHTML = '<div class="empty-state">No users found.</div>'; return; }
          listEl.innerHTML = '';
          users.forEach(u => {
              const susp = u.suspended;
              listEl.insertAdjacentHTML('beforeend', `
              <div class="adm-user-row ${susp?'adm-suspended':''}">
                  <div class="adm-user-avatar">${esc((u.displayName||'?')[0])}</div>
                  <div class="adm-user-info">
                      <div class="adm-user-name">${esc(u.displayName||u.username||u.uid)}</div>
                      <div class="adm-user-handle">@${esc(u.username||u.uid)} · ${u.role||'member'}${susp?' · 🔴 Suspended':''}</div>
                      <div class="adm-action-btns">
                          ${susp
                            ? `<button class="btn-adm-restore" onclick="admRestoreUser('${esc(u.uid)}','${esc(u.displayName||'')}')">✅ Restore</button>`
                            : `<button class="btn-adm-suspend" onclick="admSuspendUser('${esc(u.uid)}','${esc(u.displayName||'')}')">🚫 Suspend</button>`
                          }
                          <button class="btn-adm-msg" onclick="viewProfile('${esc(u.uid)}')">👤 Profile</button>
                      </div>
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error loading users.</div>'; }
  }

  window.admSuspendUser = async function(uid, name) {
      if (!admOnly()) { toastNotification('⛔ Administrator access required.'); return; }
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc } = fs;
      try {
          await updateDoc(doc(db,'users',uid), { suspended: true, status: 'offline' });
          await admAuditLog('User suspended', `${name||uid}`);
          toastNotification(`🚫 ${name||uid} suspended.`);
          admSearchUsers();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  window.admRestoreUser = async function(uid, name) {
      if (!admOnly()) { toastNotification('⛔ Administrator access required.'); return; }
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc } = fs;
      try {
          await updateDoc(doc(db,'users',uid), { suspended: false });
          await admAuditLog('User restored', `${name||uid}`);
          toastNotification(`✅ ${name||uid} restored.`);
          admSearchUsers();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  window.admLoadReports = async function(type, btn) {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      document.querySelectorAll('#admTab-reports .adm-tab').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const { db, collection, getDocs, query, where, orderBy, limit } = fs;
      const listEl = document.getElementById('admReportList');
      if (!listEl) return;
      listEl.innerHTML = '<div class="empty-state">Loading…</div>';
      try {
          const q = query(collection(db,'reports'), where('type','==',type), where('status','==','open'), orderBy('createdAt','desc'), limit(40));
          const snap = await getDocs(q);
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No open reports.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const r = d.data(); const rid = d.id;
              listEl.insertAdjacentHTML('beforeend', `
              <div class="report-card">
                  <div class="report-card-header">
                      <span>Reporter: ${esc(r.reporterName||'?')} · ${fmtDate(r.createdAt)}</span>
                      <span style="font-size:10px;background:rgba(255,51,102,0.15);border:1px solid rgba(255,51,102,0.3);color:#ff88aa;padding:2px 7px;border-radius:8px;">${esc(r.reason||'')}</span>
                  </div>
                  <div class="report-card-body">${esc(r.content||r.targetId||'')}</div>
                  <div class="report-card-actions">
                      <button class="btn-mod-dismiss" onclick="admResolveReport('${rid}','dismiss')">✓ Dismiss</button>
                      <button class="btn-mod-remove"  onclick="admResolveReport('${rid}','remove')">🗑 Remove</button>
                      ${type === 'user' ? `<button class="btn-adm-suspend" onclick="admSuspendUser('${esc(r.targetId||'')}','${esc(r.targetName||'')}')">🚫 Suspend</button>` : ''}
                  </div>
              </div>`);
          });
      } catch(e) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  };

  window.admResolveReport = async function(reportId, action) {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, doc, updateDoc, getDoc } = fs;
      try {
          const rSnap = await getDoc(doc(db,'reports',reportId));
          if (!rSnap.exists()) return;
          const r = rSnap.data();
          if ((action === 'remove') && r.type === 'post' && r.targetId) {
              try { await updateDoc(doc(db,'posts',r.targetId), { hidden: true }); } catch(_) {}
          }
          await updateDoc(doc(db,'reports',reportId), {
              status:'resolved', resolvedBy:window._snxCurrentUser?.uid||'',
              resolvedAt:Date.now(), resolution:action
          });
          await admAuditLog(`Report resolved (${action})`, `ID: ${reportId}`);
          toastNotification('✅ Report resolved.');
          admLoadReports(r.type || 'user');
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  window.admSendAnnouncement = async function() {
      if (!admOnly()) { toastNotification('⛔ Administrator access required.'); return; }
      const text = (document.getElementById('admAnnounceText')?.value||'').trim();
      if (!text) { toastNotification('Please write an announcement.'); return; }
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, addDoc, updateDoc, doc, arrayUnion } = fs;
      try {
          await addDoc(collection(db,'announcements'), {
              text, sentBy: window._snxCurrentUser?.uid||'',
              sentByName: window._snxUserData?.displayName||'Admin',
              ts: Date.now()
          });
          const snap = await getDocs(collection(db,'users'));
          const batch_promises = [];
          snap.forEach(d => {
              if (d.id === window._snxCurrentUser?.uid) return;
              batch_promises.push(updateDoc(doc(db,'users',d.id), {
                  notifications: arrayUnion({
                      id: 'ann-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),
                      type:'announcement', text: '📢 ' + text.slice(0,100),
                      read: false, ts: Date.now()
                  })
              }).catch(()=>{}));
          });
          await Promise.all(batch_promises);
          await admAuditLog('Announcement sent', text.slice(0,80));
          toastNotification('📢 Announcement sent!');
          if (document.getElementById('admAnnounceText')) document.getElementById('admAnnounceText').value = '';
          admLoadAnnounceHistory();
      } catch(e) { toastNotification('Failed: ' + e.message); }
  };

  async function admLoadAnnounceHistory() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, orderBy, limit } = fs;
      const listEl = document.getElementById('admAnnounceHistory');
      if (!listEl) return;
      try {
          const snap = await getDocs(query(collection(db,'announcements'), orderBy('ts','desc'), limit(20)));
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No announcements yet.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const a = d.data();
              listEl.insertAdjacentHTML('beforeend', `
              <div class="adm-announce-row">
                  <span class="adm-announce-ts">${fmtDate(a.ts)}</span>
                  <span class="adm-announce-msg">${esc(a.text)}</span>
              </div>`);
          });
      } catch(_) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }
  window.admLoadAnnounceHistory = admLoadAnnounceHistory;

  async function admLoadAuditLog() {
      if (!admOnly()) return;
      const fs = window._snxFirestore;
      if (!fs) return;
      const { db, collection, getDocs, query, orderBy, limit } = fs;
      const listEl = document.getElementById('admAuditLog');
      if (!listEl) return;
      try {
          const snap = await getDocs(query(collection(db,'auditLog'), orderBy('ts','desc'), limit(50)));
          if (snap.empty) { listEl.innerHTML = '<div class="empty-state">No audit entries.</div>'; return; }
          listEl.innerHTML = '';
          snap.forEach(d => {
              const e = d.data();
              listEl.insertAdjacentHTML('beforeend', `
              <div class="adm-audit-entry">
                  <span class="adm-audit-ts">${fmtDate(e.ts)}</span>
                  <span class="adm-audit-action"><strong>${esc(e.adminName||'?')}</strong> (${esc(e.role||'admin')}) — ${esc(e.action)} · ${esc(e.details||'')}</span>
              </div>`);
          });
      } catch(_) { listEl.innerHTML = '<div class="empty-state">Error.</div>'; }
  }

  async function admAuditLog(action, details) {
      const fs = window._snxFirestore;
      if (!fs || !window._snxCurrentUser) return;
      try {
          const { db, collection, addDoc } = fs;
          await addDoc(collection(db,'auditLog'), {
              action, details,
              adminUid:  window._snxCurrentUser.uid,
              adminName: window._snxUserData?.displayName || '',
              role: window._snxRole || 'administrator',
              ts: Date.now()
          });
      } catch(_) {}
  }

  window.renderAdministratorPanel = function() {
      if (!admOnly()) { toastNotification('⛔ Administrator access required.'); navTo('feed'); return; }
      admLoadStats();
  };

})();
