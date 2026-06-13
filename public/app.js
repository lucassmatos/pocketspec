'use strict';

const contentEl = document.getElementById('content');
const breadcrumbEl = document.getElementById('breadcrumb');
const actionsEl = document.getElementById('actions');

// Routes (hash-based, so the browser back button works):
//   #/            → list of registered roots
//   #/0           → root 0, top folder
//   #/0/sub/dir   → folder inside root 0
//   #/0/sub/x.md  → rendered document

function parseHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!hash) return { root: null, path: '' };
  const [rootStr, ...rest] = hash.split('/');
  return { root: Number(rootStr), path: rest.join('/') };
}

function hashFor(root, relPath) {
  const suffix = relPath ? '/' + relPath.split('/').map(encodeURIComponent).join('/') : '';
  return `#/${root}${suffix}`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

let rootsCache = null;
async function getRoots() {
  if (!rootsCache) rootsCache = await fetchJson('/api/roots');
  return rootsCache;
}

// Server tells us whether writes are allowed (--read-only). Cached once.
let metaCache = null;
async function getMeta() {
  if (!metaCache) {
    try { metaCache = await fetchJson('/api/meta'); }
    catch { metaCache = { readOnly: false }; }
  }
  return metaCache;
}

// current doc view state (used by comment + edit handlers)
let current = { root: null, path: '' };

// ---------- breadcrumb ----------

function renderBreadcrumb(rootName, root, relPath, isDoc) {
  breadcrumbEl.innerHTML = '';
  const add = (label, href) => {
    if (breadcrumbEl.childNodes.length) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      breadcrumbEl.appendChild(sep);
    }
    if (href !== null) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      breadcrumbEl.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'current';
      span.textContent = label;
      breadcrumbEl.appendChild(span);
    }
  };

  add('🏠', '#/');
  if (root === null) return;

  const parts = relPath ? relPath.split('/') : [];
  const last = parts.length - 1;
  add(rootName, parts.length ? hashFor(root, '') : null);
  parts.forEach((part, i) => {
    const label = isDoc && i === last ? part.replace(/\.md$/i, '') : part;
    add(label, i === last ? null : hashFor(root, parts.slice(0, i + 1).join('/')));
  });
  // keep the tail of a long path visible
  breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
}

// ---------- listing views ----------

function listItem(href, icon, label, meta) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = href;
  a.innerHTML = `<span class="icon">${icon}</span><span class="label"></span>` +
    (meta ? `<span class="meta">${meta}</span>` : '');
  a.querySelector('.label').textContent = label;
  li.appendChild(a);
  return li;
}

