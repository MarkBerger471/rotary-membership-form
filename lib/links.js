// Every link the club sends out is built here. The board is now asked on
// WhatsApp and LINE as well as by email, and all three have to point at the
// same vote page - so the URL cannot be built inside the mailer any more.

const enc = encodeURIComponent;

function siteUrl() {
  return (
    process.env.SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL
      : '') ||
    'https://rotary-bkkdach.vercel.app'
  );
}

// The vote link is a capability: whoever holds it votes as that address. It
// carries the channel it went out on so the log can say how someone answered.
function voteUrl(appId, email, name, action, via) {
  return `${siteUrl()}/api/admin/vote?id=${enc(appId)}&email=${enc(email)}` +
    `&name=${enc(name || '')}&action=${enc(action)}` + (via ? `&via=${enc(via)}` : '');
}

// The application itself, for a board member who was asked on a messenger and
// so has no attachment to open. Served by the vote function, to the addresses
// that were asked - it is the same capability as the vote link beside it.
function fileUrl(appId, email, type) {
  return `${siteUrl()}/api/admin/vote?id=${enc(appId)}&email=${enc(email)}&file=${enc(type)}`;
}

module.exports = { siteUrl, voteUrl, fileUrl };
