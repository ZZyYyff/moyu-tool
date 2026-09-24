const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const {
  validateSource, parseSearchPage, parseTocPage, parseTocNextPage, parseContentPage,
  applyFilters, mergeToc, onlineNovelIdFor, searchBook,
} = require('../main/booksource');

const SEARCH_HTML = `
<html><body>
<div class="result">
  <div class="t"><a href="/book/1">斗破苍穹</a></div>
  <span class="a">天蚕土豆</span>
</div>
<div class="result">
  <div class="t"><a href="/book/2">凡人修仙传</a></div>
  <span class="a">忘语</span>
</div>
<div class="result">
  <div class="t">无链接条目应被过滤</div>
</div>
</body></html>`;

const TOC_HTML = `
<html><body>
<ul class="chapters">
  <li><a href="/book/1/1.html">第一章 起点</a></li>
  <li><a href="/book/1/2.html">第二章 风起</a></li>
</ul>
<a class="next" href="/book/1/list_2.html">下一页</a>
</body></html>`;

test('validateSource：字段归一化 + 缺 id 自动生成 + 缺关键字段抛错', () => {
  const s = validateSource({
    name: '测试源',
    search: { url: 'https://x.com/s?q=%s', method: 'post', charset: 'gbk' },
    searchList: '.result',
    tocList: '.chapters li a',
    contentSelector: '#content',
  });
  assert.ok(s.id.startsWith('src-'));
  assert.equal(s.search.method, 'POST');
  assert.equal(s.search.charset, 'gbk');
  assert.equal(s.enabled, true);
  assert.deepEqual(s.filters, []);
  assert.throws(() => validateSource({ name: '无搜索' }), /search.url/);
  assert.throws(() => validateSource({ search: { url: 'x' } }), /name/);
});

test('parseSearchPage：标题/相对 URL 转绝对/作者/无链接过滤', () => {
  const source = validateSource({
    name: 't', search: { url: 'https://x.com/s?q=%s' }, searchList: '.result',
    searchTitle: '.t', searchUrl: '.t a|href', searchAuthor: '.a',
    tocList: 'li', contentSelector: '#c',
  });
  const items = parseSearchPage(source, SEARCH_HTML, 'https://x.com/s?q=a');
  assert.deepEqual(items.map(i => i.title), ['斗破苍穹', '凡人修仙传']);
  assert.equal(items[0].url, 'https://x.com/book/1');
  assert.equal(items[0].author, '天蚕土豆');
});

test('parseTocPage / parseTocNextPage：目录条目与翻页相对地址', () => {
  const source = validateSource({
    name: 't', search: { url: 'https://x.com/s?q=%s' }, tocList: '.chapters li a',
    tocUrl: '|href', tocNextPage: '.next|href', contentSelector: '#c',
  });
  const items = parseTocPage(source, TOC_HTML, 'https://x.com/book/1/');
  assert.deepEqual(items.map(i => i.title), ['第一章 起点', '第二章 风起']);
  assert.equal(items[1].url, 'https://x.com/book/1/2.html');
  assert.equal(parseTocNextPage(source, TOC_HTML, 'https://x.com/book/1/'), 'https://x.com/book/1/list_2.html');
});

test('parseContentPage：br/p 转换行保段落结构', () => {
  const source = validateSource({
    name: 't', search: { url: 'https://x.com/s?q=%s' }, tocList: 'li',
    contentSelector: '#content',
  });
  const html = '<html><body><div id="content">第一段<br>第二段<br><br>第三段</div><div id="other">广告</div></body></html>';
  assert.equal(parseContentPage(source, html), '第一段\n第二段\n\n第三段');
});

test('applyFilters：关键字行与正则行去除', () => {
  const text = '正文一\n请记住本书首发站\n正文二\n本章未完点击下一页\n正文三';
  const out = applyFilters(text, ['请记住本书首发', '/^本章未完/']);
  assert.equal(out, '正文一\n正文二\n正文三');
});

test('mergeToc：尾部增量合并、保住 startLine、缩水忽略', () => {
  const existing = [
    { title: '一', url: 'u1', startLine: 0 },
    { title: '二', url: 'u2', startLine: 10 },
  ];
  const fetched = [{ title: '一', url: 'u1' }, { title: '二', url: 'u2' }, { title: '三', url: 'u3' }];
  const merged = mergeToc(existing, fetched);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].startLine, 0);
  assert.equal(merged[2].startLine, null);
  assert.equal(mergeToc(existing, [{ title: '一', url: 'u1' }]), existing); // 缩水 → 原样返回
});

test('onlineNovelIdFor：稳定 16 位 hex', () => {
  const id = onlineNovelIdFor('src-1', 'https://x.com/book/1');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, onlineNovelIdFor('src-1', 'https://x.com/book/1'));
  assert.notEqual(id, onlineNovelIdFor('src-1', 'https://x.com/book/2'));
});

test('searchBook：%s 占位编码 + gbk 解码（注入 fetch）', async () => {
  const source = validateSource({
    name: 't', search: { url: 'https://x.com/s?q=%s', charset: 'gbk' }, searchList: '.result',
    searchTitle: '.t', searchUrl: '.t a|href', tocList: 'li', contentSelector: '#c',
  });
  let calledUrl = '';
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      arrayBuffer: async () => iconv.encode(SEARCH_HTML, 'gbk').buffer.slice(
        iconv.encode(SEARCH_HTML, 'gbk').byteOffset,
        iconv.encode(SEARCH_HTML, 'gbk').byteOffset + iconv.encode(SEARCH_HTML, 'gbk').byteLength
      ),
    };
  };
  const items = await searchBook(source, '斗 破', fakeFetch);
  assert.equal(calledUrl, 'https://x.com/s?q=' + encodeURIComponent('斗 破'));
  assert.equal(items[0].title, '斗破苍穹');
});
