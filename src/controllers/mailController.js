const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const emailService = require('../services/emailService');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sendTestEmail = asyncHandler(async (req, res) => {
  const to = String(req.body?.to || req.user.email || '').trim();
  if (!emailPattern.test(to)) throw httpError(400, 'A valid recipient email is required');
  try {
    const info = await emailService.sendTestEmail(to);
    res.json({ ok: true, to, messageId: info?.messageId || null });
  } catch (error) {
    console.error('[mail-test] send failed', {
      code: error?.code || 'UNKNOWN',
      name: error?.name || 'Error',
      message: String(error?.message || 'No error message').slice(0, 300),
    });
    if (error?.code === 'EMAIL_NOT_CONFIGURED') {
      throw httpError(503, 'Email delivery is not configured');
    }
    if (error?.code === 'EAUTH') {
      throw httpError(502, 'The mail service rejected the configured credentials');
    }
    if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND'].includes(error?.code)) {
      throw httpError(502, 'The mail service could not be reached');
    }
    throw httpError(502, 'The test email could not be sent');
  }
});

module.exports = { sendTestEmail };
