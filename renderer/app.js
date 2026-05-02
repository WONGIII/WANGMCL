// ================================================
// MC Launcher – Apple Frameless
// ================================================
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let state = { accounts: [], settings: {}, versions: [], localVersions: [], selectedVer: '', activeAcc: null };

// ================================================
// Window controls
// ================================================
$('#btnMin').addEventListener('click', () => api.send('win:minimize'));
$('#btnMax').addEventListener('click', () => api.send('win:maximize'));
$('#btnClose').addEventListener('click', () => api.send('win:close'));

// ================================================
// Tab switching
// ================================================
$$('.sb-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.sb-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $('#panel-' + tab).classList.add('active');
  });
});

// ================================================
// Init
// ================================================
async function init() {
  const data = await api.getData();
  state.settings = data.settings;
  state.accounts = data.accounts;
  state.activeAcc = data.accounts[0] || null;
  updateAccountUI();
  updateSettingsUI();
  await refreshVersions();
  // Load local versions from game dir
  state.localVersions = await api.scanGameDir();
  updateHomeUI();
}

// ================================================
// HOME TAB
// ================================================
function updateHomeUI() {
  const tag = $('#homeTagline');
  if (state.activeAcc && state.selectedVer) {
    tag.textContent = `以 ${state.activeAcc.name} 的身份启动 Minecraft ${state.selectedVer}`;
  } else if (!state.activeAcc) {
    tag.textContent = '请先在账号页面登录';
  } else {
    tag.textContent = '选择一个版本，即刻启程';
  }
  $('#btnLaunch').disabled = !state.activeAcc || !state.selectedVer;
  $('#pickerVerText').textContent = state.selectedVer || '选择版本';
  $('#footerVer').textContent = state.selectedVer || '—';
  $('#footerMem').textContent = (state.settings.memory || 2048) + ' MB';
}

