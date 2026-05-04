const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const ts = Date.now();
    await kv.set('keepalive:last', ts);
    return res.json({ ok: true, timestamp: ts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