async function renderHome() {
  const roots = await getRoots();
  renderBreadcrumb(null, null, '', false);
  contentEl.innerHTML = '<h1 class="page-title">Documents</h1>';
  if (!roots.length) {
    contentEl.insertAdjacentHTML('beforeend',
      '<p class="empty">No folders yet.<br>Use <code>pocketspec add &lt;folder&gt;</code></p>');
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'listing';
  for (const root of roots) {
    ul.appendChild(listItem(hashFor(root.id, ''), '📚', root.name, ''));
  }
  contentEl.appendChild(ul);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function renderFolder(root, relPath) {
  const roots = await getRoots();
  const rootInfo = roots.find((r) => r.id === root);
  if (!rootInfo) throw new Error('root not found');
  const data = await fetchJson(`/api/list?root=${root}&path=${encodeURIComponent(relPath)}`);
  renderBreadcrumb(rootInfo.name, root, relPath, false);
  contentEl.innerHTML = '';

  if (!data.dirs.length && !data.files.length) {
    contentEl.innerHTML = '<p class="empty">Empty folder (no .md files)</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'listing';
  const join = (name) => (relPath ? relPath + '/' + name : name);
  for (const dir of data.dirs) {
    ul.appendChild(listItem(hashFor(root, join(dir)), '📁', dir, ''));
  }
  for (const file of data.files) {
    ul.appendChild(listItem(hashFor(root, join(file.name)), '📄',
      file.name.replace(/\.md$/i, ''), formatSize(file.size)));
  }
  contentEl.appendChild(ul);
}

// ---------- document view ----------

async function renderDoc(root, relPath) {
  const roots = await getRoots();
  const rootInfo = roots.find((r) => r.id === root);
  if (!rootInfo) throw new Error('root not found');
  const res = await fetch(`/api/doc?root=${root}&path=${encodeURIComponent(relPath)}`);
  if (!res.ok) throw new Error(await res.text());
  const md = await res.text();
  renderBreadcrumb(rootInfo.name, root, relPath, true);
  current = { root, path: relPath };

  const doc = document.createElement('article');
  doc.className = 'doc';
  doc.innerHTML = marked.parse(md);

  // Rewrite relative links: .md links navigate in-app, other assets go through /api/raw
  const docDir = relPath.split('/').slice(0, -1).join('/');
  const resolveRel = (href) => {
    const stack = docDir ? docDir.split('/') : [];
    for (const part of href.split('/')) {
      if (part === '' || part === '.') continue;
      else if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
  };
  const isExternal = (href) => /^([a-z]+:|\/|#)/i.test(href);

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (isExternal(href)) continue;
    const [target, anchor] = href.split('#');
    if (/\.md$/i.test(target)) {
      a.href = hashFor(root, resolveRel(target)) + (anchor ? '#' + anchor : '');
    } else if (target) {
      a.href = `/api/raw?root=${root}&path=${encodeURIComponent(resolveRel(target))}`;
    }
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (isExternal(src)) continue;
    img.src = `/api/raw?root=${root}&path=${encodeURIComponent(resolveRel(src))}`;
  }

  const meta = await getMeta();

  // each top-level element is a commentable block (tap to comment, unless read-only)
  [...doc.children].forEach((el, i) => el.setAttribute('data-bi', i));
  if (!meta.readOnly) doc.addEventListener('click', onBlockTap);

  contentEl.innerHTML = '';
  contentEl.appendChild(doc);

  const general = document.createElement('section');
  general.id = 'general-comments';
  contentEl.appendChild(general);

  renderActions(!meta.readOnly);
  if (!meta.readOnly) ensureFab();
  await refreshComments();
  window.scrollTo(0, 0);
}

// ---------- comments ----------

const SNIPPET_LEN = 80;
const blockSnippet = (el) => el.textContent.trim().slice(0, SNIPPET_LEN);

function commentsUrl(extra) {
  return `/api/comments?root=${current.root}&path=${encodeURIComponent(current.path)}` + (extra || '');
}

function resolveAnchor(blocks, anchor) {
  if (!anchor) return null;
  const byIndex = blocks[anchor.index];
  if (byIndex && blockSnippet(byIndex) === anchor.snippet) return byIndex;
  return blocks.find((b) => blockSnippet(b) === anchor.snippet) || null;
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function commentBubble(comment, note) {
  const div = document.createElement('div');
  div.className = 'comment-bubble';
  const body = document.createElement('div');
  body.className = 'comment-text';
  body.textContent = comment.text;
  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  meta.textContent = '💬 ' + formatTime(comment.ts) + (note ? ` · ${note}` : '');
  if (!(metaCache && metaCache.readOnly)) {
    const del = document.createElement('button');
    del.className = 'comment-delete';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      await fetchJson(commentsUrl(`&id=${comment.id}`), { method: 'DELETE' });
      await refreshComments();
    });
    meta.appendChild(del);
  }
  div.appendChild(body);
  div.appendChild(meta);
  return div;
}

async function refreshComments() {
  const doc = contentEl.querySelector('article.doc');
  const general = document.getElementById('general-comments');
  if (!doc || !general) return;

  const data = await fetchJson(commentsUrl());
  doc.querySelectorAll('.comment-thread').forEach((el) => el.remove());
  doc.querySelectorAll('.has-comments').forEach((el) => el.classList.remove('has-comments'));
  general.innerHTML = '';

  const blocks = [...doc.children].filter((el) => el.hasAttribute('data-bi'));
  const orphans = [];
  const generals = [];

  for (const comment of data.comments) {
    const block = resolveAnchor(blocks, comment.anchor);
    if (!comment.anchor) generals.push(comment);
    else if (!block) orphans.push(comment);
    else {
      let thread = block.nextElementSibling;
      if (!thread || !thread.classList.contains('comment-thread')) {
        thread = document.createElement('div');
        thread.className = 'comment-thread';
        block.after(thread);
      }
      block.classList.add('has-comments');
      thread.appendChild(commentBubble(comment));
    }
  }

  if (generals.length || orphans.length) {
    const h = document.createElement('h2');
    h.className = 'general-comments-title';
    h.textContent = 'General comments';
    general.appendChild(h);
    for (const c of generals) general.appendChild(commentBubble(c));
    for (const c of orphans) {
      general.appendChild(commentBubble(c, `on: “${c.anchor.snippet.slice(0, 40)}…”`));
    }
  }
}

// ---------- comment sheet ----------

let sheet = null;
let pendingAnchor = null;
let selectedBlock = null;

// In iOS standalone (home-screen) mode, programmatic focus() marks the field
// as focused WITHOUT showing the keyboard — and a later tap on the already-
// focused field won't re-trigger focus, so the keyboard never appears.
// Let the user's own tap do the focusing there.
const isStandalone = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

// Keep the sheet above the iOS keyboard (fixed elements anchor to the layout
// viewport, which the keyboard does not always resize).
function adjustSheetForKeyboard() {
  if (!sheet || sheet.hidden) return;
  const vv = window.visualViewport;
  const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  sheet.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustSheetForKeyboard);
  window.visualViewport.addEventListener('scroll', adjustSheetForKeyboard);
}

function ensureSheet() {
  if (sheet) return sheet;
  sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="sheet-context" id="sheet-context"></div>
    <textarea id="sheet-text" rows="3" placeholder="Write your comment…"></textarea>
    <div class="sheet-buttons">
      <button class="btn" id="sheet-cancel">Cancel</button>
      <button class="btn primary" id="sheet-send">Comment</button>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelector('#sheet-cancel').addEventListener('click', closeSheet);
  sheet.querySelector('#sheet-send').addEventListener('click', async () => {
    const textarea = sheet.querySelector('#sheet-text');
    const text = textarea.value.trim();
    if (!text) return;
    await fetchJson(commentsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, anchor: pendingAnchor }),
    });
    textarea.value = '';
    closeSheet();
    await refreshComments();
  });
  return sheet;
}

