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

  // images and handwritten-note PDFs stack into one continuous sheet
  const stacks = (item) => Boolean(item) && (item.kind === 'image' || (item.kind === 'pdf' && item.joined));

  function ItemList(el, onChange) {
    let items = [];
    const render = () => {
      el.innerHTML = '';
      items.forEach((item, index) => {
        if (index > 0 && stacks(item) && stacks(items[index - 1])) {
          const joint = document.createElement('li');
          joint.className = 'joint';
          joint.innerHTML = `<button type="button" class="joint-btn${item.attach ? ' on' : ''}">${item.attach ? '🔗 위와 틈 없이 붙여서 표시' : '↕ 위와 간격을 두고 표시'}</button>`;
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
        const pdfOption = item.kind === 'pdf'
          ? `<label class="opt"><input type="checkbox" data-opt="join"${item.joined ? ' checked' : ''}> 필기처럼 쪽을 틈 없이 이어 붙이기`
            + (item.split_note ? ' <span class="hint">삼성 노트 PDF라 자동으로 켰습니다</span>' : ' <span class="hint">끄면 문서처럼 쪽을 나눠 보여 줍니다</span>')
            + '</label>'
          : '';
        li.innerHTML = `<span class="kind ${esc(item.kind)}">${thumb}</span>`
          + '<div class="item-main">'
          + `<div class="item-name" title="${esc(item.name)}">${esc(item.name)}</div>`
          + `<div class="item-sub" title="${esc(sub.join(' · '))}">${esc(sub.join(' · '))}</div>`
          + pdfOption
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
        li.addEventListener('change', (event) => {
          if (!event.target.matches('[data-opt="join"]')) return;
          item.joined = event.target.checked;
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
    $('#tab-categories').hidden = name !== 'categories';
  };
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  let nameResolve = null;
  const finishName = (value) => {
    const resolve = nameResolve;
    nameResolve = null;
    $('#name-modal').hidden = true;
    if (resolve) resolve(value);
  };
  const openModal = (selector) => { $(selector).hidden = false; };
  const closeModal = (modal) => {
    if (modal.id === 'name-modal') { finishName(null); return; }
    if (modal.id === 'edit-modal' && isEditDirty() && !window.confirm('저장하지 않은 수정 내용을 버릴까요?')) return;
    modal.hidden = true;
  };
  function askName({ title, hint = '', value = '', selectEnd }) {
    const input = $('#name-input');
    $('#name-heading').textContent = title;
    $('#name-hint').textContent = hint;
    input.value = value;
    openModal('#name-modal');
    setTimeout(() => { input.focus(); input.setSelectionRange(0, selectEnd ?? value.length); }, 30);
    return new Promise((resolve) => { nameResolve = resolve; });
  }
  $('#name-ok').addEventListener('click', () => finishName($('#name-input').value.trim()));
  $('#name-input').addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
    event.preventDefault();
    finishName($('#name-input').value.trim());
  });
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
    if (!catDirty) loadCats();
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
      items: newList.get().map((item) => ({ id: item.id, attach: item.attach, joined: item.joined })),
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
  let fileState = [];
  let editOrder = [];
  let editSnapshot = '';
  let replaceTarget = null;
  const editTags = Chips($('#edit-tags'), () => META.tags);
  Suggest($('#edit-category'), () => META.categories, { onPick: (name) => { $('#edit-category').value = name; } });
  const editList = ItemList($('#edit-items'));

  const baseName = (name) => name.split('/').pop();
  const extOf = (name) => { const at = name.lastIndexOf('.'); return at > 0 ? name.slice(at).toLowerCase() : ''; };
  const fileUrl = (file) => editing.url + file.name.split('/').map(encodeURIComponent).join('/');
  const blockers = (file) => file.used_by.filter((user) => !fileState.some((f) => f.name === user && f.removed));

  function fileOps() {
    const live = fileState.filter((f) => !f.removed);
    const order = live.filter((f) => f.embedded).map((f) => f.name);
    const before = editOrder.filter((name) => order.includes(name));
    const after = order.filter((name) => editOrder.includes(name));
    return {
      remove: fileState.filter((f) => f.removed).map((f) => f.name),
      rename: live.filter((f) => f.renameTo).map((f) => ({ from: f.name, to: f.renameTo })),
      replace: live.filter((f) => f.replaceItem).map((f) => ({ name: f.name, id: f.replaceItem.id })),
      order: before.join('\n') === after.join('\n') ? [] : after,
      pdf: Object.fromEntries(live.filter((f) => f.kind === 'pdf' && f.embedded && f.joinedNow !== f.joined).map((f) => [f.name, f.joinedNow])),
    };
  }

  function editPayload() {
    return {
      slug: editing.slug,
      new_slug: $('#edit-slug').value.trim(),
      title: $('#edit-title').value.trim(),
      date: $('#edit-date').value,
      category: $('#edit-category').value.trim(),
      tags: editTags.get(),
      description: $('#edit-description').value.trim(),
      draft: $('#edit-draft').checked,
      pin: $('#edit-pin').checked,
      body: $('#edit-body').value,
      items: editList.get().map((item) => ({ id: item.id, attach: item.attach, joined: item.joined })),
      files: fileOps(),
    };
  }

  function isEditDirty() {
    return Boolean(editing) && !$('#edit-modal').hidden && JSON.stringify(editPayload()) !== editSnapshot;
  }

  function renderFiles() {
    const live = fileState.filter((f) => !f.removed);
    const pool = live.filter((f) => f.embedded);
    $('#edit-files-count').textContent = `(${live.length}개)`;
    $('#edit-files').innerHTML = fileState.map((file, index) => {
      const kind = file.replaceItem ? file.replaceItem.kind : file.kind;
      const src = file.replaceItem
        ? `/__api/thumb?id=${encodeURIComponent(file.replaceItem.id)}&t=${encodeURIComponent(TOKEN)}`
        : fileUrl(file);
      const thumb = kind === 'image' ? `<img src="${esc(src)}" alt="" loading="lazy">` : esc(KIND_LABEL[kind] || 'FILE');
      const shown = file.renameTo ? `${baseName(file.name)} → ${file.renameTo}` : file.name;
      const states = [];
      if (file.removed) states.push('<span class="attach-state pending">삭제 예정</span>');
      if (file.renameTo) states.push('<span class="attach-state pending">이름 변경 예정</span>');
      if (file.replaceItem) states.push(`<span class="attach-state pending">교체 예정: ${esc(file.replaceItem.name)}</span>`);
      if (!file.removed) states.push(`<span class="attach-state">${file.embedded ? '본문에 표시' : file.used_by.length ? '문서가 참조' : '본문에 없음'}</span>`);
      const blocked = blockers(file);
      const lockNote = blocked.length ? `${blocked[0]} 문서가 참조 중이라 바꿀 수 없습니다` : '';
      const lock = blocked.length ? ` disabled title="${esc(lockNote)}"` : '';
      const at = pool.indexOf(file);
      const buttons = file.removed
        ? '<button class="icon-btn" type="button" data-file="restore" title="되살리기" aria-label="되살리기">↺</button>'
        : (file.embedded
          ? `<button class="icon-btn" type="button" data-file="up" title="본문에서 위로" aria-label="본문에서 위로"${at <= 0 ? ' disabled' : ''}>↑</button>`
            + `<button class="icon-btn" type="button" data-file="down" title="본문에서 아래로" aria-label="본문에서 아래로"${at >= pool.length - 1 ? ' disabled' : ''}>↓</button>`
          : '<button class="icon-btn" type="button" data-file="insert" title="본문 끝에 넣기" aria-label="본문 끝에 넣기">＋</button>')
          + `<button class="icon-btn" type="button" data-file="rename" aria-label="이름 바꾸기"${lock || ' title="이름 바꾸기"'}>✎</button>`
          + '<button class="icon-btn" type="button" data-file="replace" title="다른 파일로 교체" aria-label="다른 파일로 교체">⇄</button>'
          + `<button class="icon-btn" type="button" data-file="remove" aria-label="삭제"${lock || ' title="삭제"'}>✕</button>`;
      const pdf = kind === 'pdf' && file.embedded && !file.removed
        ? `<label class="opt"><input type="checkbox" data-file-opt="join"${file.joinedNow ? ' checked' : ''}> 필기처럼 쪽을 틈 없이 이어 붙이기</label>`
        : '';
      return `<li class="item${file.removed ? ' removed' : ''}" data-index="${index}">`
        + `<span class="kind ${esc(kind)}">${thumb}</span>`
        + '<div class="item-main">'
        + `<div class="item-name" title="${esc(shown)}">${esc(shown)}</div>`
        + `<div class="item-sub">${states.join('')}${esc(file.size_text)}</div>`
        + pdf
        + '</div>'
        + `<div class="item-btns">${buttons}</div>`
        + '</li>';
    }).join('') || '<li class="muted small">첨부 파일이 없습니다.</li>';
  }

  $('#edit-files').addEventListener('change', (event) => {
    if (!event.target.matches('[data-file-opt="join"]')) return;
    fileState[Number(event.target.closest('.item').dataset.index)].joinedNow = event.target.checked;
  });

  $('#edit-files').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-file]');
    if (!button || button.disabled) return;
    const file = fileState[Number(button.closest('.item').dataset.index)];
    const action = button.dataset.file;
    if (action === 'up' || action === 'down') {
      const pool = fileState.filter((f) => f.embedded && !f.removed);
      const other = pool[pool.indexOf(file) + (action === 'up' ? -1 : 1)];
      if (other) {
        const i = fileState.indexOf(file);
        const j = fileState.indexOf(other);
        [fileState[i], fileState[j]] = [fileState[j], fileState[i]];
      }
    } else if (action === 'insert') {
      const attrs = file.kind === 'pdf' ? (file.joinedNow ? '{.joined}' : '{.pages}') : '';
      const body = $('#edit-body');
      body.value = `${body.value.replace(/\s+$/, '')}${body.value.trim() ? '\n\n' : ''}![](<${file.name}>)${attrs}\n`;
      file.embedded = true;
      file.joined = file.joinedNow;
      editOrder.push(file.name);
      const lastEmbedded = fileState.reduce((last, f, i) => (f.embedded && f !== file ? i : last), -1);
      fileState.splice(fileState.indexOf(file), 1);
      fileState.splice(lastEmbedded + 1, 0, file);
    } else if (action === 'rename') {
      const current = file.renameTo || baseName(file.name);
      const dot = current.lastIndexOf('.');
      const next = await askName({
        title: '첨부 파일 이름 바꾸기',
        hint: '본문의 링크도 함께 바뀝니다. 확장자는 그대로 두세요.',
        value: current,
        selectEnd: dot > 0 ? dot : current.length,
      });
      if (next === null || !next) return;
      if (extOf(next) !== extOf(file.name)) { toast('확장자는 바꿀 수 없습니다. 다른 형식은 교체 버튼을 쓰세요.', 'error'); return; }
      file.renameTo = next === baseName(file.name) ? '' : next;
    } else if (action === 'replace') {
      replaceTarget = file;
      $('#edit-replace-input').value = '';
      $('#edit-replace-input').click();
      return;
    } else if (action === 'remove') {
      file.removed = true;
    } else if (action === 'restore') {
      file.removed = false;
    }
    renderFiles();
  });

  $('#edit-replace-input').addEventListener('change', async (event) => {
    const chosen = event.target.files[0];
    if (!chosen || !replaceTarget) return;
    try {
      replaceTarget.replaceItem = await withBusy('파일을 가져오는 중…', () => upload(chosen));
      renderFiles();
    } catch (error) { fail(error); }
  });

  async function openEdit(slug) {
    try {
      const post = await withBusy('글을 불러오는 중…', () => api('post?slug=' + encodeURIComponent(slug)));
      editing = post;
      $('#edit-heading').textContent = '글 수정';
      $('#edit-title').value = post.title;
      $('#edit-slug').value = post.slug;
      $('#edit-date').value = post.date;
      $('#edit-category').value = post.category;
      editTags.set(post.tags);
      $('#edit-description').value = post.description;
      $('#edit-draft').checked = post.draft;
      $('#edit-pin').checked = post.pin;
      $('#edit-body').value = post.body;
      $('#edit-view').href = post.url;
      fileState = post.files.map((f) => ({ ...f, joinedNow: f.joined, removed: false, renameTo: '', replaceItem: null }));
      editOrder = fileState.filter((f) => f.embedded).map((f) => f.name);
      $('#edit-files-field').hidden = post.single;
      $('#edit-drop').hidden = post.single;
      editList.clear();
      renderFiles();
      editSnapshot = JSON.stringify(editPayload());
      openModal('#edit-modal');
    } catch (error) { fail(error); }
  }

  $('#edit-pick').addEventListener('click', async () => {
    try { editList.add((await api('pick', { mode: 'files' })).items); } catch (error) { fail(error); }
  });

  async function saveEdit(publishNow) {
    if (!editing) return;
    editTags.flush();
    const payload = editPayload();
    if (!payload.title) { toast('제목을 적어 주세요.', 'error'); $('#edit-title').focus(); return; }
    try {
      const saved = await withBusy(publishNow ? 'GitHub에 올리는 중…' : '저장하는 중…', async () => {
        const result = await api('post/update', payload);
        if (publishNow) {
          try {
            result.publish = await api('publish', { message: `글 수정: ${payload.title}` });
          } catch (error) {
            result.publish = { ok: false, log: error.message };
          }
        }
        return result;
      });
      editing = null;
      closeModal($('#edit-modal'));
      if (saved.publish) showLog(saved.publish);
      if (saved.warnings && saved.warnings.length) toast(`저장했지만 확인이 필요합니다: ${saved.warnings.join(' / ')}`, 'error');
      else if (!saved.publish) toast('저장했습니다. [게시하기]를 누르면 블로그에 반영됩니다.');
      await refreshMeta();
    } catch (error) { fail(error); }
  }
  $('#edit-save').addEventListener('click', () => saveEdit(false));
  $('#edit-save-publish').addEventListener('click', () => saveEdit(true));

  $('#edit-delete').addEventListener('click', async () => {
    if (!editing) return;
    if (!window.confirm(`'${editing.title}' 글과 첨부 파일을 지울까요?\n[게시하기]를 누르기 전까지는 블로그에 그대로 남아 있습니다.`)) return;
    try {
      await withBusy('지우는 중…', () => api('post/delete', { slug: editing.slug }));
      editing = null;
      closeModal($('#edit-modal'));
      toast('지웠습니다. [게시하기]를 누르면 블로그에서도 사라집니다.');
      await refreshMeta();
    } catch (error) { fail(error); }
  });

  $('#edit-folder').addEventListener('click', () => { if (editing) api('open', { slug: editing.slug }).catch(fail); });

  const tagOptions = () => META.tags;
  Suggest($('#rename-tag-from'), tagOptions, { allowNew: false, prefix: '#', onPick: (name) => { $('#rename-tag-from').value = name; } });
  Suggest($('#rename-tag-to'), tagOptions, { prefix: '#', onPick: (name) => { $('#rename-tag-to').value = name; } });

  $('#rename-tag').addEventListener('click', async () => {
    const from = $('#rename-tag-from').value.trim();
    const to = $('#rename-tag-to').value.trim();
    if (!from || !to) { toast('바꿀 이름과 새 이름을 모두 적어 주세요.', 'error'); return; }
    try {
      const result = await withBusy('바꾸는 중…', () => api('rename', { kind: 'tag', old: from, new: to }));
      toast(result.changed ? `글 ${result.changed}개를 바꿨습니다. [게시하기]를 누르면 반영됩니다.` : '바꿀 글이 없습니다.', result.changed ? undefined : 'error');
      $('#rename-tag-from').value = '';
      $('#rename-tag-to').value = '';
      await refreshMeta();
    } catch (error) { fail(error); }
  });

  /* ---------------- categories ---------------- */

  let catDirty = false;
  let catTree = [];
  let catDragPath = '';
  const catRoot = $('#cat-tree');

  const flatCats = (list = catTree) => list.flatMap((node) => [node.path, ...flatCats(node.children)]);
  const findCat = (path, list = catTree) => {
    for (const node of list) {
      if (node.path === path) return { node, siblings: list };
      const inner = findCat(path, node.children);
      if (inner) return inner;
    }
    return null;
  };
  const setCatDirty = (on) => {
    catDirty = on;
    $('#cats-save').disabled = !on;
    $('#cats-reset').disabled = !on;
  };

  const catRows = (list) => list.map((node, index) => {
    const name = esc(node.name);
    return `<li><div class="cat-row" draggable="true" data-path="${esc(node.path)}">`
      + '<span class="cat-grip" aria-hidden="true">⠿</span>'
      + `<span class="cat-label" title="${esc(node.path)}">${name}</span>`
      + `<span class="cat-count">글 ${node.count}개</span>`
      + '<span class="cat-btns">'
      + `<button class="icon-btn" type="button" data-cat="up" title="위로" aria-label="${name} 위로"${index === 0 ? ' disabled' : ''}>↑</button>`
      + `<button class="icon-btn" type="button" data-cat="down" title="아래로" aria-label="${name} 아래로"${index === list.length - 1 ? ' disabled' : ''}>↓</button>`
      + `<button class="icon-btn" type="button" data-cat="child" title="하위 카테고리 추가" aria-label="${name}에 하위 카테고리 추가">＋</button>`
      + `<button class="icon-btn" type="button" data-cat="rename" title="이름 바꾸기" aria-label="${name} 이름 바꾸기">✎</button>`
      + `<button class="icon-btn" type="button" data-cat="delete" title="${node.count ? '글이 있어 지울 수 없습니다' : '삭제'}" aria-label="${name} 삭제"${node.count ? ' disabled' : ''}>✕</button>`
      + '</span></div>'
      + (node.children.length ? `<ul>${catRows(node.children)}</ul>` : '')
      + '</li>';
  }).join('');
  const renderCats = () => {
    catRoot.innerHTML = catRows(catTree) || '<li class="muted small">카테고리가 없습니다.</li>';
  };

  function loadCats() {
    const nodes = new Map();
    catTree = [];
    for (const category of META.categories) {
      const parts = category.name.split('/');
      const node = { path: category.name, name: parts[parts.length - 1], count: category.count, children: [] };
      nodes.set(category.name, node);
      const parent = nodes.get(parts.slice(0, -1).join('/'));
      (parent ? parent.children : catTree).push(node);
    }
    setCatDirty(false);
    renderCats();
  }

  async function addCat(parent) {
    const name = await askName({
      title: parent ? `${parent.name}에 하위 카테고리 추가` : '카테고리 추가',
      hint: '이름만 적으세요. 비어 있어도 사이드바에 보입니다.',
    });
    if (!name) return;
    if (name.includes('/')) { toast('이름에는 / 를 쓸 수 없습니다.', 'error'); return; }
    const siblings = parent ? parent.children : catTree;
    if (siblings.some((node) => node.name.toLowerCase() === name.toLowerCase())) { toast('같은 이름의 카테고리가 이미 있습니다.', 'error'); return; }
    siblings.push({ path: parent ? `${parent.path}/${name}` : name, name, count: 0, children: [] });
    setCatDirty(true);
    renderCats();
  }

  async function renameCat(node) {
    const next = await askName({
      title: '카테고리 이름 바꾸기',
      hint: '/ 로 위치도 옮길 수 있습니다. 이미 있는 이름으로 바꾸면 둘이 합쳐집니다.',
      value: node.path,
    });
    if (!next || next === node.path) return;
    try {
      await withBusy('바꾸는 중…', async () => {
        if (catDirty) await api('categories', { order: flatCats() });
        await api('rename', { kind: 'category', old: node.path, new: next });
      });
      setCatDirty(false);
      await refreshMeta();
      toast('이름을 바꿨습니다. [게시하기]를 누르면 반영됩니다.');
    } catch (error) { fail(error); }
  }

  catRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cat]');
    if (!button || button.disabled) return;
    const { node, siblings } = findCat(button.closest('.cat-row').dataset.path);
    const action = button.dataset.cat;
    if (action === 'child') { addCat(node); return; }
    if (action === 'rename') { renameCat(node); return; }
    const at = siblings.indexOf(node);
    if (action === 'up' && at > 0) [siblings[at - 1], siblings[at]] = [siblings[at], siblings[at - 1]];
    if (action === 'down' && at < siblings.length - 1) [siblings[at + 1], siblings[at]] = [siblings[at], siblings[at + 1]];
    if (action === 'delete') siblings.splice(at, 1);
    setCatDirty(true);
    renderCats();
  });

  const clearCatDrop = () => $$('.drop-before, .drop-after', catRoot).forEach((row) => row.classList.remove('drop-before', 'drop-after'));
  catRoot.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.cat-row');
    if (!row) return;
    catDragPath = row.dataset.path;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', catDragPath);
    row.classList.add('dragging');
  });
  catRoot.addEventListener('dragover', (event) => {
    const row = event.target.closest('.cat-row');
    clearCatDrop();
    if (!row || !catDragPath || row.dataset.path === catDragPath) return;
    if (findCat(catDragPath).siblings !== findCat(row.dataset.path).siblings) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = row.getBoundingClientRect();
    row.classList.add(event.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
  });
  catRoot.addEventListener('drop', (event) => {
    const row = event.target.closest('.cat-row');
    if (!row || !catDragPath) return;
    event.preventDefault();
    const after = row.classList.contains('drop-after');
    const valid = after || row.classList.contains('drop-before');
    clearCatDrop();
    if (!valid) return;
    const { node, siblings } = findCat(catDragPath);
    siblings.splice(siblings.indexOf(node), 1);
    const at = siblings.indexOf(findCat(row.dataset.path).node);
    siblings.splice(after ? at + 1 : at, 0, node);
    catDragPath = '';
    setCatDirty(true);
    renderCats();
  });
  catRoot.addEventListener('dragend', () => {
    catDragPath = '';
    clearCatDrop();
    $$('.dragging', catRoot).forEach((row) => row.classList.remove('dragging'));
  });

  $('#cats-add').addEventListener('click', () => addCat(null));
  $('#cats-reset').addEventListener('click', loadCats);
  $('#cats-save').addEventListener('click', async () => {
    try {
      await withBusy('저장하는 중…', () => api('categories', { order: flatCats() }));
      setCatDirty(false);
      await refreshMeta();
      toast('순서를 저장했습니다. [게시하기]를 누르면 블로그에 반영됩니다.');
    } catch (error) { fail(error); }
  });

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
    if (newList.get().length || $('#intro').value.trim() || catDirty || isEditDirty()) {
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
