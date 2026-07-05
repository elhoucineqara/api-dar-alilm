const crypto = require('crypto');

const { getPasswordResetEmailTemplate, sendEmail } = require('./email');

function getPasswordResetBaseUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:3000'
  );
}

async function issuePasswordResetForUser(user) {
  const resetToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = new Date(Date.now() + 3600000);
  await user.save();

  const resetUrl = `${getPasswordResetBaseUrl().replace(/\/$/, '')}/reset-password?token=${resetToken}`;

  return {
    resetToken,
    resetUrl,
  };
}

async function sendPasswordResetEmail(user) {
  const { resetUrl } = await issuePasswordResetForUser(user);
  const userName = `${user.firstName} ${user.lastName}`.trim();
  const emailTemplate = getPasswordResetEmailTemplate(resetUrl, userName || user.email);

  const result = await sendEmail({
    to: user.email,
    subject: 'Reinitialisation de votre mot de passe - Dar Al-Ilm',
    html: emailTemplate,
  });

  if (!result.success) {
    const error = new Error(result.error || 'Unable to send password reset email.');
    error.statusCode = 500;
    throw error;
  }

  return { resetUrl };
}

module.exports = {
  getPasswordResetBaseUrl,
  issuePasswordResetForUser,
  sendPasswordResetEmail,
};
