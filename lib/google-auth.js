const { OAuth2Client } = require('google-auth-library');
const { normalizeEmail } = require('./auth-user');

const client = new OAuth2Client();

function splitDisplayName(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return {
      firstName: 'Google',
      lastName: 'User',
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ') || 'User',
  };
}

function getGoogleClientIds() {
  const values = [process.env.GOOGLE_CLIENT_ID, process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(values)];
}

async function verifyGoogleCredential(credential) {
  const audiences = getGoogleClientIds();

  if (audiences.length === 0) {
    throw new Error('Google Sign-In is not configured on the server');
  }

  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: audiences,
  });

  const payload = ticket.getPayload();

  if (!payload || !payload.email || !payload.email_verified) {
    throw new Error('Google account email must be verified');
  }

  const fallbackNames = splitDisplayName(payload.name);

  return {
    googleId: payload.sub,
    email: normalizeEmail(payload.email),
    firstName: payload.given_name || fallbackNames.firstName,
    lastName: payload.family_name || fallbackNames.lastName,
    picture: payload.picture || '',
  };
}

module.exports = {
  verifyGoogleCredential,
};
