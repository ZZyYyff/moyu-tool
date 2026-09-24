// main/booksource.js — 在线书源（参照 Reader 的 book_source_t 设计，CSS 选择器版）
// 规则 = JSON 配置：host + 搜索页/目录页/正文页三组选择器 + 内容过滤。
// 解析函数（parseXxxPage）为纯函数（html 进结果出，可单测）；网络抓取（fetchHtml 及
// 其上的 searchBook/fetchToc/fetchContent）单独隔离，可注入 fetchImpl。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

// —— 书源存储（userData/booksources.json，原子写）——
function sourcesPath(dir) { return path.join(dir, 'booksources.json'); }
function loadSources(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(sourcesPath(dir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function saveSources(list, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = sourcesPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, sourcesPath(dir));
}

// —— 校验与归一化：缺 id 自动生成；缺关键字段抛错（调用方显示）——
function validateSource(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('书源必须是对象');
  if (!raw.name) throw new Error('书源缺少 name');
  if (!raw.search || !raw.search.url) throw new Error('书源缺少 search.url');
  if (!raw.tocList) throw new Error('书源缺少 tocList');
  if (!raw.contentSelector) throw new Error('书源缺少 contentSelector');
  const id = raw.id || 'src-' + crypto.createHash('sha1').update(raw.name + raw.search.url).digest('hex').slice(0, 8);
  return {
    id,
    name: String(raw.name),
    enabled: raw.enabled !== false,
    search: { url: String(raw.search.url), method: (raw.search.method || 'GET').toUpperCase(), charset: raw.search.charset || 'utf8' },
    searchList: raw.searchList || '',
    searchTitle: raw.searchTitle || '',
    searchUrl: raw.searchUrl || '',
    searchAuthor: raw.searchAuthor || '',
    tocList: String(raw.tocList),
    tocTitle: raw.tocTitle || '',
    tocUrl: raw.tocUrl || '|href',
    tocNextPage: raw.tocNextPage || '',
    contentSelector: String(raw.contentSelector),
    contentNextPage: raw.contentNextPage || '',
    filters: Array.isArray(raw.filters) ? raw.filters.map(String) : [],
  };
}

// —— 选择器约定："sel|attr" 取属性；"|attr" 取元素自身属性；无 "|" 取文本 ——
function splitSpec(spec) {
  if (typeof spec !== 'string') return ['', null];
  const i = spec.lastIndexOf('|');
  if (i === -1) return [spec, null];
  return [spec.slice(0, i), spec.slice(i + 1)];
}
function pickValue($, el, spec) {
  const [sel, attr] = splitSpec(spec);
  const target = sel ? $(el).find(sel).first() : $(el);
  if (!target.length) return '';
  return (attr ? (target.attr(attr) || '') : target.text()).trim();
}
function resolveUrl(base, href) {
  if (!href) return '';
  try { return new URL(href, base).href; } catch { return ''; }
}

// —— 页面解析（纯函数）——
function parseSearchPage(source, html, baseUrl) {
  const $ = cheerio.load(html);
  const results = [];
  $(source.searchList).each((_, el) => {
    const title = pickValue($, el, source.searchTitle);
    const url = resolveUrl(baseUrl, pickValue($, el, source.searchUrl));
    if (!title || !url) return;
    const item = { title, url, author: pickValue($, el, source.searchAuthor) };
    if (!results.some((r) => r.url === item.url)) results.push(item);
  });
  return results;
}

function parseTocPage(source, html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];
  $(source.tocList).each((_, el) => {
    const title = pickValue($, el, source.tocTitle);
    const url = resolveUrl(baseUrl, pickValue($, el, source.tocUrl));
    if (!title || !url) return;
    items.push({ title: title.slice(0, 40), url });
  });
  return items;
}

function parseTocNextPage(source, html, baseUrl) {
  if (!source.tocNextPage) return '';
  const $ = cheerio.load(html);
  return resolveUrl(baseUrl, pickValue($, $.root(), source.tocNextPage));
}

// <br>/</p> 先转换行再取文本，保留网文段落结构（cheerio .text() 会丢换行）
function preformatHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n');
}

function parseContentPage(source, html) {
  const $ = cheerio.load(preformatHtml(html));
  return $(source.contentSelector).first().text().trim();
}

function parseContentNextPage(source, html, baseUrl) {
  if (!source.contentNextPage) return '';
  const $ = cheerio.load(html);
  return resolveUrl(baseUrl, pickValue($, $.root(), source.contentNextPage));
}

