/* =========================================================
   Provider settings prototype — interaction layer
   No framework, no network. Everything is local demo data.
   ========================================================= */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const icon = (name, className = '') =>
  `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const clone = value => JSON.parse(JSON.stringify(value));

const FORMATS = {
  anthropic: { label: 'Anthropic Messages', path: '/v1/messages' },
  openai: { label: 'Chat Completions', path: '/chat/completions' },
  responses: { label: 'Responses', path: '/responses' },
};

const DEFAULT_REASONING_PARAMS = `{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8192
  },
  "reasoning": {
    "effort": "{{level}}"
  }
}`;

const makeModel = (id, options = {}) => ({
  id,
  context: options.context ?? 128000,
  maxOutput: options.maxOutput ?? 32768,
  smart: options.smart ?? false,
  inputTypes: options.inputTypes ?? ['text', 'image', 'pdf'],
  capabilities: options.capabilities ?? ['structured', 'system'],
  reasoning: options.reasoning ?? ['low', 'medium', 'high', 'xhigh'],
  reasoningParams: options.reasoningParams ?? DEFAULT_REASONING_PARAMS,
  enabled: options.enabled ?? true,
});

const providers = [
  {
    id: 'zd',
    name: 'ZD',
    group: '自定义供应商',
    subtitle: '中转站 · 自定义',
    color: '#2dd4bf',
    status: 'ok',
    canFetch: true,
    enabled: true,
    baseUrl: 'http://154.9.227.164:3000/v1',
    format: 'anthropic',
    apiKey: 'sk-demo-zd-3b9f7b8d2e4a6c0f1a',
    models: [
      makeModel('[bbk]claude-opus-4.6', {
        context: 1000000,
        maxOutput: 128000,
        inputTypes: ['text', 'image', 'pdf'],
        capabilities: ['structured', 'system'],
      }),
      makeModel('[jj]grok-4.6', {
        context: 500000,
        maxOutput: 128000,
        inputTypes: ['text', 'image'],
        capabilities: ['structured', 'web', 'system'],
      }),
    ],
  },
  {
    id: 'newprovider',
    name: '新供应商',
    group: '自定义供应商',
    subtitle: 'OpenAI 兼容 · 刚刚创建',
    color: '#a78bfa',
    status: 'ok',
    canFetch: true,
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    format: 'openai',
    apiKey: '',
    models: [],
  },
];

const CATALOG_GROUPS = [
  {
    name: '智谱',
    models: [
      'glm-image-image',
      'glm-5.3-chat',
      'glm-5.3-flash-free',
      'glm-4.6v-flash',
      'z-ai/glm-5.3',
      'glm-4.5-flash',
      'glm-5.3-flash',
      'z-ai/glm-5.3-flash',
    ],
  },
  {
    name: 'Cohere',
    models: [
      'command-a-03-2025', 'command-r-plus-08-2024', 'command-r-08-2024', 'command-r7b-12-2024',
      'aya-expanse-32b', 'aya-vision-32b', 'c4ai-aya-23-35b', 'c4ai-aya-23-8b',
      'command-light', 'command', 'command-nightly', 'command-r-plus',
      'command-r', 'command-r7b', 'embed-v4.0', 'rerank-v3.5',
      'aya-23-8b', 'aya-23-35b', 'c4ai-aya-vision-8b', 'c4ai-aya-vision-32b',
    ],
  },
  {
    name: 'xAI',
    models: ['grok-4.6', 'grok-4', 'grok-3', 'grok-3-mini', 'grok-2-vision'],
  },
  {
    name: 'OpenAI',
    models: ['gpt-5.3', 'gpt-5.3-mini', 'gpt-5.2', 'o4-mini', 'gpt-4.1'],
  },
  {
    name: 'DeepSeek',
    models: ['deepseek-v3.2', 'deepseek-r1'],
  },
  {
    name: 'MiniMax',
    models: ['minimax-m2.1', 'minimax-vl-01'],
  },
  {
    name: 'Llama',
    models: ['llama-4-maverick', 'llama-4-scout', 'llama-3.3-70b'],
  },
  {
    name: '通义千问',
    models: ['qwen3-max'],
  },
  {
    name: 'Gemini',
    models: ['gemini-3.0-pro', 'gemini-2.5-flash'],
  },
  {
    name: 'Anthropic',
    models: [
      'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-5',
      'claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-1',
      'claude-sonnet-4-0', 'claude-3-7-sonnet', 'claude-3-5-haiku',
      'claude-3-opus', 'claude-3-haiku',
    ],
  },
  {
    name: 'Mistral',
    models: [
      'mistral-large-3', 'mistral-medium-3', 'mistral-small-3.2', 'magistral-medium',
      'codestral-2', 'devstral-small', 'pixtral-large', 'ministral-8b',
    ],
  },
  {
    name: 'Moonshot',
    models: ['kimi-k2.5', 'kimi-k2-turbo', 'kimi-k1.5', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  },
  {
    name: 'Qwen',
    models: [
      'qwen3-max-preview', 'qwen3-coder-plus', 'qwen3-vl-235b', 'qwen3-235b-a22b',
      'qwen3-32b', 'qwen3-8b', 'qwen2.5-coder-32b', 'qwen2.5-vl-72b',
    ],
  },
  {
    name: '其他',
    models: Array.from({ length: 15 }, (_, index) => `community/model-${String(index + 1).padStart(2, '0')}`),
  },
];

const REMOVED_MODELS = [
  'glm-4-plus',
  'command-r-plus',
  'grok-2-preview',
  'o1-preview',
  'deepseek-v2.5',
];

const state = {
  activeTab: 'providers',
  selectedProviderId: 'zd',
  revealedKeys: new Set(),
  apiFormatOpen: false,
  moreMenuOpen: false,
  picker: null,
  editor: null,
  confirmAction: null,
  newProviderFormat: 'anthropic',
};

const getProvider = id => providers.find(provider => provider.id === id) ?? null;
const currentProvider = () => getProvider(state.selectedProviderId);

const formatContext = value => {
  if (!value) return '';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
};

const modelBadges = model => {
  const badges = [];
  if (model.context) badges.push(`<span class="model-badge">${esc(formatContext(model.context))}</span>`);
  if ((model.inputTypes ?? []).includes('image')) badges.push('<span class="model-badge model-badge--accent">视觉</span>');
  return badges.join('');
};

const providerStatusClass = provider => (provider.status === 'warning' ? 'is-warning' : provider.enabled ? '' : 'is-muted');

const formatLabel = format => {
  const item = FORMATS[format] ?? FORMATS.openai;
  return `${item.label} (${item.path})`;
};

/* =========================================================
   Provider list + detail
   ========================================================= */
function providerFetchButtonMarkup(provider) {
  return `<button class="provider-fetch" type="button" data-fetch-provider="${esc(provider.id)}" title="从 ${esc(provider.name)} 获取模型">${icon('cloud-down')}<span>获取模型</span></button>`;
}

function renderProviderList() {
  const root = $('#providerList');
  if (!root) return;

  const groups = [];
  for (const provider of providers) {
    let group = groups.find(item => item.name === provider.group);
    if (!group) {
      group = { name: provider.group, providers: [] };
      groups.push(group);
    }
    group.providers.push(provider);
  }

  root.innerHTML = groups
    .map(
      group => `
        <section class="provider-group" aria-label="${esc(group.name)}">
          <div class="provider-group__label">${esc(group.name)}</div>
          ${group.providers
            .map(
              provider => `
                <div class="provider-row ${provider.id === state.selectedProviderId ? 'is-active' : ''}" data-provider-id="${esc(provider.id)}" role="button" tabindex="0" aria-label="选择供应商 ${esc(provider.name)}">
                  <span class="provider-avatar" style="--avatar-color:${esc(provider.color)}">
                    ${icon(provider.group === '智谱' ? 'spark' : 'cube')}
                  </span>
                  <span class="provider-row__copy">
                    <span class="provider-row__name">${esc(provider.name)}</span>
                    <span class="provider-row__meta">${esc(provider.subtitle)}</span>
                  </span>
                  ${provider.canFetch ? providerFetchButtonMarkup(provider) : ''}
                  <span class="provider-row__status ${providerStatusClass(provider)}" title="${provider.status === 'warning' ? '配置正常，建议检查' : provider.enabled ? '配置正常' : '已停用'}"></span>
                </div>`,
            )
            .join('')}
        </section>`,
    )
    .join('');
}

function renderProviderDetail() {
  const root = $('#providerDetail');
  if (!root) return;

  const provider = currentProvider();
  if (!provider) {
    root.innerHTML = `<div class="detail-empty"><p>选择左侧的供应商查看配置。</p></div>`;
    return;
  }

  const apiKeyRevealed = state.revealedKeys.has(provider.id);
  const models = provider.models ?? [];
  const modelList = models.length
    ? `<div class="model-list">${models
        .map(
          model => `
            <div class="model-row ${model.enabled ? '' : 'is-disabled'}" data-model-row="${esc(model.id)}" role="button" tabindex="0" aria-label="编辑模型 ${esc(model.id)}">
              <span class="model-row__grip" aria-hidden="true">${icon('grip')}</span>
              <span class="model-row__name">${esc(model.id)}</span>
              ${modelBadges(model)}
              <span class="model-row__actions">
                <button class="model-action" type="button" data-model-action="edit" data-model-id="${esc(model.id)}" title="配置模型" aria-label="配置模型">${icon('sliders')}</button>
                <button class="model-action" type="button" data-model-action="edit" data-model-id="${esc(model.id)}" title="编辑模型" aria-label="编辑模型">${icon('pencil')}</button>
                <button class="model-action model-action--danger" type="button" data-model-action="delete" data-model-id="${esc(model.id)}" title="删除模型" aria-label="删除模型">${icon('trash')}</button>
                <button class="switch" type="button" role="switch" aria-checked="${model.enabled}" data-model-action="toggle" data-model-id="${esc(model.id)}" aria-label="${model.enabled ? '停用' : '启用'}模型 ${esc(model.id)}"><span></span></button>
              </span>
            </div>`,
        )
        .join('')}</div>`
    : `<div class="empty-models">
        <div class="empty-models__icon">${icon('cloud-down')}</div>
        <h3>还没有模型</h3>
        <p>${provider.canFetch ? '从这个供应商拉取上游模型，或手动添加一个模型 ID。模型只会写入当前供应商。' : '内置供应商没有可拉取的模型，请手动添加一个模型 ID。'}</p>
        <div class="empty-models__actions">
          ${provider.canFetch ? `<button class="button" type="button" data-fetch-provider="${esc(provider.id)}">${icon('cloud-down')}获取模型</button>` : ''}
          <button class="button button--primary" type="button" data-add-model="${esc(provider.id)}">${icon('plus')}手动添加</button>
        </div>
      </div>`;

  root.innerHTML = `
    <div class="provider-detail__inner">
      <header class="detail-head">
        <div class="detail-title">
          <span class="provider-avatar" style="--avatar-color:${esc(provider.color)}">
            ${icon(provider.group === '智谱' ? 'spark' : 'cube')}
          </span>
          <div class="detail-title__copy">
            <h2>${esc(provider.name)}</h2>
            <div class="detail-title__sub">
              <span class="health-dot ${provider.status === 'warning' ? 'is-warning' : ''}"></span>
              <span>${provider.status === 'warning' ? '连接正常 · 建议检查配置' : '配置正常'}</span>
              <span>·</span>
              <span>${models.length} 个模型</span>
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <span class="provider-toggle-wrap">${provider.enabled ? '已启用' : '已停用'}
            <button class="switch" type="button" role="switch" aria-checked="${provider.enabled}" data-provider-toggle="${esc(provider.id)}" aria-label="${provider.enabled ? '停用' : '启用'}供应商"><span></span></button>
          </span>
          <button class="icon-button" type="button" data-more-provider="${esc(provider.id)}" aria-label="更多供应商操作" aria-haspopup="menu">${icon('more')}</button>
        </div>
      </header>

      <div class="detail-form">
        <label class="detail-field">
          <span class="detail-field__label">Base URL</span>
          <span class="detail-input-wrap">
            <input class="detail-input" id="baseUrlInput" value="${esc(provider.baseUrl)}" spellcheck="false" autocomplete="off" aria-label="Base URL" />
          </span>
        </label>

        <div class="detail-field">
          <span class="detail-field__label">API 格式</span>
          <button class="select-trigger" id="apiFormatTrigger" type="button" aria-haspopup="listbox" aria-expanded="${state.apiFormatOpen}">
            <span>${esc(formatLabel(provider.format))}</span>
            ${icon('chevron-down')}
          </button>
        </div>

        <label class="detail-field">
          <span class="detail-field__label">API Key</span>
          <span class="detail-input-wrap">
            <input class="api-key-input ${apiKeyRevealed ? 'is-revealed' : ''}" id="apiKeyInput" type="${apiKeyRevealed ? 'text' : 'password'}" value="${esc(provider.apiKey)}" spellcheck="false" autocomplete="off" aria-label="API Key" placeholder="未配置 API Key" />
            <button class="input-action" type="button" data-toggle-key="${esc(provider.id)}" title="${apiKeyRevealed ? '隐藏' : '显示'} API Key" aria-label="${apiKeyRevealed ? '隐藏' : '显示'} API Key">
              ${icon(apiKeyRevealed ? 'eye-off' : 'eye')}
            </button>
          </span>
        </label>

        <section class="models-block" aria-label="模型列表">
          <div class="models-block__head">
            <div class="models-block__title">模型列表 <span>${models.length}</span></div>
            <div class="models-block__actions">
              ${provider.canFetch ? `<button class="button" type="button" data-fetch-provider="${esc(provider.id)}">${icon('cloud-down')}获取模型</button>` : ''}
              <button class="button button--primary" type="button" data-add-model="${esc(provider.id)}">${icon('plus')}添加模型</button>
            </div>
          </div>
          ${modelList}
        </section>
      </div>
    </div>`;
}

function renderAll() {
  renderProviderList();
  renderProviderDetail();
}

/* =========================================================
   Floating menus
   ========================================================= */
function closeFloatingMenus() {
  const apiMenu = $('#apiFormatMenu');
  const moreMenu = $('#moreMenu');
  if (apiMenu) apiMenu.hidden = true;
  if (moreMenu) moreMenu.hidden = true;
  state.apiFormatOpen = false;
  state.moreMenuOpen = false;
  const trigger = $('#apiFormatTrigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function positionFloatingMenu(menu, anchor, width) {
  menu.hidden = false;
  menu.style.width = `${width}px`;
  const rect = anchor.getBoundingClientRect();
  const maxLeft = window.innerWidth - menu.offsetWidth - 10;
  menu.style.left = `${Math.max(10, Math.min(rect.left, maxLeft))}px`;
  menu.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - menu.offsetHeight - 10)}px`;
}

