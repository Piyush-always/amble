/* Order status page (order.html?ref=AMB-...). Shows what the server knows; never trusts the URL alone. */
(function () {
  'use strict';
  var cfg = window.AMBLE_CONFIG || {};
  var PHONE = cfg.phone || '+91 85111 49747';
  var ref = new URLSearchParams(location.search).get('ref') || '';
  var title = document.getElementById('title'), lead = document.getElementById('lead');
  var dl = document.getElementById('details'), next = document.getElementById('next');
  var tries = 0, MAX_TRIES = 10;

  function rupees(paise) { return '₹' + (paise / 100).toLocaleString('en-IN'); }
  function date(iso) { return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
  function set(h, p) { title.textContent = h; lead.textContent = p; }
  function rows(list) {
    dl.textContent = '';
    list.forEach(function (r) {
      if (!r[1]) return;
      var dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = r[0]; dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
    dl.hidden = false;
  }

  function paid(o) {
    document.title = 'Order confirmed | Amble Beats';
    set('Thank you, ' + o.firstName + '. Your order is confirmed.',
      'Keep your order number for any questions. Our team has your details and will call you to arrange delivery.');
    rows([['Order number', o.ref], ['Paid', rupees(o.amount)], ['Quantity', String(o.quantity)], ['Paid on', date(o.paidAt)], ['Email', o.email]]);
    next.innerHTML = '<div class="next" style="border-top:0;padding-top:0;margin:0 0 28px"><h3>What happens next</h3><ol>' +
      '<li>We call you <span class="tbc">within one working day</span> to confirm the delivery date.</li>' +
      '<li>Your GST invoice is emailed to you.</li>' +
      '<li>Amble Beats arrives in <span class="tbc">7 to 10 working days</span>.</li></ol></div>';
  }
  function pending() {
    set('Confirming your payment', 'This usually takes a few seconds. Please keep this page open.');
  }
  function unconfirmed() {
    set('We could not confirm your payment yet',
      'Do not pay again. If money has left your account, call us on ' + PHONE + ' or message us on WhatsApp with order number ' + ref + ' and we will check it with Razorpay straight away.');
    rows([['Order number', ref]]);
  }
  function notFound() {
    set('We could not find that order', 'Check the link in your browser, or contact us on ' + PHONE + ' with your order number.');
  }

  if (!/^AMB-[0-9A-HJKMNP-TV-Z]{10}$/.test(ref) || !cfg.apiBase) { notFound(); return; }

  (function poll() {
    fetch(cfg.apiBase + '/api/orders/' + encodeURIComponent(ref))
      .then(function (r) { if (r.status === 404) throw new Error('404'); if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (o) {
        if (o.status === 'paid') return paid(o);
        if (++tries < MAX_TRIES) { pending(); setTimeout(poll, 3000); } else unconfirmed();
      })
      .catch(function (err) {
        if (err.message === '404') return notFound();
        if (++tries < MAX_TRIES) { pending(); setTimeout(poll, 3000); } else unconfirmed();
      });
  })();
})();