// 内容过滤：'关键词' = 含关键字的行整行去除；'/正则/' = 匹配行去除
function applyFilters(text, filters) {
  let lines = String(text).split('\n');
  for (const f of filters || []) {
    const m = f.match(/^\/(.+)\/$/);
    const re = m ? new RegExp(m[1]) : null;
    lines = lines.filter((line) => (re ? !re.test(line) : !line.includes(f)));
  }
  return lines.join('\n');
}

// —— 网络抓取（fetchImpl 可注入）——
async function fetchHtml(url, { method = 'GET', charset = 'utf8', body, timeoutMs = 12000 } = {}, fetchImpl) {
  const f = fetchImpl || global.fetch;
  if (typeof f !== 'function') throw new Error('环境缺少 fetch');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method,
      body: method === 'POST' ? body : undefined,
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) moyu-reader' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return iconv.decode(buf, charset === 'gbk' ? 'gbk' : 'utf8');
  } finally {
    clearTimeout(timer);
  }
}

// 搜索：构造 URL（%s 占位）→ 搜索页解析
async function searchBook(source, keyword, fetchImpl) {
  const url = source.search.url.replace('%s', encodeURIComponent(keyword));
  const html = await fetchHtml(url, source.search, fetchImpl);
  return parseSearchPage(source, html, url);
}

// 多源并行搜索；单源失败静默（返回空），单源超时 12s 不拖累整体。
// enabled 判断用 !== false：兼容手写 booksources.json 缺省字段（默认启用）
async function searchAllSources(sources, keyword, fetchImpl) {
  const jobs = sources.filter((s) => s.enabled !== false).map(async (s) => {
    try {
      const items = await searchBook(s, keyword, fetchImpl);
      return items.map((it) => ({ ...it, sourceId: s.id, sourceName: s.name }));
    } catch { return []; }
  });
  return (await Promise.all(jobs)).flat();
}

// 目录：目录页 + nextPage 追翻（上限 30 页防循环）
async function fetchToc(source, bookUrl, fetchImpl) {
  const items = [];
  let url = bookUrl;
  const visited = new Set();
  for (let page = 0; url && page < 30 && !visited.has(url); page++) {
    visited.add(url);
    const html = await fetchHtml(url, { charset: source.search.charset }, fetchImpl);
    items.push(...parseTocPage(source, html, url));
    url = parseTocNextPage(source, html, url);
    if (url && items.some((it) => it.url === url)) break; // 下一页指向已抓内容
  }
  // 站点目录常见"正文从中间开始/最新章节置顶"不去重——保持站点顺序，仅按 url 去相邻重复
  return items.filter((it, i) => i === 0 || it.url !== items[i - 1].url);
}

// 正文：内容页 + nextPage 追翻（上限 20 页），过滤后拼接
async function fetchContent(source, url, fetchImpl) {
  let text = '';
  let next = url;
  const visited = new Set();
  for (let page = 0; next && page < 20 && !visited.has(next); page++) {
    visited.add(next);
    const html = await fetchHtml(next, { charset: source.search.charset }, fetchImpl);
    text += (text ? '\n' : '') + parseContentPage(source, html);
    next = parseContentNextPage(source, html, next);
  }
  return normalizeTextBasic(applyFilters(text, source.filters));
}

function normalizeTextBasic(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 目录刷新合并：已抓章节（startLine 非空）原样保留，尾部追加新章（站点缩水时忽略）
function mergeToc(existing, fetched) {
  if (!Array.isArray(fetched) || fetched.length < existing.length) return existing;
  const merged = existing.map((ch, i) => ({ ...ch, url: fetched[i] ? fetched[i].url : ch.url }));
  for (let i = existing.length; i < fetched.length; i++) merged.push({ ...fetched[i], startLine: null });
  return merged;
}

// 在线书 novelId：书源 id + 详情页 URL 定（与本地文件 id 同算法家族）
function onlineNovelIdFor(sourceId, bookUrl) {
  return crypto.createHash('sha1').update(sourceId + '|' + bookUrl).digest('hex').slice(0, 16);
}

module.exports = {
  loadSources, saveSources, validateSource,
  parseSearchPage, parseTocPage, parseTocNextPage, parseContentPage, parseContentNextPage, applyFilters,
  searchBook, searchAllSources, fetchToc, fetchContent, mergeToc, onlineNovelIdFor,
};