function openSheet(anchor, contextLabel) {
  ensureSheet();
  pendingAnchor = anchor;
  sheet.querySelector('#sheet-context').textContent = contextLabel;
  sheet.hidden = false;
  if (!isStandalone) sheet.querySelector('#sheet-text').focus();
}

function closeSheet() {
  if (sheet) {
    sheet.querySelector('#sheet-text').blur();
    sheet.style.transform = '';
    sheet.hidden = true;
  }
  pendingAnchor = null;
  if (selectedBlock) {
    selectedBlock.classList.remove('block-selected');
    selectedBlock = null;
  }
}

function onBlockTap(e) {
  if (e.target.closest('a, .comment-thread, input, button')) return;
  const block = e.target.closest('[data-bi]');
  if (!block) return;
  if (selectedBlock) selectedBlock.classList.remove('block-selected');
  selectedBlock = block;
  block.classList.add('block-selected');
  const snippet = blockSnippet(block);
  openSheet(
    { index: Number(block.getAttribute('data-bi')), snippet },
    `Commenting on: “${snippet.slice(0, 60)}${snippet.length > 60 ? '…' : ''}”`,
  );
}

// ---------- floating button + topbar actions ----------

let fab = null;
function ensureFab() {
  if (fab) { fab.hidden = false; return; }
  fab = document.createElement('button');
  fab.id = 'fab';
  fab.title = 'General comment';
  fab.textContent = '💬';
  fab.addEventListener('click', () => openSheet(null, 'General comment on the document'));
  document.body.appendChild(fab);
}

function hideDocChrome() {
  if (fab) fab.hidden = true;
  closeSheet();
  actionsEl.innerHTML = '';
}

function renderActions(isDoc) {
  actionsEl.innerHTML = '';
  if (!isDoc) return;
  const edit = document.createElement('button');
  edit.className = 'topbtn';
  edit.title = 'Edit document';
  edit.textContent = '✏️';
  edit.addEventListener('click', openEditor);
  actionsEl.appendChild(edit);
}

// ---------- editor ----------

async function openEditor() {
  const { root, path: relPath } = current;
  const res = await fetch(`/api/doc?root=${root}&path=${encodeURIComponent(relPath)}`);
  if (!res.ok) { alert(await res.text()); return; }
  const md = await res.text();

  hideDocChrome();
  contentEl.innerHTML = '';

  const textarea = document.createElement('textarea');
  textarea.id = 'editor';
  textarea.value = md;

  // buttons live in the sticky topbar so they never scroll out of view
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', route);
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await fetchJson(`/api/save?root=${root}&path=${encodeURIComponent(relPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textarea.value }),
      });
      await route();
    } catch (err) {
      alert('Error saving: ' + err.message);
      save.disabled = false;
      save.textContent = 'Save';
    }
  });
  actionsEl.appendChild(cancel);
  actionsEl.appendChild(save);

  contentEl.appendChild(textarea);
}

// ---------- router ----------

async function route() {
  const { root, path: relPath } = parseHash();
  const isDoc = root !== null && !Number.isNaN(root) && /\.md$/i.test(relPath);
  if (!isDoc) hideDocChrome();
  try {
    if (root === null || Number.isNaN(root)) await renderHome();
    else if (isDoc) await renderDoc(root, relPath);
    else await renderFolder(root, relPath);
  } catch (err) {
    contentEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = 'Error: ' + err.message;
    contentEl.appendChild(p);
  }
}

window.addEventListener('hashchange', route);
route();
