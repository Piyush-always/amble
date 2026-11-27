/* Checkout: validate details -> create the order on our server -> Razorpay Checkout -> verify on our server
   -> order.html. The browser never decides the amount and never marks anything paid; the server does both. */
(function () {
  'use strict';
  var cfg = window.AMBLE_CONFIG || {};
  var PHONE = cfg.phone || '+91 85111 49747';
  var unit = 4620000, mrp = 5000000, max = 5; // paise; replaced by /api/product when the API is reachable
  var qty = 1, busy = false, verifying = false, lastFailure = '';
  var coupon = null;                        // { code, percentOff } once the server has accepted a code

  function $(id) { return document.getElementById(id); }
  var form = $('checkout'), payBtn = $('payBtn'), notice = $('notice');

  function rupees(paise) { return '₹' + (paise / 100).toLocaleString('en-IN'); }
  // Shows what the server will charge. The server recomputes all of it; this is only the preview.
  function totals() {
    var subtotal = unit * qty;
    var discount = coupon ? Math.round(subtotal * coupon.percentOff / 10000) * 100 : 0;
    return { subtotal: subtotal, discount: discount, total: subtotal - discount };
  }
  function render() {
    var t = totals();
    $('qty').textContent = qty;
    $('mrp').textContent = rupees(mrp * qty);
    $('priceLabel').textContent = qty > 1 ? 'Price for ' + qty : 'Price';
    $('unitPrice').textContent = rupees(t.subtotal);
    $('discountRow').hidden = !coupon;
    if (coupon) {
      $('discountLabel').textContent = coupon.code + ' (' + coupon.percentOff + '% off)';
      $('discount').textContent = '−' + rupees(t.discount);
    }
    $('total').textContent = rupees(t.total);
    $('qtyMinus').disabled = busy || qty <= 1;
    $('qtyPlus').disabled = busy || qty >= max;
    $('couponCode').disabled = busy;
    $('couponApply').disabled = busy;
    if (!busy) payBtn.textContent = 'Pay ' + rupees(t.total);
  }
  function changeQty(n) {
    qty = n;
    render();
    if (coupon) applyCoupon(coupon.code); // the coupon may have a minimum quantity
  }
  $('qtyMinus').addEventListener('click', function () { if (qty > 1) changeQty(qty - 1); });
  $('qtyPlus').addEventListener('click', function () { if (qty < max) changeQty(qty + 1); });

  /* ---------- coupon ---------- */
  var couponMsg = $('couponMsg');
  function couponNote(kind, text, removable) {
    couponMsg.className = 'coupon-msg' + (kind ? ' ' + kind : '');
    couponMsg.textContent = text;
    if (removable) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Remove';
      b.addEventListener('click', function () { coupon = null; $('couponCode').value = ''; couponNote('', ''); render(); });
      couponMsg.appendChild(b);
    }
  }
  function applyCoupon(raw) {
    var code = String(raw || '').toUpperCase().replace(/\s/g, '');
    if (!code) { couponNote('err', 'Enter a coupon code.'); return; }
    if (!cfg.apiBase) { couponNote('err', 'Coupons work once online payment is switched on. Mention the code on WhatsApp instead.'); return; }
    $('couponApply').disabled = true;
    couponNote('', 'Checking the code…');
    api('/api/coupons/check', { code: code, quantity: qty }).then(function (r) {
      coupon = { code: r.code, percentOff: r.percentOff };
      $('couponCode').value = r.code;
      couponNote('ok', r.code + ' applied: ' + r.percentOff + '% off.', true);
    }).catch(function (err) {
      coupon = null;
      couponNote('err', (err.data && err.data.message) || 'We could not check the code. Try again in a moment.');
    }).then(function () { render(); });
  }
  $('couponApply').addEventListener('click', function () { applyCoupon($('couponCode').value); });
  $('couponCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); applyCoupon($('couponCode').value); } });

  function setBusy(on, label) {
    busy = on;
    payBtn.disabled = on;
    Array.prototype.forEach.call(form.querySelectorAll('fieldset'), function (fs) { fs.disabled = on; });
    if (on) payBtn.textContent = label;
    render();
  }

  function showNotice(kind, lines, html) {
    notice.className = 'notice' + (kind ? ' ' + kind : '');
    notice.textContent = '';
    lines.forEach(function (t) { var p = document.createElement('p'); p.textContent = t; notice.appendChild(p); });
    if (html) notice.appendChild(html);
    notice.hidden = false;
    notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideNotice() { notice.hidden = true; }
  function contactLinks() {
    var p = document.createElement('p');
    p.innerHTML = '<a href="tel:' + PHONE.replace(/\s/g, '') + '">Call ' + PHONE + '</a> or <a href="https://wa.me/' + (cfg.whatsapp || '918511149747') + '">message us on WhatsApp</a>.';
    return p;
  }

  /* ---------- validation (the server checks the same rules again) ---------- */
  function phoneDigits(x) { return x.replace(/[\s\-().]/g, '').replace(/^(?:\+?91|0)(?=\d{10}$)/, ''); }
  var RULES = {
    name: function (x) { return x.length >= 2 || 'Enter your full name.'; },
    organisation: function (x) { return x.length >= 2 || 'Enter your school or organisation.'; },
    email: function (x) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x) || 'Enter a valid email address.'; },
    phone: function (x) { return /^[6-9]\d{9}$/.test(phoneDigits(x)) || 'Enter a 10-digit Indian mobile number.'; },
    gstin: function (x) { return !x || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(x.toUpperCase().replace(/\s/g, '')) || 'A GSTIN has 15 characters, like 24ABCDE1234F1Z5.'; },
    line1: function (x) { return x.length >= 3 || 'Enter the delivery address.'; },
    city: function (x) { return x.length >= 2 || 'Enter the city.'; },
    pincode: function (x) { return /^[1-9]\d{5}$/.test(x) || 'Enter the 6-digit PIN code.'; },
    state: function (x) { return !!x || 'Choose the state.'; }
  };
  function fieldError(id, msg) {
    var input = $(id), box = input.closest('.field'), err = box.querySelector('.err-msg');
    if (!err) { err = document.createElement('span'); err.className = 'err-msg'; err.id = id + '-err'; box.appendChild(err); }
    err.textContent = msg || '';
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', err.id); else input.removeAttribute('aria-describedby');
  }
  function check(id) { var r = RULES[id]($(id).value.trim()); fieldError(id, r === true ? '' : r); return r === true; }
  function validateAll() {
    var first = null;
    Object.keys(RULES).forEach(function (id) { if (!check(id) && !first) first = $(id); });
    if (first) first.focus();
    return !first;
  }
  // Errors appear when Pay is pressed and clear as the buyer corrects them. Checking on blur instead
  // inserts an error line while the pointer is on its way to Pay, the button jumps and the click is lost.
  Object.keys(RULES).forEach(function (id) {
    $(id).addEventListener($(id).tagName === 'SELECT' ? 'change' : 'input', function () {
      if ($(id).getAttribute('aria-invalid') === 'true') check(id);
    });
  });

  function details() {
    function v(id) { return $(id).value.trim(); }
    return {
      quantity: qty,
      customer: { name: v('name'), organisation: v('organisation'), email: v('email'), phone: v('phone'), gstin: v('gstin') },
      address: { line1: v('line1'), line2: v('line2'), city: v('city'), state: v('state'), pincode: v('pincode') },
      notes: v('notes'),
      couponCode: coupon ? coupon.code : ''
    };
  }

  /* One key per checkout attempt. Pressing Pay again with the same details reuses it, so the server hands
     back the same Razorpay order instead of creating a second one. Changed details get a new key. */
  function attemptKey(fingerprint) {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('amble.checkout') || 'null'); } catch (e) { saved = null; }
    if (saved && saved.fp === fingerprint) return saved.key;
    var key = 'chk-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    try { sessionStorage.setItem('amble.checkout', JSON.stringify({ fp: fingerprint, key: key })); } catch (e) { /* private mode: key lives for this page only */ }
    return key;
  }
  function clearAttempt() { try { sessionStorage.removeItem('amble.checkout'); } catch (e) { /* nothing stored */ } }

  function api(path, body) {
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 20000);
    return fetch(cfg.apiBase + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        clearTimeout(timer);
        if (!r.ok) { var e = new Error(data.error || 'http_' + r.status); e.status = r.status; e.data = data; throw e; }
        return data;
      });
    }, function () {
      clearTimeout(timer);
      var e = new Error('network'); e.status = 0; throw e;
    });
  }

  function goToOrder(ref) { location.href = 'order.html?ref=' + encodeURIComponent(ref); }

  /* ---------- no API yet: send the order on WhatsApp instead ---------- */
  function orderByWhatsApp(d) {
    var a = d.address, c = d.customer;
    var text = ['Hi Invengic, I would like to order Amble Beats.', 'Quantity: ' + d.quantity + ' (' + rupees(totals().total) + ')',
      d.couponCode ? 'Coupon: ' + d.couponCode : '',
      'Name: ' + c.name, 'Organisation: ' + c.organisation, 'Phone: ' + c.phone, 'Email: ' + c.email, c.gstin ? 'GSTIN: ' + c.gstin : '',
      'Deliver to: ' + [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', '), d.notes ? 'Notes: ' + d.notes : '']
      .filter(Boolean).join('\n');
    window.open('https://wa.me/' + (cfg.whatsapp || '918511149747') + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    showNotice('', ['WhatsApp has opened with your order. Press send there and we will reply with a payment link.'], contactLinks());
  }

  /* ---------- pay ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    hideNotice();
    if (!validateAll()) return;
    var d = details();
    if (!cfg.apiBase) { orderByWhatsApp(d); return; }
    if (!window.Razorpay) {
      showNotice('err', ['The payment window did not load. Check your internet connection and reload the page.'], contactLinks());
      return;
    }
    var fingerprint = JSON.stringify(d);
    d.idempotencyKey = attemptKey(fingerprint);
    setBusy(true, 'Starting payment…');
    api('/api/orders', d).then(function (order) {
      if (order.status === 'paid') { clearAttempt(); goToOrder(order.ref); return; }
      openRazorpay(order);
    }).catch(function (err) {
      setBusy(false);
      if (err.status === 400 && err.data && err.data.fields && err.data.fields.couponCode) {
        // The coupon stopped working between Apply and Pay (expired, used up): show the new total first.
        coupon = null;
        couponNote('err', err.data.fields.couponCode);
        render();
        showNotice('err', ['The coupon could not be applied, so the total has changed to ' + rupees(totals().total) + '. Press Pay to continue without it, or try another code.']);
      } else if (err.status === 400 && err.data && err.data.fields) {
        var first = null;
        Object.keys(err.data.fields).forEach(function (k) {
          if ($(k)) { fieldError(k, err.data.fields[k]); if (!first) first = $(k); }
        });
        if (first) first.focus();
        showNotice('err', ['Please check the highlighted details.']);
      } else if (err.status === 409) {
        clearAttempt();
        showNotice('err', ['Your details changed while a payment was being set up. Press Pay again to continue.']);
      } else if (err.status === 503) {
        showNotice('err', ['Online payment is not available right now. You have not been charged.'], contactLinks());
      } else {
        showNotice('err', ['We could not start the payment. You have not been charged. Please try again in a minute.'], contactLinks());
      }
    });
  });

  function openRazorpay(order) {
    lastFailure = '';
    var rzp = new window.Razorpay({
      key: order.keyId,
      order_id: order.razorpayOrderId,
      amount: order.amount,
      currency: order.currency,
      name: 'Amble Beats',
      description: order.quantity + (order.quantity > 1 ? ' instruments' : ' instrument') + (order.couponCode ? ', ' + order.couponCode : '') + ' · ' + order.ref,
      image: new URL('assets/apple-touch-icon.png', location.href).href,
      prefill: order.prefill,
      notes: { ref: order.ref },
      theme: { color: '#24140e' },
      handler: function (resp) { verify(order, resp); },
      modal: { confirm_close: true, ondismiss: function () { if (!verifying) dismissed(order); } }
    });
    rzp.on('payment.failed', function (resp) {
      lastFailure = (resp && resp.error && resp.error.description) || 'The payment did not go through.';
    });
    setBusy(true, 'Waiting for payment…');
    rzp.open();
  }

  function dismissed(order) {
    // A UPI payment can complete after the window closes; the webhook records it. Check before asking for another payment.
    api('/api/orders/' + order.ref).then(function (s) {
      if (s.status === 'paid') { clearAttempt(); goToOrder(order.ref); return; }
      throw new Error('unpaid');
    }).catch(function () {
      setBusy(false);
      var lines = lastFailure
        ? ['Your payment did not go through: ' + lastFailure, 'Press Pay to try again, or use a different payment method.']
        : ['The payment window was closed before the payment finished. Press Pay to try again.'];
      lines.push('If money has already left your account, do not pay again. Contact us with reference ' + order.ref + '.');
      showNotice('err', lines, contactLinks());
    });
  }

  function verify(order, resp) {
    verifying = true;
    setBusy(true, 'Confirming payment…');
    api('/api/orders/verify', {
      razorpay_order_id: resp.razorpay_order_id,
      razorpay_payment_id: resp.razorpay_payment_id,
      razorpay_signature: resp.razorpay_signature
    }).then(function () {
      clearAttempt();
    }).catch(function () {
      // Keep the attempt key: if the payment did go through, pressing Pay again finds the paid order.
    }).then(function () {
      // The order page shows the server's view: paid, still confirming, or not confirmed with next steps.
      goToOrder(order.ref);
    });
  }

  /* ---------- start ---------- */
  if (!cfg.apiBase) {
    showNotice('', ['Online payment is being switched on. You can still fill in your details and press the button: your order will open in WhatsApp and we will send you a payment link.']);
    payBtn.dataset.mode = 'whatsapp';
  } else {
    api('/api/product').then(function (p) {
      if (p && p.unitPrice > 0) { unit = p.unitPrice; mrp = p.mrp || mrp; max = p.maxQty || max; if (qty > max) qty = max; render(); }
    }).catch(function () { /* keep the built-in price; the server still charges its own price */ });
  }
  render();
  // A coupon link from the sales team, e.g. checkout.html?coupon=AMBLE20
  var linked = new URLSearchParams(location.search).get('coupon');
  if (linked) { $('couponCode').value = linked; applyCoupon(linked); }
})();