// Version picker dropdown
$('#pickerVersion').addEventListener('click', () => {
  const dd = $('#pickerDropdown');
  if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
  const releases = state.versions.filter(v => v.type === 'release');
  dd.innerHTML = releases.map(v =>
    `<div class="picker-option${v.id === state.selectedVer ? ' selected' : ''}" data-id="${v.id}">${v.id}</div>`
  ).join('');
  dd.classList.add('open');
  if (state.selectedVer) {
    const sel = dd.querySelector('.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
});

$('#pickerDropdown').addEventListener('click', e => {
  const opt = e.target.closest('.picker-option');
  if (!opt) return;
  state.selectedVer = opt.dataset.id;
  $('#pickerDropdown').classList.remove('open');
  updateHomeUI();
  renderVersions($('#searchInput').value);
});

// Close dropdown on outside click
document.addEventListener('click', e => {
  if (!$('#pickerDropdown').contains(e.target) && e.target !== $('#pickerVersion') && !$('#pickerVersion').contains(e.target)) {
    $('#pickerDropdown').classList.remove('open');
  }
});

// Launch
$('#btnLaunch').addEventListener('click', async () => {
  if (!state.activeAcc || !state.selectedVer) return;
  const btn = $('#btnLaunch');
  btn.disabled = true;
  btn.innerHTML = '<span>准备中...</span>';

  const dot = $('#statusDot');
  dot.classList.add('downloading');
  $('#homeStatusText').textContent = '下载中...';

  try {
    await api.downloadVersion(state.selectedVer);
    dot.classList.remove('downloading');
    dot.classList.add('active');
    $('#homeStatusText').textContent = '启动中...';
    $('#statusText').textContent = '启动中...';
    await api.launch(state.activeAcc, state.selectedVer);
    $('#homeStatusText').textContent = '游戏运行中';
    $('#statusText').textContent = '游戏已启动';
    $('#homeBadge').textContent = 'PLAYING';
  } catch (e) {
    dot.classList.remove('downloading', 'active');
    $('#homeStatusText').textContent = trunc(e.message, 40);
    $('#statusText').textContent = '错误';
  } finally {
    btn.disabled = !state.activeAcc || !state.selectedVer;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg><span>启动游戏</span>';
    updateHomeUI();
  }
});

// Progress
api.onProgress(ev => {
  if (ev.type === 'progress') {
    const pct = ev.current && ev.total ? Math.round((ev.current / ev.total) * 100) : 0;
    $('#progressFill').style.width = pct + '%';
    $('#statusText').textContent = `下载资源 ${ev.current}/${ev.total}`;
    $('#homeStatusText').textContent = `下载中 ${pct}%`;
  } else if (ev.type === 'done') {
    $('#progressFill').style.width = '100%';
    $('#statusText').textContent = '下载完成';
    $('#homeStatusText').textContent = '准备就绪';
  }
});

// ================================================
// VERSIONS TAB
// ================================================
async function refreshVersions() {
  const grid = $('#versionList');
  grid.innerHTML = `<div class="shimmer-grid">${'<div class="shimmer-card"></div>'.repeat(6)}</div>`;
  try {
    state.versions = await api.getVersions();
    renderVersions();
    $('#verCount').textContent = `${state.versions.filter(v => v.type === 'release').length} 个版本可用`;
  } catch (e) {
    grid.innerHTML = `<div style="padding:32px;text-align:center;color:var(--ink-tertiary)">加载失败</div>`;
  }
}

function versionTypeLabel(type) {
  if (type === 'release') return '正式版';
  if (type === 'snapshot') return '快照';
  if (type === 'forge') return 'Forge';
  if (type === 'fabric') return 'Fabric';
  if (type === 'modified') return '修改版';
  return type;
}

function versionTypeTagClass(type) {
  if (type === 'forge' || type === 'fabric' || type === 'modified') return 'mod';
  if (type === 'snapshot') return 'snap';
  return '';
}

function renderVersions(filter = '') {
  const grid = $('#versionList');

  // Build combined list: local first, then remote (dedup by id)
  const seen = new Set();
  let list = [];

  for (const v of (state.localVersions || [])) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      list.push({ ...v, _local: true });
    }
  }

  for (const v of state.versions) {
    if (!seen.has(v.id) && v.type === 'release') {
      seen.add(v.id);
      list.push({ ...v, _local: false });
    }
  }

  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(v => v.id.toLowerCase().includes(q));
    // Also include snapshots when filtering
    for (const v of state.versions) {
      if (!seen.has(v.id) && v.type === 'snapshot' && v.id.toLowerCase().includes(q)) {
        seen.add(v.id);
        list.push({ ...v, _local: false });
      }
    }
  }

  if (!list.length) {
    grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink-tertiary);grid-column:1/-1">没有匹配的版本</div>';
    return;
  }

  grid.innerHTML = list.map((v, i) => {
    const sel = v.id === state.selectedVer ? ' selected' : '';
    const tagClass = versionTypeTagClass(v.type);
    return `<div class="ver-card${sel}" data-id="${v.id}" data-type="${v.type}" style="animation: cardIn 0.4s ${i*0.015}s var(--ease-smooth) both">
      <div class="ver-id">${v.id}</div>
      <div class="ver-meta">
        <span class="ver-type">${versionTypeLabel(v.type)}</span>
        ${v._local ? '<span class="ver-tag local">本地</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

$('#versionList').addEventListener('click', e => {
  const card = e.target.closest('.ver-card');
  if (!card) return;
  state.selectedVer = card.dataset.id;
  renderVersions($('#searchInput').value);
  updateHomeUI();
});

$('#btnRefreshVersions').addEventListener('click', refreshVersions);
$('#btnScanLocal').addEventListener('click', refreshLocalVersions);
$('#searchInput').addEventListener('input', e => renderVersions(e.target.value));

// Version isolation toggle
$('#isoToggle').addEventListener('change', async () => {
  state.settings.versionIsolation = $('#isoToggle').checked;
  state.settings = await api.saveSettings(state.settings);
  showToast('版本隔离已' + (state.settings.versionIsolation ? '开启' : '关闭'));
});

// ================================================
// ACCOUNTS TAB
// ================================================
function updateAccountUI() {
  const grid = $('#accountGrid');
  const empty = $('#accountEmpty');
  if (!state.accounts.length) {
    grid.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = state.accounts.map(a => {
    const ini = a.name.slice(0, 2).toUpperCase();
    const cls = a.type === 'microsoft' ? 'ms' : 'offline';
    const active = a === state.activeAcc ? ' active' : '';
    return `<div class="account-card${active}" data-uuid="${a.uuid}">
      <div class="acc-avatar ${cls}">${ini}</div>
      <div>
        <div class="acc-name">${a.name}</div>
        <div class="acc-type">${a.type === 'microsoft' ? 'Microsoft 正版' : '离线模式'}</div>
      </div>
    </div>`;
  }).join('');
}

$('#accountGrid').addEventListener('click', e => {
  const card = e.target.closest('.account-card');
  if (!card) return;
  const uuid = card.dataset.uuid;
  const acc = state.accounts.find(a => a.uuid === uuid);
  if (!acc) return;

  state.activeAcc = acc;
  updateAccountUI();
  updateHomeUI();
  showToast(`已切换至 ${acc.name}`);
});

$('#accountGrid').addEventListener('dblclick', async e => {
  const card = e.target.closest('.account-card');
  if (!card) return;
  const uuid = card.dataset.uuid;
  await api.removeAccount(uuid);
  state.accounts = state.accounts.filter(a => a.uuid !== uuid);
  if (state.activeAcc?.uuid === uuid) state.activeAcc = state.accounts[0] || null;
  updateAccountUI();
  updateHomeUI();
});

// Login
$('#btnMSLogin').addEventListener('click', msLogin);
$('#btnOfflineLogin').addEventListener('click', () => showModal('offlineOverlay'));
$('#btnOfflineCancel').addEventListener('click', () => hideModal('offlineOverlay'));
$('#btnOfflineConfirm').addEventListener('click', async () => {
  const name = $('#offlineNameInput').value.trim();
  if (!name) return;
  const acc = await api.loginOffline(name);
  state.accounts = state.accounts.filter(a => a.uuid !== acc.uuid);
  state.accounts.push(acc);
  state.activeAcc = acc;
  updateAccountUI();
  updateHomeUI();
  hideModal('offlineOverlay');
  $('#offlineNameInput').value = '';
});

async function msLogin() {
  showModal('msOverlay');
  $('#msStatus').textContent = '正在打开浏览器...';
  advanceMsStep(1);
  try {
    const acc = await api.loginMicrosoft();
    advanceMsStep(2);
    state.accounts = state.accounts.filter(a => a.uuid !== acc.uuid);
    state.accounts.push(acc);
    state.activeAcc = acc;
    updateAccountUI();
    updateHomeUI();
    advanceMsStep(3);
    setTimeout(() => hideModal('msOverlay'), 800);
  } catch (e) {
    $('#msStatus').textContent = '登录失败: ' + (e.message || '未知错误');
  }
}

$('#btnMSCancel').addEventListener('click', () => hideModal('msOverlay'));

function resetMsSteps() {
  $$('.ms-step').forEach((s, i) => { s.classList.remove('active', 'done'); if (i === 0) s.classList.add('active'); });
  $$('.ms-line').forEach(l => l.classList.remove('done'));
}
function advanceMsStep(n) {
  $$('.ms-step').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i < n) s.classList.add('done');
    if (i === n) s.classList.add('active');
  });
  $$('.ms-line').forEach((l, i) => { if (i < n) l.classList.add('done'); });
}

// ================================================
// SETTINGS TAB
// ================================================
function updateSettingsUI() {
  $('#javaPath').textContent = state.settings.javaPath || 'java';
  $('#gameDir').textContent = state.settings.gameDir || '未设置';
  $('#memoryInput').value = state.settings.memory || 2048;
  $('#memorySlider').value = state.settings.memory || 2048;
  if (state.settings.versionIsolation != null) {
    $('#isoToggle').checked = state.settings.versionIsolation;
  }
}

$('#btnSettingsSave').addEventListener('click', async () => {
  state.settings.memory = parseInt($('#memoryInput').value) || 2048;
  state.settings = await api.saveSettings(state.settings);
  updateHomeUI();
  showToast('设置已保存');
});

$('#btnJavaSelect').addEventListener('click', async () => {
  const p = await api.selectJava();
  if (p) { state.settings.javaPath = p; updateSettingsUI(); }
});

$('#btnGameDirSelect').addEventListener('click', async () => {
  const result = await api.selectGameDir();
  if (result) {
    state.settings.gameDir = result.path;
    state.localVersions = result.localVersions || [];
    updateSettingsUI();
    renderVersions($('#searchInput').value);
  }
});

async function refreshLocalVersions() {
  state.localVersions = await api.scanGameDir();
  renderVersions($('#searchInput').value);
}

$('#memorySlider').addEventListener('input', e => { $('#memoryInput').value = e.target.value; });
$('#memoryInput').addEventListener('input', e => { $('#memorySlider').value = e.target.value; });

// ================================================
// Modals
// ================================================
function showModal(id) { $('#' + id).classList.add('show'); }
function hideModal(id) { $('#' + id).classList.remove('show'); }

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('show')) {
    e.target.classList.remove('show');
  }
});

// Toast
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 1800);
}

// ================================================
// Keyboard shortcuts
// ================================================
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $$('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    $('#pickerDropdown').classList.remove('open');
  }
  if (e.key === 'Enter' && !document.querySelector('.modal-overlay.show')) {
    if (state.activeAcc && state.selectedVer) $('#btnLaunch').click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    // Switch to versions tab and focus search
    $$('.sb-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-tab="versions"]').classList.add('active');
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $('#panel-versions').classList.add('active');
    $('#searchInput').focus();
  }
  // Tab numbers
  if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    const tabs = ['home', 'versions', 'accounts', 'settings'];
    const t = tabs[parseInt(e.key) - 1];
    $$('.sb-tab').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-tab="${t}"]`).classList.add('active');
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $('#panel-' + t).classList.add('active');
  }
});

// ================================================
// Utility
// ================================================
function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

// ================================================
// Boot
// ================================================
init();
