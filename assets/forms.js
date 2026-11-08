/* Enquiry forms (<form data-lead="...">).
   With the order API configured, the enquiry is posted to it and stored. Without it, the message is
   handed to WhatsApp, which works on any phone; the old mailto: action silently failed on devices
   with no mail app set up. The form's own mailto: action remains only as the no-JavaScript fallback. */
(function () {
  'use strict';
  var cfg = window.AMBLE_CONFIG || {};
  var FIELDS = [['name', 'Name'], ['organisation', 'Organisation'], ['role', 'Role'], ['org_type', 'Type of centre'],
    ['city', 'City'], ['phone', 'Phone'], ['email', 'Email'], ['interest', 'Looking for'], ['message', 'Message']];

  function collect(form) {
    var fd = new FormData(form), out = {};
    FIELDS.forEach(function (f) {
      var v = fd.get(f[0]);
      if (v != null && String(v).trim()) out[f[0]] = String(v).trim();
    });
    out.website = String(fd.get('website') || '');
    return out;
  }

  function whatsappUrl(form, d) {
    var lines = ['Hi Invengic, I would like to know about Amble Beats' + (form.dataset.lead === 'health' ? ' for therapy.' : '.')];
    FIELDS.forEach(function (f) { if (d[f[0]]) lines.push(f[1] + ': ' + d[f[0]]); });
    return 'https://wa.me/' + (cfg.whatsapp || '918511149747') + '?text=' + encodeURIComponent(lines.join('\n'));
  }

  function setStatus(el, cls, text) {
    if (!el) return;
    el.className = 'form-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }

  Array.prototype.forEach.call(document.querySelectorAll('form[data-lead]'), function (form) {
    var status = form.querySelector('.form-status');
    var button = form.querySelector('[type="submit"]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = collect(form);
      if (d.website) return; // honeypot filled in: a bot, not a person

      if (!cfg.apiBase) {
        window.open(whatsappUrl(form, d), '_blank', 'noopener');
        setStatus(status, 'ok', 'WhatsApp has opened with your details. Press send there and we will reply.');
        return;
      }

      button.disabled = true;
      setStatus(status, '', 'Sending your request…');
      var ctrl = 'AbortController' in window ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      var payload = { source: form.dataset.lead, page: location.pathname };
      Object.keys(d).forEach(function (k) { payload[k] = d[k]; });

      fetch(cfg.apiBase + '/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        form.reset();
        setStatus(status, 'ok', 'Thank you. We have your request and will call you on ' + d.phone + '.');
      }).catch(function () {
        setStatus(status, 'err', 'Your request did not go through. Call us on ' + (cfg.phone || '+91 85111 49747') + ' or message us on WhatsApp, and we will take it from there.');
      }).then(function () {
        clearTimeout(timer);
        button.disabled = false;
      });
    });
  });
})();
