/* Site settings.
   apiBase: URL of the Amble Beats order API (the Cloudflare Worker in /server), with no trailing slash,
   e.g. 'https://amble-api.<your-subdomain>.workers.dev'. While it is empty the site still works:
   enquiry forms hand the message to WhatsApp and the checkout page offers ordering by phone. */
window.AMBLE_CONFIG = {
  apiBase: '',
  whatsapp: '918511149747',
  phone: '+91 85111 49747'
};
