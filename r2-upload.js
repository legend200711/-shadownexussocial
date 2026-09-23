/**
 * r2-upload.js — Shadow Nexus Social
 *
 * Shared Cloudflare R2 upload module.
 * Provides a single `snxUploadToR2(file, opts)` function used across:
 *   Feed posts · Profile pictures · Profile covers · Music Hub ·
 *   Cloud Radio · 24-Hour Cloud Stream · Theme Engine backgrounds
 *
 * Upload pipeline:
 *   1. Client-side MIME + size validation.
 *   2. Fresh Firebase ID token fetched (never stored or logged).
 *   3. ≤ 20 MB  → single XHR  POST /            (with progress)
 *      > 20 MB  → chunked     POST /upload-chunk × N
 *                              POST /upload-complete
 *      Each chunk retried up to 3 times with exponential back-off.
 *   4. Permanent R2 CDN URL returned on success.
 *
 * Security:
 *   • Private credentials never leave the server — the frontend only
 *     passes a short-lived Firebase ID token in the Authorization header.
 *   • The Worker verifies the token server-side and scopes every key to
 *     the authenticated UID.
 *   • Caller-supplied `keyPrefix` is validated against allowed prefixes.
 *
 * Usage (ES module):
 *   import { snxUploadToR2 } from './r2-upload.js';
 *   const url = await snxUploadToR2(file, {
 *     keyPrefix: 'posts/{uid}/',   // optional — server uses uid/ by default
 *     onProgress: pct => ...,
 *     mediaKind: 'post',           // for Firestore metadata
 *   });
 *
 * Usage (classic script — exposes window.snxUploadToR2):
 *   <script src="r2-upload.js"></script>
 */