function openApiFormatMenu(anchor) {
  const provider = currentProvider();
  if (!provider) return;
  closeFloatingMenus();
  const menu = $('#apiFormatMenu');
  menu.innerHTML = Object.entries(FORMATS)
    .map(
      ([value, item]) => `
        <button type="button" class="menu-option" data-api-format="${value}" role="option" aria-selected="${provider.format === value}">
          <span>${esc(item.label)} <span style="color:var(--text-500)">(${esc(item.path)})</span></span>
          ${provider.format === value ? icon('check') : ''}
        </button>`,
    )
    .join('');
  state.apiFormatOpen = true;
  anchor.setAttribute('aria-expanded', 'true');
  positionFloatingMenu(menu, anchor, Math.max(anchor.offsetWidth, 420));
}

function openMoreMenu(anchor, provider) {
  closeFloatingMenus();
  const menu = $('#moreMenu');
  menu.innerHTML = `
    ${provider.canFetch ? `<button class="menu-option" type="button" role="menuitem" data-more-action="fetch">${icon('cloud-down')}<span>获取模型</span></button>` : ''}
    <button class="menu-option" type="button" role="menuitem" data-more-action="clear">${icon('trash')}<span>清空模型列表</span></button>
    <div class="menu-divider"></div>
    <button class="menu-option menu-option--danger" type="button" role="menuitem" data-more-action="delete">${icon('x')}<span>删除供应商</span></button>`;
  menu.dataset.providerId = provider.id;
  state.moreMenuOpen = true;
  positionFloatingMenu(menu, anchor, 176);
}


