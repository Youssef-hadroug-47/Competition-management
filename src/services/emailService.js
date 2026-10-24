const nodemailer = require('nodemailer');
const config = require('../config');

let transporter;

function getTransporter() {
  if (!config.smtpHost || !config.smtpFrom) {
    const error = new Error('Email delivery is not configured');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(config.smtpUser
        ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
        : {}),
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function sendVerificationEmail(user, token) {
  const verifyUrl = new URL('/verify-email', `${config.publicAppUrl}/`);
  verifyUrl.hash = `token=${encodeURIComponent(token)}`;
  await getTransporter().sendMail({
    from: config.smtpFrom,
    to: user.email,
    subject: 'Verify your Tournly email address',
    text: `Hi ${user.name},\n\nVerify your email address by visiting:\n${verifyUrl}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Verify your Tournly email address by clicking the link below. It expires in 24 hours.</p><p><a href="${escapeHtml(verifyUrl)}">Verify email address</a></p><p>If you did not create this account, you can ignore this email.</p>`,
  });
}

async function sendTestEmail(to) {
  const sentAt = new Date().toISOString();
  return getTransporter().sendMail({
    from: config.smtpFrom,
    to,
    subject: 'Tournly mail service test',
    text: `This is a test email from the Tournly API sent at ${sentAt}.\n\nIf you received it, the mail service is configured correctly.`,
    html: `<p>This is a test email from the Tournly API sent at ${escapeHtml(sentAt)}.</p><p>If you received it, the mail service is configured correctly.</p>`,
  });
}

module.exports = { sendVerificationEmail, sendTestEmail };
