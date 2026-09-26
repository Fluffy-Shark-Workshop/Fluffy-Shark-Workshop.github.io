/* Sidebar search with tag autocomplete, table of contents, image zoom, mobile menu. */
(() => {
  'use strict';

  const base = (window.BLOG && window.BLOG.base) || '';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } },
  };

  /* ---------- mobile menu ---------- */
  const menuButton = $('#menu-btn');
  const scrim = $('#scrim');
  const setNav = (open) => {
    document.body.classList.toggle('nav-open', open);
    if (menuButton) menuButton.setAttribute('aria-expanded', String(open));
    if (scrim) scrim.hidden = !open;
  };
  if (menuButton) menuButton.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
  if (scrim) scrim.addEventListener('click', () => setNav(false));

  /* ---------- Hangul-aware matching (초성 검색) ---------- */
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
    const n = name.toLowerCase();
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

  /* ---------- search / tag autocomplete ---------- */
  const input = $('#search-input');
  const results = $('#search-results');
  if (input && results) {
    let data = null;
    let pending = null;
    let items = [];
    let active = -1;

    const load = () => {
      if (data) return Promise.resolve(data);
      if (!pending) {
        pending = fetch(base + '/search.json')
          .then((r) => r.json())
          .then((json) => (data = json))
          .catch(() => (data = { posts: [], tags: [], categories: [] }));
      }
      return pending;
    };

    const rank = (list, key, query, limit) =>
      list
        .map((entry) => [score(key(entry), query), entry])
        .filter(([s]) => s > 0)
        .sort((a, b) => b[0] - a[0] || (b[1].k || 0) - (a[1].k || 0))
        .slice(0, limit)
        .map(([, entry]) => entry);

    const find = (raw) => {
      const text = raw.trim();
      const tagOnly = text.startsWith('#');
      const query = text.replace(/^#+/, '').trim().toLowerCase();
      const groups = [];
      const tags = rank(data.tags, (t) => t.n, query, tagOnly ? 14 : 6);
      if (tags.length) groups.push({ title: '태그', items: tags.map((t) => ({ url: t.u, html: '#' + mark(t.n, query), sub: t.k + '개' })) });
      if (!tagOnly && query) {
        const cats = rank(data.categories, (c) => c.n, query, 4);
        if (cats.length) groups.push({ title: '카테고리', items: cats.map((c) => ({ url: c.u, html: mark(c.n.replace(/\//g, ' › '), query), sub: c.k + '개' })) });
        const posts = data.posts
          .map((p) => [Math.max(score(p.t, query), p.g.some((g) => score(g, query) >= 3) ? 1 : 0), p])
          .filter(([s]) => s > 0)
          .sort((a, b) => b[0] - a[0] || (a[1].d < b[1].d ? 1 : -1))
          .slice(0, 8)
          .map(([, p]) => p);
        if (posts.length) groups.push({ title: '글', items: posts.map((p) => ({ url: p.u, html: mark(p.t, query), sub: p.d })) });
      }
      return groups;
    };

    const show = (on) => {
      results.hidden = !on;
      input.setAttribute('aria-expanded', String(on));
    };

    const render = (groups) => {
      active = -1;
      if (!groups.length) {
        results.innerHTML = '<div class="sr-empty">검색 결과가 없습니다</div>';
        items = [];
        show(true);
        return;
      }
      results.innerHTML = groups
        .map((g) => `<div class="sr-group">${g.title}</div>` + g.items
          .map((it) => `<a class="sr-item" role="option" href="${esc(it.url)}"><span class="sr-main">${it.html}</span><span class="sr-sub">${esc(it.sub || '')}</span></a>`)
          .join(''))
        .join('');
      items = [...results.querySelectorAll('.sr-item')];
      show(true);
    };

    const update = async () => {
      await load();
      if (!input.value.trim()) { show(false); return; }
      render(find(input.value));
    };

    const move = (step) => {
      if (!items.length) return;
      active = (active + step + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('focus', () => { load(); if (input.value.trim()) update(); });
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;   // 한글 조합 중
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') {
        const target = items[active >= 0 ? active : 0];
        if (target) { event.preventDefault(); location.href = target.href; }
      } else if (event.key === 'Escape') { show(false); input.blur(); }
    });
    document.addEventListener('click', (event) => { if (!event.target.closest('#search')) show(false); });
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.activeElement.isContentEditable) return;
      event.preventDefault();
      if (window.matchMedia('(max-width: 960px)').matches) setNav(true);
      input.focus();
    });
  }

  /* ---------- table of contents ---------- */
  const body = $('#post-body');
  const tocButton = $('#toc-btn');
  const tocPanel = $('#toc-panel');
  const tocList = $('#toc-list');
  if (body && tocButton && tocPanel && tocList) {
    const heads = [...body.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')];
    if (heads.length >= 3) {
      tocButton.hidden = false;
      tocList.innerHTML = heads
        .map((h) => `<a class="lv${h.tagName[1]}" href="#${esc(encodeURIComponent(h.id))}" data-id="${esc(h.id)}">${esc(h.textContent.trim())}</a>`)
        .join('');
      const links = new Map([...tocList.querySelectorAll('a')].map((a) => [a.dataset.id, a]));
      const setOpen = (open) => {
        tocPanel.hidden = !open;
        tocButton.setAttribute('aria-expanded', String(open));
        store.set('toc-open', open ? '1' : '0');
      };
      tocButton.addEventListener('click', () => setOpen(tocPanel.hidden));
      $('#toc-close').addEventListener('click', () => setOpen(false));
      tocList.addEventListener('click', () => { if (window.innerWidth < 960) setOpen(false); });
      if (store.get('toc-open') === '1' && window.innerWidth >= 1200) setOpen(true);
      const spy = new IntersectionObserver((entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (!visible.length) return;
        links.forEach((a) => a.classList.remove('active'));
        const current = links.get(visible[0].target.id);
        if (current) {
          current.classList.add('active');
          if (!tocPanel.hidden) current.scrollIntoView({ block: 'nearest' });
        }
      }, { rootMargin: '-8% 0px -80% 0px' });
      heads.forEach((h) => spy.observe(h));
    }
  }

  /* ---------- image zoom ---------- */
  const openLightbox = (img) => {
    const box = document.createElement('div');
    box.className = 'lightbox';
    const big = new Image();
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || '';
    const tall = img.naturalWidth && img.naturalHeight / img.naturalWidth > (window.innerHeight / window.innerWidth) * 1.4;
    if (tall) box.classList.add('fit-width');
    const close = document.createElement('button');
    close.className = 'lightbox-close';
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    close.textContent = '✕';
    const hint = document.createElement('div');
    hint.className = 'lightbox-hint';
    hint.textContent = '이미지 클릭: 원본 크기 · 바깥 클릭 또는 Esc: 닫기';
    box.append(big, close, hint);
    const shut = () => {
      box.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => { if (event.key === 'Escape') shut(); };
    big.addEventListener('click', (event) => { event.stopPropagation(); box.classList.toggle('natural'); });
    box.addEventListener('click', shut);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    document.body.appendChild(box);
  };
  document.addEventListener('click', (event) => {
    const img = event.target.closest && event.target.closest('.post-body img');
    if (!img || img.closest('a') || event.button !== 0) return;
    openLightbox(img);
  });

  /* ---------- back to top ---------- */
  const topButton = $('#to-top');
  if (topButton) {
    const onScroll = () => topButton.classList.toggle('on', window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    topButton.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    onScroll();
  }
})();
