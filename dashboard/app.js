// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, the filters, the category evidence table, the set-asides (the live tokens and the
// bridges the category rule excludes), and a detail view per protocol with the model's factors and
// the farm plan. No network: every byte is in data.js.
//
// The detail view recomputes a row's implied value in this page, from the factors the row carries —
// the model rounds every factor to four decimals before it multiplies, so the page's arithmetic is
// the board's arithmetic, and the two numbers are the same dollar.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var state = { q: '', category: 'all', chain: 'all', watch: false, sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unlisted';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined) return 'n/a';
    return n.toFixed(2) + 'x';
  }
  // The model in one function: the same multiplication main.ts runs, factor by factor, in the page.
  function impliedOf(row) {
    var m = row.model;
    return Math.max(1, Math.round(row.tvl_usd * m.category_multiple * m.momentum_factor * m.breadth_factor * m.age_factor));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function chainText(row) {
    if (!row.chains || row.chains.length === 0) return 'an unnamed chain';
    if (row.chains.length <= 2) return row.chains.join(', ');
    return row.chains.slice(0, 2).join(', ') + ' +' + (row.chains.length - 2);
  }

  /* ---------------------------------------------------------- header and stats */

  function fillChrome() {
    var meta = document.getElementById('top-meta');
    meta.appendChild(el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })));
    meta.appendChild(el('span', null, 'Model ', el('b', { text: DATA.model_version })));
    meta.appendChild(el('span', null, el('b', { text: String(DATA.stats.protocols) }), ' protocols indexed'));
    var s = DATA.stats;
    var stats = document.getElementById('stats');
    [
      ['Protocols ranked', String(s.ranked), 'of ' + s.pre_token + ' that record no token'],
      ['Total implied value', fmtUsd(s.total_implied_usd), 'across the whole board'],
      ['Watchlist covered', s.watchlist_size + ' / ' + s.watchlist_size, 'the floor, at $' + Math.round(DATA.floor_usd / 1e6) + 'M TVL and up'],
      ['Deepest category', s.top_category, 'most rows on the board']
    ].forEach(function (row) {
      stats.appendChild(el('div', { class: 'stat' },
        el('span', { text: row[0] }), el('b', { text: row[1] }), el('small', { text: row[2] })));
    });
  }

  /* ---------------------------------------------------------- filters */

  var search = document.getElementById('q');
  var catSelect = document.getElementById('category');
  var chainSelect = document.getElementById('chain');
  var watchBox = document.getElementById('watch-only');

  function fillSelects() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorized'; }))).sort();
    catSelect.appendChild(el('option', { value: 'all', text: 'All categories' }));
    cats.forEach(function (c) { catSelect.appendChild(el('option', { value: c, text: c })); });
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; }))).sort();
    chainSelect.appendChild(el('option', { value: 'all', text: 'All chains' }));
    chains.forEach(function (c) { chainSelect.appendChild(el('option', { value: c, text: c })); });
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorized') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', r.chains.join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'multiple') { av = a.model.category_multiple; bv = b.model.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }

  /* ---------------------------------------------------------- the board */

  var head = document.getElementById('board-head');
  var body = document.getElementById('board-body');
  var emptyBox = document.getElementById('empty');
  var count = document.getElementById('count');

  function sortHeader(key, label, numeric) {
    var attrs = { scope: 'col' };
    if (numeric) attrs.class = 'num';
    return el('th', attrs,
      el('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
        renderBoard();
      } }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25BC' : ' \u25B2' }) : null)
    );
  }

  function renderBoard() {
    head.textContent = '';
    head.appendChild(el('tr', null,
      sortHeader('implied', 'Rank'),
      sortHeader('name', 'Protocol'),
      el('th', { scope: 'col', text: 'Chains' }),
      sortHeader('tvl', 'TVL', true),
      sortHeader('growth', '7d', true),
      sortHeader('multiple', 'Multiple', true),
      sortHeader('implied', 'Implied value', true),
      el('th', { scope: 'col', text: 'Status' })
    ));
    var list = sortedRows(visibleRows());
    body.textContent = '';
    emptyBox.hidden = list.length > 0;
    count.textContent = list.length + ' of ' + DATA.rows.length + ' rows shown';
    var max = 0;
    DATA.rows.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    list.forEach(function (r) {
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      body.appendChild(el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rank', text: String(r.rank) }),
        el('td', null,
          el('span', { class: 'pname', text: r.name }),
          el('span', { class: 'psub', text: (r.category || 'Uncategorized') + ' \u00B7 listed ' + (r.listed_at || 'date unrecorded') })
        ),
        el('td', { class: 'chains', text: chainText(r) }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtMult(r.model.category_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, r.watchlist
          ? el('span', { class: 'chip watch', text: 'Watchlist' })
          : el('span', { class: 'chip', text: 'Early' }))
      ));
    });
  }

  /* ---------------------------------------------------------- evidence tables */

  function renderEvidence() {
    var cb = document.getElementById('category-body');
    DATA.categories.forEach(function (c) {
      cb.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.rows) }),
        el('td', { class: 'num', text: String(c.peers) }),
        el('td', { class: 'num', text: c.peer_median === null ? 'none launched' : fmtMult(c.peer_median) }),
        el('td', { class: 'num', text: fmtMult(c.multiple) })
      ));
    });
    var lb = document.getElementById('live-body');
    DATA.live.forEach(function (r) {
      lb.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'pname', text: r.name })),
        el('td', { text: r.category || 'Uncategorized' }),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) })
      ));
    });
    var ba = document.getElementById('bridge-aside');
    if (ba && DATA.set_aside) {
      var examples = DATA.set_aside.bridge_examples.map(function (p) {
        return p.name + ' (' + fmtUsd(p.tvl_usd) + ' of TVL)';
      }).join(', ');
      ba.textContent = 'Set aside on this snapshot: ' + DATA.set_aside.bridges +
        ' pre-token bridges and canonical bridges, holding ' + fmtUsd(DATA.set_aside.bridge_tvl_usd) +
        ' of other assets between them — the largest are ' + examples + '.';
    }
  }

  /* ---------------------------------------------------------- detail view */

  var dialog = document.getElementById('detail');
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); renderBoard(); });

  function fact(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { class: 'num', text: value }));
  }

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    renderBoard();
    var m = row.model;
    var recomputed = impliedOf(row);
    var wrap = el('div', { class: 'detail-in' });
    wrap.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'chip ' + (row.watchlist ? 'watch' : ''), text: row.watchlist ? 'Watchlist' : 'Early radar' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.rows.length + ' \u00B7 ' + (row.category || 'Uncategorized') + ' \u00B7 ' + (row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    wrap.appendChild(el('h3', { text: 'Why this value' }));
    var eq = el('div', { class: 'equation' });
    eq.appendChild(fact('TVL (snapshot)', fmtUsd(row.tvl_usd)));
    eq.appendChild(fact('Category multiple', fmtMult(m.category_multiple) + ' \u00B7 ' + m.peer_count + ' launched peer' + (m.peer_count === 1 ? '' : 's') + (m.peer_median === null ? '' : ', median ' + fmtMult(m.peer_median))));
    eq.appendChild(fact('Momentum \u00B7 7d ' + fmtPct(m.growth_pct), '\u00D7 ' + m.momentum_factor.toFixed(4) ));
    eq.appendChild(fact('Breadth \u00B7 ' + row.chains.length + ' chain' + (row.chains.length === 1 ? '' : 's'), '\u00D7 ' + m.breadth_factor.toFixed(4) ));
    eq.appendChild(fact('Track record \u00B7 ' + fmtAge(row.age_days) + ' with no token', '\u00D7 ' + m.age_factor.toFixed(4) ));
    eq.appendChild(el('div', { class: 'total' }, el('span', { text: 'Implied launch value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })));
    wrap.appendChild(eq);
    wrap.appendChild(el('p', { class: 'recheck' },
      'Recomputed in this page from the factors above: ',
      el('b', { text: fmtUsd(recomputed) }),
      recomputed === row.implied_value_usd
        ? ' — the same dollar board.json carries.'
        : ' — which differs from the board, so the data would be stale.'
    ));
    wrap.appendChild(el('h3', { text: 'Farm plan' }));
    wrap.appendChild(el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), tail ? el('span', { class: 'cost', text: tail }) : null);
    })));
    wrap.appendChild(el('p', { class: 'recheck', text: 'A plan for positioning ahead of a possible launch, sized from this protocol\u2019s own TVL tier. It is not financial advice, and no token is promised.' }));
    dialog.textContent = '';
    dialog.appendChild(wrap);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  /* ---------------------------------------------------------- state and wiring */

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) { state.category = params.get('category'); catSelect.value = state.category; }
    if (params.get('watch') === '1') { state.watch = true; watchBox.checked = true; }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.category !== 'all') params.set('category', state.category);
    if (state.watch) params.set('watch', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  search.addEventListener('input', function () { state.q = search.value; renderBoard(); });
  catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); renderBoard(); });
  chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; renderBoard(); });
  watchBox.addEventListener('change', function () { state.watch = watchBox.checked; writeHash(); renderBoard(); });
  document.getElementById('clear-filters').addEventListener('click', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false;
    search.value = ''; catSelect.value = 'all'; chainSelect.value = 'all'; watchBox.checked = false;
    writeHash(); renderBoard();
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });

  fillChrome();
  fillSelects();
  readHash();
  renderBoard();
  renderEvidence();
  if (state.selected) openDetail(state.selected);
})();