/* =========================================================
   Modal helpers
   ========================================================= */
function openModal(id) {
  const layer = document.getElementById(id);
  if (!layer) return;
  layer.hidden = false;
  requestAnimationFrame(() => {
    const focusable = layer.querySelector('input:not([type="hidden"]), button:not([disabled]), textarea');
    focusable?.focus({ preventScroll: true });
  });
}

function closeModal(id) {
  const layer = document.getElementById(id);
  if (layer) layer.hidden = true;
  if (id === 'modelPickerModal') state.picker = null;
  if (id === 'modelEditorModal') state.editor = null;
  if (id === 'confirmModal') state.confirmAction = null;
}

function toast(title, message = '', tone = 'normal') {
  const root = $('#toastStack');
  const item = document.createElement('div');
  item.className = `toast ${tone === 'danger' ? 'toast--danger' : ''}`;
  item.innerHTML = `
    <span class="toast__icon">${icon(tone === 'danger' ? 'x' : 'check')}</span>
    <span class="toast__copy"><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ''}</span>`;
  root.appendChild(item);
  window.setTimeout(() => {
    item.classList.add('is-leaving');
    window.setTimeout(() => item.remove(), 180);
  }, 2800);
}

function askConfirm({ title, message, label = '删除', onConfirm }) {
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmActionBtn').textContent = label;
  state.confirmAction = onConfirm;
  openModal('confirmModal');
}

