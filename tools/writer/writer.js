/* 블로그 글쓰기 도구 화면 */
(() => {
  'use strict';

  const TOKEN = document.querySelector('meta[name="writer-token"]').content;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KIND_LABEL = { md: 'MD', pdf: 'PDF', html: 'HTML', image: 'IMG', video: 'VID', audio: 'AUD', file: 'FILE' };

  let META = { posts: [], categories: [], tags: [], git: {}, settings: {} };

  /* ---------------- server ---------------- */

  async function api(path, body) {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Writer-Token': TOKEN } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch('/__api/' + path, init);
    } catch (error) {
      throw new Error('글쓰기 도구에 연결할 수 없습니다. 검은 창(도구)이 닫혔는지 확인하세요.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }

  async function upload(file) {
    const response = await fetch('/__api/upload', {
      method: 'POST',
      headers: {
        'X-Writer-Token': TOKEN,
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Modified': String(file.lastModified || 0),
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  /* ---------------- feedback ---------------- */

  let busyDepth = 0;
  const busy = (on, text) => {
    const el = $('#busy');
    if (on) {
      busyDepth += 1;
      $('#busy-text').textContent = text || '처리 중…';
      el.hidden = false;
    } else {
      busyDepth = Math.max(0, busyDepth - 1);
      if (!busyDepth) el.hidden = true;
    }
  };
  const withBusy = async (text, job) => {
    busy(true, text);
    try { return await job(); } finally { busy(false); }
  };
  let toastTimer = null;
  const toast = (message, kind) => {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
  };
  const fail = (error) => toast(error && error.message ? error.message : String(error), 'error');

  /* ---------------- Hangul-aware matching (초성) ---------------- */

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const initials = (text) => {
    let out = '';
    for (const ch of text) {
      const code = ch.charCodeAt(0) - 0xac00;
      out += code >= 0 && code < 11172 ? CHO[Math.floor(code / 588)] : ch;
    }
    return out;
  };
  const score = (name, query) => {
    const n = String(name).toLowerCase();
    if (!query) return 1;
    if (n === query) return 4;
    if (n.startsWith(query)) return 3;
    if (n.includes(query)) return 2;
    if (/^[ㄱ-ㅎ]+$/.test(query) && initials(n).replace(/\s+/g, '').includes(query)) return 1;
    return 0;
  };
  const mark = (text, query) => {
    const at = query ? text.toLowerCase().indexOf(query) : -1;
    if (at < 0) return esc(text);
    return esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + query.length)) + '</mark>' + esc(text.slice(at + query.length));
  };

  /* ---------------- autocomplete ---------------- */

  function Suggest(input, getOptions, options = {}) {
    const { onPick, allowNew = true, exclude = () => [], container = input.parentElement, prefix = '' } = options;
    const box = document.createElement('div');
    box.className = 'suggest';
    box.hidden = true;
    container.appendChild(box);
    let list = [];
    let active = -1;
    const query = () => input.value.trim().replace(/^#+/, '');

    const render = () => {
      if (!list.length || document.activeElement !== input) { box.hidden = true; return; }
      const q = query().toLowerCase();
      box.innerHTML = list.map((option, i) => (
        `<div class="suggest-item${option.isNew ? ' new' : ''}${i === active ? ' active' : ''}" data-i="${i}">`
        + `<span>${option.isNew ? '새로 만들기: ' + esc(prefix + option.name) : esc(prefix) + mark(option.name, q)}</span>`
        + (option.count !== undefined ? `<span class="count">${option.count}개 글</span>` : '')
        + '</div>'
      )).join('');
      box.hidden = false;
      const current = box.querySelector('.active');
      if (current) current.scrollIntoView({ block: 'nearest' });
    };

    const update = () => {
      const q = query().toLowerCase();
      const skip = new Set(exclude().map((s) => s.toLowerCase()));
      const all = getOptions();
      list = all
        .filter((o) => !skip.has(o.name.toLowerCase()))
        .map((o) => [score(o.name, q), o])
        .filter(([s]) => s > 0)
        .sort((a, b) => b[0] - a[0] || (b[1].count || 0) - (a[1].count || 0))
        .slice(0, 12)
        .map(([, o]) => o);
      if (allowNew && q && !all.some((o) => o.name.toLowerCase() === q) && !skip.has(q)) list.push({ name: query(), isNew: true });
      active = q && list.length ? 0 : -1;
      render();
    };

    const pick = (index) => {
      const option = list[index];
      if (!option) return false;
      list = [];
      box.hidden = true;
      onPick(option.name);
      return true;
    };

    input.addEventListener('input', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (event) => {
      const el = event.target.closest('.suggest-item');
      if (!el) return;
      event.preventDefault();
      pick(Number(el.dataset.i));
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;   // 한글 조합 중에는 건드리지 않음
      if (event.key === 'ArrowDown' && list.length) {
        event.preventDefault();
        if (box.hidden) { render(); return; }
        active = (active + 1) % list.length;
        render();
      } else if (event.key === 'ArrowUp' && list.length) {
        event.preventDefault();
        active = (active - 1 + list.length) % list.length;
        render();
      } else if ((event.key === 'Enter' || event.key === 'Tab') && !box.hidden && active >= 0) {
        if (pick(active)) event.preventDefault();
      } else if (event.key === 'Escape') {
        box.hidden = true;
      }
    });
    return { update, isOpen: () => !box.hidden, close: () => { box.hidden = true; } };
  }

  function Chips(root, getOptions) {
    const input = root.querySelector('input');
    let tags = [];
    const add = (raw) => {
      for (const piece of String(raw).split(',')) {
        const tag = piece.trim().replace(/^#+/, '').trim();
        if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
      }
      render();
    };
    const render = () => {
      $$('.chip', root).forEach((chip) => chip.remove());
      for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `#${esc(tag)}<button type="button" aria-label="${esc(tag)} 빼기">×</button>`;
        chip.querySelector('button').addEventListener('click', (event) => {
          event.stopPropagation();
          tags = tags.filter((t) => t !== tag);
          render();
        });
        root.insertBefore(chip, input);
      }
    };
    const suggest = Suggest(input, getOptions, {
      container: root,
      prefix: '#',
      exclude: () => tags,
      onPick: (name) => { add(name); input.value = ''; setTimeout(() => suggest.update(), 0); },
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.defaultPrevented) {
        event.preventDefault();
        if (input.value.trim()) { add(input.value); input.value = ''; suggest.update(); }
      } else if (event.key === 'Backspace' && !input.value && tags.length) {
        tags.pop();
        render();
        suggest.update();
      }
    });
    input.addEventListener('input', () => {
      if (!input.value.includes(',')) return;
      const parts = input.value.split(',');
      const rest = parts.pop();
      parts.forEach(add);
      input.value = rest;
      suggest.update();
    });
    root.addEventListener('click', () => input.focus());
    return {
      get: () => [...tags],
      set: (list) => { tags = [...(list || [])]; render(); },
      flush: () => { if (input.value.trim()) { add(input.value); input.value = ''; } },
    };
  }

  /* ---------------- file list ---------------- */

  function ItemList(el, onChange) {
    let items = [];
    const render = () => {
      el.innerHTML = '';
      items.forEach((item, index) => {
        if (index > 0 && item.kind === 'image' && items[index - 1].kind === 'image') {
          const joint = document.createElement('li');
          joint.className = 'joint';
          joint.innerHTML = `<button type="button" class="joint-btn${item.attach ? ' on' : ''}">${item.attach ? '🔗 위 이미지와 틈 없이 붙여서 표시' : '↕ 위 이미지와 간격을 두고 표시'}</button>`;
          joint.querySelector('button').addEventListener('click', () => { item.attach = !item.attach; render(); });
          el.appendChild(joint);
        }
        const li = document.createElement('li');
        li.className = 'item';
        const thumb = item.kind === 'image'
          ? `<img src="/__api/thumb?id=${encodeURIComponent(item.id)}&t=${encodeURIComponent(TOKEN)}" alt="" loading="lazy">`
          : esc(KIND_LABEL[item.kind] || 'FILE');
        const sub = [item.size_text];
        if (item.refs && item.refs.length) sub.push(`참조 파일 ${item.refs.length}개도 함께 올림 (${item.refs_size})`);
        if (item.origin) sub.push(item.origin);
        const missing = item.missing && item.missing.length
          ? `<div class="item-warn">⚠ 이 문서가 참조하는 파일 ${item.missing.length}개를 찾지 못했습니다: ${esc(item.missing.slice(0, 3).join(', '))}${item.missing.length > 3 ? ' …' : ''}`
            + '<button type="button" class="btn small" data-act="resolve">원본 폴더 선택</button></div>'
          : '';
        li.innerHTML = `<span class="kind ${esc(item.kind)}">${thumb}</span>`
          + '<div class="item-main">'
          + `<div class="item-name" title="${esc(item.name)}">${esc(item.name)}</div>`
          + `<div class="item-sub" title="${esc(sub.join(' · '))}">${esc(sub.join(' · '))}</div>`
          + missing
          + (item.warn ? `<div class="item-warn">⚠ ${esc(item.warn)}</div>` : '')
          + '</div>'
          + '<div class="item-btns">'
          + '<button class="icon-btn" type="button" data-act="up" title="위로" aria-label="위로">↑</button>'
          + '<button class="icon-btn" type="button" data-act="down" title="아래로" aria-label="아래로">↓</button>'
          + '<button class="icon-btn" type="button" data-act="remove" title="빼기" aria-label="빼기">✕</button>'
          + '</div>';
        li.addEventListener('click', async (event) => {
          const button = event.target.closest('[data-act]');
          if (!button) return;
          const at = items.indexOf(item);
          if (button.dataset.act === 'up' && at > 0) [items[at - 1], items[at]] = [items[at], items[at - 1]];
          if (button.dataset.act === 'down' && at < items.length - 1) [items[at + 1], items[at]] = [items[at], items[at + 1]];
          if (button.dataset.act === 'remove') items.splice(at, 1);
          if (button.dataset.act === 'resolve') {
            try {
              const chosen = await api('pick', { mode: 'folder' });
              if (!chosen.paths.length) return;
              const fresh = await api('resolve', { id: item.id, folder: chosen.paths[0] });
              Object.assign(item, fresh);
              toast(fresh.missing.length ? `아직 ${fresh.missing.length}개를 찾지 못했습니다.` : '참조 파일을 모두 찾았습니다.', fresh.missing.length ? 'error' : undefined);
            } catch (error) { fail(error); }
          }
          render();
        });
        el.appendChild(li);
      });
      if (onChange) onChange(items);
    };
    return {
      add: (list) => { for (const item of list) items.push({ ...item, attach: true }); render(); },
      get: () => items,
      clear: () => { items = []; render(); },
    };
  }

  /* ---------------- tabs & modals ---------------- */

  const switchTab = (name) => {
    $$('.tab').forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    $('#tab-new').hidden = name !== 'new';
    $('#tab-manage').hidden = name !== 'manage';
  };
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  const openModal = (selector) => { $(selector).hidden = false; };
  const closeModal = (modal) => { modal.hidden = true; };
  $$('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) closeModal(modal);
      else if (event.target === modal && modal.id !== 'edit-modal') closeModal(modal);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = $$('.modal').filter((m) => !m.hidden).pop();
    if (open && !$('.suggest:not([hidden])', open)) closeModal(open);
  });

  /* ---------------- meta & git ---------------- */

  const liveUrl = (path) => (META.site_url || '') + path;
  const repoUrl = () => (META.git && META.git.remote ? META.git.remote.replace(/\.git$/, '') : '');

  const updatePending = () => {
    const git = META.git || {};
    const count = (git.changes || 0) + (git.ahead || 0);
    const el = $('#pending');
    el.hidden = !count;
    el.textContent = `게시 안 된 변경 ${git.changes || 0}${git.ahead ? ` · 올리지 않은 커밋 ${git.ahead}` : ''}`;
  };

  async function refreshMeta() {
    META = await api('meta');
    renderPosts();
    updatePending();
  }

  setInterval(async () => {
    try { META.git = await api('git'); updatePending(); } catch (error) { /* tool closed */ }
  }, 20000);

  /* ---------------- new post ---------------- */

  const nowLocal = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  let titleWasAuto = true;
  $('#title').addEventListener('input', () => { titleWasAuto = !$('#title').value.trim(); });
  const newList = ItemList($('#items'), (items) => {
    if (titleWasAuto) {
      const first = items.find((i) => i.kind === 'md' || i.kind === 'html') || items[0];
      $('#title').value = first ? first.title : '';
    }
  });
  const newTags = Chips($('#tags'), () => META.tags);
  Suggest($('#category'), () => META.categories, { onPick: (name) => { $('#category').value = name; } });
  $('#date').value = nowLocal();

  const resetNew = () => {
    newList.clear();
    newTags.set([]);
    ['#title', '#category', '#description', '#intro'].forEach((s) => { $(s).value = ''; });
    $('#draft').checked = false;
    $('#date').value = nowLocal();
    titleWasAuto = true;
  };

  async function saveNew(publishNow) {
    newTags.flush();
    const payload = {
      title: $('#title').value.trim(),
      date: $('#date').value,
      category: $('#category').value.trim(),
      tags: newTags.get(),
      description: $('#description').value.trim(),
      draft: $('#draft').checked,
      intro: $('#intro').value,
      items: newList.get().map((item) => ({ id: item.id, attach: item.attach })),
      publish: publishNow,
    };
    if (!payload.items.length && !payload.intro.trim()) { toast('올릴 파일이나 본문을 넣어 주세요.', 'error'); return; }
    if (!payload.title) { toast('제목을 적어 주세요.', 'error'); $('#title').focus(); return; }
    try {
      const result = await withBusy(publishNow ? 'GitHub에 올리는 중… (처음에는 로그인 창이 뜰 수 있습니다)' : '저장하는 중…', () => api('save', payload));
      showResult(result);
      resetNew();
      await refreshMeta();
      if (!publishNow) window.open(result.url, '_blank');
    } catch (error) { fail(error); }
  }

  let lastLog = null;
  function showResult(result) {
    const el = $('#result');
    el.hidden = false;
    const failed = result.publish && !result.publish.ok;
    el.classList.toggle('error', Boolean(failed));
    let html = `저장했습니다. <a href="${esc(result.url)}" target="_blank" rel="noopener">미리보기 ↗</a>`;
    if (result.warnings && result.warnings.length) html += `<br>⚠ ${esc(result.warnings.join(' / '))}`;
    if (result.publish) {
      lastLog = result.publish;
      html += result.publish.ok
        ? `<br>게시했습니다. 1~2분 뒤 <a href="${esc(liveUrl(result.url))}" target="_blank" rel="noopener">블로그</a>에 반영됩니다.`
        : '<br>게시하지 못했습니다. <a href="#" data-log>기록 보기</a>';
    }
    el.innerHTML = html;
  }
  $('#result').addEventListener('click', (event) => {
    if (!event.target.closest('[data-log]')) return;
    event.preventDefault();
    if (lastLog) showLog(lastLog);
  });

  $('#save-preview').addEventListener('click', () => saveNew(false));
  $('#save-publish').addEventListener('click', () => saveNew(true));

  $('#pick-files').addEventListener('click', async () => {
    try {
      const result = await withBusy('파일 선택 창을 열었습니다…', () => api('pick', { mode: 'files' }));
      newList.add(result.items);
    } catch (error) { fail(error); }
  });

  $('#paste-paths').addEventListener('click', () => { $('#paths-text').value = ''; openModal('#paths-modal'); setTimeout(() => $('#paths-text').focus(), 50); });
  $('#paths-add').addEventListener('click', async () => {
    const paths = $('#paths-text').value.split(/\r?\n/).map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (!paths.length) return;
    try {
      const result = await withBusy('파일을 확인하는 중…', () => api('inspect', { paths }));
      const target = $('#edit-modal').hidden ? newList : editList;
      target.add(result.items);
      closeModal($('#paths-modal'));
      if (result.missing.length) toast(`찾을 수 없는 경로: ${result.missing.join(', ')}`, 'error');
    } catch (error) { fail(error); }
  });

  /* ---------------- drag & drop ---------------- */

  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => { if (hasFiles(event)) { dragDepth += 1; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const entries = [...event.dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const files = [...event.dataTransfer.files];
    const folders = entries.filter((e) => e && e.isDirectory).map((e) => e.name);
    const plain = files.filter((file, i) => !(entries[i] && entries[i].isDirectory));
    const target = $('#edit-modal').hidden ? newList : editList;
    if (target === newList) switchTab('new');
    if (folders.length) toast(`폴더(${folders.join(', ')})는 [경로 붙여넣기]에 폴더 경로를 넣거나 '블로그 글쓰기.bat' 위에 끌어다 놓으세요.`, 'error');
    if (!plain.length) return;
    await withBusy(`파일 ${plain.length}개를 가져오는 중…`, async () => {
      for (const file of plain) {
        try { target.add([await upload(file)]); } catch (error) { fail(new Error(`${file.name}: ${error.message}`)); }
      }
    });
  });

  /* ---------------- manage ---------------- */

  function renderPosts() {
    const q = $('#post-filter').value.trim().toLowerCase();
    const rows = META.posts.filter((p) => !q || [p.title, p.category, ...p.tags].some((s) => score(s, q) > 0));
    $('#post-count').textContent = `${rows.length} / ${META.posts.length}개`;
    $('#post-rows').innerHTML = rows.map((p) => (
      `<tr data-slug="${esc(p.slug)}">`
      + `<td class="date">${esc(p.date.slice(0, 10))}</td>`
      + `<td class="title">${p.draft ? '<span class="badge">초안</span>' : ''}${p.pin ? '📌 ' : ''}${esc(p.title)}</td>`
      + `<td class="cat">${esc(p.category.replace(/\//g, ' › '))}</td>`
      + `<td>${p.tags.map((t) => `<span class="tagpill">#${esc(t)}</span>`).join('')}</td>`
      + `<td class="btns"><button class="btn small" type="button" data-act="edit">수정</button> <a class="btn small ghost" href="${esc(p.url)}" target="_blank" rel="noopener">보기</a></td>`
      + '</tr>'
    )).join('') || '<tr><td colspan="5" class="muted">글이 없습니다.</td></tr>';
  }
  $('#post-filter').addEventListener('input', renderPosts);
  $('#post-rows').addEventListener('click', (event) => {
    const button = event.target.closest('[data-act="edit"]');
    if (button) openEdit(button.closest('tr').dataset.slug);
  });

  let editing = null;
  const editTags = Chips($('#edit-tags'), () => META.tags);
  Suggest($('#edit-category'), () => META.categories, { onPick: (name) => { $('#edit-category').value = name; } });
  const editList = ItemList($('#edit-items'));

  async function openEdit(slug) {
    try {
      const post = await withBusy('글을 불러오는 중…', () => api('post?slug=' + encodeURIComponent(slug)));
      editing = post;
      $('#edit-heading').textContent = `글 수정 · ${post.slug}`;
      $('#edit-title').value = post.title;
      $('#edit-date').value = post.date;
      $('#edit-category').value = post.category;
      editTags.set(post.tags);
      $('#edit-description').value = post.description;
      $('#edit-draft').checked = post.draft;
      $('#edit-pin').checked = post.pin;
      $('#edit-body').value = post.body;
      $('#edit-view').href = post.url;
      $('#edit-files-count').textContent = `(${post.files.length}개)`;
      $('#edit-files').innerHTML = post.files.map((f) => `<li>${esc(f.name)} <span class="muted">${esc(f.size_text)}</span></li>`).join('');
      $('#edit-drop').hidden = post.single;
      editList.clear();
      openModal('#edit-modal');
    } catch (error) { fail(error); }
  }

  $('#edit-pick').addEventListener('click', async () => {
    try { editList.add((await api('pick', { mode: 'files' })).items); } catch (error) { fail(error); }
  });

  $('#edit-save').addEventListener('click', async () => {
    if (!editing) return;
    editTags.flush();
    const payload = {
      slug: editing.slug,
      title: $('#edit-title').value.trim(),
      date: $('#edit-date').value,
      category: $('#edit-category').value.trim(),
      tags: editTags.get(),
      description: $('#edit-description').value.trim(),
      draft: $('#edit-draft').checked,
      pin: $('#edit-pin').checked,
      body: $('#edit-body').value,
      items: editList.get().map((item) => ({ id: item.id, attach: item.attach })),
    };
    try {
      await withBusy('저장하는 중…', () => api('post/update', payload));
      closeModal($('#edit-modal'));
      toast('저장했습니다. [게시하기]를 누르면 블로그에 반영됩니다.');
      await refreshMeta();
    } catch (error) { fail(error); }
  });

  $('#edit-delete').addEventListener('click', async () => {
    if (!editing) return;
    if (!window.confirm(`'${editing.title}' 글과 첨부 파일을 지울까요?\n[게시하기]를 누르기 전까지는 블로그에 그대로 남아 있습니다.`)) return;
    try {
      await withBusy('지우는 중…', () => api('post/delete', { slug: editing.slug }));
      closeModal($('#edit-modal'));
      toast('지웠습니다. [게시하기]를 누르면 블로그에서도 사라집니다.');
      await refreshMeta();
    } catch (error) { fail(error); }
  });

  $('#edit-folder').addEventListener('click', () => { if (editing) api('open', { slug: editing.slug }).catch(fail); });

  const tagOptions = () => META.tags;
  const catOptions = () => META.categories;
  Suggest($('#rename-tag-from'), tagOptions, { allowNew: false, prefix: '#', onPick: (name) => { $('#rename-tag-from').value = name; } });
  Suggest($('#rename-tag-to'), tagOptions, { prefix: '#', onPick: (name) => { $('#rename-tag-to').value = name; } });
  Suggest($('#rename-cat-from'), catOptions, { allowNew: false, onPick: (name) => { $('#rename-cat-from').value = name; } });
  Suggest($('#rename-cat-to'), catOptions, { onPick: (name) => { $('#rename-cat-to').value = name; } });

  const rename = async (kind) => {
    const from = $(kind === 'tag' ? '#rename-tag-from' : '#rename-cat-from').value.trim();
    const to = $(kind === 'tag' ? '#rename-tag-to' : '#rename-cat-to').value.trim();
    if (!from || !to) { toast('바꿀 이름과 새 이름을 모두 적어 주세요.', 'error'); return; }
    try {
      const result = await withBusy('바꾸는 중…', () => api('rename', { kind, old: from, new: to }));
      toast(result.changed ? `글 ${result.changed}개를 바꿨습니다. [게시하기]를 누르면 반영됩니다.` : '바꿀 글이 없습니다.', result.changed ? undefined : 'error');
      $(kind === 'tag' ? '#rename-tag-from' : '#rename-cat-from').value = '';
      $(kind === 'tag' ? '#rename-tag-to' : '#rename-cat-to').value = '';
      await refreshMeta();
    } catch (error) { fail(error); }
  };
  $('#rename-tag').addEventListener('click', () => rename('tag'));
  $('#rename-cat').addEventListener('click', () => rename('category'));

  /* ---------------- publish ---------------- */

  function showLog(result) {
    const summary = $('#log-summary');
    summary.className = result.ok ? 'ok' : 'fail';
    const actions = repoUrl() ? ` · <a href="${esc(repoUrl())}/actions" target="_blank" rel="noopener">배포 진행 상황</a>` : '';
    summary.innerHTML = result.ok
      ? `게시했습니다. 1~2분 뒤 <a href="${esc(liveUrl('/'))}" target="_blank" rel="noopener">블로그</a>에 반영됩니다.${actions}`
      : '게시하지 못했습니다. 아래 기록을 확인하세요. GitHub 로그인 창이 떴다면 로그인한 뒤 다시 [게시하기]를 누르면 됩니다.';
    $('#log-text').textContent = result.log || '';
    $('#log-text').parentElement.open = !result.ok;
    openModal('#log-modal');
  }

  $('#publish-all').addEventListener('click', async () => {
    try {
      META.git = await api('git');
      updatePending();
      if (!META.git.changes && !META.git.ahead) { toast('게시할 변경이 없습니다.'); return; }
      const result = await withBusy('GitHub에 올리는 중…', () => api('publish', {}));
      showLog(result);
      await refreshMeta();
    } catch (error) { fail(error); }
  });

  /* ---------------- settings & quit ---------------- */

  const renderRoots = () => {
    const roots = (META.settings && META.settings.source_roots) || [];
    $('#roots').innerHTML = roots.map((r, i) => `<li><span title="${esc(r)}">${esc(r)}</span><button class="icon-btn" type="button" data-i="${i}" aria-label="빼기">✕</button></li>`).join('')
      || '<li class="muted"><span>아직 없습니다. 자료를 모아 두는 폴더(예: 구글 드라이브)를 추가하세요.</span></li>';
    $('#repo-info').textContent = META.git && META.git.remote ? `GitHub: ${repoUrl()}` : 'GitHub 저장소가 아직 연결되지 않았습니다.';
  };
  const saveRoots = async (roots) => {
    META.settings = await api('settings', { source_roots: roots });
    renderRoots();
  };
  $('#settings-btn').addEventListener('click', () => { renderRoots(); openModal('#settings-modal'); });
  $('#roots').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-i]');
    if (!button) return;
    const roots = [...(META.settings.source_roots || [])];
    roots.splice(Number(button.dataset.i), 1);
    saveRoots(roots).catch(fail);
  });
  $('#add-root').addEventListener('click', async () => {
    try {
      const chosen = await api('pick', { mode: 'folder' });
      if (chosen.paths.length) await saveRoots([...(META.settings.source_roots || []), chosen.paths[0]]);
    } catch (error) { fail(error); }
  });
  $('#open-repo').addEventListener('click', () => api('open', { target: 'repo' }).catch(fail));

  $('#quit-btn').addEventListener('click', async () => {
    if (!window.confirm('글쓰기 도구를 종료할까요? 저장하지 않은 입력은 사라집니다.')) return;
    try { await api('quit', {}); } catch (error) { /* already closing */ }
    document.body.innerHTML = '<div style="padding:80px 20px;text-align:center;font-size:17px">글쓰기 도구를 종료했습니다. 이 탭을 닫아도 됩니다.</div>';
  });

  window.addEventListener('beforeunload', (event) => {
    if (newList.get().length || $('#intro').value.trim()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  /* ---------------- files handed over (bat / 보내기) ---------------- */

  const pollInbox = async () => {
    try {
      const result = await api('inbox');
      if (result.items.length) {
        switchTab('new');
        newList.add(result.items);
        toast(`파일 ${result.items.length}개를 받았습니다.`);
      }
    } catch (error) { /* tool closed */ }
  };

  refreshMeta().catch(fail).finally(() => {
    pollInbox();
    setInterval(pollInbox, 2000);
  });
})();
