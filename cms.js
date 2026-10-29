// Редактируемо съдържание на сайта (общо за сайта и за admin.html).
// Всеки текст и всяка снимка в изброените секции получава ключ „секция.номер“.
// Промените се пазят като { ключ: { v: нова стойност, o: оригинал } } – прилагат се само ако
// оригиналът в сайта още е същият (ако текстът в кода бъде сменен, старата промяна не се налага насила).
(function () {
  const SECTIONS = [
    ['top', 'Главна'], ['kniga', 'За книгата'], ['avtor', 'Авторът'], ['vatre', 'Какво има вътре'],
    ['dela', 'Истински дела'], ['otzivi', 'Отзиви'], ['galeria', 'Галерия'], ['vaprosi', 'Въпроси'],
    ['poruchka', 'Поръчка'], ['kontakti', 'Контакти']
  ];
  const SEL = '.tag, h2, h3, .eyebrow, p, blockquote, figcaption, summary, li, cite, .d, .perk-line, .deed-chip > div, img';
  const SKIP = 'form, #track, .live-count, .eq, .socials, .calc, .proof, .rev-ctas, .secure, h1';
  const KIND = { IMG: 'Снимка', H2: 'Заглавие', H3: 'Подзаглавие', P: 'Текст', BLOCKQUOTE: 'Цитат', FIGCAPTION: 'Надпис',
    SUMMARY: 'Въпрос / заглавие', LI: 'Ред от списък', CITE: 'Автор на цитата', SPAN: 'Малък надпис', DIV: 'Текст' };
  const SETTINGS = [
    { key: 'set.price', label: 'Цена на книгата (както се показва)', type: 'setting' },
    { key: 'set.booksBase', label: 'Продадени книги преди сайта (броячът започва от тук)', type: 'setting' }
  ];
  const editableNode = n => n.nodeType === 3 || (n.nodeType === 1 && /^(B|STRONG|BR)$/.test(n.tagName));

  // Текст ↔ поле за писане: **удебелено**, нов ред = <br>
  function serialize(el) {
    const nodes = [...el.childNodes];
    const first = nodes.findIndex(editableNode), last = nodes.length - 1 - [...nodes].reverse().findIndex(editableNode);
    if (first < 0) return null;
    for (let i = first; i <= last; i++) if (!editableNode(nodes[i]) && !(nodes[i].nodeType === 8)) return null; // защитен елемент в средата
    let s = '';
    for (let i = first; i <= last; i++) {
      const n = nodes[i];
      if (n.nodeType === 3) s += n.textContent;
      else if (n.tagName === 'BR') s += '\n';
      else if (n.nodeType === 1) s += '**' + n.textContent + '**';
    }
    return s.replace(/\s*\n\s*/g, '\n').replace(/[ \t]+/g, ' ').trim();
  }
  const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toHtml(s) {
    return escHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }
  function writeText(el, value) {
    const nodes = [...el.childNodes];
    const first = nodes.findIndex(editableNode), last = nodes.length - 1 - [...nodes].reverse().findIndex(editableNode);
    const tmp = document.createElement('div'); tmp.innerHTML = toHtml(value);
    const frag = document.createDocumentFragment(); [...tmp.childNodes].forEach(n => frag.appendChild(n));
    const after = nodes[last].nextSibling;
    for (let i = first; i <= last; i++) nodes[i].remove();
    el.insertBefore(frag, after);
  }
  function writeImg(el, url) {
    const pic = el.closest('picture');
    if (pic) pic.querySelectorAll('source').forEach(s => s.remove());
    el.src = url; el.removeAttribute('srcset');
  }

  // Списък на всички редактируеми полета в даден документ
  function fields(doc) {
    const out = [];
    for (const [id, name] of SECTIONS) {
      const sec = doc.getElementById(id); if (!sec) continue;
      let n = 0;
      sec.querySelectorAll(SEL).forEach(el => {
        if (el.closest(SKIP)) return;
        let value, type;
        if (el.tagName === 'IMG') { type = 'img'; value = el.getAttribute('src'); }
        else { type = 'text'; value = serialize(el); if (value === null || value === '') return; }
        n++;
        out.push({ key: id + '.' + n, section: name, sectionId: id, type, label: (KIND[el.tagName] || 'Текст'), value, el });
      });
    }
    return out;
  }

  // Прилага запазените промени върху страницата
  let base = null;
  function apply(doc, content) {
    if (!content) return;
    if (!base) base = fields(doc);
    base.forEach(f => {
      const c = content[f.key];
      const v = c && c.o === f.value ? c.v : (f.applied ? f.value : null); // върни оригинала, ако промяната е изтрита
      if (v === null) return;
      if (f.type === 'img') writeImg(f.el, v); else writeText(f.el, v);
      f.applied = v !== f.value;
    });
  }
  function setting(content, key, fallback) {
    const c = content && content[key];
    return c && c.v !== '' && c.v != null ? c.v : fallback;
  }

  // Зареждане: първо от кеша (мигновено), после най-новото от Google Таблицата
  const CACHE = 'cms-cache', DEMO = 'cms-demo';
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };
  function cached(api) { return api ? read(CACHE) : read(DEMO); }
  async function fresh(api) {
    if (!api) return read(DEMO);
    const r = await fetch(api + '?action=content'); const d = await r.json();
    write(CACHE, d.content || {}); return d.content || {};
  }

  window.CMS = { SECTIONS, SETTINGS, fields, serialize, apply, setting, cached, fresh, read, write, DEMO, toHtml };
})();