/* =========================================================
   Fetch + model picker
   ========================================================= */
function fetchModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider || !provider.canFetch) return;

  const buttons = $$(`[data-fetch-provider="${providerId}"]`);
  buttons.forEach(button => {
    button.classList.add('is-loading');
    const text = button.querySelector('span');
    if (text) text.textContent = '拉取中';
    button.disabled = true;
  });

  window.setTimeout(() => {
    buttons.forEach(button => {
      button.classList.remove('is-loading');
      const text = button.querySelector('span');
      if (text) text.textContent = '获取模型';
      button.disabled = false;
    });

    state.picker = {
      providerId,
      tab: 'new',
      query: '',
      newSelected: new Set(),
      removedSelected: new Set(),
      collapsed: new Set(CATALOG_GROUPS.slice(1).map(group => group.name)),
    };
    renderPicker();
    openModal('modelPickerModal');
    toast(`已从 ${provider.name} 获取 97 个模型`, '选择模型后可以逐个完善上下文、能力和推理参数。');
  }, 720);
}

function pickerGroups() {
  if (!state.picker) return [];
  if (state.picker.tab === 'removed') return [{ name: '上游已删除', models: REMOVED_MODELS }];
  return CATALOG_GROUPS;
}

function filteredPickerGroups() {
  const groups = pickerGroups();
  const query = (state.picker?.query ?? '').trim().toLowerCase();
  if (!query) return groups;
  return groups
    .map(group => ({
      ...group,
      models: group.models.filter(
        model => model.toLowerCase().includes(query) || group.name.toLowerCase().includes(query),
      ),
    }))
    .filter(group => group.models.length > 0);
}

function pickerSelection() {
  if (!state.picker) return new Set();
  return state.picker.tab === 'removed' ? state.picker.removedSelected : state.picker.newSelected;
}

function renderPickerShell() {
  if (!state.picker) return;
  const provider = getProvider(state.picker.providerId);
  const selection = pickerSelection();
  const total = state.picker.tab === 'removed' ? REMOVED_MODELS.length : 97;

  $('#pickerProviderName').textContent = provider?.name ?? '供应商';
  $('#pickerTabNew').classList.toggle('is-active', state.picker.tab === 'new');
  $('#pickerTabNew').setAttribute('aria-selected', String(state.picker.tab === 'new'));
  $('#pickerTabRemoved').classList.toggle('is-active', state.picker.tab === 'removed');
  $('#pickerTabRemoved').setAttribute('aria-selected', String(state.picker.tab === 'removed'));
  $('#pickerSelectedCount').textContent = String(selection.size);
  $('#pickerTotalCount').textContent = String(total);
  $('#pickerConfirmBtn').textContent = state.picker.tab === 'removed' ? '移除已选' : '确定';
  $('#pickerConfirmBtn').disabled = selection.size === 0;
  const search = $('#pickerSearchInput');
  if (document.activeElement !== search) search.value = state.picker.query;
}

function renderPickerBody() {
  if (!state.picker) return;
  const root = $('#pickerBody');
  const groups = filteredPickerGroups();
  const selection = pickerSelection();
  const query = state.picker.query.trim();

  if (!groups.length) {
    root.innerHTML = `<div class="picker-empty">${icon('search')}<p>没有匹配的模型</p></div>`;
    syncPickerChecks();
    return;
  }

  root.innerHTML = groups.map(group => renderPickerGroup(group, selection, query)).join('');
  syncPickerChecks();
}

function renderPickerGroup(group, selection, query) {
  const collapsed = !query && state.picker.collapsed.has(group.name);
  const selectedInGroup = group.models.filter(model => selection.has(model)).length;
  const allSelected = selectedInGroup === group.models.length && group.models.length > 0;
  const modelHtml = group.models.map(model => {
    const selected = selection.has(model);
    const removed = state.picker.tab === 'removed' ? '<span class="model-option__removed">已删除</span>' : '';
    return `<label class="model-option ${selected ? 'is-selected' : ''}">
      <input type="checkbox" data-model-check="${esc(model)}" ${selected ? 'checked' : ''} />
      <span class="checkbox__box"></span>
      <span class="model-option__name" title="${esc(model)}">${esc(model)}</span>
      ${removed}
    </label>`;
  }).join('');
  return `<section class="picker-group ${collapsed ? 'is-collapsed' : ''}" data-group-name="${esc(group.name)}">
    <div class="picker-group__head">
      <label class="checkbox" title="选择 ${esc(group.name)} 下的可见模型">
        <input type="checkbox" data-group-check="${esc(group.name)}" ${allSelected ? 'checked' : ''} />
        <span class="checkbox__box"></span>
      </label>
      <button class="group-toggle" type="button" data-group-toggle="${esc(group.name)}" aria-label="${collapsed ? '展开' : '折叠'} ${esc(group.name)}" aria-expanded="${!collapsed}">${icon('chevron-down')}</button>
      <span class="picker-group__name">${esc(group.name)} <span class="picker-group__count">(${group.models.length})</span></span>
      <span class="picker-group__selected">${selectedInGroup > 0 ? `已选 ${selectedInGroup}` : ''}</span>
    </div>
    <div class="picker-group__body">
      <div class="picker-group__summary">${icon('spark')}已选择 ${selectedInGroup} / ${group.models.length}</div>
      <div class="model-grid">${modelHtml}</div>
    </div>
  </section>`;
}

