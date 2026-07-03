// ==UserScript==
// @name         Nacos 配置列表分页与排序助手
// @namespace    local.nacos.config-page-query-utils
// @version      2.1.3
// @description  在 Nacos 2.x 配置管理页面提供可拖拽悬浮窗，支持记住每页条数、排序列和排序方向。
// @author       local
// @match        http://*/nacos*
// @match        https://*/nacos*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_ROUTE = '#/configurationManagement';
  const DEFAULT_PAGE_NO = '1';
  const SETTINGS_COOKIE_KEY = 'nacos_config_page_query_utils_settings';
  const SETTINGS_VERSION = 3;
  const SETTINGS_COOKIE_MAX_AGE = 31536000;
  const SETTINGS_COOKIE_PATH = '/nacos';
  const RESORT_DELAY_MS = 120;
  const PAGE_SIZE_REFRESH_DELAY_MS = 80;
  const NATIVE_PAGINATION_SYNC_DELAY_MS = 40;
  const JQUERY_PATCH_INTERVAL_MS = 50;
  const JQUERY_PATCH_TIMEOUT_MS = 10000;
  const LONG_PRESS_DRAG_MS = 250;
  const DRAG_EDGE_PADDING = 8;
  const DEFAULT_PANEL_RIGHT = 24;
  const DEFAULT_PANEL_TOP = 120;
  const FAB_SIZE = 48;
  const PANEL_WIDTH = 286;
  const PANEL_HEIGHT = 224;

  const SORT_COLUMNS = [
    {
      value: 'dataId',
      label: 'Data ID',
      aliases: ['dataid', 'data id'],
      responseKeys: ['dataId', 'dataID', 'data_id'],
    },
    {
      value: 'group',
      label: 'Group',
      aliases: ['group', '分组'],
      responseKeys: ['group', 'groupName'],
    },
    {
      value: 'appName',
      label: 'App Name',
      aliases: ['appname', 'app name', '归属应用', '应用名'],
      responseKeys: ['appName', 'app'],
    },
    {
      value: 'tenant',
      label: '命名空间',
      aliases: ['tenant', 'namespace', 'namespaceid', 'namespace id', '命名空间'],
      responseKeys: ['tenant', 'namespace', 'namespaceId'],
    },
  ];

  const DEFAULT_SETTINGS = {
    pageSize: '100',
    sortColumn: 'dataId',
    sortOrder: 'asc',
    panelPosition: null,
  };

  let settings = normalizeSettings(readCookieSettings());
  let sortTimer = 0;
  let observer = null;
  let normalizingHistory = false;
  let jqueryPatchTimer = 0;
  let jqueryPatchStartedAt = 0;
  let uiRoot = null;
  let uiStyle = null;
  let uiExpanded = false;
  let lastDragEndedAt = 0;

  function parsePositiveInteger(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const rawValue = String(value).trim();
    if (!/^\d+$/.test(rawValue)) {
      return null;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return null;
    }

    return Math.min(parsed, 9999);
  }

  function normalizePageSize(value, fallback) {
    const parsed = parsePositiveInteger(value);
    if (parsed !== null) {
      return String(parsed);
    }

    return fallback || DEFAULT_SETTINGS.pageSize;
  }

  function getSortColumnDefinition(value) {
    return SORT_COLUMNS.find((column) => column.value === value) || SORT_COLUMNS[0];
  }

  function normalizeSortColumn(value) {
    return getSortColumnDefinition(value).value;
  }

  function normalizeSortOrder(value) {
    return value === 'desc' ? 'desc' : 'asc';
  }

  function normalizeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getDefaultPanelPosition(controlWidth) {
    const width = controlWidth || FAB_SIZE;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || width + DEFAULT_PANEL_RIGHT;

    return {
      x: Math.max(DRAG_EDGE_PADDING, viewportWidth - width - DEFAULT_PANEL_RIGHT),
      y: DEFAULT_PANEL_TOP,
    };
  }

  function normalizeSettings(rawSettings) {
    const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const rawPosition = raw.panelPosition && typeof raw.panelPosition === 'object'
      ? raw.panelPosition
      : {};
    const savedX = normalizeNumber(rawPosition.x, null);
    const savedY = normalizeNumber(rawPosition.y, null);
    const hasSavedPosition = savedX !== null && savedY !== null;
    const isLegacyLeftDefaultPosition = raw.settingsVersion !== SETTINGS_VERSION
      && savedX === 24
      && savedY === 120;
    const panelPosition = hasSavedPosition && !isLegacyLeftDefaultPosition
      ? { x: savedX, y: savedY }
      : getDefaultPanelPosition();

    return {
      settingsVersion: SETTINGS_VERSION,
      pageSize: normalizePageSize(raw.pageSize, DEFAULT_SETTINGS.pageSize),
      sortColumn: normalizeSortColumn(raw.sortColumn),
      sortOrder: normalizeSortOrder(raw.sortOrder),
      panelPosition,
    };
  }

  function getCookieValue(key) {
    const cookies = String(document.cookie || '').split(';');
    for (const cookie of cookies) {
      const trimmed = cookie.trim();
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const cookieKey = trimmed.slice(0, separatorIndex);
      if (cookieKey === key) {
        return trimmed.slice(separatorIndex + 1);
      }
    }
    return '';
  }

  function readCookieSettings() {
    const value = getCookieValue(SETTINGS_COOKIE_KEY);
    if (!value) {
      return {};
    }

    try {
      return JSON.parse(decodeURIComponent(value));
    } catch (error) {
      return {};
    }
  }

  function writeCookieSettings() {
    const persisted = {
      settingsVersion: SETTINGS_VERSION,
      pageSize: settings.pageSize,
      sortColumn: settings.sortColumn,
      sortOrder: settings.sortOrder,
      panelPosition: {
        x: Math.round(settings.panelPosition.x),
        y: Math.round(settings.panelPosition.y),
      },
    };

    document.cookie = [
      `${SETTINGS_COOKIE_KEY}=${encodeURIComponent(JSON.stringify(persisted))}`,
      `path=${SETTINGS_COOKIE_PATH}`,
      `max-age=${SETTINGS_COOKIE_MAX_AGE}`,
      'SameSite=Lax',
    ].join('; ');
  }

  function updateSettings(partialSettings, options) {
    const updateOptions = options || {};
    const rawSettings = Object.assign({}, settings, partialSettings || {});
    if (partialSettings && partialSettings.panelPosition) {
      rawSettings.panelPosition = Object.assign({}, settings.panelPosition, partialSettings.panelPosition);
    }

    const previousSettings = settings;
    const nextSettings = normalizeSettings(rawSettings);
    const pageSizeChanged = nextSettings.pageSize !== previousSettings.pageSize;
    const sortChanged = nextSettings.sortColumn !== previousSettings.sortColumn
      || nextSettings.sortOrder !== previousSettings.sortOrder;
    const positionChanged = nextSettings.panelPosition.x !== previousSettings.panelPosition.x
      || nextSettings.panelPosition.y !== previousSettings.panelPosition.y;

    if (!pageSizeChanged
      && !sortChanged
      && !positionChanged
      && !updateOptions.forcePersist
      && !updateOptions.forceSortApply
      && !updateOptions.forcePageSizeApply) {
      return false;
    }

    settings = nextSettings;

    if (uiRoot) {
      applyRootPosition();
      updateUiValues();
    }

    if (updateOptions.persist !== false) {
      writeCookieSettings();
    }

    if ((pageSizeChanged && updateOptions.applyPageSize) || updateOptions.forcePageSizeApply) {
      applyPageSizePreference();
    }

    if (sortChanged || updateOptions.forceSortApply) {
      applySortPreference();
    }

    return true;
  }

  function pageBaseUrl() {
    return window.location.href.split('#')[0];
  }

  function toUrl(rawUrl) {
    try {
      return new URL(String(rawUrl), pageBaseUrl());
    } catch (error) {
      return null;
    }
  }

  function isNacosPath(pathname) {
    const pathnameText = String(pathname || '').toLowerCase();
    return pathnameText === '/nacos' || pathnameText.startsWith('/nacos/');
  }

  function isTargetHash(hash) {
    return String(hash || '').startsWith(TARGET_ROUTE);
  }

  function isTargetRoute() {
    return isNacosPath(window.location.pathname) && isTargetHash(window.location.hash);
  }

  function normalizeConfigHash(hash, options) {
    if (!isTargetHash(hash)) {
      return hash;
    }

    const normalizeOptions = options || {};
    const queryIndex = hash.indexOf('?');
    const route = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));

    params.set('pageSize', settings.pageSize);
    if (normalizeOptions.resetPageNo) {
      params.set('pageNo', DEFAULT_PAGE_NO);
    }

    return `${route}?${params.toString()}`;
  }

  function normalizeHistoryUrl(rawUrl) {
    if (rawUrl === undefined || rawUrl === null || rawUrl === '') {
      return rawUrl;
    }

    const url = toUrl(rawUrl);
    if (!url || !isNacosPath(url.pathname) || !isTargetHash(url.hash)) {
      return rawUrl;
    }

    const nextHash = normalizeConfigHash(url.hash);
    if (nextHash === url.hash) {
      return rawUrl;
    }

    url.hash = nextHash;
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function dispatchSyntheticHashChange(oldUrl) {
    if (typeof HashChangeEvent === 'function') {
      window.dispatchEvent(new HashChangeEvent('hashchange', {
        oldURL: oldUrl,
        newURL: window.location.href,
      }));
    } else {
      window.dispatchEvent(new Event('hashchange'));
    }
  }

  function dispatchSyntheticPopState() {
    if (typeof PopStateEvent === 'function') {
      window.dispatchEvent(new PopStateEvent('popstate', {
        state: window.history.state,
      }));
    } else {
      window.dispatchEvent(new Event('popstate'));
    }
  }

  function isVisibleElement(element) {
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && style.pointerEvents !== 'none';
  }

  function getActionText(element) {
    return (element ? element.innerText || element.textContent || element.getAttribute('title') || '' : '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function findConfigQueryButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], .next-btn'));
    return buttons.find((button) => {
      if (!isVisibleElement(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        return false;
      }

      const text = getActionText(button);
      if (!text || /(重置|reset|删除|delete|新建|创建|create|导出|export)/i.test(text)) {
        return false;
      }

      return text === '查询'
        || text === '搜索'
        || text === 'search'
        || text === 'query'
        || text.includes('查询')
        || text.includes('search');
    });
  }

  function triggerConfigListRefresh() {
    if (!isTargetRoute()) {
      return;
    }

    window.setTimeout(() => {
      if (!isTargetRoute()) {
        return;
      }

      dispatchSyntheticHashChange(window.location.href);
      dispatchSyntheticPopState();

      const queryButton = findConfigQueryButton();
      if (queryButton) {
        queryButton.click();
      }

      window.setTimeout(() => {
        syncNativePagination(settings.pageSize);
      }, NATIVE_PAGINATION_SYNC_DELAY_MS);
    }, PAGE_SIZE_REFRESH_DELAY_MS);
  }

  function normalizeCurrentHash(options) {
    const normalizeOptions = options || {};
    if (!isTargetRoute()) {
      return false;
    }

    const oldUrl = window.location.href;
    const nextHash = normalizeConfigHash(window.location.hash, normalizeOptions);
    if (nextHash === window.location.hash) {
      if (normalizeOptions.forceDispatch) {
        dispatchSyntheticHashChange(oldUrl);
      }
      return false;
    }

    normalizingHistory = true;
    try {
      window.history.replaceState(
        window.history.state,
        document.title,
        `${window.location.pathname}${window.location.search}${nextHash}`,
      );
    } finally {
      normalizingHistory = false;
    }

    dispatchSyntheticHashChange(oldUrl);
    return true;
  }

  function applyPageSizePreference() {
    if (!isTargetRoute()) {
      return;
    }

    const oldUrl = window.location.href;
    const nextHash = normalizeConfigHash(window.location.hash, {
      resetPageNo: true,
    });
    if (nextHash !== window.location.hash) {
      window.location.hash = nextHash;
    } else {
      dispatchSyntheticHashChange(oldUrl);
    }

    syncNativePagination(settings.pageSize);
    window.setTimeout(() => {
      syncNativePagination(settings.pageSize);
    }, NATIVE_PAGINATION_SYNC_DELAY_MS);
    triggerConfigListRefresh();
  }

  function isConfigListEndpoint(url) {
    if (!url || url.origin !== window.location.origin) {
      return false;
    }

    const path = url.pathname.toLowerCase();
    return /\/v\d+\/cs\/configs$/.test(path)
      || path.includes('/diamond-ops/configlist/serverid/');
  }

  function isConfigListRequest(url, method) {
    return String(method || 'GET').toUpperCase() === 'GET'
      && isTargetRoute()
      && isConfigListEndpoint(url);
  }

  function normalizeConfigListRequest(rawUrl, method) {
    const url = toUrl(rawUrl);
    const target = isConfigListRequest(url, method);
    if (!target) {
      return { target: false, url: rawUrl };
    }

    url.searchParams.set('pageSize', settings.pageSize);

    return { target: true, url: url.toString() };
  }

  function setPageParams(params, options) {
    const paramOptions = options || {};
    params.set('pageSize', settings.pageSize);
    if (paramOptions.resetPageNo) {
      params.set('pageNo', DEFAULT_PAGE_NO);
    }
  }

  function normalizeAjaxData(data, options) {
    if (!data) {
      return data;
    }

    if (typeof data === 'string') {
      const params = new URLSearchParams(data);
      setPageParams(params, options);
      return params.toString();
    }

    if (data instanceof URLSearchParams) {
      const next = new URLSearchParams(data);
      setPageParams(next, options);
      return next;
    }

    if (typeof FormData === 'function' && data instanceof FormData) {
      data.set('pageSize', settings.pageSize);
      if (options && options.resetPageNo) {
        data.set('pageNo', DEFAULT_PAGE_NO);
      }
      return data;
    }

    if (Object.prototype.toString.call(data) === '[object Object]') {
      const nextData = Object.assign({}, data, {
        pageSize: settings.pageSize,
      });
      if (options && options.resetPageNo) {
        nextData.pageNo = DEFAULT_PAGE_NO;
      }
      return nextData;
    }

    return data;
  }

  function readSortValue(item, columnValue) {
    if (!item || typeof item !== 'object') {
      return '';
    }

    const column = getSortColumnDefinition(columnValue);
    const keys = [column.value].concat(column.responseKeys || []);
    for (const key of keys) {
      if (item[key] !== undefined && item[key] !== null) {
        return String(item[key]);
      }
    }

    return '';
  }

  function compareSortKeys(leftKey, rightKey) {
    const compared = String(leftKey).localeCompare(String(rightKey), undefined, {
      numeric: true,
      sensitivity: 'base',
    });

    return settings.sortOrder === 'desc' ? -compared : compared;
  }

  function sortConfigList(list) {
    if (!Array.isArray(list) || list.length < 2) {
      return false;
    }

    const sortedItems = list
      .map((item, index) => ({
        item,
        index,
        key: readSortValue(item, settings.sortColumn),
      }))
      .sort((left, right) => {
        const compared = compareSortKeys(left.key, right.key);
        return compared || left.index - right.index;
      });

    const alreadySorted = sortedItems.every((entry, index) => entry.item === list[index]);
    if (alreadySorted) {
      return false;
    }

    sortedItems.forEach((entry, index) => {
      list[index] = entry.item;
    });
    return true;
  }

  function transformResponsePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    sortConfigList(payload.pageItems);
    sortConfigList(payload.data);
    if (payload.data && typeof payload.data === 'object') {
      sortConfigList(payload.data.pageItems);
      sortConfigList(payload.data.data);
    }
    return payload;
  }

  function transformResponseText(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return text;
    }

    try {
      return JSON.stringify(transformResponsePayload(JSON.parse(text)));
    } catch (error) {
      return text;
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__nacosConfigPageQueryPatched) {
      return;
    }

    const nativeFetch = window.fetch;
    function patchedFetch(input, init) {
      const method = init && init.method
        ? init.method
        : input instanceof Request
          ? input.method
          : 'GET';

      let target = false;
      let nextInput = input;

      if (typeof input === 'string' || input instanceof URL) {
        const normalized = normalizeConfigListRequest(input.toString(), method);
        target = normalized.target;
        nextInput = normalized.url;
      } else if (input instanceof Request) {
        const normalized = normalizeConfigListRequest(input.url, method);
        target = normalized.target;
        if (target) {
          nextInput = new Request(normalized.url, input);
        }
      }

      return nativeFetch.call(this, nextInput, init).then((response) => {
        if (!target) {
          return response;
        }

        return response.clone().text().then((text) => {
          const headers = new Headers(response.headers);
          headers.delete('content-length');

          return new Response(transformResponseText(text), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        });
      });
    }

    patchedFetch.__nacosConfigPageQueryPatched = true;
    window.fetch = patchedFetch;
  }

  function findDescriptor(object, property) {
    let cursor = object;
    while (cursor) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        return descriptor;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
  }

  function patchXhrResponse(xhr) {
    if (xhr.__nacosConfigPageQueryResponsePatched) {
      return;
    }

    const responseTextDescriptor = findDescriptor(window.XMLHttpRequest.prototype, 'responseText');
    const responseDescriptor = findDescriptor(window.XMLHttpRequest.prototype, 'response');
    if (!responseTextDescriptor || typeof responseTextDescriptor.get !== 'function') {
      return;
    }

    xhr.__nacosConfigPageQueryResponsePatched = true;

    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get() {
        const rawText = responseTextDescriptor.get.call(this);
        if (!this.__nacosConfigPageQueryListRequest) {
          return rawText;
        }

        if (this.__nacosConfigPageQueryRawText === rawText) {
          return this.__nacosConfigPageQuerySortedText;
        }

        this.__nacosConfigPageQueryRawText = rawText;
        this.__nacosConfigPageQuerySortedText = transformResponseText(rawText);
        return this.__nacosConfigPageQuerySortedText;
      },
    });

    if (responseDescriptor && typeof responseDescriptor.get === 'function') {
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          const rawResponse = responseDescriptor.get.call(this);
          if (!this.__nacosConfigPageQueryListRequest) {
            return rawResponse;
          }

          if (this.responseType === '' || this.responseType === 'text') {
            return this.responseText;
          }

          if (this.responseType === 'json') {
            return transformResponsePayload(rawResponse);
          }

          return rawResponse;
        },
      });
    }
  }

  function patchXhr() {
    if (!window.XMLHttpRequest || window.XMLHttpRequest.prototype.open.__nacosConfigPageQueryPatched) {
      return;
    }

    const nativeOpen = window.XMLHttpRequest.prototype.open;
    function patchedOpen(method, url) {
      const normalized = normalizeConfigListRequest(url, method);
      this.__nacosConfigPageQueryListRequest = normalized.target;
      if (normalized.target) {
        patchXhrResponse(this);
      }

      return nativeOpen.apply(this, [method, normalized.url].concat(Array.prototype.slice.call(arguments, 2)));
    }

    patchedOpen.__nacosConfigPageQueryPatched = true;
    window.XMLHttpRequest.prototype.open = patchedOpen;
  }

  function normalizeAjaxOptions(options) {
    if (!options || !options.url) {
      return options;
    }

    const method = options.type || options.method || 'GET';
    const normalized = normalizeConfigListRequest(options.url, method);
    if (!normalized.target) {
      return options;
    }

    const nextOptions = Object.assign({}, options, {
      url: normalized.url,
      data: normalizeAjaxData(options.data),
    });
    const originalDataFilter = options.dataFilter;

    nextOptions.dataFilter = function patchedDataFilter(data, type) {
      const filteredData = typeof originalDataFilter === 'function'
        ? originalDataFilter.call(this, data, type)
        : data;

      return transformResponseText(filteredData);
    };

    return nextOptions;
  }

  function patchJqueryAjax() {
    const jquery = window.jQuery || window.$;
    if (!jquery || typeof jquery.ajax !== 'function' || jquery.ajax.__nacosConfigPageQueryPatched) {
      return false;
    }

    const nativeAjax = jquery.ajax;
    function patchedAjax(urlOrOptions, maybeOptions) {
      if (typeof urlOrOptions === 'string') {
        const options = normalizeAjaxOptions(Object.assign({}, maybeOptions || {}, { url: urlOrOptions }));
        return nativeAjax.call(this, options);
      }

      return nativeAjax.call(this, normalizeAjaxOptions(urlOrOptions));
    }

    patchedAjax.__nacosConfigPageQueryPatched = true;
    jquery.ajax = patchedAjax;
    return true;
  }

  function startJqueryPatchLoop() {
    if (patchJqueryAjax()) {
      return;
    }

    jqueryPatchStartedAt = Date.now();
    jqueryPatchTimer = window.setInterval(() => {
      if (patchJqueryAjax() || Date.now() - jqueryPatchStartedAt > JQUERY_PATCH_TIMEOUT_MS) {
        window.clearInterval(jqueryPatchTimer);
      }
    }, JQUERY_PATCH_INTERVAL_MS);
  }

  function normalizeText(element) {
    return (element ? element.innerText || element.textContent || '' : '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getReactFiber(element) {
    if (!element) {
      return null;
    }

    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$')
      || name.startsWith('__reactInternalInstance$'));
    return key ? element[key] : null;
  }

  function getFiberProps(fiber) {
    if (!fiber) {
      return null;
    }

    return fiber.memoizedProps || fiber.pendingProps || null;
  }

  function isPaginationProps(props) {
    if (!props || typeof props !== 'object') {
      return false;
    }

    const hasPageSize = props.pageSize !== undefined || props.defaultPageSize !== undefined;
    const hasTotal = props.total !== undefined || props.totalCount !== undefined || props.pagesAvailable !== undefined;
    const hasPaginationCallback = typeof props.onChange === 'function'
      || typeof props.onPageSizeChange === 'function'
      || typeof props.onShowSizeChange === 'function';

    return hasPageSize && hasPaginationCallback && (hasTotal || props.current !== undefined || props.defaultCurrent !== undefined);
  }

  function getPaginationRoots() {
    return Array.from(document.querySelectorAll(
      '.next-pagination, .ant-pagination, [class*="pagination"], [class*="Pagination"]',
    )).filter(isVisibleElement);
  }

  function collectPaginationFibers() {
    const roots = getPaginationRoots();
    const fibers = [];
    const seenFibers = new Set();

    roots.forEach((root) => {
      const elements = [root].concat(Array.from(root.querySelectorAll('*')));
      elements.forEach((element) => {
        let fiber = getReactFiber(element);
        let depth = 0;
        while (fiber && depth < 12) {
          if (!seenFibers.has(fiber)) {
            seenFibers.add(fiber);
            fibers.push(fiber);
          }
          fiber = fiber.return;
          depth += 1;
        }
      });
    });

    return fibers;
  }

  function callSafely(callback, args) {
    try {
      callback.apply(null, args);
      return true;
    } catch (error) {
      return false;
    }
  }

  function syncPaginationProps(pageSize) {
    const pageSizeNumber = Number(pageSize);
    const seenProps = new Set();
    let synced = false;

    collectPaginationFibers().forEach((fiber) => {
      const props = getFiberProps(fiber);
      if (!isPaginationProps(props) || seenProps.has(props)) {
        return;
      }

      seenProps.add(props);

      if (typeof props.onPageSizeChange === 'function') {
        synced = callSafely(props.onPageSizeChange, [pageSizeNumber]) || synced;
      }

      if (typeof props.onShowSizeChange === 'function') {
        synced = callSafely(props.onShowSizeChange, [1, pageSizeNumber]) || synced;
      }

      if (typeof props.onChange === 'function') {
        synced = callSafely(props.onChange, [1, pageSizeNumber]) || synced;
      }
    });

    return synced;
  }

  function patchPaginationStateObject(state, pageSize) {
    if (!state || typeof state !== 'object') {
      return null;
    }

    const pageSizeNumber = Number(pageSize);
    let nextState = null;

    if (Object.prototype.hasOwnProperty.call(state, 'pageSize')) {
      nextState = Object.assign({}, state, {
        current: 1,
        pageNo: 1,
        pageNumber: 1,
        pageSize: pageSizeNumber,
      });
    }

    if (state.page && typeof state.page === 'object' && Object.prototype.hasOwnProperty.call(state.page, 'pageSize')) {
      nextState = Object.assign({}, nextState || state, {
        page: Object.assign({}, state.page, {
          current: 1,
          pageNo: 1,
          pageNumber: 1,
          pageSize: pageSizeNumber,
        }),
      });
    }

    ['pagination', 'pageInfo'].forEach((key) => {
      if (state[key] && typeof state[key] === 'object' && Object.prototype.hasOwnProperty.call(state[key], 'pageSize')) {
        nextState = Object.assign({}, nextState || state, {
          [key]: Object.assign({}, state[key], {
            current: 1,
            pageNo: 1,
            pageNumber: 1,
            pageSize: pageSizeNumber,
          }),
        });
      }
    });

    return nextState;
  }

  function syncPaginationState(pageSize) {
    const seenInstances = new Set();
    let synced = false;

    collectPaginationFibers().forEach((fiber) => {
      let cursor = fiber;
      let depth = 0;
      while (cursor && depth < 12) {
        const instance = cursor.stateNode;
        if (instance && typeof instance.setState === 'function' && instance.state && !seenInstances.has(instance)) {
          seenInstances.add(instance);
          const nextState = patchPaginationStateObject(instance.state, pageSize);
          if (nextState) {
            try {
              instance.setState(nextState);
              synced = true;
            } catch (error) {
              // 忽略非目标 React 实例的 setState 异常。
            }
          }
        }

        cursor = cursor.return;
        depth += 1;
      }
    });

    return synced;
  }

  function updateNativePaginationText(pageSize) {
    const pageSizeText = String(pageSize);
    getPaginationRoots().forEach((root) => {
      Array.from(root.querySelectorAll('input')).forEach((input) => {
        const label = normalizeText(input.closest('label') || input.parentElement || root).toLowerCase();
        if (/size|每页|条/.test(label) && input.value !== pageSizeText) {
          input.value = pageSizeText;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
  }

  function syncNativePagination(pageSize) {
    const propsSynced = syncPaginationProps(pageSize);
    const stateSynced = syncPaginationState(pageSize);
    updateNativePaginationText(pageSize);
    return propsSynced || stateSynced;
  }

  function normalizeComparableText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\s+/g, '');
  }

  function getHeaderCells(table) {
    const ownHeaders = Array.from(table.querySelectorAll('thead th, thead td'));
    if (ownHeaders.length > 0) {
      return ownHeaders;
    }

    const wrapper = table.closest('.next-table, .ant-table-wrapper, [class*="table"]');
    if (!wrapper) {
      return [];
    }

    return Array.from(wrapper.querySelectorAll('thead th, thead td'));
  }

  function isHeaderForColumn(cell, column) {
    const headerText = normalizeComparableText(normalizeText(cell));
    if (!headerText) {
      return false;
    }

    return column.aliases.some((alias) => {
      const normalizedAlias = normalizeComparableText(alias);
      return headerText === normalizedAlias || headerText.includes(normalizedAlias);
    });
  }

  function findSortColumnIndex(table, rows) {
    const headers = getHeaderCells(table);
    const column = getSortColumnDefinition(settings.sortColumn);
    const headerIndex = headers.findIndex((cell) => isHeaderForColumn(cell, column));
    if (headerIndex !== -1) {
      return headerIndex;
    }

    if (column.value !== 'dataId') {
      return -1;
    }

    const firstRow = rows[0];
    if (!firstRow) {
      return -1;
    }

    const cells = Array.from(firstRow.children);
    const checkboxIndex = cells.findIndex((cell) => cell.querySelector('input[type="checkbox"]'));
    if (checkboxIndex === 0 && cells.length > 1) {
      return 1;
    }

    return cells.length > 0 ? 0 : -1;
  }

  function getSortableRows(tbody) {
    return Array.from(tbody.children)
      .filter((row) => row.matches('tr') && row.children.length > 1);
  }

  function rowKey(row, columnIndex) {
    return normalizeText(row.children[columnIndex]);
  }

  function sortOneTable(table) {
    const bodies = Array.from(table.tBodies || []);
    for (const tbody of bodies) {
      const rows = getSortableRows(tbody);
      if (rows.length < 2) {
        continue;
      }

      const columnIndex = findSortColumnIndex(table, rows);
      if (columnIndex < 0) {
        continue;
      }

      const sortedRows = rows
        .map((row, index) => ({ row, index, key: rowKey(row, columnIndex) }))
        .sort((left, right) => {
          const compared = compareSortKeys(left.key, right.key);
          return compared || left.index - right.index;
        })
        .map((item) => item.row);

      const alreadySorted = sortedRows.every((row, index) => row === rows[index]);
      if (!alreadySorted) {
        const fragment = document.createDocumentFragment();
        sortedRows.forEach((row) => fragment.appendChild(row));
        tbody.appendChild(fragment);
      }
    }
  }

  function sortConfigTables() {
    if (!isTargetRoute()) {
      return;
    }

    const tables = Array.from(document.querySelectorAll('table'))
      .filter((table) => table.tBodies && table.tBodies.length > 0);

    tables.forEach(sortOneTable);
  }

  function scheduleSort() {
    window.clearTimeout(sortTimer);
    sortTimer = window.setTimeout(sortConfigTables, RESORT_DELAY_MS);
  }

  function applySortPreference() {
    sortConfigTables();
    scheduleSort();
  }

  function ensureUiStyle() {
    if (uiStyle) {
      return;
    }

    uiStyle = document.createElement('style');
    uiStyle.id = 'nacos-config-page-query-utils-style';
    uiStyle.textContent = `
#nacos-config-page-query-utils-root {
  position: fixed;
  left: auto;
  right: ${DEFAULT_PANEL_RIGHT}px;
  top: ${DEFAULT_PANEL_TOP}px;
  z-index: 2147483647;
  width: ${FAB_SIZE}px;
  height: ${FAB_SIZE}px;
  color: #1f2933;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
  line-height: 1.4;
  transition: width 180ms ease, height 180ms ease, filter 180ms ease;
}
#nacos-config-page-query-utils-root,
#nacos-config-page-query-utils-root * {
  box-sizing: border-box;
}
#nacos-config-page-query-utils-root.ncpqu-root--hidden {
  display: none;
}
#nacos-config-page-query-utils-root.ncpqu-root--collapsed {
  width: ${FAB_SIZE}px;
  height: ${FAB_SIZE}px;
}
#nacos-config-page-query-utils-root.ncpqu-root--expanded {
  width: min(${PANEL_WIDTH}px, calc(100vw - ${DRAG_EDGE_PADDING * 2}px));
  height: ${PANEL_HEIGHT}px;
}
#nacos-config-page-query-utils-root.ncpqu-root--dragging {
  filter: saturate(1.08);
}
.ncpqu-surface {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid rgba(20, 120, 255, 0.22);
  border-radius: 999px;
  box-shadow: 0 12px 30px rgba(20, 120, 255, 0.22);
  transition: border-radius 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
}
.ncpqu-root--expanded .ncpqu-surface {
  border-radius: 8px;
  box-shadow: 0 18px 44px rgba(20, 120, 255, 0.22);
}
.ncpqu-fab,
.ncpqu-panel {
  position: absolute;
  inset: 0;
  transform-origin: top right;
  transition: opacity 160ms ease, transform 180ms ease;
}
.ncpqu-fab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: #ffffff;
  background: linear-gradient(135deg, #1478ff 0%, #1683ff 48%, #1aa7ff 100%);
  box-shadow: 0 12px 28px rgba(20, 120, 255, 0.32);
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.ncpqu-fab:hover {
  filter: brightness(1.04);
}
.ncpqu-fab-main {
  display: block;
  max-width: 42px;
  overflow: hidden;
  font-size: 14px;
  font-weight: 700;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ncpqu-fab-sub {
  display: block;
  font-size: 10px;
  line-height: 12px;
  opacity: 0.86;
}
.ncpqu-root--expanded .ncpqu-fab {
  opacity: 0;
  pointer-events: none;
  transform: scale(0.82);
}
.ncpqu-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.96);
}
.ncpqu-root--expanded .ncpqu-panel {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}
.ncpqu-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 44px;
  min-width: 0;
  padding: 0 10px 0 14px;
  color: #0f172a;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.ncpqu-root--dragging .ncpqu-panel-header,
.ncpqu-root--dragging .ncpqu-fab {
  cursor: grabbing;
}
.ncpqu-panel-title {
  overflow: hidden;
  font-size: 14px;
  font-weight: 700;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ncpqu-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: #475569;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.ncpqu-close:hover {
  color: #0f172a;
  background: #e2e8f0;
}
.ncpqu-panel-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding: 14px;
}
.ncpqu-field {
  display: grid;
  grid-template-columns: 80px 1fr;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.ncpqu-field span {
  overflow: hidden;
  color: #475569;
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ncpqu-field input,
.ncpqu-field select {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  color: #0f172a;
  background: #ffffff;
  font-size: 13px;
  outline: none;
}
.ncpqu-field input:focus,
.ncpqu-field select:focus {
  border-color: #1478ff;
  box-shadow: 0 0 0 2px rgba(20, 120, 255, 0.14);
}
.ncpqu-field input.ncpqu-invalid {
  border-color: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.12);
}
`;

    (document.head || document.documentElement).appendChild(uiStyle);
  }

  function getUiElement(selector) {
    return uiRoot ? uiRoot.querySelector(selector) : null;
  }

  function populateSortColumnOptions(select) {
    select.innerHTML = '';
    SORT_COLUMNS.forEach((column) => {
      const option = document.createElement('option');
      option.value = column.value;
      option.textContent = column.label;
      select.appendChild(option);
    });
  }

  function updateUiValues() {
    if (!uiRoot) {
      return;
    }

    const fabMain = getUiElement('.ncpqu-fab-main');
    const fab = getUiElement('.ncpqu-fab');
    const pageSizeInput = getUiElement('.ncpqu-page-size');
    const sortColumnSelect = getUiElement('.ncpqu-sort-column');
    const sortOrderSelect = getUiElement('.ncpqu-sort-order');

    if (fabMain) {
      fabMain.textContent = settings.pageSize;
    }

    if (fab) {
      fab.title = `配置分页与排序，当前每页 ${settings.pageSize} 条`;
    }

    if (pageSizeInput && document.activeElement !== pageSizeInput) {
      pageSizeInput.value = settings.pageSize;
      pageSizeInput.classList.remove('ncpqu-invalid');
    }

    if (sortColumnSelect) {
      sortColumnSelect.value = settings.sortColumn;
    }

    if (sortOrderSelect) {
      sortOrderSelect.value = settings.sortOrder;
    }
  }

  function getExpectedRootSize(expanded) {
    return expanded
      ? { width: Math.min(PANEL_WIDTH, Math.max(FAB_SIZE, window.innerWidth - DRAG_EDGE_PADDING * 2)), height: PANEL_HEIGHT }
      : { width: FAB_SIZE, height: FAB_SIZE };
  }

  function getRootSize() {
    return getExpectedRootSize(uiExpanded);
  }

  function clampPosition(position) {
    const size = getRootSize();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || size.width;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || size.height;
    const maxX = Math.max(DRAG_EDGE_PADDING, viewportWidth - size.width - DRAG_EDGE_PADDING);
    const maxY = Math.max(DRAG_EDGE_PADDING, viewportHeight - size.height - DRAG_EDGE_PADDING);

    return {
      x: Math.min(Math.max(DRAG_EDGE_PADDING, position.x), maxX),
      y: Math.min(Math.max(DRAG_EDGE_PADDING, position.y), maxY),
    };
  }

  function applyRootPosition(position) {
    if (!uiRoot) {
      return;
    }

    const nextPosition = clampPosition(position || settings.panelPosition);
    const size = getRootSize();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || size.width;
    const right = Math.max(DRAG_EDGE_PADDING, viewportWidth - nextPosition.x - size.width);
    settings.panelPosition = nextPosition;
    uiRoot.style.left = 'auto';
    uiRoot.style.right = `${Math.round(right)}px`;
    uiRoot.style.top = `${Math.round(nextPosition.y)}px`;
  }

  function updateRootMode(options) {
    const modeOptions = options || {};
    if (!uiRoot) {
      return;
    }

    uiRoot.classList.toggle('ncpqu-root--expanded', uiExpanded);
    uiRoot.classList.toggle('ncpqu-root--collapsed', !uiExpanded);

    const panel = getUiElement('.ncpqu-panel');
    const fab = getUiElement('.ncpqu-fab');
    if (panel) {
      panel.setAttribute('aria-hidden', uiExpanded ? 'false' : 'true');
    }
    if (fab) {
      fab.setAttribute('aria-hidden', uiExpanded ? 'true' : 'false');
    }

    window.setTimeout(() => {
      if (typeof modeOptions.keepRightEdge === 'number') {
        applyRootPosition({
          x: modeOptions.keepRightEdge - getRootSize().width,
          y: settings.panelPosition.y,
        });
      } else {
        applyRootPosition();
      }
      writeCookieSettings();
    }, 0);
  }

  function setPanelExpanded(expanded) {
    if (uiExpanded === expanded) {
      return;
    }

    const currentSize = getRootSize();
    const keepRightEdge = settings.panelPosition.x + currentSize.width;
    uiExpanded = expanded;
    updateRootMode({ keepRightEdge });
  }

  function validatePageSizeDraft(input) {
    const value = parsePositiveInteger(input.value);
    if (value === null) {
      input.classList.add('ncpqu-invalid');
      return false;
    }

    input.classList.remove('ncpqu-invalid');
    return true;
  }

  function commitPageSizeInput(input) {
    const value = parsePositiveInteger(input.value);
    if (value === null) {
      input.value = settings.pageSize;
      input.classList.remove('ncpqu-invalid');
      return;
    }

    const nextPageSize = String(value);
    input.value = nextPageSize;
    input.classList.remove('ncpqu-invalid');
    updateSettings({ pageSize: nextPageSize }, {
      applyPageSize: true,
    });
  }

  function commitSortColumnSelect(select) {
    updateSettings({ sortColumn: select.value }, {
      forceSortApply: true,
    });
  }

  function commitSortOrderSelect(select) {
    updateSettings({ sortOrder: select.value }, {
      forceSortApply: true,
    });
  }

  function isDragIgnoredTarget(target, allowInteractiveTarget) {
    if (allowInteractiveTarget) {
      return false;
    }

    return Boolean(target.closest('button, input, select, textarea, label, a'));
  }

  function bindLongPressDrag(handle, options) {
    const dragOptions = options || {};
    let pressTimer = 0;
    let pointerId = null;
    let dragging = false;
    let latestPointer = null;
    let grabOffset = null;

    function clearPressTimer() {
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    }

    function moveToPointer(pointer) {
      if (!pointer || !grabOffset) {
        return;
      }

      applyRootPosition({
        x: pointer.clientX - grabOffset.x,
        y: pointer.clientY - grabOffset.y,
      });
    }

    function removeDocumentListeners() {
      document.removeEventListener('pointermove', onDocumentPointerMove, true);
      document.removeEventListener('pointerup', onDocumentPointerEnd, true);
      document.removeEventListener('pointercancel', onDocumentPointerEnd, true);
    }

    function endDrag(event) {
      clearPressTimer();
      if (dragging) {
        event.preventDefault();
        lastDragEndedAt = Date.now();
        uiRoot.classList.remove('ncpqu-root--dragging');
        writeCookieSettings();
      }

      removeDocumentListeners();
      pointerId = null;
      dragging = false;
      latestPointer = null;
      grabOffset = null;
    }

    function onDocumentPointerMove(event) {
      if (pointerId !== event.pointerId) {
        return;
      }

      latestPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
      };

      if (!dragging) {
        return;
      }

      event.preventDefault();
      moveToPointer(latestPointer);
    }

    function onDocumentPointerEnd(event) {
      if (pointerId !== event.pointerId) {
        return;
      }

      endDrag(event);
    }

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) {
        return;
      }

      if (isDragIgnoredTarget(event.target, dragOptions.allowInteractiveTarget)) {
        return;
      }

      pointerId = event.pointerId;
      latestPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const rootRect = uiRoot.getBoundingClientRect();
      grabOffset = {
        x: event.clientX - rootRect.left,
        y: event.clientY - rootRect.top,
      };

      clearPressTimer();
      document.addEventListener('pointermove', onDocumentPointerMove, true);
      document.addEventListener('pointerup', onDocumentPointerEnd, true);
      document.addEventListener('pointercancel', onDocumentPointerEnd, true);

      pressTimer = window.setTimeout(() => {
        dragging = true;
        uiRoot.classList.add('ncpqu-root--dragging');
        moveToPointer(latestPointer);
      }, LONG_PRESS_DRAG_MS);
    });
  }

  function ensureUiRoot() {
    if (uiRoot || !document.body) {
      return uiRoot;
    }

    ensureUiStyle();
    uiRoot = document.createElement('div');
    uiRoot.id = 'nacos-config-page-query-utils-root';
    uiRoot.className = 'ncpqu-root ncpqu-root--collapsed ncpqu-root--hidden';
    uiRoot.innerHTML = `
<div class="ncpqu-surface">
  <button class="ncpqu-fab" type="button" title="配置分页与排序">
    <span class="ncpqu-fab-main"></span>
    <span class="ncpqu-fab-sub">条</span>
  </button>
  <section class="ncpqu-panel" aria-label="Nacos 配置列表设置" aria-hidden="true">
    <header class="ncpqu-panel-header">
      <span class="ncpqu-panel-title">配置列表设置</span>
      <button class="ncpqu-close" type="button" title="关闭" aria-label="关闭">×</button>
    </header>
    <div class="ncpqu-panel-body">
      <label class="ncpqu-field">
        <span>单页条数</span>
        <input class="ncpqu-page-size" type="number" min="1" max="9999" step="1" inputmode="numeric">
      </label>
      <label class="ncpqu-field">
        <span>排序列</span>
        <select class="ncpqu-sort-column"></select>
      </label>
      <label class="ncpqu-field">
        <span>排序方向</span>
        <select class="ncpqu-sort-order">
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
      </label>
    </div>
  </section>
</div>`;

    document.body.appendChild(uiRoot);

    const fab = getUiElement('.ncpqu-fab');
    const closeButton = getUiElement('.ncpqu-close');
    const header = getUiElement('.ncpqu-panel-header');
    const pageSizeInput = getUiElement('.ncpqu-page-size');
    const sortColumnSelect = getUiElement('.ncpqu-sort-column');
    const sortOrderSelect = getUiElement('.ncpqu-sort-order');

    populateSortColumnOptions(sortColumnSelect);

    fab.addEventListener('click', () => {
      if (Date.now() - lastDragEndedAt < 220) {
        return;
      }
      setPanelExpanded(true);
    });

    closeButton.addEventListener('click', () => {
      setPanelExpanded(false);
    });

    pageSizeInput.addEventListener('input', () => {
      validatePageSizeDraft(pageSizeInput);
    });

    pageSizeInput.addEventListener('blur', () => {
      commitPageSizeInput(pageSizeInput);
    });

    pageSizeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        pageSizeInput.blur();
      }
    });

    ['input', 'change', 'blur'].forEach((eventName) => {
      sortColumnSelect.addEventListener(eventName, () => {
        commitSortColumnSelect(sortColumnSelect);
      });

      sortOrderSelect.addEventListener(eventName, () => {
        commitSortOrderSelect(sortOrderSelect);
      });
    });

    bindLongPressDrag(fab, { allowInteractiveTarget: true });
    bindLongPressDrag(header, { allowInteractiveTarget: false });

    updateUiValues();
    updateRootMode();
    applyRootPosition();
    return uiRoot;
  }

  function updateUiVisibility() {
    if (!document.body) {
      return;
    }

    if (!isTargetRoute()) {
      if (uiRoot) {
        setPanelExpanded(false);
        uiRoot.classList.add('ncpqu-root--hidden');
      }
      return;
    }

    ensureUiRoot();
    if (!uiRoot) {
      return;
    }

    uiRoot.classList.remove('ncpqu-root--hidden');
    updateUiValues();
    applyRootPosition();
  }

  function startDomObserver() {
    if (observer || !document.body) {
      return;
    }

    observer = new MutationObserver(scheduleSort);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    scheduleSort();
  }

  function afterRouteChanged() {
    normalizeCurrentHash();
    updateUiVisibility();
    scheduleSort();
  }

  function patchNavigation() {
    if (window.history.pushState.__nacosConfigPageQueryPatched) {
      return;
    }

    const nativePushState = window.history.pushState;
    const nativeReplaceState = window.history.replaceState;

    function patchedPushState(state, title, url) {
      const result = nativePushState.call(this, state, title, normalizeHistoryUrl(url));
      window.setTimeout(afterRouteChanged, 0);
      return result;
    }

    function patchedReplaceState(state, title, url) {
      const result = nativeReplaceState.call(this, state, title, normalizeHistoryUrl(url));
      if (!normalizingHistory) {
        window.setTimeout(afterRouteChanged, 0);
      }
      return result;
    }

    patchedPushState.__nacosConfigPageQueryPatched = true;
    patchedReplaceState.__nacosConfigPageQueryPatched = true;
    window.history.pushState = patchedPushState;
    window.history.replaceState = patchedReplaceState;

    window.addEventListener('hashchange', afterRouteChanged);
    window.addEventListener('popstate', afterRouteChanged);
  }

  function startUi() {
    updateUiVisibility();
    startDomObserver();
    normalizeCurrentHash();
  }

  window.addEventListener('resize', () => {
    if (!uiRoot) {
      return;
    }

    applyRootPosition();
    writeCookieSettings();
  });

  patchFetch();
  patchXhr();
  patchNavigation();
  startJqueryPatchLoop();
  normalizeCurrentHash();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUi, { once: true });
  } else {
    startUi();
  }
}());
