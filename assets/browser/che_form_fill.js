// CHE form fill engine ("CHE, use my master profile").
//
// Injected into CHE's in-app browser (lib/browser/che_browser.dart) and run
// entirely inside the page on the owner's iPhone. Deterministic: field
// matching uses HTML autocomplete tokens (WHATWG "autofill detail tokens"),
// input type, name/id, label/placeholder/aria text and a synonym table. No
// AI call, no network request, no storage.
//
// Privacy contract (checked by tools/che_form_fill_test.mjs):
//  - scan() and the fill report NEVER contain field values: only labels,
//    classifications and statuses. Verification compares the DOM value with
//    the intended value here in the page and returns true/false.
//  - Passwords are set through setSecret(), which returns only a boolean.
//  - Nothing is logged to the console.
//  - Submit / Pay / Place order are never clicked by fill(). next() clicks
//    only a button that reads as non-submitting step navigation.
//
// API (window.CheFormFill), every method returns a JSON string:
//   scan()                         → {fields, captcha, verification, next, submit, payment, ...}
//   start(planJson)                → starts filling {values: {fieldId: value}} ; returns {started:true}
//   poll()                         → {pending:true} or the fill report
//   setSecret(fieldId, value)      → {ok:bool} (password fields only; value never echoed)
//   next()                         → {clicked:label|null}
//   submit()                       → {clicked:label|null}
//   captchaState()                 → {present, solved, kind}
//   readBack(fieldIdsJson)         → {fieldId: value} for non-secret custom answers (owner's "remember my answers")
(function () {
  if (window.CheFormFill && window.CheFormFill.version === 3) return;

  // ── Synonym table: canonical key → label regex. Order matters (specific first). ──
  var RULES = [
    ['cc', /(card ?number|cardnumber|cc-?num|ccnum|credit ?card|debit ?card|\bcvv2?\b|\bcvc2?\b|\bcsc\b|card ?verification|card ?security|expir(y|ation)|exp(iry)? ?date|name on card|card ?holder|cardholder)/],
    ['one-time-code', /(\botp\b|one[- ]?time|verification ?code|confirm(ation)? ?code|security ?code|\b2fa\b|two[- ]?(factor|step)|auth(entication|enticator)? ?code|sms ?code|6[- ]digit|enter (the )?code|passcode)/],
    ['x-ein', /(\bein\b|employer identification|federal tax|tax ?id|\bfein\b|\btin\b|\bitin\b)/],
    ['x-ssn', /(\bssn\b|social security)/],
    ['username', /(user ?name|login ?id|user ?id|screen ?name|handle)/],
    ['email', /(e-?mail)/],
    ['organization-title', /(job ?title|position|occupation|\brole\b|designation)/],
    ['honorific-prefix', /(^|\b)(salutation|honorific|prefix|title)\b/],
    ['organization', /(company|business ?name|legal ?name|organi[sz]ation|employer|\bdba\b|doing business as|\bfirm\b|entity ?name|trade ?name)/],
    ['given-name', /(first ?name|given ?name|forename|\bfname\b|first_?nm)/],
    ['family-name', /(last ?name|surname|family ?name|\blname\b)/],
    ['additional-name', /(middle ?name|middle ?initial|\bmi\b)/],
    ['tel', /(phone|mobile|\bcell\b|telephone|\btel\b|contact ?number)/],
    ['address-line2', /(address ?(line)? ?2|\bapt\b|apartment|suite|\bunit\b|address2|addr2|floor)/],
    ['postal-code', /(\bzip\b|zip ?code|postal|post ?code|postcode)/],
    ['address-level2', /(\bcity\b|\btown\b|locality|suburb)/],
    ['address-level1', /(\bstate\b|province|region|prefecture)/],
    ['country', /(country|nation)/],
    ['street-address', /(address ?(line)? ?1|street|address1|addr1|mailing ?address|billing ?address|shipping ?address|home ?address|\baddress\b)/],
    ['bday', /(birth|\bdob\b|\bbday\b)/],
    ['sex', /(gender|\bsex\b)/],
    ['url', /(website|web ?site|\burl\b|homepage|home ?page)/],
    ['name', /(full ?name|your ?name|contact ?name|^name$|\bname\b)/],
  ];
  // WHATWG field names CHE understands (after stripping section-*, shipping/billing, home/work/mobile/fax/pager).
  var TOKENS = {
    'name': 1, 'honorific-prefix': 1, 'given-name': 1, 'additional-name': 1, 'family-name': 1, 'honorific-suffix': 1, 'nickname': 1,
    'username': 1, 'new-password': 1, 'current-password': 1, 'one-time-code': 1, 'organization-title': 1, 'organization': 1,
    'street-address': 1, 'address-line1': 1, 'address-line2': 1, 'address-line3': 1, 'address-level1': 1, 'address-level2': 1,
    'country': 1, 'country-name': 1, 'postal-code': 1, 'bday': 1, 'bday-day': 1, 'bday-month': 1, 'bday-year': 1, 'sex': 1, 'url': 1,
    'email': 1, 'tel': 1, 'tel-national': 1, 'tel-country-code': 1, 'tel-area-code': 1, 'tel-local': 1,
    'cc-name': 1, 'cc-number': 1, 'cc-exp': 1, 'cc-exp-month': 1, 'cc-exp-year': 1, 'cc-csc': 1, 'cc-type': 1,
  };
  var BUSINESS_WORDS = /(business|company|employer identification|\bein\b|\bllc\b|\binc\b|corporation|\bdba\b|doing business as|tax ?id|organi[sz]ation|vendor|merchant|work email|business email)/;
  var NEXT_WORDS = /^(next|next step|next page|continue|continue to .{1,30}|proceed|save (and|&) continue|go on|forward|→|next ›|next »)$/;
  var SUBMIT_WORDS = /(submit|sign ?up|register|create (my )?account|join|finish|complete|done|send|apply|confirm|place (my )?order|pay|buy|purchase|checkout|check out|subscribe|book|donate|order now|start (my )?(free )?trial|get started)/;
  var PAY_WORDS = /(\bpay\b|pay now|buy|purchase|place (my )?order|checkout|check out|subscribe|donate|order total|amount due|start (my )?trial|upgrade|\$\s?\d)/;

  var US_STATES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico',GU:'Guam',VI:'U.S. Virgin Islands',AS:'American Samoa',MP:'Northern Mariana Islands'};
  var COUNTRIES = {US:['United States','United States of America','USA','U.S.','U.S.A.','America'],CA:['Canada'],MX:['Mexico'],GB:['United Kingdom','UK','Great Britain','England','U.K.'],IE:['Ireland'],AU:['Australia'],NZ:['New Zealand'],DE:['Germany','Deutschland'],FR:['France'],ES:['Spain'],IT:['Italy'],PT:['Portugal'],NL:['Netherlands','Holland'],BE:['Belgium'],CH:['Switzerland'],AT:['Austria'],SE:['Sweden'],NO:['Norway'],DK:['Denmark'],FI:['Finland'],PL:['Poland'],CZ:['Czech Republic','Czechia'],GR:['Greece'],TR:['Turkey','Türkiye'],IL:['Israel'],AE:['United Arab Emirates','UAE'],SA:['Saudi Arabia'],IN:['India'],PK:['Pakistan'],CN:['China'],JP:['Japan'],KR:['South Korea','Korea, Republic of','Republic of Korea'],SG:['Singapore'],PH:['Philippines'],VN:['Vietnam','Viet Nam'],TH:['Thailand'],ID:['Indonesia'],MY:['Malaysia'],BR:['Brazil','Brasil'],AR:['Argentina'],CL:['Chile'],CO:['Colombia'],PE:['Peru'],ZA:['South Africa'],NG:['Nigeria'],KE:['Kenya'],EG:['Egypt'],MA:['Morocco'],JM:['Jamaica'],DO:['Dominican Republic'],PR:['Puerto Rico'],UA:['Ukraine'],RU:['Russia','Russian Federation'],RO:['Romania'],HU:['Hungary']};
  var COUNTRY_ISO3 = {US:'USA',CA:'CAN',MX:'MEX',GB:'GBR',AU:'AUS',DE:'DEU',FR:'FRA',ES:'ESP',IT:'ITA',IN:'IND',CN:'CHN',JP:'JPN',BR:'BRA'};
  var MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[_\-\.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9$@ ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function normAttr(s) { return norm(String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2')); }
  function txt(el) { return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  // ── Documents: this page plus same-origin iframes (cross-origin ones are listed, never touched). ──
  function docs() {
    var out = [{ doc: document, frame: 0 }], blocked = [];
    var frames = document.querySelectorAll('iframe,frame');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], d = null;
      try { d = f.contentDocument; } catch (e) { d = null; }
      if (d && d.body) out.push({ doc: d, frame: out.length });
      else {
        var host = '';
        try { host = new URL(f.src, location.href).host; } catch (e) { host = ''; }
        if (host && host !== location.host) blocked.push(host);
      }
    }
    return { list: out, blocked: blocked };
  }

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'hidden') return false;
    var win = el.ownerDocument.defaultView || window;
    var st = win.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return true;
    // Styled radios/checkboxes hide the real input behind a visible label.
    if (el.type === 'radio' || el.type === 'checkbox') { var l = labelEl(el); return !!(l && l.getBoundingClientRect().width > 1); }
    return false;
  }

  function labelEl(el) {
    var d = el.ownerDocument;
    if (el.id) { try { var l = d.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l; } catch (e) {} }
    return el.closest ? el.closest('label') : null;
  }

  function labelText(el) {
    var d = el.ownerDocument, parts = [];
    var lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(function (id) { var n = d.getElementById(id); if (n) parts.push(txt(n)); });
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    var l = labelEl(el);
    if (l) {
      // A wrapping label's own text without the option texts of a select inside it.
      var clone = l.cloneNode(true);
      [].slice.call(clone.querySelectorAll('select,option,input,textarea')).forEach(function (n) { n.remove(); });
      parts.push(txt(clone));
    }
    if (!parts.join('').trim()) {
      // Nearby text: previous sibling or the parent's leading text node.
      var p = el.previousElementSibling;
      if (p && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(p.tagName) && txt(p).length < 80) parts.push(txt(p));
      else if (el.parentElement) {
        var lead = '';
        for (var c = el.parentElement.firstChild; c && c !== el; c = c.nextSibling) if (c.nodeType === 3) lead += c.textContent;
        if (lead.trim()) parts.push(lead.trim());
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').replace(/[*:]+\s*$/, '').trim();
  }

  function legendText(el) {
    var fs = el.closest ? el.closest('fieldset,[role=radiogroup],[role=group]') : null;
    if (!fs) return '';
    var lg = fs.querySelector('legend');
    if (lg) return txt(lg);
    var lb = fs.getAttribute('aria-labelledby');
    if (lb) { var n = el.ownerDocument.getElementById(lb); if (n) return txt(n); }
    return fs.getAttribute('aria-label') || '';
  }

  function hintText(el) {
    var d = el.ownerDocument, parts = [el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('pattern') || ''];
    var db = el.getAttribute('aria-describedby');
    if (db) db.split(/\s+/).forEach(function (id) { var n = d.getElementById(id); if (n) parts.push(txt(n)); });
    return parts.join(' ');
  }

  // ── Classification ────────────────────────────────────────────────────
  function tokenFromAutocomplete(el) {
    var ac = String(el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (!ac || ac === 'on' || ac === 'off') return { key: '', section: '', hint: '' };
    var words = ac.split(/\s+/), section = '', hint = '';
    var field = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.indexOf('section-') === 0) section = w;
      else if (w === 'shipping' || w === 'billing') section = section || w;
      else if (w === 'home' || w === 'work' || w === 'mobile' || w === 'fax' || w === 'pager') hint = w;
      else if (w === 'webauthn') continue;
      else if (TOKENS[w]) field = w;
    }
    return { key: field, section: section, hint: hint };
  }

  function classify(el, ctx) {
    var type = (el.getAttribute('type') || el.tagName).toLowerCase();
    var ac = tokenFromAutocomplete(el);
    var label = labelText(el);
    var legend = (type === 'radio' || type === 'checkbox') ? legendText(el) : '';
    var attrs = normAttr([el.getAttribute('name'), el.id].join(' '));
    var words = norm([label, legend, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' '));
    var key = ac.key;
    if (type === 'password') {
      if (key !== 'current-password' && key !== 'new-password') {
        key = (ctx.passwordCount > 1 || /(new|create|choose|confirm|repeat|re ?enter|again|verify)/.test(words + ' ' + attrs)) ? 'new-password' : 'current-password';
      }
    } else if (type === 'file') {
      key = 'file';
    } else if (!key) {
      if (type === 'email') key = 'email';
      else if (type === 'tel') key = 'tel';
      else if (type === 'url') key = 'url';
      else if (type === 'date') key = /(birth|dob|bday)/.test(words + ' ' + attrs) ? 'bday' : 'x-date';
      for (var i = 0; !key && i < RULES.length; i++) if (RULES[i][1].test(words)) key = RULES[i][0];
      for (var j = 0; !key && j < RULES.length; j++) if (RULES[j][1].test(attrs)) key = RULES[j][0];
    }
    if (key && key.indexOf('cc-') === 0) key = 'cc';
    if (key === 'address-line1') key = 'street-address';
    if (key === 'country-name') key = 'country';
    if (key === 'tel-national') key = 'tel';
    // Split birthday parts: day / month / year by name or placeholder.
    if (key === 'bday' && type !== 'date') {
      var part = norm(attrs + ' ' + words + ' ' + (el.getAttribute('placeholder') || ''));
      if (/\b(day|dd)\b/.test(part)) key = 'bday-day';
      else if (/\b(month|mm|mon)\b/.test(part)) key = 'bday-month';
      else if (/\b(year|yyyy|yy)\b/.test(part)) key = 'bday-year';
    }
    var hint = ac.hint;
    if (!hint && (key === 'email' || key === 'tel') && /(work|business|office|company)/.test(words + ' ' + attrs)) hint = 'work';
    var shown = (legend && (type === 'radio' || type === 'checkbox')) ? legend + (label ? ': ' + label : '') : label;
    return { key: key || 'custom', label: shown || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || type, hint: hint, section: ac.section };
  }
  function classifyText(t) { var w = norm(t); for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(w)) return RULES[i][0]; return ''; }

  function controlOf(el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'text';
    if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'file') return 'file';
    if (type === 'password') return 'password';
    if (type === 'date' || type === 'month') return 'date';
    if (el.isContentEditable) return 'editable';
    return 'text';
  }
  // ── Enumerate fields (ids are stable per page via data-che-ff). ─────────
  var counter = 0;
  function byId(id) {
    var d = docs().list;
    for (var i = 0; i < d.length; i++) { var e = d[i].doc.querySelector('[data-che-ff="' + id + '"]'); if (e) return e; }
    return null;
  }
  function hasValue(el, control) {
    if (control === 'checkbox') return !!el.checked;
    if (control === 'select') {
      var o = el.options[el.selectedIndex];
      return !!(o && o.value !== '' && !/^(select|choose|please|--|—)/i.test(o.text.trim()));
    }
    if (control === 'editable') return !!txt(el);
    return !!String(el.value || '').trim();
  }
  function dateFormat(el) {
    var t = String(el.getAttribute('type') || '').toLowerCase();
    if (t === 'date') return 'YYYY-MM-DD';
    if (t === 'month') return 'YYYY-MM';
    var h = hintText(el).toUpperCase().replace(/\s+/g, '');
    var m = h.match(/(MM|DD|YYYY)[\/\.\-](MM|DD|YYYY)[\/\.\-](MM|DD|YYYY)/);
    return m ? m[0] : '';
  }
  function isCaptchaInternal(el) {
    var n = String((el.name || '') + ' ' + (el.id || ''));
    return /g-recaptcha-response|h-captcha-response|cf-turnstile-response/.test(n);
  }
  function enumerate() {
    var d = docs(), fields = [], groups = {};
    var sel = 'input,select,textarea,[role=combobox],[contenteditable=true],[contenteditable=""]';
    d.list.forEach(function (entry) {
      var els = [].slice.call(entry.doc.querySelectorAll(sel));
      var pwCount = els.filter(function (e) { return e.type === 'password' && visible(e); }).length;
      els.forEach(function (el) {
        var type = (el.getAttribute('type') || '').toLowerCase();
        if (/^(hidden|submit|button|reset|image|search)$/.test(type)) return;
        if (isCaptchaInternal(el)) return;
        if (el.tagName === 'INPUT' && el.parentElement && el.parentElement.closest && el.parentElement.closest('[role=combobox]')) return;
        if (!visible(el)) return;
        if (!el.getAttribute('data-che-ff')) el.setAttribute('data-che-ff', 'f' + entry.frame + '-' + (++counter));
        var id = el.getAttribute('data-che-ff');
        var control = controlOf(el);
        var c = classify(el, { passwordCount: pwCount });
        if (control === 'radio') {
          var g = entry.frame + ':' + (el.name || id);
          var opt = { id: id, text: (labelText(el) || el.value || '').slice(0, 60) };
          if (groups[g]) { groups[g].options.push(opt); return; }
          var lg = legendText(el);
          groups[g] = { id: id, key: (lg && classifyText(lg)) || (c.key === 'custom' ? 'custom' : c.key), label: (lg || c.label).slice(0, 80), control: 'radio', type: 'radio', required: !!el.required, frame: entry.frame, options: [opt], filled: false };
          fields.push(groups[g]);
          return;
        }
        var f = { id: id, key: c.key, label: String(c.label).slice(0, 80), control: control, type: type || el.tagName.toLowerCase(), required: !!(el.required || el.getAttribute('aria-required') === 'true'), frame: entry.frame, hint: c.hint || '', filled: hasValue(el, control) };
        if (control === 'select') f.options = [].slice.call(el.options).slice(0, 300).map(function (o) { return o.text.trim().slice(0, 60); });
        if (control === 'text' || control === 'date') f.format = dateFormat(el);
        if (control === 'password') {
          f.minlength = el.minLength > 0 ? el.minLength : null;
          f.maxlength = el.maxLength > 0 ? el.maxLength : null;
          f.passwordrules = el.getAttribute('passwordrules') || '';
          f.pattern = el.getAttribute('pattern') || '';
        }
        fields.push(f);
      });
    });
    fields.forEach(function (f) {
      if (f.control === 'radio') f.filled = f.options.some(function (o) { var e = byId(o.id); return !!(e && e.checked); });
    });
    return { fields: fields, blocked: d.blocked };
  }

  // ── CAPTCHA: detection only. CHE never clicks, solves or interacts with a
  // challenge; it reports it so the owner completes it himself. "solved" is
  // read only from the site's own response field being non-empty. ──────────
  function captchaState() {
    var kind = '', solved = false;
    var d = docs();
    var markers = [
      ['reCAPTCHA', '.g-recaptcha,[data-sitekey].g-recaptcha,iframe[src*="recaptcha"],iframe[title*="reCAPTCHA"]', 'g-recaptcha-response'],
      ['hCaptcha', '.h-captcha,iframe[src*="hcaptcha"]', 'h-captcha-response'],
      ['Cloudflare Turnstile', '.cf-turnstile,iframe[src*="challenges.cloudflare.com"]', 'cf-turnstile-response'],
    ];
    d.list.forEach(function (entry) {
      markers.forEach(function (m) {
        if (kind) return;
        if (entry.doc.querySelector(m[1])) {
          kind = m[0];
          var tok = entry.doc.querySelector('[name="' + m[2] + '"],#' + m[2]);
          solved = !!(tok && String(tok.value || '').trim());
        }
      });
      if (!kind) {
        var body = txt(entry.doc.body).slice(0, 20000).toLowerCase();
        if (/i'?m not a robot|verify (that )?you are (a )?human|are you a robot|complete the security check|press and hold/.test(body)) kind = 'human check';
      }
    });
    d.blocked.forEach(function (h) {
      if (kind) return;
      if (/recaptcha|google\.com$/.test(h) && document.querySelector('iframe[src*="recaptcha"]')) kind = 'reCAPTCHA';
      else if (/hcaptcha/.test(h)) kind = 'hCaptcha';
      else if (/challenges\.cloudflare\.com/.test(h)) kind = 'Cloudflare Turnstile';
    });
    return { present: !!kind, solved: solved, kind: kind };
  }

  // Owner-only verification steps (2FA code, email/SMS link, ID upload, payment confirmation).
  function verificationState(fields) {
    var body = txt(document.body).slice(0, 20000).toLowerCase();
    if (fields.some(function (f) { return f.key === 'one-time-code'; }) || /(enter|type) the (\d+[- ]digit )?code|we (sent|texted|emailed) (you )?a code|verification code/.test(body)) return { kind: 'code', text: 'a verification code sent to your phone, email or authenticator app' };
    if (/check your (email|inbox)|verify your email|we sent (you )?(an? )?(email|link)|click the link/.test(body)) return { kind: 'email_link', text: 'a verification link sent to your email' };
    if (fields.some(function (f) { return f.control === 'file' && /(id|identity|license|licence|passport|selfie)/.test(norm(f.label)); })) return { kind: 'id_upload', text: 'an ID document or selfie upload' };
    if (/3-?d secure|confirm (the )?payment (in|with) your (bank|app)|approve (this|the) (payment|purchase)/.test(body)) return { kind: 'payment_confirmation', text: 'a payment approval in your bank or card app' };
    return null;
  }

  function buttonText(b) { return norm(b.getAttribute('aria-label') || b.value || txt(b) || b.title || ''); }
  function buttons() {
    var out = [];
    docs().list.forEach(function (entry) {
      [].slice.call(entry.doc.querySelectorAll('button,input[type=submit],input[type=button],[role=button],a[role=button]')).forEach(function (b) {
        if (visible(b) && buttonText(b)) out.push(b);
      });
    });
    return out;
  }
  function findNext() {
    var bs = buttons();
    for (var i = 0; i < bs.length; i++) {
      var t = buttonText(bs[i]);
      if (NEXT_WORDS.test(t) && !SUBMIT_WORDS.test(t) && !PAY_WORDS.test(t)) return bs[i];
    }
    return null;
  }
  function findSubmit() {
    var bs = buttons(), best = null;
    for (var i = 0; i < bs.length; i++) {
      var t = buttonText(bs[i]);
      if (NEXT_WORDS.test(t)) continue;
      if (SUBMIT_WORDS.test(t) || (bs[i].type === 'submit' && bs[i].form)) { best = bs[i]; break; }
    }
    return best;
  }

  function scan() {
    var e = enumerate();
    var page = norm(document.title + ' ' + txt(document.body).slice(0, 8000));
    var labels = norm(e.fields.map(function (f) { return f.label; }).join(' '));
    var business = (BUSINESS_WORDS.test(labels) ? 2 : 0) + (BUSINESS_WORDS.test(page) ? 1 : 0) + e.fields.filter(function (f) { return f.key === 'organization' || f.key === 'x-ein' || f.hint === 'work'; }).length * 2;
    var personal = /(personal|date of birth|birthday|\bdob\b|gender)/.test(labels) ? 1 : 0;
    var nx = findNext(), sb = findSubmit();
    var payment = e.fields.some(function (f) { return f.key === 'cc'; }) || PAY_WORDS.test(sb ? buttonText(sb) : '') || /(order total|amount due|subtotal|billing cycle|per month|\/mo\b)/.test(page);
    // Signed-in account email DOMAINS only (never the address): shown in the page header or a prefilled email field.
    var domains = {};
    var m = txt(document.body).slice(0, 20000).match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g) || [];
    m.forEach(function (a) { domains[a.split('@')[1].toLowerCase()] = 1; });
    e.fields.forEach(function (f) { if (f.key === 'email' && f.filled) { var el = byId(f.id); var v = el && String(el.value || ''); if (v.indexOf('@') > 0) domains[v.split('@')[1].toLowerCase()] = 1; } });
    return {
      site: location.host, title: document.title.slice(0, 100), fields: e.fields,
      crossOriginFrames: e.blocked, captcha: captchaState(), verification: verificationState(e.fields),
      next: nx ? buttonText(nx).slice(0, 40) : null, submit: sb ? buttonText(sb).slice(0, 40) : null,
      payment: !!payment, businessSignals: business, personalSignals: personal, emailDomains: Object.keys(domains).slice(0, 5),
    };
  }
  // ── Value helpers ─────────────────────────────────────────────────────
  function candidates(value, key) {
    var v = String(value).trim(), out = [v];
    var up = v.toUpperCase();
    if (key === 'address-level1') {
      if (US_STATES[up]) out.push(US_STATES[up]);
      for (var code in US_STATES) if (norm(US_STATES[code]) === norm(v)) out.push(code);
    }
    if (key === 'country') {
      for (var iso in COUNTRIES) {
        var names = COUNTRIES[iso];
        if (iso === up || COUNTRY_ISO3[iso] === up || names.some(function (n) { return norm(n) === norm(v); })) {
          out.push(iso); if (COUNTRY_ISO3[iso]) out.push(COUNTRY_ISO3[iso]); out = out.concat(names);
        }
      }
    }
    if (key === 'bday-month') {
      var n = parseInt(v, 10);
      if (n >= 1 && n <= 12) { out.push(String(n), (n < 10 ? '0' : '') + n, MONTHS[n - 1], MONTHS[n - 1].slice(0, 3)); }
    }
    if (key === 'bday-day') { var dd = parseInt(v, 10); if (dd) out.push(String(dd), (dd < 10 ? '0' : '') + dd); }
    return out;
  }
  function eventsFor(el) {
    var win = el.ownerDocument.defaultView || window;
    return function (name) {
      var ev = (name === 'input') ? new win.Event('input', { bubbles: true }) : new win.Event(name, { bubbles: true });
      el.dispatchEvent(ev);
    };
  }
  // React/Vue-compatible: call the prototype's native value setter so the
  // framework's value tracker sees a real change, then fire input/change/blur.
  function setNative(el, value) {
    var win = el.ownerDocument.defaultView || window;
    var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    var fire = eventsFor(el);
    try { el.focus({ preventScroll: true }); } catch (e) {}
    fire('focus');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    fire('input'); fire('change'); fire('blur');
  }
  function formatDate(iso, fmt) {
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    if (!fmt) {
      var lang = (document.documentElement.lang || navigator.language || 'en-US').toLowerCase();
      fmt = /^en-(us|ph)|^en$/.test(lang) ? 'MM/DD/YYYY' : /^(zh|ja|ko|sv|lt|hu)/.test(lang) ? 'YYYY-MM-DD' : 'DD/MM/YYYY';
    }
    if (fmt === 'YYYY-MM') return m[1] + '-' + m[2];
    return fmt.replace('YYYY', m[1]).replace('MM', m[2]).replace('DD', m[3]);
  }
  function telFor(el, value) {
    var digits = String(value).replace(/\D/g, '');
    var max = el.maxLength > 0 ? el.maxLength : 0;
    var pat = el.getAttribute('pattern') || '';
    if (digits.length === 11 && digits[0] === '1' && (max === 10 || /\\d\{10\}|\[0-9\]\{10\}/.test(pat))) return digits.slice(1);
    if ((max && max <= 12) || /^\\d|^\[0-9\]/.test(pat)) return digits.length === 11 && digits[0] === '1' && max === 10 ? digits.slice(1) : digits;
    return String(value).trim();
  }
  function selectOption(el, value, key) {
    var c = candidates(value, key).map(norm);
    var opts = [].slice.call(el.options);
    var hit = null;
    for (var pass = 0; pass < 3 && !hit; pass++) {
      for (var i = 0; i < opts.length && !hit; i++) {
        var o = opts[i], t = norm(o.text), v = norm(o.value);
        if (!t && !v) continue;
        if (pass === 0 && (c.indexOf(v) >= 0 || c.indexOf(t) >= 0)) hit = o;
        else if (pass === 1 && c.some(function (x) { return x.length >= 3 && (t.indexOf(x) === 0 || x.indexOf(t) === 0 && t.length >= 3); })) hit = o;
        else if (pass === 2 && key === 'bday-year' && t === norm(value)) hit = o;
      }
    }
    if (!hit) return false;
    setNative(el, hit.value);
    return el.value === hit.value;
  }
  function verifyText(el, expected) { return norm(el.value) === norm(expected) || String(el.value).replace(/\D/g, '') === String(expected).replace(/\D/g, '') && /\d/.test(expected); }

  function fillOne(f, el, value) {
    var key = f.key;
    if (key === 'cc' || key === 'one-time-code' || isCaptchaInternal(el)) return 'refused';
    if (f.control === 'file') return 'unsupported';
    if (f.control === 'password') return 'refused'; // passwords only via setSecret()
    if (f.control === 'select') return selectOption(el, value, key) ? 'filled' : 'no_option';
    if (f.control === 'radio') {
      var c = candidates(value, key).map(norm);
      var group = f.options.map(function (o) { return { o: o, el: byId(o.id) }; });
      var pick = group.filter(function (g) { var t = norm(g.o.text), v = norm(g.el && g.el.value); return c.indexOf(t) >= 0 || c.indexOf(v) >= 0; })[0]
        || group.filter(function (g) { var t = norm(g.o.text); return c.some(function (x) { return x.length >= 3 && t.indexOf(x) === 0; }); })[0];
      if (!pick || !pick.el) return 'no_option';
      pick.el.click();
      if (!pick.el.checked) { pick.el.checked = true; eventsFor(pick.el)('change'); }
      return pick.el.checked ? 'filled' : 'failed';
    }
    if (f.control === 'checkbox') {
      // Only an explicit remembered yes/no; consent boxes are never ticked by CHE.
      var want = /^(yes|true|checked|on|1)$/i.test(String(value)) ? true : /^(no|false|unchecked|off|0)$/i.test(String(value)) ? false : null;
      if (want === null) return 'no_option';
      if (el.checked !== want) el.click();
      return el.checked === want ? 'filled' : 'failed';
    }
    var v = String(value);
    if (f.control === 'date') v = formatDate(v, f.format) || v;
    else if ((key === 'bday' || key === 'x-date') && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = formatDate(v, f.format);
    else if (key === 'tel') v = telFor(el, v);
    if (f.control === 'editable') {
      el.focus(); el.ownerDocument.execCommand('selectAll', false, null); el.ownerDocument.execCommand('insertText', false, v);
      return norm(txt(el)) === norm(v) ? 'filled' : 'failed';
    }
    if (el.maxLength > 0 && v.length > el.maxLength) return 'too_long';
    setNative(el, v);
    return verifyText(el, v) ? 'filled' : 'failed';
  }

  // ARIA combobox: type the value, wait for the listbox, click the matching option.
  function fillCombobox(f, el, value) {
    return new Promise(function (resolve) {
      var c = candidates(value, f.key).map(norm);
      var input = el.tagName === 'INPUT' ? el : el.querySelector('input');
      try { el.click(); } catch (e) {}
      if (input) setNative(input, String(value));
      var tries = 0;
      (function look() {
        var d = el.ownerDocument;
        var lbId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || (input && (input.getAttribute('aria-controls') || input.getAttribute('aria-owns')));
        var lb = (lbId && d.getElementById(lbId)) || [].slice.call(d.querySelectorAll('[role=listbox]')).filter(visible)[0];
        var opts = lb ? [].slice.call(lb.querySelectorAll('[role=option]')) : [];
        var hit = opts.filter(function (o) { return c.indexOf(norm(txt(o))) >= 0 || c.indexOf(norm(o.getAttribute('data-value'))) >= 0; })[0]
          || opts.filter(function (o) { var t = norm(txt(o)); return c.some(function (x) { return x.length >= 3 && t.indexOf(x) === 0; }); })[0];
        if (hit) {
          ['mousedown', 'mouseup', 'click'].forEach(function (n) { hit.dispatchEvent(new MouseEvent(n, { bubbles: true })); });
          setTimeout(function () {
            var shown = norm((input && input.value) || txt(el));
            resolve(c.some(function (x) { return shown.indexOf(x) >= 0; }) || hit.getAttribute('aria-selected') === 'true' ? 'filled' : 'failed');
          }, 60);
          return;
        }
        if (++tries > 15) { resolve(opts.length ? 'no_option' : 'failed'); return; }
        setTimeout(look, 80);
      })();
    });
  }

  var job = null;
  function start(planJson) {
    var plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
    var values = plan.values || {};
    var fields = enumerate().fields;
    var results = [], waits = [];
    fields.forEach(function (f) {
      if (!Object.prototype.hasOwnProperty.call(values, f.id)) return;
      var el = byId(f.id);
      if (!el) { results.push({ id: f.id, status: 'gone' }); return; }
      if (f.filled && !plan.overwrite) { results.push({ id: f.id, status: 'kept' }); return; }
      if (f.control === 'combobox') {
        var r = { id: f.id, status: 'pending' }; results.push(r);
        waits.push(function () { return fillCombobox(f, el, values[f.id]).then(function (s) { r.status = s; }); });
        return;
      }
      var s;
      try { s = fillOne(f, el, values[f.id]); } catch (e) { s = 'failed'; }
      results.push({ id: f.id, status: s });
    });
    job = { done: false, report: null };
    var chain = Promise.resolve();
    waits.forEach(function (w) { chain = chain.then(w).catch(function () {}); });
    chain.then(function () {
      job.done = true;
      job.report = { results: results, captcha: captchaState() };
    });
    return { started: true, count: results.length };
  }
  function poll() { return !job ? { idle: true } : job.done ? job.report : { pending: true }; }

  // Passwords: set directly from the vault, never echoed back.
  function setSecret(id, value) {
    var el = byId(id);
    if (!el || el.type !== 'password') return { ok: false };
    setNative(el, String(value));
    var ok = el.value === String(value);
    return { ok: ok };
  }
  function clickButton(b) { if (!b) return null; var t = buttonText(b).slice(0, 40); try { b.scrollIntoView({ block: 'center' }); } catch (e) {} b.click(); return t; }
  function next() { return { clicked: clickButton(findNext()) }; }
  function submit() { return { clicked: clickButton(findSubmit()) }; }
  // Owner's "remember my answers": the current values of the named non-secret fields, on the phone only.
  function readBack(idsJson) {
    var ids = typeof idsJson === 'string' ? JSON.parse(idsJson) : idsJson, out = {};
    (ids || []).forEach(function (id) {
      var el = byId(id);
      if (!el || el.type === 'password' || isCaptchaInternal(el)) return;
      var f = { key: classify(el, { passwordCount: 0 }).key };
      if (f.key === 'cc' || f.key === 'one-time-code' || f.key === 'x-ssn') return;
      if (el.type === 'radio') { var g = el.ownerDocument.querySelector('input[type=radio][name="' + el.name + '"]:checked'); if (g) out[id] = labelText(g) || g.value; return; }
      if (el.type === 'checkbox') { out[id] = el.checked ? 'yes' : 'no'; return; }
      if (el.tagName === 'SELECT') { var o = el.options[el.selectedIndex]; if (o && hasValue(el, 'select')) out[id] = o.text.trim(); return; }
      var v = String(el.value || txt(el) || '').trim();
      if (v) out[id] = v;
    });
    return out;
  }

  function wrap(fn) { return function () { try { return JSON.stringify(fn.apply(null, arguments)); } catch (e) { return JSON.stringify({ error: (e && e.name) || 'Error' }); } }; } // never the message: it can quote input values
  window.CheFormFill = {
    version: 3,
    scan: wrap(scan), start: wrap(start), poll: wrap(poll), setSecret: wrap(setSecret),
    next: wrap(next), submit: wrap(submit), captchaState: wrap(captchaState), readBack: wrap(readBack),
  };
})();