function syncPickerChecks() {
  if (!state.picker) return;
  const selection = pickerSelection();
  const groups = filteredPickerGroups();
  const visibleModels = groups.flatMap(group => group.models);
  const all = visibleModels.length > 0 && visibleModels.every(model => selection.has(model));
  const some = visibleModels.some(model => selection.has(model));

  groups.forEach(group => {
    const checkbox = document.querySelector(`[data-group-check="${cssEscape(group.name)}"]`);
    if (checkbox) {
      const groupSelected = group.models.filter(model => selection.has(model)).length;
      checkbox.checked = groupSelected === group.models.length;
      checkbox.indeterminate = groupSelected > 0 && groupSelected < group.models.length;
    }
  });

  const selectAll = $('#pickerSelectAll');
  selectAll.checked = all;
  selectAll.indeterminate = some && !all;
  $('#pickerSelectedCount').textContent = String(selection.size);
  $('#pickerConfirmBtn').disabled = selection.size === 0;
}

function renderPicker() {
  renderPickerShell();
  renderPickerBody();
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function confirmPickerSelection() {
  if (!state.picker) return;
  const provider = getProvider(state.picker.providerId);
  if (!provider) return;
  const selection = pickerSelection();
  if (!selection.size) return;
  const selected = Array.from(selection);

  if (state.picker.tab === 'removed') {
    provider.models = provider.models.filter(model => !selection.has(model.id));
    const count = selected.length;
    closeModal('modelPickerModal');
    renderAll();
    toast('已移除所选模型', `从 ${provider.name} 移除了 ${count} 个模型。`);
    return;
  }

  const addedIds = [];
  for (const id of selected) {
    if (provider.models.some(model => model.id === id)) continue;
    provider.models.push(makeModel(id, {
      context: 1000000,
      maxOutput: 128000,
      inputTypes: ['text', 'image', 'pdf'],
      capabilities: ['structured', 'system'],
      reasoning: ['low', 'medium', 'high', 'xhigh'],
    }));
    addedIds.push(id);
  }

  closeModal('modelPickerModal');
  renderAll();

  if (!addedIds.length) {
    toast('没有新增模型', '所选模型已经存在于当前供应商中。');
    return;
  }

  const first = addedIds[0];
  const queue = addedIds.slice(1);
  if (queue.length) {
    toast(`已添加 ${addedIds.length} 个模型`, '接下来会逐个打开配置，保存后自动进入下一个。');
  } else {
    toast('已添加模型', '把模型 ID、上下文和参数核对一遍再保存。');
  }
  openEditor(provider.id, provider.models.find(model => model.id === first), {
    source: 'fetched',
    queue,
    queueTotal: addedIds.length,
    queueIndex: 0,
  });
}

/* =========================================================
   Model editor
   ========================================================= */
function blankModel() {
  return makeModel('', {
    context: 128000,
    maxOutput: 32768,
    inputTypes: ['text', 'image', 'pdf'],
    capabilities: ['structured', 'system'],
    reasoning: ['low', 'medium', 'high', 'xhigh'],
  });
}

function openEditor(providerId, model, options = {}) {
  const provider = getProvider(providerId);
  if (!provider) return;
  const source = options.source ?? 'manual';
  const original = model ? clone(model) : blankModel();
  state.editor = {
    providerId,
    original,
    draft: clone(original),
    mode: model ? 'edit' : 'create',
    source,
    queue: options.queue ? [...options.queue] : [],
    queueTotal: options.queueTotal ?? 1,
    queueIndex: options.queueIndex ?? 0,
  };
  renderEditor();
  openModal('modelEditorModal');
}

function renderEditor() {
  if (!state.editor) return;
  const provider = getProvider(state.editor.providerId);
  const draft = state.editor.draft;
  if (!provider || !draft) return;

  $('#editorProviderName').textContent = provider.name;
  $('#editorModeLabel').textContent =
    state.editor.source === 'fetched' ? '同步后配置' : state.editor.mode === 'create' ? '手动添加模型' : '模型配置';
  $('#modelEditorTitle').textContent = state.editor.mode === 'create' ? '添加模型配置' : '编辑模型配置';
  const progress = $('#editorProgress');
  if (state.editor.queueTotal > 1) {
    progress.hidden = false;
    progress.textContent = `${state.editor.queueIndex + 1} / ${state.editor.queueTotal}`;
  } else {
    progress.hidden = true;
  }

  $('#smartConfigToggle').setAttribute('aria-checked', String(Boolean(draft.smart)));
  $('#modelIdInput').value = draft.id;
  $('#contextWindowInput').value = draft.context;
  $('#maxOutputInput').value = draft.maxOutput;
  $('#reasoningParamsInput').value = draft.reasoningParams;

  $$('.chip-toggle[data-input-type]').forEach(button => {
    const active = (draft.inputTypes ?? []).includes(button.dataset.inputType);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $$('.chip-toggle[data-capability]').forEach(button => {
    const active = (draft.capabilities ?? []).includes(button.dataset.capability);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderReasoningChips();
}

function renderReasoningChips() {
  if (!state.editor) return;
  const row = $('#reasoningChips');
  const addButton = $('#addReasoningBtn');
  const values = state.editor.draft.reasoning ?? [];
  $$('.chip-toggle[data-reasoning]', row).forEach(button => button.remove());
  for (const value of values) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-toggle is-active';
    button.dataset.reasoning = value;
    button.setAttribute('aria-pressed', 'true');
    button.textContent = value;
    row.insertBefore(button, addButton);
  }
}

function updateEditorDraftFromFields() {
  if (!state.editor) return;
  state.editor.draft.id = $('#modelIdInput').value.trim();
  state.editor.draft.context = Number($('#contextWindowInput').value) || 0;
  state.editor.draft.maxOutput = Number($('#maxOutputInput').value) || 0;
  state.editor.draft.reasoningParams = $('#reasoningParamsInput').value;
}

function saveEditor() {
  if (!state.editor) return;
  const provider = getProvider(state.editor.providerId);
  if (!provider) return;
  updateEditorDraftFromFields();
  const draft = state.editor.draft;

  if (!draft.id) {
    toast('模型 ID 不能为空', '填写上游接口实际使用的模型 ID。', 'danger');
    $('#modelIdInput').focus();
    return;
  }
  const duplicate = provider.models.find(model => model.id === draft.id && model.id !== state.editor.original.id);
  if (duplicate) {
    toast('模型 ID 已存在', '当前供应商下已有同名模型。', 'danger');
    $('#modelIdInput').focus();
    return;
  }
  if (!draft.context || draft.context < 1 || !draft.maxOutput || draft.maxOutput < 1) {
    toast('参数不完整', '上下文窗口和最大输出 Token 必须是大于 0 的整数。', 'danger');
    return;
  }

  if (state.editor.mode === 'create') {
    provider.models.push(clone(draft));
  } else {
    const index = provider.models.findIndex(model => model.id === state.editor.original.id);
    if (index >= 0) provider.models[index] = clone(draft);
    else provider.models.push(clone(draft));
  }

  const queue = [...state.editor.queue];
  const nextId = queue.shift();
  const nextQueueIndex = state.editor.queueIndex + 1;
  const queueTotal = state.editor.queueTotal;
  if (nextId) {
    const nextModel = provider.models.find(model => model.id === nextId);
    if (nextModel) {
      state.editor = null;
      toast('已保存', '继续配置下一个模型。');
      openEditor(provider.id, nextModel, {
        source: 'fetched',
        queue,
        queueTotal,
        queueIndex: nextQueueIndex,
      });
      return;
    }
  }

  closeModal('modelEditorModal');
  renderAll();
  toast('模型配置已保存', `${provider.name} · ${draft.id}`);
}

function resetEditorForm() {
  if (!state.editor) return;
  state.editor.draft = clone(state.editor.original);
  renderEditor();
  toast('已重置表单', '恢复到打开编辑器时的配置。');
}

/* =========================================================
   Events
   ========================================================= */
function openAddProviderModal() {
  $('#providerForm').reset();
  $('#newProviderFormat').querySelectorAll('.segmented__item').forEach(button => {
    button.classList.toggle('is-active', button.dataset.value === 'anthropic');
  });
  state.newProviderFormat = 'anthropic';
  openModal('providerModal');
}

function selectProvider(providerId) {
  if (!getProvider(providerId)) return;
  state.selectedProviderId = providerId;
  state.apiFormatOpen = false;
  state.moreMenuOpen = false;
  closeFloatingMenus();
  renderProviderList();
  renderProviderDetail();
}

function setupProviderEvents() {
  $('#providerList').addEventListener('click', event => {
    const fetchButton = event.target.closest('[data-fetch-provider]');
    if (fetchButton) {
      event.stopPropagation();
      fetchModels(fetchButton.dataset.fetchProvider);
      return;
    }
    const row = event.target.closest('[data-provider-id]');
    if (row) selectProvider(row.dataset.providerId);
  });

  $('#providerList').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-provider-id]');
    if (row && event.target === row) {
      event.preventDefault();
      selectProvider(row.dataset.providerId);
    }
  });

  $('#providerDetail').addEventListener('click', event => {
    const fetchButton = event.target.closest('[data-fetch-provider]');
    if (fetchButton) {
      event.stopPropagation();
      fetchModels(fetchButton.dataset.fetchProvider);
      return;
    }

    const addModel = event.target.closest('[data-add-model]');
    if (addModel) {
      event.stopPropagation();
      openEditor(addModel.dataset.addModel, null, { source: 'manual' });
      return;
    }

    const providerToggle = event.target.closest('[data-provider-toggle]');
    if (providerToggle) {
      event.stopPropagation();
      const provider = getProvider(providerToggle.dataset.providerToggle);
      if (provider) {
        provider.enabled = !provider.enabled;
        renderProviderList();
        renderProviderDetail();
        toast(provider.enabled ? '已启用供应商' : '已停用供应商', provider.name);
      }
      return;
    }

    const keyToggle = event.target.closest('[data-toggle-key]');
    if (keyToggle) {
      event.stopPropagation();
      const id = keyToggle.dataset.toggleKey;
      if (state.revealedKeys.has(id)) state.revealedKeys.delete(id);
      else state.revealedKeys.add(id);
      renderProviderDetail();
      return;
    }

    const apiTrigger = event.target.closest('#apiFormatTrigger');
    if (apiTrigger) {
      event.stopPropagation();
      if (state.apiFormatOpen) closeFloatingMenus();
      else openApiFormatMenu(apiTrigger);
      return;
    }

    const moreButton = event.target.closest('[data-more-provider]');
    if (moreButton) {
      event.stopPropagation();
      const provider = getProvider(moreButton.dataset.moreProvider);
      if (provider) {
        if (state.moreMenuOpen) closeFloatingMenus();
        else openMoreMenu(moreButton, provider);
      }
      return;
    }

    const actionButton = event.target.closest('[data-model-action]');
    if (actionButton) {
      event.stopPropagation();
      const provider = currentProvider();
      if (!provider) return;
      openModelAction(provider, actionButton.dataset.modelId, actionButton.dataset.modelAction);
      return;
    }

    const modelRow = event.target.closest('[data-model-row]');
    if (modelRow) {
      const provider = currentProvider();
      const model = provider?.models.find(item => item.id === modelRow.dataset.modelRow);
      if (model) openEditor(provider.id, model, { source: 'manual' });
    }
  });

  $('#providerDetail').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-model-row]');
    if (row && event.target === row) {
      event.preventDefault();
      const provider = currentProvider();
      const model = provider?.models.find(item => item.id === row.dataset.modelRow);
      if (model) openEditor(provider.id, model, { source: 'manual' });
    }
  });

  $('#providerDetail').addEventListener('input', event => {
    const provider = currentProvider();
    if (!provider) return;
    if (event.target.id === 'baseUrlInput') provider.baseUrl = event.target.value;
    if (event.target.id === 'apiKeyInput') provider.apiKey = event.target.value;
  });
}