(function (global, factory) {
  /* UMD: works as an ES module or a plain <script> tag */
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    const exp = factory();
    global.snxUploadToR2   = exp.snxUploadToR2;
    global.snxR2KeyForUser = exp.snxR2KeyForUser;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────────
  const R2_WORKER    = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  const CHUNK_SIZE   = 10 * 1024 * 1024;   // 10 MB per chunk
  const SINGLE_LIMIT = 20 * 1024 * 1024;   // ≤ 20 MB → single request
  const MAX_RETRIES  = 3;

  // Per-type client-side size limits (server also enforces these)
  const IMG_LIMIT   = 10  * 1024 * 1024;   // 10 MB
  const VIDEO_LIMIT = 100 * 1024 * 1024;   // 100 MB (chunked handles larger)
  const AUDIO_LIMIT = 200 * 1024 * 1024;   // 200 MB

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Return a collision-resistant R2 object key for a file. */
  function snxR2KeyForUser(uid, namespace, file) {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    return (namespace || uid) + '/' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.' + ext;
  }

  /** Obtain a fresh Firebase ID token from whichever auth reference is available. */
  function _getIdToken() {
    const user = (typeof auth !== 'undefined' && auth && auth.currentUser)
      ? auth.currentUser
      : (typeof window !== 'undefined' && window._snxCurrentUser)
        ? window._snxCurrentUser
        : null;
    if (!user || typeof user.getIdToken !== 'function') {
      return Promise.reject(new Error('No authenticated Firebase session. Please sign in again.'));
    }
    return user.getIdToken(true);
  }

  /** Derive media type from MIME string. */
  function _mimeKind(mime) {
    if (!mime) return 'other';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'other';
  }

  /** XHR single upload (≤ 20 MB). Returns Promise<{ url, key }>. */
  function _uploadSingle(file, idToken, opts, attempt) {
    attempt = attempt || 1;
    const { onProgress, keyPrefix } = opts || {};
    const form = new FormData();
    form.append('file', file);
    if (keyPrefix) form.append('path', keyPrefix);

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.timeout = 8 * 60 * 1000;   // 8 min

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 90));
        }
      };

      xhr.onload = function () {
        if (onProgress) onProgress(100);
        if (xhr.status === 200) {
          var res;
          try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
          if (res.url) { resolve({ url: res.url, key: res.key || '' }); return; }
          reject(new Error(res.error || 'Upload succeeded but no URL returned.'));
        } else {
          var msg = 'Upload failed (HTTP ' + xhr.status + ').';
          try {
            var err = JSON.parse(xhr.responseText);
            if (err.error) msg = err.error;
          } catch (_) {}
          if (xhr.status === 401) msg = 'Session expired — please sign in again.';
          else if (xhr.status === 413) msg = 'File is too large for this upload type.';
          else if (xhr.status === 415) msg = 'File format not supported.';
          reject(new Error(msg));
        }
      };

      xhr.onerror = function () {
        var isNetworkDrop = xhr.status === 0;
        console.error('[SNX R2] Upload XHR error. Status:', xhr.status, '| Attempt:', attempt);
        if (attempt < MAX_RETRIES) {
          var delay = Math.pow(2, attempt - 1) * 1500;
          setTimeout(function () {
            _uploadSingle(file, idToken, opts, attempt + 1).then(resolve).catch(reject);
          }, delay);
        } else {
          reject(new Error(
            isNetworkDrop
              ? 'Upload interrupted. Check your connection and try again.'
              : 'Upload failed (server error ' + xhr.status + '). Please try again.'
          ));
        }
      };

      xhr.ontimeout = function () {
        reject(new Error('Upload timed out — your connection may be too slow. Please try again.'));
      };

      xhr.open('POST', R2_WORKER);
      xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
      xhr.send(form);
    });
  }

  /** Chunked upload (> 20 MB). Returns Promise<{ url, key }>. */
  async function _uploadChunked(file, idToken, opts) {
    var onProgress = opts && opts.onProgress;
    var keyPrefix  = opts && opts.keyPrefix;
    var totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    var uploadId    = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    var ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Build a scoped key hint for /upload-complete to validate
    var user = (typeof auth !== 'undefined' && auth && auth.currentUser)
      ? auth.currentUser
      : (typeof window !== 'undefined' ? window._snxCurrentUser : null);
    var uid = user ? user.uid : '';
    var finalKey = keyPrefix || (uid ? uid + '/' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.' + ext : '');

    // Upload each chunk with retry
    for (var i = 0; i < totalChunks; i++) {
      var start = i * CHUNK_SIZE;
      var slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
      if (onProgress) onProgress(Math.round((i / totalChunks) * 85));

      var succeeded = false;
      for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        var fd = new FormData();
        fd.append('uploadId',    uploadId);
        fd.append('chunkIndex',  String(i));
        fd.append('totalChunks', String(totalChunks));
        fd.append('chunk',       slice, file.name);

        try {
          var controller = new AbortController();
          var timer = setTimeout(function () { controller.abort(); }, 5 * 60 * 1000);
          var resp;
          try {
            resp = await fetch(R2_WORKER + '/upload-chunk', {
              method:  'POST',
              headers: { 'Authorization': 'Bearer ' + idToken },
              body:    fd,
              signal:  controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!resp.ok) {
            var body = await resp.json().catch(function () { return {}; });
            var chunkErr = body.error || ('Upload interrupted (HTTP ' + resp.status + ')');
            if (resp.status === 401) throw new Error('Session expired — please sign in again.');
            if (resp.status === 413) throw new Error('File is too large for this upload type.');
            throw new Error(chunkErr);
          }
          succeeded = true;
          break;
        } catch (e) {
          var isAbort = e.name === 'AbortError';
          var isNet   = e.name === 'TypeError' || isAbort;
          if (attempt === MAX_RETRIES) {
            throw new Error(
              isAbort ? 'Upload timed out — your connection may be too slow. Please try again.' :
              isNet   ? 'Upload interrupted. Check your connection and try again.' :
              'Upload failed after ' + MAX_RETRIES + ' attempts: ' + e.message
            );
          }
          await new Promise(function (r) { setTimeout(r, Math.pow(2, attempt - 1) * 1500); });
        }
      }
      if (!succeeded) throw new Error('Part ' + i + ' could not be uploaded.');
    }

    if (onProgress) onProgress(92);

    // Assemble on server
    var complFd = new FormData();
    complFd.append('uploadId',    uploadId);
    complFd.append('totalChunks', String(totalChunks));
    if (finalKey) complFd.append('key', finalKey);
    complFd.append('fileName',    file.name);
    complFd.append('fileType',    file.type || '');
    complFd.append('fileSize',    String(file.size));

    var complResp = await fetch(R2_WORKER + '/upload-complete', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + idToken },
      body:    complFd,
    });
    if (!complResp.ok) {
      var complBody = await complResp.json().catch(function () { return {}; });
      throw new Error(complBody.error || 'Upload assembly failed (HTTP ' + complResp.status + ').');
    }
    var result = await complResp.json();
    if (!result.url) throw new Error(result.error || 'Assembly returned no URL.');
    if (onProgress) onProgress(100);
    return { url: result.url, key: result.key || finalKey };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Upload a File to Cloudflare R2.
   *
   * @param {File}   file
   * @param {object} [opts]
   *   opts.onProgress {Function}  (pct: 0–100) => void
   *   opts.keyPrefix  {string}    Caller-suggested R2 key prefix (validated by Worker)
   *   opts.mediaKind  {string}    'post' | 'profile' | 'cover' | 'audio' | 'artwork' | ...
   * @returns {Promise<string>}    Permanent R2 CDN URL
   */
  async function snxUploadToR2(file, opts) {
    opts = opts || {};

    // ── Client-side validation ─────────────────────────────────────────────
    var kind = _mimeKind(file.type);
    if (kind === 'image' && file.size > IMG_LIMIT) {
      throw new Error(
        'Image too large — maximum is 10 MB (your file is ' +
        (file.size / 1024 / 1024).toFixed(1) + ' MB). Please resize it first.'
      );
    }
    if (kind === 'video' && file.size > VIDEO_LIMIT) {
      throw new Error(
        'Video too large — maximum is 100 MB (your file is ' +
        (file.size / 1024 / 1024).toFixed(1) + ' MB). Please compress it first.'
      );
    }
    if (kind === 'audio' && file.size > AUDIO_LIMIT) {
      throw new Error(
        'Audio file too large — maximum is 200 MB (your file is ' +
        (file.size / 1024 / 1024).toFixed(1) + ' MB).'
      );
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    var idToken = await _getIdToken();

    // ── Upload ──────────────────────────────────────────────────────────────
    var result;
    if (file.size > SINGLE_LIMIT) {
      result = await _uploadChunked(file, idToken, opts);
    } else {
      result = await _uploadSingle(file, idToken, opts, 1);
    }

    return result.url;
  }

  return { snxUploadToR2: snxUploadToR2, snxR2KeyForUser: snxR2KeyForUser };
});