function openModelAction(provider, modelId, action) {
  const model = provider.models.find(item => item.id === modelId);
  if (!model) return;
  if (action === 'toggle') {
    model.enabled = !model.enabled;
    renderProviderDetail();
    toast(model.enabled ? '已启用模型' : '已停用模型', model.id);
    return;
  }
  if (action === 'edit') {
    openEditor(provider.id, model, { source: 'manual' });
    return;
  }
  if (action === 'delete') {
    askConfirm({
      title: '删除模型？',
      message: `将从 ${provider.name} 的模型列表中移除 ${model.id}。这不会影响上游接口。`,
      label: '删除模型',
      onConfirm: () => {
        provider.models = provider.models.filter(item => item.id !== model.id);
        renderProviderDetail();
        toast('模型已删除', model.id);
      },
    });
  }
}

function setupPickerEvents() {
  const modal = $('#modelPickerModal');

  modal.addEventListener('click', event => {
    const tab = event.target.closest('[data-picker-tab]');
    if (tab) {
      if (!state.picker) return;
      state.picker.tab = tab.dataset.pickerTab;
      state.picker.query = '';
      $('#pickerSearchInput').value = '';
      renderPicker();
      return;
    }

    const groupToggle = event.target.closest('[data-group-toggle]');
    if (groupToggle) {
      if (!state.picker) return;
      const name = groupToggle.dataset.groupToggle;
      if (state.picker.collapsed.has(name)) state.picker.collapsed.delete(name);
      else state.picker.collapsed.add(name);
      renderPickerBody();
    }
  });

  modal.addEventListener('input', event => {
    if (event.target.id !== 'pickerSearchInput' || !state.picker) return;
    state.picker.query = event.target.value;
    renderPickerBody();
  });

  modal.addEventListener('change', event => {
    if (!state.picker) return;
    const selection = pickerSelection();

    if (event.target.matches('[data-group-check]')) {
      const groupName = event.target.dataset.groupCheck;
      const group = filteredPickerGroups().find(item => item.name === groupName);
      if (!group) return;
      if (event.target.checked) group.models.forEach(model => selection.add(model));
      else group.models.forEach(model => selection.delete(model));
      renderPicker();
      return;
    }

    if (event.target.matches('[data-model-check]')) {
      const model = event.target.dataset.modelCheck;
      if (event.target.checked) selection.add(model);
      else selection.delete(model);
      renderPicker();
      return;
    }

    if (event.target.id === 'pickerSelectAll') {
      const models = filteredPickerGroups().flatMap(group => group.models);
      if (event.target.checked) models.forEach(model => selection.add(model));
      else models.forEach(model => selection.delete(model));
      renderPicker();
    }
  });

  $('#pickerConfirmBtn').addEventListener('click', confirmPickerSelection);
}

function setupEditorEvents() {
  $('#modelEditorForm').addEventListener('submit', event => {
    event.preventDefault();
    saveEditor();
  });

  $('#advancedToggle').addEventListener('click', event => {
    const button = event.currentTarget;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    $('#advancedBody').hidden = expanded;
  });

  $('#smartConfigToggle').addEventListener('click', () => {
    if (!state.editor) return;
    const next = !state.editor.draft.smart;
    state.editor.draft.smart = next;
    if (next) {
      const id = ($('#modelIdInput').value || '').toLowerCase();
      if (id.includes('claude')) {
        state.editor.draft.context = 1000000;
        state.editor.draft.maxOutput = 128000;
        state.editor.draft.inputTypes = ['text', 'image', 'pdf'];
      } else if (id.includes('gemini')) {
        state.editor.draft.context = 1000000;
        state.editor.draft.maxOutput = 65536;
        state.editor.draft.inputTypes = ['text', 'image', 'video', 'pdf'];
      } else if (id.includes('grok') || id.includes('qwen')) {
        state.editor.draft.context = 500000;
        state.editor.draft.maxOutput = 128000;
        state.editor.draft.inputTypes = ['text', 'image'];
      }
      toast('智能配置已开启', '已根据模型 ID 填入一组推荐参数。');
    } else {
      toast('智能配置已关闭', '可以手动调整全部参数。');
    }
    renderEditor();
  });

  $('#modelEditorModal').addEventListener('click', event => {
    if (!state.editor) return;
    const inputChip = event.target.closest('[data-input-type]');
    if (inputChip) {
      updateEditorDraftFromFields();
      const value = inputChip.dataset.inputType;
      const list = state.editor.draft.inputTypes;
      const index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1);
      else list.push(value);
      renderEditor();
      return;
    }

    const capabilityChip = event.target.closest('[data-capability]');
    if (capabilityChip) {
      updateEditorDraftFromFields();
      const value = capabilityChip.dataset.capability;
      const list = state.editor.draft.capabilities;
      const index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1);
      else list.push(value);
      renderEditor();
      return;
    }

    const reasoningChip = event.target.closest('[data-reasoning]');
    if (reasoningChip) {
      const value = reasoningChip.dataset.reasoning;
      const list = state.editor.draft.reasoning;
      const index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1);
      else list.push(value);
      renderReasoningChips();
    }
  });

  $('#addReasoningBtn').addEventListener('click', () => {
    if (!state.editor) return;
    const list = state.editor.draft.reasoning;
    const value = list.includes('minimal') ? 'ultra' : 'minimal';
    if (!list.includes(value)) list.unshift(value);
    renderReasoningChips();
    toast('已添加推理等级', value);
  });

  $('#formatJsonBtn').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('#reasoningParamsInput').value);
      $('#reasoningParamsInput').value = JSON.stringify(parsed, null, 2);
      toast('JSON 已格式化');
    } catch {
      toast('JSON 格式有误', '请检查逗号、引号和括号。', 'danger');
    }
  });

  $('#resetModelFormBtn').addEventListener('click', resetEditorForm);
}

function setupGlobalEvents() {
  $('#addProviderBtn').addEventListener('click', openAddProviderModal);
  $('#listAddProviderBtn').addEventListener('click', openAddProviderModal);

  $('#refreshProvidersBtn').addEventListener('click', event => {
    const button = event.currentTarget;
    button.classList.add('is-spinning');
    window.setTimeout(() => {
      button.classList.remove('is-spinning');
      toast('供应商配置已刷新', '已重新读取本地供应商与模型缓存。');
    }, 650);
  });

  $('#newProviderFormat').addEventListener('click', event => {
    const item = event.target.closest('[data-value]');
    if (!item) return;
    state.newProviderFormat = item.dataset.value;
    $('#newProviderFormat').querySelectorAll('.segmented__item').forEach(button => {
      button.classList.toggle('is-active', button === item);
    });
  });

  $('#providerForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#providerNameInput').value.trim();
    const baseUrl = $('#providerBaseUrlInput').value.trim();
    const apiKey = $('#providerKeyInput').value.trim();
    if (!name || !baseUrl) {
      toast('信息不完整', '名称和 Base URL 都是必填项。', 'danger');
      return;
    }
    const id = `custom-${Date.now()}`;
    const provider = {
      id,
      name,
      group: '自定义供应商',
      subtitle: '自定义 · 刚刚添加',
      color: '#a78bfa',
      status: 'ok',
      canFetch: true,
      enabled: true,
      baseUrl,
      format: state.newProviderFormat,
      apiKey,
      models: [],
    };
    providers.push(provider);
    closeModal('providerModal');
    state.activeTab = 'providers';
    selectProvider(id);
    toast('供应商已添加', '现在可以从这个供应商获取模型，或手动添加模型。');
  });
}

function setupMenuAndNavEvents() {
  $('#apiFormatMenu').addEventListener('click', event => {
    const option = event.target.closest('[data-api-format]');
    if (!option) return;
    const provider = currentProvider();
    if (!provider) return;
    provider.format = option.dataset.apiFormat;
    closeFloatingMenus();
    renderProviderDetail();
    toast('API 格式已切换', formatLabel(provider.format));
  });

  $('#moreMenu').addEventListener('click', event => {
    const option = event.target.closest('[data-more-action]');
    if (!option) return;
    const providerId = $('#moreMenu').dataset.providerId;
    const provider = getProvider(providerId);
    if (!provider) return;
    const action = option.dataset.moreAction;
    closeFloatingMenus();

    if (action === 'fetch') {
      fetchModels(provider.id);
      return;
    }
    if (action === 'clear') {
      askConfirm({
        title: '清空模型列表？',
        message: `将移除 ${provider.name} 下全部 ${provider.models.length} 个本地模型配置。上游模型不会被删除。`,
        label: '清空列表',
        onConfirm: () => {
          provider.models = [];
          renderAll();
          toast('模型列表已清空', provider.name);
        },
      });
      return;
    }
    if (action === 'delete') {
      askConfirm({
        title: '删除供应商？',
        message: `将删除 ${provider.name} 及其本地模型配置。此操作不可撤销。`,
        label: '删除供应商',
        onConfirm: () => {
          const index = providers.findIndex(item => item.id === provider.id);
          if (index >= 0) providers.splice(index, 1);
          if (state.selectedProviderId === provider.id) {
            state.selectedProviderId = providers[0]?.id ?? '';
          }
          renderAll();
          toast('供应商已删除', provider.name);
        },
      });
    }
  });

  $('#confirmActionBtn').addEventListener('click', () => {
    const action = state.confirmAction;
    closeModal('confirmModal');
    if (typeof action === 'function') action();
  });

  document.addEventListener('click', event => {
    const closeButton = event.target.closest('[data-close]');
    if (closeButton) {
      closeModal(closeButton.dataset.close);
      return;
    }

    const navButton = event.target.closest('[data-tab]');
    if (navButton) {
      const tab = navButton.dataset.tab;
      state.activeTab = tab;
      $$('.nav-item').forEach(button => {
        const active = button.dataset.tab === tab;
        button.classList.toggle('is-active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      const isProviders = tab === 'providers';
      $('#providersPage').hidden = !isProviders;
      $('#placeholderPage').hidden = isProviders;
      const activeNav = $$('.nav-item').find(button => button.dataset.tab === tab);
      $('#placeholderTitle').textContent = `${activeNav?.querySelector('span')?.textContent ?? '设置'}设置`;
      $('.breadcrumbs strong').textContent = activeNav?.querySelector('span')?.textContent ?? '设置';
      closeFloatingMenus();
    }
  });
}

function setupWindowEvents() {
  $('#settingsSearch').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    $$('.settings-nav .nav-item').forEach(item => {
      item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query);
    });
    $$('.settings-nav .nav-group').forEach(group => {
      const visible = $$('.nav-item', group).some(item => !item.hidden);
      group.hidden = Boolean(query) && !visible;
    });
  });

  document.addEventListener('pointerdown', event => {
    if (!state.apiFormatOpen && !state.moreMenuOpen) return;
    if (event.target.closest('.floating-menu')) return;
    if (event.target.closest('#apiFormatTrigger') || event.target.closest('[data-more-provider]')) return;
    closeFloatingMenus();
  });

  window.addEventListener('resize', closeFloatingMenus);
  window.addEventListener('scroll', closeFloatingMenus, true);

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#settingsSearch').focus();
      return;
    }
    if (event.key !== 'Escape') return;
    const ids = ['confirmModal', 'modelEditorModal', 'modelPickerModal', 'providerModal'];
    const openLayer = ids.map(id => document.getElementById(id)).find(layer => layer && !layer.hidden);
    if (openLayer) {
      event.preventDefault();
      closeModal(openLayer.id);
    } else {
      closeFloatingMenus();
    }
  });
}

function init() {
  renderAll();
  setupProviderEvents();
  setupPickerEvents();
  setupEditorEvents();
  setupGlobalEvents();
  setupMenuAndNavEvents();
  setupWindowEvents();
}

init();



